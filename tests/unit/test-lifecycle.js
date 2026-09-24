const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { fork } = require('node:child_process');
const { io } = require('socket.io-client');
const { createLifecycle } = require('../../src/lifecycle');
const { validate } = require('../../src/config/startup');
const { checkStartup } = require('../../src/startupChecks');
let passed = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function test(name, fn) { await fn(); passed++; console.log(`ok ${name}`); }
async function fixture(mode) {
  const portServer = http.createServer();
  await new Promise(r => portServer.listen(0, '127.0.0.1', r));
  const port = portServer.address().port;
  await new Promise(r => portServer.close(r));
  const child = fork(path.join(__dirname, 'fixtures/lifecycle-server.js'), [mode], {
    env: { PATH: process.env.PATH, PORT: String(port) }, silent: true,
  });
  const events = []; let output = '';
  child.on('message', e => events.push(e));
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 34000);
  exited.then(() => clearTimeout(watchdog));
  async function until(fn) {
    for (let n = 0; n < 1000; n++) { if (fn()) return; if (child.exitCode !== null) throw Error(output); await sleep(10); }
    throw Error('fixture wait timed out');
  }
  return { child, events, exited, until, url: `http://127.0.0.1:${port}`, output: () => output,
    ready: () => until(() => output.includes('STARTUP_READY')) };
}
(async () => {
  await test('configuration validation precedes resource setup and is sanitized', async () => {
    const f = await fixture('config-fail'); assert.equal((await f.exited).code, 1);
    assert.equal(f.events.length, 0); assert.match(f.output(), /STARTUP_FAILED/);
    assert.doesNotMatch(f.output(), /fixture-only|postgres/);
    assert.doesNotThrow(() => validate({ NODE_ENV: 'development' }));
  });
  await test('production config rejects bad captured values without printing them', async () => {
    const env={TRUST_PROXY_HOPS:'0',COORDINATION_URL:'redis://127.0.0.1:6379',BASE_URL:'https://fixture.invalid',NODE_ENV:'production',DATABASE_URL:'postgresql://fixture:fixture@ep-fixture-pooler.us.aws.neon.tech/fixture',SESSION_SECRET:'fixture-only-not-a-real-secret-123456'};
    for(const override of [{SESSION_SECRET:''},{PORT:'0'},{R2_MAX_TOTAL_BYTES:'secret'},{MEDIA_PROXY_SECRET:env.SESSION_SECRET},{MEDIA_HOST:'media.example',MEDIA_ORIGIN:'bad'}]) {
      assert.throws(()=>validate({...env,...override}), /STARTUP_CONFIG_INVALID/);
    }
    for (const override of [{NODE_ENV:'other-sentinel'},{NODE_ENV:''},{BASE_URL:undefined},{BASE_URL:'http://host.invalid'},{BASE_URL:'https://user:password@host.invalid'},{BASE_URL:'not-a-url'},{R2_BUCKET:'partial-bucket'}]) {
      assert.throws(()=>validate({...env,...override}), /STARTUP_CONFIG_INVALID/);
    }
    validate({}); validate({NODE_ENV:'test'}); validate(env);
    const storage={R2_ACCOUNT_ID:'fixture',R2_BUCKET:'fixture-bucket',R2_PUBLIC_BASE_URL:'https://media.invalid',R2_ACCESS_KEY_ID:'fixture',R2_SECRET_ACCESS_KEY:'fixture'};
    validate({...env,...storage});
    validate({...env,...Object.fromEntries(Object.keys(storage).map(key=>[key,'']))});
    assert.throws(()=>validate({...env,...Object.fromEntries(Object.keys(storage).map(key=>[key,' ']))}), /R2_ACCOUNT_ID/);
    for (const key of Object.keys(storage)) assert.throws(()=>validate({...env,...storage,[key]:''}), new RegExp(key));
  });
  for (const [mode,key] of [['env-fail','NODE_ENV'],['base-fail','BASE_URL'],['storage-fail','R2_BUCKET']]) await test(`pre-resource diagnostic ${key}`,async()=>{
    const f=await fixture(mode);assert.equal((await f.exited).code,1);assert.equal(f.events.length,0);
    assert.match(f.output(),new RegExp(key));assert.doesNotMatch(f.output(),/value-sentinel/);
  });
  await test('failure after app pool creation closes the only allocated pool', async () => {
    const f = await fixture('import-fail'); assert.equal((await f.exited).code, 1);
    assert.deepEqual(f.events, [{kind:'close',resource:'app'}]);
    assert.doesNotMatch(f.output(), /secret-import/);
  });
  await test('partial construction closes attached transports before the allocated pool',async()=>{
    const f=await fixture('pool-construction-fail');assert.equal((await f.exited).code,1);
    assert.deepEqual(f.events,[{kind:'http-close'},{kind:'close',resource:'app'}]);
    assert.doesNotMatch(f.output(),/pool-value-sentinel/);
  });
  for (const mode of ['startup-fail', 'session-fail', 'schema-fail']) await test(`${mode}: partial setup closes both pools without maintenance`, async () => {
    const f = await fixture(mode); assert.equal((await f.exited).code, 1);
    assert.deepEqual(f.events.filter(e => e.kind === 'close').map(e => e.resource).sort(), ['app','session']);
    assert(!f.events.some(e => e.kind === 'job-start'));
    if (mode === 'startup-fail') assert.equal(f.events.filter(e => e.kind === 'sql').length, 1); assert.doesNotMatch(f.output(), /sensitive|secret-session/);
  });
  await test('checks are SELECT-only and reject incomplete/locked migration history', async () => {
    const queries = [];
    const names = fs.readdirSync(path.join(__dirname, '../../src/db/migrations')).sort();
    let missing = false, locked = false;
    const db = { raw: async sql => { queries.push(sql); return { rows: sql.includes('knex_migrations_lock') ? [{ is_locked: locked ? 1 : 0 }] : sql.includes('knex_migrations') ? (missing ? [] : names.map(name => ({name}))) : [] }; } };
    const pool = { query: async sql => { queries.push(sql); return {rows: []}; } };
    await checkStartup(db, pool, true); assert(queries.every(q => q.startsWith('SELECT ')));
    assert(queries.some(q => q.includes('public.session'))); assert(queries.some(q => q.includes('"upload_attempts"')));
    missing = true; await assert.rejects(checkStartup(db,pool,true), /MIGRATIONS_INVALID/);
    missing = false; locked = true; await assert.rejects(checkStartup(db,pool,true), /MIGRATIONS_LOCKED/);
  });
  await test('real HTTP health with valid signed session cookie performs zero SQL', async () => {
    const f = await fixture('normal'); await f.ready();
    const cookie = 'connect.sid=' + encodeURIComponent('s:' + require('cookie-signature').sign('present-session', 'fixture-only-not-a-real-secret-123456'));
    const initial = f.events.filter(e => e.kind === 'sql').length;
    await fetch(f.url + '/api/auth/sql-count', {headers:{cookie}});
    await sleep(20);
    const before = f.events.filter(e => e.kind === 'sql').length;
    assert(before > initial, 'positive control: the same cookie on business traffic reads sessions');
    for (const [headers, method] of [[{},'GET'], [{cookie},'GET'], [{cookie},'POST']]) {
      const r = await fetch(f.url + '/healthz', {headers,method});
      assert.equal(r.status,200); assert.equal(r.headers.get('cache-control'),'no-store'); assert.deepEqual(await r.json(),{status:'ready'});
    }
    await sleep(30); assert.equal(f.events.filter(e => e.kind === 'sql').length,before);
    f.child.kill('SIGTERM'); assert.equal((await f.exited).code,0);
  });
  await test('disconnected HTTP, socket and maintenance work drain before pool close; repeated signals', async () => {
    const f = await fixture('normal'); await f.ready();
    const req = http.get(f.url + '/api/auth/slow'); req.on('error', () => {});
    const socket = io(f.url, { transports: ['websocket'], reconnection: false });
    await new Promise((resolve,reject) => { socket.on('connect',resolve); socket.on('connect_error',reject); });
    socket.emit('work');
    await f.until(() => f.events.some(e => e.kind === 'http-start') && f.events.some(e => e.kind === 'socket-start'));
    req.destroy(); socket.disconnect();
    f.child.kill('SIGTERM'); f.child.kill('SIGINT');
    const health = await fetch(f.url + '/healthz'); assert.equal(health.status,503); assert.deepEqual(await health.json(),{status:'stopping'});
    assert.equal((await fetch(f.url + '/api/auth/slow')).status,503);
    const rejected = io(f.url,{transports:['websocket'],reconnection:false,timeout:1000});
    await new Promise((resolve,reject) => { rejected.on('connect_error',resolve); rejected.on('connect',()=>reject(Error('admitted during shutdown'))); });
    rejected.close();
    assert.equal((await f.exited).code,0);
    const firstClose = f.events.findIndex(e => e.kind === 'close');
    for (const kind of ['http-done','socket-done','job-done']) assert(f.events.findIndex(e => e.kind === kind) >= 0 && f.events.findIndex(e => e.kind === kind) < firstClose, kind);
    assert.equal(f.events.filter(e => e.kind === 'close').length,2);
  });
  await test('accepted socket middleware continues into handler during drain', async () => {
    const f = await fixture('normal'); await f.ready();
    const socket = io(f.url,{transports:['websocket'],reconnection:false});
    await new Promise(r => socket.on('connect',r)); socket.emit('work');
    await f.until(() => f.events.some(e => e.kind === 'packet-start')); f.child.kill('SIGTERM');
    assert.equal((await f.exited).code,0); socket.close();
    assert(f.events.findIndex(e => e.kind === 'socket-done') < f.events.findIndex(e => e.kind === 'close'));
    assert(f.events.some(e => e.kind === 'socket-done'));
  });
  await test('real aborted streaming transport releases callback holds promptly',async()=>{
    const f=await fixture('normal');await f.ready();
    await new Promise((resolve,reject)=>{
      const req=http.get(f.url+'/api/auth/stream',res=>{res.once('data',()=>{req.destroy();resolve();});});
      req.on('error',reject);
    });
    await f.until(()=>f.events.some(e=>e.kind==='stream-closed'));
    const start=Date.now();f.child.kill('SIGTERM');assert.equal((await f.exited).code,0);
    assert(Date.now()-start<3000);assert.doesNotMatch(f.output(),/DEADLINE/);
    assert.equal(f.events.filter(e=>e.kind==='http-close').length,1);
  });
  await test('callback business middleware remains tracked after HTTP disconnect',async()=>{
    const f=await fixture('callback-slow');await f.ready();
    const req=http.get(f.url+'/api/auth/slow');req.on('error',()=>{});
    await f.until(()=>f.events.some(e=>e.kind==='callback-start'));req.destroy();f.child.kill('SIGTERM');
    assert.equal((await f.exited).code,0);
    for(const kind of ['callback-done','http-done']) assert(f.events.findIndex(e=>e.kind===kind)>=0 && f.events.findIndex(e=>e.kind===kind)<f.events.findIndex(e=>e.kind==='close'));
  });
  for (const disconnectClient of [false,true]) await test(`actual socket/room lifecycle drain; client disconnect=${disconnectClient}`,async()=>{
    const f=await fixture('real-socket');await f.ready();
    const cookie='connect.sid='+encodeURIComponent('s:'+require('cookie-signature').sign('fixture-session','fixture-only-not-a-real-secret-123456'));
    const socket=io(f.url,{transports:['websocket'],reconnection:false,extraHeaders:{cookie}});
    await new Promise((resolve,reject)=>{socket.on('connect',resolve);socket.on('connect_error',reject);});
    await fetch(f.url+'/api/auth/real-state');
    if(disconnectClient){
      socket.emit('campaign:join',{campaign_id:'campaign-fixture'});
      await f.until(()=>f.events.some(e=>e.kind==='member-start'));socket.disconnect();
    } else {
      const joined=await new Promise(resolve=>socket.emit('campaign:join',{campaign_id:'campaign-fixture'},resolve));assert.equal(joined.ok,true);
      socket.emit('lobby:subscribe',{});
      await f.until(()=>f.events.some(e=>e.kind==='lobby-start'));
    }
    f.child.kill('SIGTERM');assert.equal((await f.exited).code,0);socket.close();
    const poolIndex=f.events.findIndex(e=>e.kind==='close');
    const work=disconnectClient?'member-done':'lobby-done';
    assert(f.events.findIndex(e=>e.kind===work)>=0 && f.events.findIndex(e=>e.kind===work)<poolIndex);
    if(!disconnectClient) assert(f.events.findIndex(e=>e.kind==='lobby-done')<f.events.findIndex(e=>e.kind==='disconnect-start'));
    const completed=f.events.findIndex(e=>e.kind==='disconnect-done');assert(completed>=0 && completed<poolIndex);
    assert.equal(f.events[completed].remaining,0);assert.equal(f.events[completed].rooms,0);
    assert.equal(f.events.filter(e=>e.kind==='http-close').length,1);
    assert(f.events.findIndex(e=>e.kind==='http-close')<poolIndex);
  });
  await test('actual recovery handler retains work after sending its response',async()=>{
    const source=fs.readFileSync(path.join(__dirname,'../../src/routes/auth.js'),'utf8');
    const start=source.indexOf("router.post('/forgot-password',");
    let handler,release,started;const gate=new Promise(r=>{release=r;});const reached=new Promise(r=>{started=r;});
    const order=[];
    require('node:vm').runInNewContext(source.slice(start,source.indexOf("router.post('/logout',",start)),{
      router:{post:(_,fn)=>{handler=fn;}},normalizeEmail:value=>value,
      knex:()=>({where:()=>({first:async()=>({id:'user'})})}),
      issuePasswordResetEmail:async()=>{started();await gate;order.push('recovery-done');},console,
    });
    const l=createLifecycle({exit:()=>{},log:()=>{}});l.ready();
    l.track(handler({body:{email:'fixture@example.invalid'}},{json:()=>order.push('response')},error=>{throw error;}));
    await reached;l.pools.push(()=>order.push('pool'));const stopping=l.shutdown();
    await sleep(10);assert.deepEqual(order,['response']);release();await stopping;
    assert.deepEqual(order,['response','recovery-done','pool']);
  });
  await test('phases keep pools after transport-triggered work, including transport failure',async()=>{
    for(const fail of [false,true]){
      const order=[];const l=createLifecycle({exit:c=>order.push('exit:'+c),log:()=>{}});l.ready();
      l.transports.push(async()=>{order.push('transport');l.track(sleep(20).then(()=>order.push('completion')));if(fail)throw Error('fixture');});
      l.pools.push(()=>order.push('pool'));await l.shutdown();
      assert.deepEqual(order,['transport','completion','pool','exit:'+(fail?1:0)]);
    }
  });
  await test('active session pruning finishes before pools close', async () => {
    const f=await fixture('normal'); await f.ready();
    await fetch(f.url + '/api/auth/prune');
    await f.until(()=>f.events.some(e=>e.kind==='prune-start')); f.child.kill('SIGTERM');
    assert.equal((await f.exited).code,0);
    assert(f.events.findIndex(e=>e.kind==='prune-done') < f.events.findIndex(e=>e.kind==='close'));
  });
  await test('session pool error takes sanitized shutdown path', async () => {
    const f = await fixture('normal'); await f.ready();
    await fetch(f.url + '/api/auth/pool-error'); assert.equal((await f.exited).code,1);
    assert.match(f.output(),/SESSION_POOL_ERROR/); assert.doesNotMatch(f.output(),/secret-session/);
  });
  await test('query callback follow-up work drains before closing', async () => {
    const order=[]; const l=createLifecycle({exit:()=>{},log:()=>{}}); l.ready();
    let finish; const query=new Promise(r=>{finish=r;}); l.track(query);
    query.then(()=>process.nextTick(()=>{
      l.track(sleep(20).then(()=>order.push('callback-done')));
    }));
    l.pools.push(()=>order.push('close'));
    const stopping=l.shutdown(); finish(); await stopping;
    assert.deepEqual(order,['callback-done','close']);
  });
  await test('idempotent shutdown, timer cancellation and stuck closer deadline (short injected clock budget)', async () => {
    const exits=[]; let ticks=0, closes=0;
    const l = createLifecycle({shutdownMs:40, exit: c => exits.push(c),log:()=>{}}); l.ready();
    l.schedule(async()=>{ticks++;},5); await sleep(8);
    l.pools.push(()=>{closes++;return new Promise(()=>{});});
    const p=l.shutdown(); assert.equal(l.shutdown(),p); const count=ticks;
    await sleep(70); assert.equal(ticks,count); assert.equal(closes,1); assert.deepEqual(exits,[1]);
  });
  await test('stuck transport is bounded and forced cleanup precedes pools',async()=>{
    const order=[];const l=createLifecycle({shutdownMs:200,exit:c=>order.push('exit:'+c),log:()=>{}});l.ready();
    l.transports.push(()=>new Promise(()=>{}));
    l.forceTransports.push(()=>order.push('force-transport'));
    l.pools.push(()=>order.push('pool'));const start=Date.now();await l.shutdown();
    assert.deepEqual(order,['force-transport','pool','exit:1']);assert(Date.now()-start<350);
  });
  for (const [mode, maximum] of [['startup-stuck',31000],['job-stuck',26000],['close-stuck',26000]]) await test(`${mode}: real process deadline and attempted cleanup`, async () => {
    const start = Date.now(); const f=await fixture(mode);
    if(mode !== 'startup-stuck') { await f.ready(); f.child.kill('SIGTERM'); }
    assert.equal((await f.exited).code,1); assert(Date.now()-start < maximum);
    assert(f.events.some(e=>e.kind==='close' && e.resource==='app'));
    assert(f.events.some(e=>e.kind==='close' && e.resource==='session'));
  });
  console.log(`${passed} passed, 0 failed`);
})().catch(error => { console.error(error); console.log(`${passed} passed, 1 failed`); process.exit(1); });
