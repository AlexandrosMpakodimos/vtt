// Child-only harness: real Socket.IO, production socket handlers, Redis client
// and PostgreSQL. Only the login handshake and media storage boundary are synthetic.
if (process.env.NODE_ENV !== 'test' || !process.send || !/^coord_test_[a-f0-9]{24}$/.test(process.env.COORD_TEST_SCHEMA || '')) throw Error('Child fixture refused');
const path = require('node:path');
const http = require('node:http');
const { Server } = require('socket.io');
const { createBus } = require('../../../src/coordination/bus');
const { createCoordinatedSockets } = require('../../../src/coordination/sockets');
const { configuration } = require('../../../src/coordination/config');
const base = require('../../../knexfile').test;
const config = { ...base, connection: { ...base.connection, application_name: process.env.COORD_TEST_SCHEMA + '-' + process.env.COORD_TEST_NODE }, pool: { ...base.pool, afterCreate(client, done) {
  base.pool.afterCreate(client, error => {
    if (error) return done(error, client);
    client.query(`SET search_path TO "${process.env.COORD_TEST_SCHEMA}"`, err => done(err, client));
  });
} } };
const db = require('knex')(config);
require.cache[require.resolve('../../../src/db')] = { id: require.resolve('../../../src/db'), filename: require.resolve('../../../src/db'), loaded: true, exports: db };
const gatewayPath = require.resolve('../../../src/services/mediaGateway');
require.cache[gatewayPath] = { id: gatewayPath, filename: gatewayPath, loaded: true, exports: { rewritePayload: async()=>{} } };
const { initSockets } = require('../../../src/socket');
const server = http.createServer();
const io = new Server(server, { transports: ['websocket'] });
let stopping, failed = false;
const active = new Set();
function track(promise) {
  if (promise?.then) { active.add(promise); promise.then(()=>active.delete(promise),()=>active.delete(promise)); }
  return promise;
}
const lifecycle = { state: 'ready', track };
const bus = createBus({ ...configuration(process.env), onFailure() {
  failed = true;
  for (const socket of io.sockets.sockets.values()) socket.conn.close();
  process.send?.({ type: 'failed' });
  stop(1);
} });
const coordination = createCoordinatedSockets({ io, knex: db, bus, workLifecycle: lifecycle, rewritePayload: async()=>{} });
io.use((socket,next)=>{
  const auth=socket.handshake.auth;
  socket.request.user={id:auth.userId,username:'coord-fixture'};
  socket.request.sessionID=auth.sid;
  socket.request.sessionStore={get(sid,callback){track(db('session').where({sid}).where('expire','>',db.fn.now()).first().then(row=>callback(null,row?.sess),error=>callback(error)));}};
  next();
});
const api = initSockets(io,lifecycle,coordination);
async function stop(code=0) {
  if(stopping)return stopping;
  lifecycle.state='stopping';
  const deadline=setTimeout(()=>process.exit(1),7000);
  stopping=(async()=>{
    await coordination.stop();
    await new Promise(resolve=>io.close(resolve));
    await Promise.allSettled([...active]);
    await db.destroy();
    clearTimeout(deadline);process.exit(code);
  })();return stopping;
}
process.on('message',message=>{
  if(message.method==='stop')return stop();
  const allowed=new Set(['broadcastRoom','broadcastToOwner','broadcastToPlayers','broadcastScene','broadcastScenePlayers','broadcastToUsers','broadcastLobby','evictUser','evictCampaign','evictGamePlayers','disconnectSessions']);
  if(!allowed.has(message.method))return;
  track(Promise.resolve().then(()=>api[message.method](...message.args))).then(
    ()=>process.send?.({type:'reply',id:message.id,ok:true}),
    ()=>process.send?.({type:'reply',id:message.id,ok:false}),
  );
});
process.on('SIGTERM',()=>stop());
process.on('disconnect',()=>stop(1));
(async()=>{
  await db.raw('SELECT 1');await coordination.start();
  if(failed)return;
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  process.send?.({type:'ready',port:server.address().port});
})().catch(()=>{console.error('COORDINATION_FIXTURE_START_FAILED');stop(1);});
