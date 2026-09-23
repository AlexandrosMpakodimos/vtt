// Process fixture: real HTTP, Express, session store and Socket.IO; no real DB,
// storage or mail. Each substituted boundary is explicit and process-local.
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '../../..');
const mode = process.argv[2];
const report = event => process.send?.(event);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const realSockets = mode.startsWith('real-socket');
const migrations = fs.readdirSync(path.join(root, 'src/db/migrations')).sort();
let sql = 0;
const raw = async text => {
  sql++; report({ kind: 'sql', text });
  if (mode === 'startup-stuck') return new Promise(() => {});
  if (mode === 'schema-fail' && text.includes('upload_attempts')) throw Error('column missing');
  if (mode === 'startup-fail') throw Error('postgres://sensitive-do-not-log');
  if (text.includes('knex_migrations_lock')) return { rows: [{ is_locked: 0 }] };
  if (text.includes('knex_migrations')) return { rows: migrations.map(name => ({ name })) };
  return { rows: [] };
};
function db(table) {
  if (realSockets && table === 'campaign_members as m') {
    const result = async () => { report({kind:'lobby-start'}); await sleep(200); report({kind:'lobby-done'}); return [{id:'campaign-fixture'}]; };
    const chain = new Proxy({}, {get: (_, key) => key === 'then' ? (resolve,reject)=>result().then(resolve,reject) : ()=>chain});
    return chain;
  }
  const q = new Proxy({}, { get: (_, key) => key === 'then' ? resolve => resolve(0) : () => q }); return q; }
db.raw = raw; db.fn = { now: () => 'now' };
db.destroy = async () => { report({ kind: 'close', resource: 'app' }); if (['close-stuck', 'startup-stuck'].includes(mode)) await new Promise(() => {}); };
class Pool extends EventEmitter {
  constructor() { super(); if (mode === 'pool-construction-fail') throw Error('pool-value-sentinel'); report({ kind: 'pool' }); global.pool = this; }
  async query(text) { sql++; report({ kind: 'sql', text });
    if (text.startsWith('DELETE FROM')) { report({kind:'prune-start'}); await sleep(200); report({kind:'prune-done'}); } if (mode === 'session-fail') throw Error('secret-session');
    if (realSockets && text.startsWith('SELECT sess')) return {rows:[{sess:{cookie:{originalMaxAge:60000,expires:new Date(Date.now()+60000).toISOString(),httpOnly:true},passport:{user:'fixture-user'}}}]};
    return { rows: [] }; }
  async end() { report({ kind: 'close', resource: 'session' }); }
}
const express = require('express');
const routes = express.Router();
routes.get('/slow', async (req, res) => {
  report({ kind: 'http-start' });
  await sleep(200);
  report({ kind: 'http-done' });
  res.json({ ok: true });
});
routes.get('/stream', (req,res) => {
  res.write('first chunk');
  const timer=setInterval(()=>res.write('more'),10);
  res.once('close',()=>{clearInterval(timer);report({kind:'stream-closed'});});
});
routes.get('/real-state', (req,res)=> { global.socketApi=req.app.get('campaignSockets'); res.json({users:global.socketApi.socketsByUser.size}); });
routes.get('/prune', (req, res) => { req.sessionStore.pruneSessions(); res.end(); });
routes.get('/pool-error', (req, res) => { global.pool.emit('error', Error('secret-session')); res.end(); });
routes.get('/sql-count', (req, res) => res.json({ sql }));
const empty = express.Router();
const original = Module._load;
Module._load = function(request, parent, isMain) {
  // Keep synthetic lifecycle fixtures independent of the owner's local .env.
  if (request === 'dotenv') return { config: () => ({ parsed: {} }) };
  const resolved = request.startsWith('.') ? Module._resolveFilename(request, parent) : request;
  if (resolved === path.join(root, 'src/db/index.js')) return db;
  if (request === 'socket.io') {
    const {Server}=original.call(this,request,parent,isMain);
    return {Server:class extends Server {
      constructor(server, ...args) {
        super(server,...args);
        const close=server.close;
        server.close=function(...closeArgs){report({kind:'http-close'}); return close.apply(this,closeArgs);};
        if (realSockets) process.nextTick(()=>this.on('connection',socket=>{
          socket.on('disconnect',async()=>{
            report({kind:'disconnect-start'});
            await sleep(200);
            report({kind:'disconnect-done',remaining:global.socketApi?.socketsByUser.size,rooms:socket.rooms.size});
          });
        }));
      }
    }};
  }
  if (request === 'pg') return { Pool };
  if (request === 'knex') throw Error('fixture refuses real database driver');
  if (resolved === path.join(root, 'src/routes/assets.js') && mode === 'import-fail') throw Error('secret-import');
  if (resolved === path.join(root, 'src/routes/assets.js')) return { router: empty };
  if (resolved === path.join(root, 'src/routes/media.js')) return { router: empty };
  if (resolved === path.join(root, 'src/routes/auth.js')) return routes;
  if (resolved === path.join(root, 'src/routes/campaigns.js')) return { router: empty, SOFT_DELETE_DAYS: 30 };
  if (resolved === path.join(root, 'src/config/passport.js')) return { initialize: () => (req,res,next) => next(), session: () => (req,res,next) => {
    if (realSockets && req.session?.passport) req.user={id:'fixture-user',username:'fixture'};
    if (mode === 'callback-slow' && req.url.includes('/slow')) {
      report({kind:'callback-start'}); setTimeout(()=>{report({kind:'callback-done'}); next();},200);
    } else next();
  } };
  if (realSockets && resolved === path.join(root, 'src/middleware/campaignAuth.js')) return {isActiveMember:async()=>{report({kind:'member-start'});await sleep(200);report({kind:'member-done'});return true;}};
  if (realSockets && resolved === path.join(root, 'src/services/mediaGateway.js')) return {rewritePayload:async()=>{}};
  if (realSockets && resolved === path.join(root, 'src/routes/scenes.js')) return {};
  if (resolved === path.join(root, 'src/services/storageBudget.js')) return {};
  if (resolved === path.join(root, 'src/services/staleAssetCleanup.js')) return { cleanupStaleAssets: async () => {
    report({ kind: 'job-start' });
    if (mode === 'job-stuck') await new Promise(() => {});
    await sleep(200); report({ kind: 'job-done' });
  } };
  if (resolved === path.join(root, 'src/services/storageCleanup.js')) return { tick: async () => {} };
  if (!realSockets && resolved === path.join(root, 'src/socket.js')) return { initSockets(io) {
    io.on('connection', socket => {
      socket.use(async (packet, next) => { report({ kind: 'packet-start' }); await sleep(30); next(); });
      socket.on('work', async () => { report({ kind: 'socket-start' }); await sleep(200); report({ kind: 'socket-done' }); });
    });
    return {};
  } };
  return original.call(this, request, parent, isMain);
};
process.env.NODE_ENV = mode === 'env-fail' ? 'unknown-value-sentinel' : 'production';
process.env.BASE_URL = mode === 'base-fail' ? 'http://base-value-sentinel.invalid' : 'https://fixture.invalid';
if (mode === 'storage-fail') process.env.R2_ACCOUNT_ID='storage-value-sentinel';
process.env.DATABASE_URL = 'postgresql://fixture:fixture@ep-fixture-pooler.us.aws.neon.tech/fixture';
process.env.SESSION_SECRET = mode === 'config-fail' ? '' : 'fixture-only-not-a-real-secret-123456';
require(path.join(root, 'src/server'));
