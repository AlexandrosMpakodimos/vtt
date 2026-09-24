// Real HTTP/WebSocket transports and production coordinator. Redis and SQL are
// explicit in-memory boundary doubles; this does not replace the direct DB test.
const assert=require('node:assert/strict');
const http=require('node:http');
const {randomUUID}=require('node:crypto');
const {Server}=require('socket.io');
const {io:client}=require('socket.io-client');
const {createBus}=require('../../src/coordination/bus');
const {createCoordinatedSockets}=require('../../src/coordination/sockets');
const {broker}=require('./fixtures/coordination-boundaries');
const campaign=randomUUID(),owner=randomUUID(),player=randomUUID(),outside=randomUUID(),scene=randomUUID(),otherScene=randomUUID();
const members=new Map([[owner,'active'],[player,'active'],[outside,'active']]);
const sessions=new Set([owner,player,outside]);
const row={id:campaign,owner_id:owner,is_open:true,active_scene_id:scene};
const network=broker(),nodes=[],clients=[];
let paused,releaseRead,passed=0,failed=0;
function chain(table){
  const filters={};const q={
    where(key,value){if(typeof key==='object')Object.assign(filters,key);else filters[key]=value;return q;},
    whereNull(){return q;},andWhere(){return q;},join(){return q;},forShare(){return q;},
    select:async()=>[{id:campaign}],
    first:async()=>{
      if(table==='campaigns'){
        if(paused){const p=paused;paused=null;await p;}
        return filters.id===campaign?{...row}:undefined;
      }
      if(table==='session')return sessions.has(filters.sid)?{sess:{passport:{user:filters.sid}},expire:new Date(Date.now()+60000)}:undefined;
      if(table==='campaign_members')return {status:members.get(filters.user_id)};
    },
  };return q;
}
const db=table=>chain(table);db.fn={now:()=>new Date()};
db.raw=async()=>({rows:[{now:new Date()}]});db.transaction=fn=>fn(db);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){const end=Date.now()+4000;while(!fn()){if(Date.now()>end)throw Error('routing condition timeout');await sleep(5);}}
async function test(name,fn){await fn();passed++;console.log('ok '+name);}
async function node(){
  const server=http.createServer(),io=new Server(server,{transports:['websocket']});
  const bus=createBus({url:'redis://fixture',prefix:'routing',createClient:network.createClient,onFailure(){failed++;for(const s of io.sockets.sockets.values())s.conn.close();}});
  const c=createCoordinatedSockets({io,knex:db,bus,rewritePayload:async()=>{}});
  const n={server,io,bus,c};nodes.push(n);
  io.on('connection',s=>{s.data.authSessionId=s.handshake.auth.user;s.request.user={id:s.handshake.auth.user};c.attach(s,s.request.user);});
  await c.start();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return n;
}
async function connect(n,user){
  const s=client('http://127.0.0.1:'+n.server.address().port,{transports:['websocket'],reconnection:false,forceNew:true,auth:{user}});clients.push(s);s.events=[];
  s.onAny((event,payload)=>s.events.push({event,payload}));
  await new Promise((resolve,reject)=>{s.once('connect',resolve);s.once('connect_error',reject);});
  s.ack=(event,payload)=>new Promise((resolve,reject)=>s.timeout(3000).emit(event,payload,(err,data)=>err?reject(err):resolve(data)));
  return s;
}
const seen=(s,tag)=>s.events.some(e=>e.payload?.tag===tag);
(async()=>{
  const a=await node(),b=await node();
  const gm=await connect(a,owner),pl=await connect(b,player),tab=await connect(a,player),out=await connect(b,outside);
  for(const s of [gm,pl,tab])assert.equal((await s.ack('campaign:join',{campaign_id:campaign})).ok,true);
  async function send(mode,extra={}){const tag=randomUUID();await a.c.broadcast(campaign,mode,'fixture:data',{tag},extra);return tag;}
  async function barrier(){const tag=await send('room');await until(()=>seen(gm,tag)&&seen(pl,tag)&&seen(tab,tag));}
  await test('room fanout includes both nodes but not unjoined socket',async()=>{const tag=await send('room');await barrier();for(const s of [gm,pl,tab])assert(seen(s,tag));assert(!seen(out,tag));});
  await test('owner targeting excludes every player socket',async()=>{const tag=await send('owner');await barrier();assert(seen(gm,tag));assert(!seen(pl,tag));assert(!seen(tab,tag));});
  await test('player targeting excludes owner',async()=>{const tag=await send('players');await barrier();assert(!seen(gm,tag));assert(seen(pl,tag));assert(seen(tab,tag));});
  await test('whisper excludes untargeted owner and unjoined recipient',async()=>{const tag=await send('users',{userIds:[player,outside,player]});await barrier();assert(!seen(gm,tag));assert(!seen(out,tag));assert.equal(pl.events.filter(e=>e.payload?.tag===tag).length,1);});
  await test('inactive scene reaches owner only',async()=>{const tag=await send('scene',{sceneId:otherScene});await barrier();assert(seen(gm,tag));assert(!seen(pl,tag));});
  await test('active scene players reach both player tabs only',async()=>{const tag=await send('scenePlayers',{sceneId:scene});await barrier();assert(!seen(gm,tag));assert(seen(pl,tag));assert(seen(tab,tag));});
  await test('global presence deduplicates user across nodes',async()=>{await until(()=>a.c.onlineCount(campaign)===2);const r=await gm.ack('lobby:subscribe',{});assert.equal(r.campaigns[0].online,2);});
  await test('second game tab notifies remote lobby without increasing distinct count',async()=>{
    // Drain older work, then register the observer before the new join.
    await barrier();
    const before=gm.events.length;
    const second=await connect(b,player);
    assert.equal((await second.ack('campaign:join',{campaign_id:campaign})).ok,true);
    await until(()=>gm.events.slice(before).some(e=>e.event==='lobby:presence'&&e.payload.campaign_id===campaign));
    const updates=gm.events.slice(before).filter(e=>e.event==='lobby:presence'&&e.payload.campaign_id===campaign);
    assert(updates.every(e=>e.payload.online===2));
    second.close();
  });
  await test('500-token paste stays bounded and retains owner/scene privacy',async()=>{
    const tag=randomUUID();
    const visible=Array.from({length:400},(_,i)=>({tag,id:i,hidden:false}));
    const hidden=Array.from({length:100},(_,i)=>({tag,id:400+i,hidden:true}));
    await a.c.broadcastBatch(campaign,'scene','token:created',visible,{sceneId:scene});
    await a.c.broadcastBatch(campaign,'owner','token:created',hidden);
    await barrier();
    for (const s of [gm,pl,tab]) {
      const got=s.events.filter(e=>e.payload?.tag===tag).map(e=>e.payload);
      assert.equal(got.length,s===gm?500:400);
      assert.equal(new Set(got.map(t=>t.id)).size,got.length);
      if(s!==gm)assert(got.every(t=>!t.hidden));
    }
    assert(!seen(out,tag));assert(a.bus.ready&&b.bus.ready);
    const privateTag=randomUUID();
    await a.c.broadcastBatch(campaign,'scene','token:created',[{tag:privateTag}],{sceneId:otherScene});
    await barrier();assert(seen(gm,privateTag));assert(!seen(pl,privateTag));
  });
  await test('parallel paste batches retain every event and keep both nodes ready',async()=>{
    const tag=randomUUID();
    await Promise.all(Array.from({length:40},(_,batch)=>a.c.broadcastBatch(campaign,'scene','token:created',
      Array.from({length:20},(_,i)=>({tag,id:batch*20+i})),{sceneId:scene})));
    await barrier();
    for(const s of [gm,pl,tab]){
      const got=s.events.filter(e=>e.payload?.tag===tag);assert.equal(got.length,800);
      assert.equal(new Set(got.map(e=>e.payload.id)).size,800);
    }
    assert(a.bus.ready&&b.bus.ready);assert(!seen(out,tag));
  });
  await test('190-region fog paste preserves ordered events and inactive-scene privacy',async()=>{
    for(const sceneId of [scene,otherScene]){
      const tag=randomUUID();
      const regions=Array.from({length:190},(_,i)=>({tag,id:i,scene_id:sceneId,
        type:'rect',points:[[i,i],[i+1,i+1]],revealed:i%2===0}));
      await a.c.broadcastBatch(campaign,'scene','fog:created',regions,{sceneId});
      await barrier();
      for(const s of [gm,pl,tab,out]){
        const got=s.events.filter(e=>e.payload?.tag===tag);
        const allowed=s===gm||(sceneId===scene&&s!==out);
        assert.deepEqual(got.map(e=>e.payload),allowed?regions:[]);
        assert(got.every(e=>e.event==='fog:created'));
      }
      assert(a.bus.ready&&b.bus.ready);
    }
  });
  await test('idle session revoked remotely is disconnected',async()=>{sessions.delete(outside);await a.c.disconnectSessions([outside]);await until(()=>!out.connected);});
  await test('outbound authorization rejects ban even without control delivery',async()=>{members.set(player,'banned');const tag=await send('room');await until(()=>pl.events.some(e=>e.event==='campaign:evicted'));assert(!seen(pl,tag));assert(!seen(tab,tag));});
  await test('pending join invalidated by remote control',async()=>{
    members.set(player,'active');paused=new Promise(resolve=>{releaseRead=resolve;});
    const joining=pl.ack('campaign:join',{campaign_id:campaign});joining.catch(()=>{});
    await until(()=>paused===null);await a.c.evictUser(campaign,player,'removed');
    // Wait for B's actual local generation to change, not a timed sleep.
    const remote=b.io.sockets.sockets.get(pl.id);await until(()=>remote.data.admissionGeneration>=2);
    releaseRead();assert.equal((await joining).ok,false);assert(!remote.rooms.has('campaign:'+campaign));
  });
  await test('subscription error fails closed and shuts remote transport',async()=>{network.clients[3].emit('error',Error('fixture-disconnect'));await until(()=>!pl.connected);assert.equal(b.bus.ready,false);assert.equal(failed,1);});
  console.log(`${passed} passed, 0 failed`);
})().catch(error=>{console.error(error);console.log(`${passed} passed, 1 failed`);process.exitCode=1;}).finally(async()=>{
  releaseRead?.();for(const s of clients)s.close();
  for(const n of nodes){await n.c.stop();await new Promise(resolve=>n.io.close(resolve));}
});
