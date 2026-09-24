const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createBus } = require('../../src/coordination/bus');
const { createAuthorization } = require('../../src/coordination/authorization');
const { configuration } = require('../../src/coordination/config');
const { validate, diagnostic } = require('../../src/config/startup');
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`ok ${name}`); }
const turn = () => new Promise(resolve => setImmediate(resolve));
const { broker, database, socket, user, campaignId } = require('./fixtures/coordination-boundaries');
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
