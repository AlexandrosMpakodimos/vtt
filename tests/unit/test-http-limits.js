const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const express=require('express'),session=require('express-session');
const {createBackend}=require('../../src/rateLimit/backend');
const {proxyHops}=require('../../src/config/proxy');
const secret='fixture-only-session-secret-123456789';
let passed=0;const servers=[],modules=[],backends=[];
async function test(name,fn){await fn();passed++;console.log('ok '+name);}
async function listen(app){const s=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});servers.push(s);return 'http://127.0.0.1:'+s.address().port;}
function network(){
 const counts=new Map(),clients=[];
 return {counts,clients,createClient(options){
  const c=new EventEmitter();clients.push(c);c.options=options;
  c.connect=async()=>{};c.ping=async()=>'PONG';c.destroy=()=>{c.destroyed=true;};
  // Explicit boundary double; the real Lua is covered by the separate local integration test.
  c.eval=async(script,{keys,arguments:args})=>{const old=counts.get(keys[0]);const v={count:(old?.count||0)+1,reset:old?.reset||Date.now()+Number(args[0])};counts.set(keys[0],v);return [v.count,v.reset];};
  c.del=async key=>counts.delete(key);return c;
 }};
}
function backend(n,extra={}){const b=createBackend({url:'redis://fixture',prefix:'fixture',secret,createClient:n.createClient,...extra});backends.push(b);return b;}
function limits(){delete require.cache[require.resolve('../../src/middleware/rateLimit')];const m=require('../../src/middleware/rateLimit');modules.push(m);return m;}
function errors(e,req,res,next){res.status(e.status||500).json({error:'unavailable'});}
(async()=>{
 process.env.NODE_ENV='test';process.env.RL_LOGIN_MAX='3';
 await test('proxy defaults off locally; production requires an explicit bounded hop count',async()=>{
  assert.equal(proxyHops({}),0);
  for(const value of [undefined,'','true','-1','6','1.5',' 1','01'])assert.throws(()=>proxyHops({NODE_ENV:'production',TRUST_PROXY_HOPS:value}),/TRUST_PROXY_HOPS/);
  assert.equal(proxyHops({NODE_ENV:'production',TRUST_PROXY_HOPS:'1'}),1);
 });
 const app=express();app.set('trust proxy',proxyHops({TRUST_PROXY_HOPS:'1'}));
 app.use(session({secret,resave:false,saveUninitialized:false,cookie:{secure:true,httpOnly:true,sameSite:'lax'}}));
 app.get('/',(req,res)=>{req.session.visits=1;res.json({ip:req.ip,secure:req.secure});});const url=await listen(app);
 await test('one hop ignores forged leftmost IP and permits secure forwarded-HTTPS cookies',async()=>{
  const r=await fetch(url,{headers:{'X-Forwarded-For':'192.0.2.99, 198.51.100.4','X-Forwarded-Proto':'https'}});
  assert.deepEqual(await r.json(),{ip:'198.51.100.4',secure:true});
  for(const attr of ['Secure','HttpOnly','SameSite=Lax'])assert(r.headers.get('set-cookie').includes(attr));
 });
 await test('plain HTTP receives no production session cookie',async()=>{assert.equal((await fetch(url)).headers.get('set-cookie'),null);});
 await test('direct local mode ignores forwarded IP and protocol headers',async()=>{
  const x=express();x.set('trust proxy',proxyHops({}));x.get('/',(req,res)=>res.json({ip:req.ip,secure:req.secure}));
  const r=await fetch(await listen(x),{headers:{'X-Forwarded-For':'192.0.2.99','X-Forwarded-Proto':'https'}});assert.deepEqual(await r.json(),{ip:'127.0.0.1',secure:false});
 });
 const n=network(),a=backend(n),b=backend(n);await a.start();await b.start();
 const la=limits(),lb=limits();la.configureBackend(a);lb.configureBackend(b);const urls=[];
 for(const m of [la,lb]){const x=express();x.set('trust proxy',1);x.get('/login',m.loginLimiter,(req,res)=>res.json({ok:true}));x.get('/register',m.registerLimiter,(req,res)=>res.json({ok:true}));x.use(errors);urls.push(await listen(x));}
 const request=(i,route='/login',ip='198.51.100.4')=>fetch(urls[i]+route,{headers:{'X-Forwarded-For':ip}});
 await test('independent limiter instances share one allowance and return retry headers',async()=>{
  for(const i of [0,1,0])assert.equal((await request(i)).status,200);
  const r=await request(1);assert.equal(r.status,429);assert(Number(r.headers.get('retry-after'))>0);assert(r.headers.has('ratelimit-limit'));
 });
 await test('endpoint scopes and client IPs are isolated; Redis keys omit raw IPs',async()=>{
  assert.equal((await request(1,'/register')).status,200);assert.equal((await request(1,'/login','198.51.100.5')).status,200);assert([...n.counts.keys()].every(k=>!k.includes('198.51.100')));
 });
 await test('IPv6 /56 addresses share an allowance',async()=>{
  for(let i=1;i<=3;i++)assert.equal((await request(i%2,'/login','2001:db8:abcd:1200::'+i)).status,200);
  assert.equal((await request(0,'/login','2001:db8:abcd:12ff::9')).status,429);
 });
 await test('backend failure returns 503 without fallback or raw errors and reports once',async()=>{
  let failures=0;const n=network(),c=backend(n,{onFailure:()=>failures++});await c.start();n.clients[0].emit('error',Error('redis://secret-sentinel'));n.clients[0].emit('error',Error('again'));
  await assert.rejects(c.increment('scope','ip',1000),e=>e.status===503&&!e.message.includes('sentinel'));assert.equal(failures,1);assert(n.clients[0].destroyed);
  const m=limits();m.configureBackend(c);const x=express();x.get('/',m.loginLimiter,(req,res)=>res.end('bad'));x.use(errors);assert.equal((await fetch(await listen(x))).status,503);
 });
 await test('hung startup times out and closes the client',async()=>{
  const n=network(),original=n.createClient;n.createClient=o=>{const c=original(o);c.connect=()=>new Promise(()=>{});return c;};const c=backend(n,{timeoutMs:20});await assert.rejects(c.start(),e=>e.status===503);assert(n.clients[0].destroyed);
 });
 await test('shutdown cancels pending commands and is idempotent',async()=>{
  const n=network(),c=backend(n);await c.start();n.clients[0].eval=()=>new Promise(()=>{});const p=c.increment('scope','ip',1000),checked=assert.rejects(p,e=>e.status===503);await new Promise(r=>setImmediate(r));c.stop();c.stop();await checked;
 });
 await test('queue capacity is bounded and shutdown rejects every pending command',async()=>{
  const n=network(),c=backend(n);await c.start();n.clients[0].eval=()=>new Promise(()=>{});
  const pending=Array.from({length:128},()=>assert.rejects(c.increment('scope','ip',1000),e=>e.status===503));
  await assert.rejects(c.increment('scope','overflow',1000),e=>e.status===503);
  c.stop();await Promise.all(pending);
 });
 await test('malformed Redis replies fail closed',async()=>{
  const n=network(),c=backend(n);await c.start();n.clients[0].eval=async()=>['secret-value',null];
  await assert.rejects(c.increment('scope','ip',1000),e=>e.status===503&&!e.message.includes('secret-value'));
  assert(n.clients[0].destroyed);
 });
 await test('production refuses a missing shared backend',async()=>{
  process.env.NODE_ENV='production';const m=limits(),x=express();x.get('/',m.loginLimiter,(req,res)=>res.end('bad'));x.use(errors);assert.equal((await fetch(await listen(x))).status,503);process.env.NODE_ENV='test';
 });
 console.log(`${passed} passed, 0 failed`);
})().catch(e=>{console.error(e);console.log(`${passed} passed, 1 failed`);process.exitCode=1;}).finally(async()=>{
 for(const m of modules)m.stop();for(const b of backends)b.stop();await Promise.all(servers.map(s=>new Promise(r=>s.close(r))));
});
