// Real-time event coverage — do the two halves of the socket layer agree?
//
//     node test-events.js
//
// No server, no database, no browser: this reads the SOURCE of both sides and
// compares them.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// The server emits an event; a client handles it. Nothing has ever checked that
// the two lists agree, and they did not:
//
//   - `scene:updated` was added for live grid re-alignment and NO client ever
//     handled it. The patch was reported as applied, the handler was not in the
//     file, and the map simply did not update until reload. Nobody noticed for
//     days, because a missing handler is silence — there is no error, no failed
//     request, and no failing assertion.
//   - `actor:updated` had been broadcast since M4 and no canvas listened. A
//     character edit reached the character page and stopped there. That was half
//     of the "token images do not update" report; fixing the underlying copy
//     alone would not have fixed the symptom.
//
// Both are the same shape as the wrong-half probe and the one-directional
// reconciliation script recorded elsewhere in this project: **two parts that
// must agree, and nothing asserting that they do.**
//
// This is a crude textual check and it is deliberately crude. It cannot tell
// whether a handler is CORRECT — only whether one exists. That is precisely the
// failure it is built for, because both defects above were absences rather than
// mistakes.

const fs = require('fs');
const path = require('path');

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

const read = (p) => fs.readFileSync(p, 'utf8');
const strip = (src) => src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ---- what the server emits -------------------------------------------------
const serverFiles = [
  ...fs.readdirSync('src/routes').filter((f) => f.endsWith('.js')).map((f) => path.join('src/routes', f)),
  'src/socket.js',
];
const emitted = new Set();
for (const f of serverFiles) {
  const code = strip(read(f));
  // The event name sits at a DIFFERENT ARGUMENT POSITION depending on the
  // helper — broadcastRoom(id, event, payload) has one argument before it,
  // broadcastScene(id, sceneId, event, payload) has two. The first version of
  // this probe allowed only one and therefore missed twelve real emits, which
  // then showed up as "phantom" handlers on the other side. A probe that
  // mis-parses one half invents a discrepancy in the other.
  for (const m of code.matchAll(/(?:broadcast\w*|\.emit)\(\s*(?:[^,()]+,\s*){0,3}'([a-z]+:[a-z-]+)'/g)) {
    emitted.add(m[1]);
  }
  // A third idiom: the event name as a DEFAULT PARAMETER, then passed through
  // as a variable — `broadcastItem(req, item, event = 'item:updated')`. The
  // call site carries no literal at all, so scanning calls alone reported two
  // real events as phantom handlers.
  for (const m of code.matchAll(/\bevent\s*=\s*'([a-z]+:[a-z-]+)'/g)) emitted.add(m[1]);
}

// ---- what the clients handle -----------------------------------------------
const clientFiles = fs.readdirSync('public/js')
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.join('public/js', f));
const handled = new Set();
for (const f of clientFiles) {
  const code = strip(read(f));
  for (const m of code.matchAll(/socket\.on\(\s*'([a-z]+:[a-z-]+)'/g)) handled.add(m[1]);
  // The loop form: `for (const ev of ['a:b','c:d']) socket.on(ev, ...)`
  for (const m of code.matchAll(/for\s*\(const ev of \[([^\]]+)\]/g)) {
    for (const q of m[1].matchAll(/'([a-z]+:[a-z-]+)'/g)) handled.add(q[1]);
  }
}

// Events a client SENDS to the server rather than receives. These legitimately
// appear on the emit side with no handler, because the direction is reversed.
const CLIENT_TO_SERVER = new Set(['campaign:join', 'token:move', 'token:move-batch']);

// [FOUND 2026-08-10] Server handlers that NO CLIENT CALLS. Recorded rather than
// removed: `campaign:leave` is a working, authorised handler for a message
// nothing sends — a client leaves a campaign over HTTP, and simply disconnects
// or navigates away from the room. It is dead weight rather than a defect, and
// it is listed here so that the absence is a recorded fact instead of an
// unexamined one. Deleting it is a decision for whoever next touches the socket
// layer; leaving it undocumented was how it stayed invisible.
const SERVER_HANDLERS_WITH_NO_CALLER = {
  'campaign:leave': 'clients leave over HTTP; room membership ends on disconnect',
};

// Events deliberately emitted with no client handler. Each needs a REASON, and
// the list is short on purpose — it is the escape hatch that would otherwise let
// this probe rot into meaninglessness.
const NO_HANDLER_BY_DESIGN = {
  'campaign:user-joined': 'presence, not yet surfaced anywhere in the harnesses',
  'campaign:user-left': 'presence, not yet surfaced anywhere in the harnesses',
  'actor:deleted': 'handled via the actor:* loop in actors.js; no canvas action is needed because token:unlinked carries the board change',
};

console.log('\n--- the two halves of the socket layer ---');
console.log(`  server emits ${emitted.size} event(s); clients handle ${handled.size}`);

const unhandled = [...emitted]
  .filter((e) => !handled.has(e))
  .filter((e) => !CLIENT_TO_SERVER.has(e))
  .filter((e) => !(e in NO_HANDLER_BY_DESIGN));

t('every event the server emits is handled somewhere, or excused',
  unhandled.length === 0,
  unhandled.length ? `unhandled: ${unhandled.join(', ')}` : '');

const phantom = [...handled].filter((e) => !emitted.has(e) && !CLIENT_TO_SERVER.has(e));
// A handler for an event nothing emits is dead code — usually a rename that
// updated one side.
t('no client handles an event the server never emits',
  phantom.length === 0, phantom.length ? `phantom: ${phantom.join(', ')}` : '');

console.log('\n--- the two events whose absence caused real defects ---');
t('scene:updated is emitted', emitted.has('scene:updated'));
t('scene:updated is handled — the map must repaint without a reload',
  handled.has('scene:updated'));
t('actor:updated is emitted', emitted.has('actor:updated'));
t('actor:updated is handled — token pictures are inherited, not copied',
  handled.has('actor:updated'));

console.log('\n--- the canvas handles what changes the board ---');
const sceneJs = strip(read('public/js/scene.js'));
for (const ev of ['token:created', 'token:updated', 'token:moved', 'token:deleted',
  'fog:created', 'fog:updated', 'fog:deleted',
  'scene:activated', 'scene:updated', 'actor:updated']) {
  t(`scene.js handles ${ev}`, sceneJs.includes(`socket.on('${ev}'`));
}

console.log('\n--- every excuse names an event that is actually emitted ---');
// The exclusion list must not become a place stale names accumulate: a renamed
// event would otherwise leave an excuse silencing a genuine gap.
const staleExcuses = Object.keys(NO_HANDLER_BY_DESIGN).filter((e) => !emitted.has(e));
t('no excused event has been renamed or removed',
  staleExcuses.length === 0, staleExcuses.join(', '));
// Client-to-server events are EMITTED BY CLIENTS, so their staleness has to be
// checked against the client source rather than the server's emit list — which
// is where the first version of this probe looked, and why it reported all four
// as stale.
const clientEmits = new Set();
for (const f of clientFiles) {
  for (const m of strip(read(f)).matchAll(/socket\.emit\(\s*'([a-z]+:[a-z-]+)'/g)) clientEmits.add(m[1]);
}
const staleClientSends = [...CLIENT_TO_SERVER].filter((e) => !clientEmits.has(e));
t('every client-to-server name is actually sent by a client',
  staleClientSends.length === 0, staleClientSends.join(', '));

console.log('\n--- server handlers nothing calls ---');
const socketJs = strip(read('src/socket.js'));
for (const [ev, why] of Object.entries(SERVER_HANDLERS_WITH_NO_CALLER)) {
  t(`${ev} is still handled server-side (${why})`, socketJs.includes(`socket.on('${ev}'`));
  t(`...and still has no client caller, as recorded`, !clientEmits.has(ev),
    'if a client now sends it, move it to CLIENT_TO_SERVER');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
