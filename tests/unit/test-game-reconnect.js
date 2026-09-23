const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { rootPath } = require('../helpers/paths');
let passed = 0;
const tick = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
function setup() {
  const timers = new Map(); let next = 0;
  const window = {
    setTimeout(fn) { timers.set(++next, fn); return next; },
    clearTimeout(id) { timers.delete(id); },
    dispatchEvent() {}, CustomEvent: class {},
  };
  vm.runInNewContext(fs.readFileSync(rootPath('public/js/shared/common.js'), 'utf8'), { window });
  const listeners = new Map(); const acks = [];
  const socket = {
    connected: false,
    on(e, f) { if (!listeners.has(e)) listeners.set(e, new Set()); listeners.get(e).add(f); },
    off(e, f) { listeners.get(e)?.delete(f); },
    emit(e, data, ack) { assert.equal(e, 'campaign:join'); acks.push({ data, ack }); },
    fire(e, data) { if (e === 'connect') this.connected = true; if (e === 'disconnect') this.connected = false; for (const f of listeners.get(e) || []) f(data); },
  };
  return { C: window.VTTCommon, socket, acks, timers, state: () => window.VTTCommon.connectionStates()[0] };
}
async function test(name, body) { await body(); passed++; console.log('ok ' + name); }
(async () => {
  await test('disconnected clients do not buffer room joins; connected joins deduplicate', async () => {
    const x = setup(); let refreshed = 0;
    const c = x.C.watchCampaignSocket('scene', x.socket, () => 'C', async () => refreshed++);
    c.join(); assert.equal(x.acks.length, 0);
    x.socket.fire('connect'); c.join(); assert.equal(x.acks.length, 1);
    assert.equal(refreshed, 0); x.acks[0].ack({ ok: true }); await tick();
    assert.equal(refreshed, 1); assert.equal(x.state(), 'ready');
  });
  await test('a reconnect re-enters the room and refreshes independently', async () => {
    const x = setup(); let refreshed = 0;
    x.C.watchCampaignSocket('scene', x.socket, () => 'C', async () => refreshed++);
    x.socket.fire('connect'); x.acks[0].ack({ ok: true }); await tick();
    x.socket.fire('disconnect'); assert.equal(x.state(), 'disconnected');
    x.socket.fire('connect'); x.acks[1].ack({ ok: true }); await tick();
    assert.equal(refreshed, 2); assert.equal(x.state(), 'ready');
  });
  await test('late acknowledgements from an old connection cannot admit the new one', async () => {
    const x = setup(); let refreshed = 0;
    x.C.watchCampaignSocket('scene', x.socket, () => 'C', async () => refreshed++);
    x.socket.fire('connect'); x.socket.fire('disconnect'); x.socket.fire('connect');
    x.acks[0].ack({ ok: true }); await tick();
    assert.equal(refreshed, 0); assert.equal(x.state(), 'joining');
    x.acks[1].ack({ ok: true }); await tick(); assert.equal(refreshed, 1);
  });
  await test('refusal does not load state or announce readiness', async () => {
    const x = setup(); let refreshed = 0;
    x.C.watchCampaignSocket('scene', x.socket, () => 'C', async () => refreshed++);
    x.socket.fire('connect'); x.acks[0].ack({ ok: false }); await tick();
    assert.equal(refreshed, 0); assert.equal(x.state(), 'blocked');
  });
  await test('join timeout is bounded and ignores late success', async () => {
    const x = setup(); let refreshed = 0;
    x.C.watchCampaignSocket('scene', x.socket, () => 'C', async () => refreshed++);
    x.socket.fire('connect'); [...x.timers.values()][0]();
    x.acks[0].ack({ ok: true }); await tick();
    assert.equal(refreshed, 0); assert.equal(x.state(), 'failed');
  });
  await test('refresh failure remains visible and handles its rejection', async () => {
    const x = setup();
    x.C.watchCampaignSocket('scene', x.socket, () => 'C', async () => { throw new Error('network'); });
    x.socket.fire('connect'); x.acks[0].ack({ ok: true }); await tick();
    assert.equal(x.state(), 'failed');
  });
  await test('new snapshot waits for old work; old completion cannot set ready', async () => {
    const x = setup(); const resolvers = [];
    x.C.watchCampaignSocket('scene', x.socket, () => 'C', () => new Promise(resolve => resolvers.push(resolve)));
    x.socket.fire('connect'); x.acks[0].ack({ ok: true }); await tick();
    x.socket.fire('disconnect'); x.socket.fire('connect'); x.acks[1].ack({ ok: true }); await tick();
    assert.equal(resolvers.length, 1); resolvers[0](); await tick();
    assert.equal(resolvers.length, 2); assert.equal(x.state(), 'recovering');
    resolvers[1](); await tick(); assert.equal(x.state(), 'ready');
  });
  await test('eviction during refresh cannot be overwritten by its completion', async () => {
    const x = setup(); let finish;
    x.C.watchCampaignSocket('scene', x.socket, () => 'C', () => new Promise(resolve => { finish = resolve; }));
    x.socket.fire('connect'); x.acks[0].ack({ ok: true }); await tick();
    x.socket.fire('campaign:evicted', { campaign_id: 'other' }); assert.equal(x.state(), 'recovering');
    x.socket.fire('campaign:evicted', { campaign_id: 'C' }); finish(); await tick();
    assert.equal(x.state(), 'blocked');
  });
  await test('replacing a connection disposes old listeners and acknowledgements', async () => {
    const x = setup(); let old = 0, current = 0;
    x.C.watchCampaignSocket('scene', x.socket, () => 'C', async () => old++);
    x.socket.fire('connect');
    x.C.watchCampaignSocket('scene', x.socket, () => 'C', async () => current++);
    x.acks[0].ack({ ok: true }); x.acks[1].ack({ ok: true }); await tick();
    assert.equal(old, 0); assert.equal(current, 1); assert.equal(x.C.connectionStates().length, 1);
  });
  console.log(`\n${passed} passed, 0 failed`);
})().catch(error => { console.error(error); console.log(`\n${passed} passed, 1 failed`); process.exitCode = 1; });
