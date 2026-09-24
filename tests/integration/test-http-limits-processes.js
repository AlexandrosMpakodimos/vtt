// Opt-in. Only local Redis database 0; every key uses this run's random namespace.
const assert=require('node:assert/strict');
const {fork}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const path=require('node:path');
const {createClient}=require('redis');
const {createBackend}=require('../../src/rateLimit/backend');
const {configuration}=require('../../src/coordination/config');
let config;
try {
 if(process.env.NODE_ENV!=='test'||!process.env.TEST_COORDINATION_URL)throw Error();
 config=configuration({NODE_ENV:'test',COORDINATION_URL:process.env.TEST_COORDINATION_URL});
} catch {console.error('REFUSED: set NODE_ENV=test and TEST_COORDINATION_URL to local Redis database 0.');process.exit(1);}
const prefix='vtt:http-test:'+randomUUID(),secret='fixture-only-http-limit-secret-123456';
const children=[],backends=[];
let admin,passed=0,currentTest='setup';
const watchdog=setTimeout(()=>{for(const c of children)c.kill('SIGKILL');admin?.destroy();console.error('TEST_DEADLINE');process.exit(1);},30000);
async function test(name,fn){currentTest=name;await fn();passed++;console.log('ok '+name);}
async function node(){
 const c=fork(path.join(__dirname,'fixtures/http-limit-node.js'),[],{silent:true,env:{PATH:process.env.PATH,
  NODE_ENV:'test',COORDINATION_URL:config.url,COORDINATION_PREFIX:prefix,SESSION_SECRET:secret,
  TRUST_PROXY_HOPS:'1',RL_LOGIN_MAX:'3'}});children.push(c);
 // Drain output without exposing backend URLs or test identities.
 c.stdout.resume();c.stderr.resume();
 c.exited=new Promise(resolve=>c.once('exit',resolve));
 const port=await new Promise((resolve,reject)=>{
  c.once('message',m=>resolve(m.port));c.once('error',()=>reject(Error('FIXTURE_FAILED')));c.once('exit',()=>reject(Error('FIXTURE_EXITED')));
 });return {child:c,url:'http://127.0.0.1:'+port};
}
async function stop(c){if(c.exitCode===null&&c.signalCode===null){c.kill('SIGTERM');await c.exited;}}
(async()=>{
 admin=createClient({url:config.url,socket:{connectTimeout:2000,reconnectStrategy:false},disableOfflineQueue:true});
 admin.on('error',()=>{});await admin.connect();
 const a=await node(),b=await node();
 const request=(n,route='/login',ip='198.51.100.4')=>fetch(n.url+route,{headers:{'X-Forwarded-For':ip}});
 await test('two OS processes admit exactly three of 40 concurrent login requests',async()=>{
  const results=await Promise.all(Array.from({length:40},(_,i)=>request(i%2?a:b)));
  assert.equal(results.filter(r=>r.status===200).length,3);assert.equal(results.filter(r=>r.status===429).length,37);
  assert(results.filter(r=>r.status===429).every(r=>Number(r.headers.get('retry-after'))>0));
 });
 await test('separate scopes and IPs do not consume the login bucket',async()=>{
  assert.equal((await request(a,'/register')).status,200);assert.equal((await request(b,'/login','198.51.100.5')).status,200);
 });
 await test('forged leftmost forwarded IP cannot create another allowance',async()=>{
  assert.equal((await request(a,'/login','192.0.2.99, 198.51.100.4')).status,429);
 });
 await test('application restart preserves an exhausted allowance',async()=>{
  await stop(a.child);const replacement=await node();assert.equal((await request(replacement)).status,429);
 });
 const direct=createBackend({...config,prefix,secret});backends.push(direct);await direct.start();
 await test('Lua preserves a fixed expiry and expires counters',async()=>{
  const first=await direct.increment('expiry','fixture',500);
  const second=await direct.increment('expiry','fixture',500);
  assert.equal(first.totalHits,1);assert.equal(second.totalHits,2);assert(Math.abs(first.resetTime.getTime()-second.resetTime.getTime())<=5);
  await new Promise(r=>setTimeout(r,550));assert.equal((await direct.increment('expiry','fixture',500)).totalHits,1);
 });
 await test('decrement and reset affect only their own scope',async()=>{
  await direct.increment('reset','fixture',1000);await direct.increment('reset','fixture',1000);
  await direct.decrement('reset','fixture');assert.equal((await direct.increment('reset','fixture',1000)).totalHits,2);
  await direct.resetKey('reset','fixture');assert.equal((await direct.increment('reset','fixture',1000)).totalHits,1);
 });
 console.log(`${passed} passed, 0 failed`);
})().catch(()=>{console.error('HTTP_LIMIT_INTEGRATION_FAILED: '+currentTest);process.exitCode=1;}).finally(async()=>{
 try {
  for(const c of children)await stop(c);for(const b of backends)b.stop();
  if(admin?.isReady){
   for await(const keys of admin.scanIterator({MATCH:prefix+':*',COUNT:100})){
    for(const key of keys){assert(key.startsWith(prefix+':'));await admin.del(key);}
   }
   admin.destroy();
  }
  console.log('teardown: complete');
 } catch {console.error('TEARDOWN_FAILED');process.exitCode=1;admin?.destroy();}
 clearTimeout(watchdog);
});
