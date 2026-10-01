const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createBus } = require('../../src/coordination/bus');
const { createAuthorization } = require('../../src/coordination/authorization');
const { configuration } = require('../../src/coordination/config');
const { validate, diagnostic } = require('../../src/config/startup');
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`ok ${name}`); }
const turn = () => new Promise(resolve => setImmediate(resolve));
const { broker, database, socket, socketFor, user, campaignId } = require('./fixtures/coordination-boundaries');
(async()=>{
  await test('local mode and exact Redis URL validation',()=>{
    assert.equal(configuration({}),null);
    assert.equal(configuration({COORDINATION_URL:'rediss://default:fixture@host:6379/0'}).prefix,'vtt:coord:v1');
    for(const value of ['https://host','redis://host/1','redis://host?secret=1','redis://host#secret',' redis://host'])assert.throws(()=>configuration({COORDINATION_URL:value}),/CONFIG_INVALID/);
    assert.throws(()=>configuration({COORDINATION_URL:'redis://host',COORDINATION_PREFIX:'bad space'}));
  });
  await test('production requires coordination and sanitized errors',()=>{
    const env={TRUST_PROXY_HOPS:'0',NODE_ENV:'production',DATABASE_URL:'postgresql://u:p@ep-fixture-pooler.us.aws.neon.tech/vtt',SESSION_SECRET:'fixture-secret-12345678901234567890',BASE_URL:'https://fixture.invalid'};
    assert.throws(()=>validate(env),/COORDINATION_URL/);
    try{configuration({COORDINATION_URL:'secret-value'});}catch(error){assert.equal(diagnostic(error),'STARTUP_FAILED: STARTUP_CONFIG_INVALID: COORDINATION_URL');}
  });
  await test('delivery callback runs under database row locks',async()=>{
    const d=database();let calls=0;
    assert.equal(await createAuthorization(d.db).access(socket(),campaignId,false,()=>{assert(d.locked);calls++;}),true);
    assert.equal(calls,1);assert.deepEqual(d.queries,['campaigns','session','campaign_members']);assert.equal(d.locked,false);
  });
  for(const [name,options,lobby,expected]of[
    ['revoked session',{session:false},false,false],['banned member',{member:'banned'},false,false],
    ['closed game',{open:false},false,false],['closed lobby',{open:false},true,true],
    ['closed owner',{open:false,owner:true},false,true],['deleted campaign',{deleted:true,owner:true},true,false],
  ])await test(name,async()=>{const d=database(options);let emitted=false;
    assert.equal(await createAuthorization(d.db).access(socket(),campaignId,lobby,()=>{emitted=true;}),expected);assert.equal(emitted,expected);
  });
  await test('invalid id refuses before SQL',async()=>{
    let touched=false;const a=createAuthorization({transaction(){touched=true;}});
    assert.equal(await a.access(socket(),'invalid',false,()=>{}),false);assert.equal(touched,false);
  });
  // [2026-10-01] Batch authorization: one transaction per message, whatever the
  // number of recipients (production capacity test: per-recipient checks cost
  // ~55 ms each in series). Same checks, same row locks during the enqueue.
  const u=n=>`3333333${n}-3333-4333-8333-333333333333`;
  await test('batch: N recipients cost ONE transaction, delivered under the locks',async()=>{
    const d=database({owner:false});const sockets=[1,2,3,4,5].map(n=>socketFor(u(n)));let delivered=null;
    const r=await createAuthorization(d.db).accessMany(sockets,campaignId,false,(c,list)=>{assert(d.locked);delivered=list;});
    assert.equal(d.transactions,1);assert.equal(r.allowed.length,5);assert.equal(delivered.length,5);
    assert.deepEqual(d.queries,['campaigns','session','campaign_members']);assert.equal(d.locked,false);
  });
  await test('batch: each recipient is judged on its own (revoked, banned, wrong user, owner on a closed game)',async()=>{
    const ownerSocket={connected:true,data:{userId:user,authSessionId:'sid-'+user}};
    const d=database({owner:true,open:false,users:{[u(1)]:{session:false},[u(2)]:{member:'banned'},[u(3)]:{sessionUser:u(9)}}});
    const sockets=[socketFor(u(1)),socketFor(u(2)),socketFor(u(3)),socketFor(u(4)),ownerSocket];
    const r=await createAuthorization(d.db).accessMany(sockets,campaignId,false,()=>{});
    // u(2) banned, u(3) session of another user, u(4) a player on a closed game: refused here.
    // u(1)'s session row is gone (revoked); a missing row is indistinguishable from a
    // skipped one, so it goes back for the single check, which then refuses it.
    assert.deepEqual(r.allowed,[ownerSocket]);assert.deepEqual(r.denied,[sockets[1],sockets[2],sockets[3]]);assert.deepEqual(r.fallback,[sockets[0]]);
    assert.equal(await createAuthorization(d.db).access(sockets[0],campaignId,false,()=>{}),false);
  });
  await test('batch: a closed game still reaches lobby (dashboard) recipients',async()=>{
    const d=database({open:false});const r=await createAuthorization(d.db).accessMany([socketFor(u(1)),socketFor(u(2))],campaignId,true,()=>{});
    assert.equal(r.allowed.length,2);
  });
  await test('batch: a deleted campaign refuses everyone and delivers nothing',async()=>{
    const d=database({deleted:true});let called=false;
    const r=await createAuthorization(d.db).accessMany([socketFor(u(1))],campaignId,false,()=>{called=true;});
    assert.equal(called,false);assert.equal(r.allowed.length,0);assert.equal(r.denied.length,1);
  });
  await test('batch: a session row held by another transaction is skipped, not waited on, and handed back for access()',async()=>{
    const d=database({users:{[u(2)]:{session:'locked'}}});const sockets=[socketFor(u(1)),socketFor(u(2))];
    const r=await createAuthorization(d.db).accessMany(sockets,campaignId,false,()=>{});
    assert.deepEqual(r.allowed,[sockets[0]]);assert.deepEqual(r.fallback,[sockets[1]]);assert.equal(r.denied.length,0);
  });
  await test('batch: invalid ids and disconnected sockets refuse before SQL',async()=>{
    let touched=false;const a=createAuthorization({transaction(){touched=true;}});
    let r=await a.accessMany([socketFor(u(1))],'invalid',false,()=>{});assert.equal(r.denied.length,1);
    r=await a.accessMany([{connected:false,data:{userId:u(1),authSessionId:'x'}},{connected:true,data:{userId:'bad',authSessionId:'x'}}],campaignId,false,()=>{});
    assert.equal(r.denied.length,2);assert.equal(touched,false);
  });
  await test('two buses receive exactly once through subscriptions',async()=>{
    const network=broker(),events=[[],[]],failures=[];
    const buses=[0,1].map(i=>createBus({url:'redis://fixture',prefix:'test',createClient:network.createClient,onFailure:()=>failures.push(i)}));
    try{
      await buses[0].start(m=>events[0].push(m),()=>({[campaignId]:['a']}));
      await buses[1].start(m=>events[1].push(m),()=>({[campaignId]:['b']}));
      await buses[0].publish({type:'event',payload:'fixture'});await turn();
      assert.equal(events[0].length,1);assert.equal(events[1].length,1);assert.deepEqual(failures,[]);
      await buses[0].refresh();assert.equal(buses[0].nodes.length,2);
    }finally{await Promise.all(buses.map(b=>b.close()));}
  });
  await test('slow connection setup uses the connect bound; commands keep the short bound',async()=>{
    const bus=require('../../src/coordination/bus');assert.equal(bus.COMMAND_TIMEOUT_MS,2500);assert.equal(bus.CONNECT_TIMEOUT_MS,10000);
    const network=broker(),original=network.createClient;const reasons=[];
    network.createClient=o=>{const c=original(o);c.connect=()=>new Promise(r=>setTimeout(r,80));return c;};
    const b=createBus({url:'redis://fixture',prefix:'test',createClient:network.createClient,commandTimeoutMs:20,connectTimeoutMs:400,onFailure:r=>reasons.push(r)});
    try{
      await b.start(()=>{},()=>({}));assert.equal(b.ready,true);assert.deepEqual(reasons,[]);
      for(const c of network.clients)c.publish=()=>new Promise(()=>{});
      await assert.rejects(b.publish({type:'event'}),/COORDINATION_/);assert.equal(b.ready,false);assert.deepEqual(reasons,['TIMEOUT']);
    }finally{await b.close();}
  });
  await test('connection setup beyond the connect bound fails closed',async()=>{
    const network=broker(),original=network.createClient;const reasons=[];
    network.createClient=o=>{const c=original(o);c.connect=()=>new Promise(r=>setTimeout(r,200));return c;};
    const b=createBus({url:'redis://fixture',prefix:'test',createClient:network.createClient,commandTimeoutMs:20,connectTimeoutMs:60,onFailure:r=>reasons.push(r)});
    try{await assert.rejects(b.start(()=>{},()=>({})));assert.equal(b.ready,false);assert.deepEqual(reasons,['TIMEOUT']);}finally{await b.close();}
  });
  for(const mode of ['reset','full','receiver','size','close'])await test(`bounded failure: ${mode}`,async()=>{
    const network=broker();let failed=0;
    const bus=createBus({url:'redis://fixture',prefix:'test',createClient:network.createClient,onFailure:()=>failed++});
    try{
      await bus.start(()=>{if(mode==='receiver')throw Error('fixture');},()=>({}));
      if(mode==='reset'){network.reset();await assert.rejects(bus.refresh(),/RESET/);await turn();}
      if(mode==='full'){network.full();await assert.rejects(bus.publish({type:'event'}));}
      if(mode==='receiver'){await bus.publish({type:'event'});await turn();}
      if(mode==='size')await assert.rejects(bus.publish({type:'event',payload:'x'.repeat(1024*1024)}),/LIMIT/);
      if(mode==='close'){await bus.close();await bus.close();await assert.rejects(bus.publish({type:'event'}),/UNAVAILABLE/);}
      assert.equal(bus.ready,false);assert.equal(failed,mode==='close'?0:1);
    }finally{await bus.close();}
  });
  console.log(`${passed} passed, 0 failed`);
})().catch(error=>{console.error(error);console.log(`${passed} passed, 1 failed`);process.exitCode=1;});
