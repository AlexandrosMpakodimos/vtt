// Controlled diagnostic: real Passport/Express/session middleware; simulated
// credentials/database and MemoryStore by default. The DB wrapper uses isolated
// PostgreSQL row locks and sessions, with controlled password verification.
const fs=require('fs'), vm=require('vm'), assert=require('assert/strict');
const express=require('express'), session=require('express-session');
const {Passport}=require('passport'), {Strategy}=require('passport-local');
const usePg = process.env.LOGIN_RACE_POSTGRES === '1';
let database, pool;
const createdUsers = [];
if (usePg) {
 assert.equal(process.env.NODE_ENV, 'test', 'PostgreSQL mode requires isolated test environment');
 database = require('./src/db');
 pool = new (require('pg').Pool)(require('./knexfile').test.connection);
}
let passed=0,failed=0;
function check(name,ok){console.log(`  ${ok?'PASS':'FAIL'}  ${name}`);ok?passed++:failed++;}
function latch(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function bounded(p){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('scheduling timeout')),5000);})]);}finally{clearTimeout(timer);}}
async function scenario(mode){
 console.log('\n--- '+mode+' ---');
 let user={id:'diagnostic-user',email:'race@example.com',username:'race',password_hash:'old-hash',email_verified_at:'2026-01-01'};
 if (usePg) {
  const suffix = require('crypto').randomBytes(8).toString('hex');
  [user] = await database('users').insert({ email: suffix+'@example.com', username: 'lr'+suffix,
   password_hash: 'old-hash', email_verified_at: database.fn.now() }).returning('*');
  createdUsers.push(user.id);
 }
 const reached=latch(),release=latch();
 const store = usePg ? new (require('connect-pg-simple')(session))({pool, createTableIfMissing:false, pruneSessionInterval:false}) : new session.MemoryStore();
 const originalSet=store.set.bind(store);let paused=false;
 store.set=(sid,data,cb)=>{
  if(mode==='before-session-save'&&data.passport?.user&&!paused){paused=true;reached.resolve();release.promise.then(()=>originalSet(sid,data,cb));}
  else originalSet(sid,data,cb);
 };
 const memoryKnex=()=>{const q={where(){return q;},select(){return q;},forUpdate(){return q;},first:async()=>({...user})};return q;};
 // Model the same per-user transaction lock used by PostgreSQL FOR UPDATE.
 let lock = Promise.resolve();
 memoryKnex.transaction = async work => {
  const previous = lock, gate = latch(); lock = gate.promise;
  await previous;
  try { return await work(memoryKnex); } finally { gate.resolve(); }
 };
 const knex = usePg ? database : memoryKnex;
 const verifyPassword=async(hash,password)=>{if(mode==='during-verification'){reached.resolve();await release.promise;}return hash==='old-hash'&&password==='old-password';};
 const passport=new Passport();
 vm.runInNewContext(fs.readFileSync(__dirname+'/src/config/passport.js','utf8'),{module:{exports:{}},require(name){
  if(name==='passport')return passport;if(name==='passport-local')return {Strategy};
  if(name==='../services/password')return {verifyPassword};if(name==='../db')return knex;
  throw new Error('Unexpected dependency: '+name);
 }},{filename:'src/config/passport.js'});
 const source=fs.readFileSync(__dirname+'/src/routes/auth.js','utf8');
 const start=source.indexOf("router.post('/login',"),end=source.indexOf('// POST /api/auth/resend-verification',start);
 assert(start>=0&&end>start,'login route boundaries');
 const router=express.Router();
 vm.runInNewContext(source.slice(start,end),{router,passport,knex,normalizeEmail:v=>String(v||'').trim().toLowerCase(),publicUser:u=>({id:u.id}),gateway:{sendJson:(_req,res,body)=>res.json(body)}},{filename:'auth.js:login'});
 const app=express();app.use(express.json());
 app.use(session({store,secret:'isolated-diagnostic-only',resave:false,saveUninitialized:false}));
 app.use(passport.initialize());app.use(passport.session());app.use(router);
 app.get('/me',(req,res)=>res.status(req.isAuthenticated()?200:401).json({authenticated:req.isAuthenticated()}));
 app.use((err,req,res,next)=>res.status(500).json({error:err.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base='http://127.0.0.1:'+server.address().port;let request;
 try{
  request=fetch(base+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:user.email,password:'old-password'}),signal:AbortSignal.timeout(8000)});
  if(mode!=='normal'){
   await bounded(reached.promise);
   // Model a committed password replacement and deletion of this user's sessions.
   const revoke = knex.transaction(async trx => {
    if (usePg) {
     await trx('users').where({id:user.id}).forUpdate().first();
     await trx('users').where({id:user.id}).update({password_hash:'new-hash'});
     await trx('session').whereRaw("sess -> 'passport' ->> 'user' = ?", [user.id]).del();
    } else {
     user={...user,password_hash:'new-hash'};
     await new Promise((resolve,reject)=>store.clear(err=>err?reject(err):resolve()));
    }
   });
   // During save the login holds the user lock: let it finish, then revocation
   // must delete its session. During hashing revocation can commit immediately.
   if (mode==='before-session-save') release.resolve();
   await bounded(revoke);
   release.resolve();
  }
  const response=await request,cookie=(response.headers.get('set-cookie')||'').split(';')[0];
  const me=await fetch(base+'/me',{headers:cookie?{Cookie:cookie}:{},signal:AbortSignal.timeout(5000)});
  const rows=usePg
   ? (await database('session').whereRaw("sess -> 'passport' ->> 'user' = ?", [user.id]).select('sess')).map(r=>r.sess)
   : await new Promise((resolve,reject)=>store.all((err,rows)=>err?reject(err):resolve(rows)));
  const count=Object.values(rows).filter(s=>s.passport?.user===user.id).length;
  console.log(`  NOTE  login=${response.status}, subsequent /me=${me.status}, authenticated sessions=${count}`);
  if(mode==='normal'){check('normal login succeeds',response.status===200);check('normal cookie authenticates',me.status===200);check('normal session saved',count===1);}
  else{check('overlapping login produces no server error',response.status<500);check('old credentials leave no usable cookie after revocation',me.status===401);check('no authenticated session survives the controlled race',count===0);}
 }finally{
  release.resolve();if(request)await request.catch(()=>{});
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 }
}
(async()=>{
 try{
  if(usePg){
   const result=await database.raw('select current_database() as database, current_user as role');
   assert.equal(result.rows[0].database,'vtt_test');assert.equal(result.rows[0].role,'vtt_test_runner');
   console.log('PostgreSQL row locks and connect-pg-simple session store; controlled password verification.');
  }
  for(const mode of ['normal','during-verification','before-session-save'])await scenario(mode);
 }catch(err){failed++;console.error('SUITE ERROR:',err);}
 finally{
  if(database){
   try{for(const id of createdUsers){await database('session').whereRaw("sess -> 'passport' ->> 'user' = ?",[id]).del();await database('users').where({id}).del();}}
   catch(err){failed++;console.error('Cleanup failed:',err);}
   await database.destroy();await pool.end();
  }
 }
 console.log(`\n${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
})();
