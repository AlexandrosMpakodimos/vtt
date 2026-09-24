// Direct-only. Fresh synthetic schema in the existing guarded vtt_test database.
// Requires local Redis/Valkey; never accepts the Render connection URL.
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const path = require('node:path');
if(process.env.NODE_ENV !== 'test')throw Error('NODE_ENV=test is required');
const base=require('../../knexfile').test;
const redisURL=new URL(process.env.TEST_COORDINATION_URL || '');
if(redisURL.protocol!=='redis:' || !['localhost','127.0.0.1','[::1]'].includes(redisURL.hostname) || redisURL.search || redisURL.hash || !['','/','/0'].includes(redisURL.pathname))throw Error('Local Redis/Valkey test URL required');
const {createClient}=require('redis');
const {io:client}=require('socket.io-client');
const admin=require('knex')({...base,pool:{...base.pool,afterCreate(c,done){
  base.pool.afterCreate(c,error=>{if(error)return done(error,c);c.query("SET statement_timeout = '8000ms'",e=>done(e,c));});
}}});
const schema=`coord_test_${randomBytes(12).toString('hex')}`,prefix=`${schema}:bus`;
const children=[],sockets=[],sessions=[],timers=new Set();
let db,redis,created=false,passed=0,primary;
function bounded(promise,ms=8000){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('test deadline')),ms);timers.add(timer);})]).finally(()=>{clearTimeout(timer);timers.delete(timer);});}
async function check(name,fn){await fn();passed++;console.log(`ok ${name}`);}
async function child(){
  const p=fork(path.join(__dirname,'fixtures/coordination-node.js'),[],{silent:true,env:{...process.env,NODE_ENV:'test',COORD_TEST_SCHEMA:schema,COORD_TEST_NODE:String(children.length),COORDINATION_URL:redisURL.toString(),COORDINATION_PREFIX:prefix,MEDIA_HOST:'',R2_ACCOUNT_ID:'',R2_BUCKET:'',R2_ACCESS_KEY_ID:'',R2_SECRET_ACCESS_KEY:''}});
  const c={p,node:String(children.length),events:[],pending:new Map(),seq:0,log:''};children.push(c);
  p.stdout.on('data',b=>{c.log=(c.log+b).slice(-10000);});p.stderr.on('data',b=>{c.log=(c.log+b).slice(-10000);});
  c.exited=new Promise(resolve=>{
    const ended=(code,signal)=>{c.exit={code,signal};for(const wait of c.pending.values())wait.reject(Error('fixture exited'));c.pending.clear();resolve(c.exit);};
    p.once('exit',ended);p.once('error',()=>ended(1,'spawn-error'));
  });
  c.ready=bounded(new Promise((resolve,reject)=>{c.pending.set('ready',{resolve,reject});}));
  p.on('message',m=>{c.events.push(m);if(m.type==='ready'){c.port=m.port;c.pending.get('ready')?.resolve();c.pending.delete('ready');}if(m.type==='reply'){const wait=c.pending.get(m.id);c.pending.delete(m.id);m.ok?wait?.resolve():wait?.reject(Error('fixture command failed'));}});
  c.call=(method,...args)=>{const id=++c.seq;const promise=new Promise((resolve,reject)=>c.pending.set(id,{resolve,reject}));p.send({id,method,args});return bounded(promise).finally(()=>c.pending.delete(id));};
  await c.ready;return c;
}
async function socketAt(c,user,sid){
  const s=client(`http://127.0.0.1:${c.port}`,{transports:['websocket'],forceNew:true,reconnection:false,auth:{userId:user,sid}});sockets.push(s);
  s.received=[];s.onAny((event,payload)=>s.received.push({event,payload}));
  await bounded(new Promise((resolve,reject)=>{s.once('connect',resolve);s.once('connect_error',reject);}));
  s.ack=(event,payload)=>bounded(new Promise(resolve=>s.emit(event,payload,resolve)));
  return s;
}
async function until(fn){const deadline=Date.now()+8000;while(!fn()){if(Date.now()>deadline)throw Error('condition deadline');await new Promise(r=>setTimeout(r,10));}}
async function fixtureUser(label){const id=randomUUID();await db('users').insert({id});const sid=`${schema}-${label}`;sessions.push(sid);await db('session').insert({sid,sess:{passport:{user:id}},expire:new Date(Date.now()+600000)});return{id,sid};}
const seen=(s,marker)=>s.received.some(m=>m.payload?.marker===marker);
async function marker(c,method,args,event){const tag=randomUUID();await c.call(method,...args,event,{marker:tag});return tag;}
(async()=>{
  await admin.raw('SELECT 1');
  redis=createClient({url:redisURL.toString(),disableOfflineQueue:true,socket:{connectTimeout:2000,reconnectStrategy:false}});redis.on('error',()=>{});await bounded(redis.connect());
  // Record exact ownership before schema creation; cleanup never touches public data.
  created=true;await admin.raw('CREATE SCHEMA ??',[schema]);
  db=require('knex')({...base,pool:{...base.pool,afterCreate(c,done){base.pool.afterCreate(c,error=>{if(error)return done(error,c);c.query(`SET search_path TO "${schema}"; SET statement_timeout = '8000ms'`,e=>done(e,c));});}}});
  await db.raw('CREATE TABLE users (id uuid PRIMARY KEY)');
  await db.raw('CREATE TABLE campaigns (id uuid PRIMARY KEY, owner_id uuid REFERENCES users(id), deleted_at timestamptz, is_open boolean NOT NULL, active_scene_id uuid)');
  await db.raw('CREATE TABLE campaign_members (campaign_id uuid REFERENCES campaigns(id), user_id uuid REFERENCES users(id), status text, PRIMARY KEY(campaign_id,user_id))');
  await db.raw('CREATE TABLE session (sid text PRIMARY KEY, sess json NOT NULL, expire timestamp NOT NULL)');
  const owner=await fixtureUser('owner'),player=await fixtureUser('player'),other=await fixtureUser('other');
  const campaign=randomUUID(),scene=randomUUID(),hiddenScene=randomUUID();
  await db('campaigns').insert({id:campaign,owner_id:owner.id,is_open:true,active_scene_id:scene});
  await db('campaign_members').insert([owner,player,other].map(u=>({campaign_id:campaign,user_id:u.id,status:'active'})));
  const a=await child(),b=await child();
  const gm=await socketAt(a,owner.id,owner.sid),pl=await socketAt(b,player.id,player.sid),plTab=await socketAt(a,player.id,player.sid),outsider=await socketAt(b,other.id,other.sid);
  for(const s of [gm,pl,plTab])assert.equal((await s.ack('campaign:join',{campaign_id:campaign})).ok,true);
  await check('cross-process room event reaches both servers',async()=>{const tag=await marker(a,'broadcastRoom',[campaign],'fixture:event');await until(()=>seen(gm,tag)&&seen(pl,tag)&&seen(plTab,tag));assert(!seen(outsider,tag));});
  // Positive barrier is published after each restricted message on the same
  // connection. Observing it proves that the earlier message was processed.
  async function barrier(){const tag=await marker(a,'broadcastRoom',[campaign],'fixture:barrier');await until(()=>seen(gm,tag)&&seen(pl,tag)&&seen(plTab,tag));}
  await check('owner-only event does not reach remote player',async()=>{const tag=await marker(a,'broadcastToOwner',[campaign],'fixture:owner');await barrier();assert(seen(gm,tag));assert(!seen(pl,tag));assert(!seen(plTab,tag));});
  await check('players-only event excludes owner and unjoined socket',async()=>{const tag=await marker(a,'broadcastToPlayers',[campaign],'fixture:players');await barrier();assert(!seen(gm,tag));assert(seen(pl,tag));assert(seen(plTab,tag));assert(!seen(outsider,tag));});
  await check('whisper targets only requested users in this room',async()=>{const tag=await marker(a,'broadcastToUsers',[campaign,[player.id,player.id]],'fixture:whisper');await barrier();assert(!seen(gm,tag));assert.equal(pl.received.filter(m=>m.payload?.marker===tag).length,1);assert(!seen(outsider,tag));});
  await check('inactive-scene data remains owner-only across instances',async()=>{const tag=await marker(a,'broadcastScene',[campaign,hiddenScene],'fixture:scene');await barrier();assert(seen(gm,tag));assert(!seen(pl,tag));});
  await check('presence counts distinct users across instances',async()=>{await until(()=>gm.received.some(m=>m.event==='campaign:presence'&&m.payload.user_ids.length===2));const r=await gm.ack('lobby:subscribe',{});assert.equal(r.campaigns[0].online,2);});
  await check('committed ban blocks outbound data even before eviction signal',async()=>{
    await db.transaction(async trx=>{await trx('campaigns').where({id:campaign}).forUpdate().first();await trx('campaign_members').where({campaign_id:campaign,user_id:player.id}).update({status:'banned'});});
    const tag=await marker(a,'broadcastRoom',[campaign],'fixture:after-ban');await until(()=>seen(gm,tag));
    // Sender and receiver have independent delivery queues: use receiver IPC
    // publication + owner delivery as a barrier only after player eviction observed.
    await until(()=>pl.received.some(m=>m.event==='campaign:evicted')&&plTab.received.some(m=>m.event==='campaign:evicted'));assert(!seen(pl,tag));assert(!seen(plTab,tag));
    await a.call('evictUser',campaign,player.id,'banned');assert.equal((await pl.ack('campaign:join',{campaign_id:campaign})).ok,false);
  });
  await check('revocation disconnects idle remote socket',async()=>{await db('session').where({sid:other.sid}).del();await a.call('disconnectSessions',[other.sid]);await until(()=>!outsider.connected);});
  await check('closed campaign refuses player but retains owner',async()=>{await db('campaign_members').where({campaign_id:campaign,user_id:player.id}).update({status:'active'});await db('campaigns').where({id:campaign}).update({is_open:false});assert.equal((await pl.ack('campaign:join',{campaign_id:campaign})).ok,false);assert.equal((await gm.ack('campaign:join',{campaign_id:campaign})).ok,true);});
  await check('delayed join cannot use a pre-ban read',async()=>{
    await db('campaigns').where({id:campaign}).update({is_open:true});
    const trx=await db.transaction();let join;
    try{await trx('campaigns').where({id:campaign}).forUpdate().first();await trx('campaign_members').where({campaign_id:campaign,user_id:player.id}).update({status:'banned'});
      join=pl.ack('campaign:join',{campaign_id:campaign});join.catch(()=>{});
      const limit=Date.now()+5000;
      while(true){
        const waiting=await admin('pg_stat_activity').where({application_name:schema+'-'+b.node,wait_event_type:'Lock'}).first();
        if(waiting)break;
        if(Date.now()>limit)throw Error('join did not reach the locked campaign row');
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      await trx.commit();assert.equal((await join).ok,false);
    }finally{if(!trx.isCompleted())await trx.rollback();}
  });
  await check('Redis epoch removal forces both processes to stop',async()=>{
    await redis.del(`${prefix}:epoch`);await bounded(Promise.all([a.exited,b.exited]),10000);assert.equal(a.exit.code,1);assert.equal(b.exit.code,1);assert(!gm.connected);
  });
  await check('replacement process starts fresh and reauthorizes without event replay',async()=>{
    const replacement=await child();
    const fresh=await socketAt(replacement,owner.id,owner.sid);
    assert.equal((await fresh.ack('campaign:join',{campaign_id:campaign})).ok,true);
    assert(!fresh.received.some(m=>m.event.startsWith('fixture:')));
    const tag=await marker(replacement,'broadcastRoom',[campaign],'fixture:fresh');await until(()=>seen(fresh,tag));
    const banned=await socketAt(replacement,player.id,player.sid);
    assert.equal((await banned.ack('campaign:join',{campaign_id:campaign})).ok,false);
  });
})().catch(error=>{primary=error;console.error(error.message);}).finally(async()=>{
  const failures=[];
  async function attempt(name,fn){try{await bounded(Promise.resolve().then(fn),10000);}catch{failures.push(name);}}
  for(const s of sockets)s.close();
  for(const c of children)await attempt('child',async()=>{if(c.exit)return;if(c.p.connected)c.p.send({method:'stop'});await c.exited;});
  for(const c of children)if(!c.exit)c.p.kill('SIGKILL');
  // All child clients are gone before their schema is removed.
  for(const c of children)await attempt('child-exit',()=>c.exited);
  if(db)await attempt('db-close',()=>db.destroy());
  if(created)await attempt('owned-schema',()=>admin.raw('DROP SCHEMA IF EXISTS ?? CASCADE',[schema]));
  if(redis?.isReady)await attempt('owned-redis-keys',()=>redis.del([`${prefix}:nodes`,`${prefix}:presence`,`${prefix}:epoch`]));
  if(redis?.isOpen)redis.destroy();
  await attempt('admin-close',()=>admin.destroy());
  for(const timer of timers)clearTimeout(timer);
  console.log(`teardown: ${failures.length ? failures.join(', ') : 'complete'}`);
  console.log(`${passed} passed, ${primary||failures.length?1:0} failed`);
  process.exitCode=primary||failures.length?1:0;
});
