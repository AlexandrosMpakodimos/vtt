// Loopback-only fixture; real Express middleware and Redis backend, no database.
const express = require('express');
const { createBackend } = require('../../../src/rateLimit/backend');
const { proxyHops } = require('../../../src/config/proxy');
const limits = require('../../../src/middleware/rateLimit');
const backend = createBackend({ url: process.env.COORDINATION_URL,
  prefix: process.env.COORDINATION_PREFIX, secret: process.env.SESSION_SECRET });
limits.configureBackend(backend);
const app = express();
app.set('trust proxy', proxyHops(process.env));
app.get('/login', limits.loginLimiter, (req,res) => res.json({ok:true}));
app.get('/register', limits.registerLimiter, (req,res) => res.json({ok:true}));
app.use((e,req,res,next) => res.status(e.status || 500).json({error:'unavailable'}));
let server;
process.on('SIGTERM', () => { limits.stop(); server?.closeAllConnections(); server?.close(()=>process.exit(0)); });
backend.start().then(() => {
  server=app.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
}).catch(()=>{limits.stop();console.error('FIXTURE_START_FAILED');process.exitCode=1;});
