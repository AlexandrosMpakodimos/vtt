// Image picker — jsdom suite. No server, no database, no bucket:
//     node test-imagepicker.js
//
// public/js/imagepicker.js is a new client file, and this project has twice
// shipped a client file with no runtime coverage and had it break silently —
// combat.js lost a function to an edit, and actors.js was one edit away from
// the same. A shared module is worse than either, because it has three call
// sites and a defect reaches all of them at once.
//
// The picker is also the only place the three-step upload conversation now
// lives, so it carries the logic that used to be duplicated. That makes it
// worth probing for what it SENDS as much as for what it renders.

const { JSDOM } = require('jsdom');
const fs = require('fs');

const dom = new JSDOM(`<!DOCTYPE html><html><body>
  <input id="target" value="" />
  <input id="second" value="" />
</body></html>`, { runScripts: 'outside-only', url: 'http://localhost:3000/x.html' });
const { window } = dom;
const { document } = window;

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

const calls = [];
let presignStatus = 201;
window.fetch = async (path, opts = {}) => {
  const method = opts.method || 'GET';
  calls.push({ path, method, body: opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : null });
  const json = async () => {
    if (/\/api\/assets\?campaign_id=/.test(path)) {
      return {
        assets: [
          { id: 'A1', url: 'https://pub-x.r2.dev/c/C1/portrait/a.png', source: 'upload', kind: 'portrait' },
          { id: 'A2', url: 'https://elsewhere.example/b.png', source: 'external', kind: 'map' },
        ],
      };
    }
    if (/\/api\/assets$/.test(path)) {
      return { assets: [{ id: 'A3', url: 'https://pub-x.r2.dev/u/U1/avatar/me.png', source: 'upload', kind: 'avatar' }] };
    }
    if (/presign$/.test(path)) {
      return {
        asset: { id: 'NEW', status: 'pending' },
        upload: { url: 'https://bucket.example/put', method: 'PUT', headers: { 'Content-Type': 'image/png' } },
      };
    }
    if (/confirm$/.test(path)) return { asset: { id: 'NEW', url: 'https://pub-x.r2.dev/c/C1/portrait/new.png' } };
    if (/external$/.test(path)) return { asset: { id: 'EXT', url: 'https://elsewhere.example/pasted.png' } };
    return {};
  };
  if (/\/put$/.test(path)) return { ok: true, status: 200, json };
  return { status: /presign$|external$/.test(path) ? presignStatus : 200, json };
};

window.eval(fs.readFileSync('public/js/imagepicker.js', 'utf8'));
const P = window.VTTImagePicker;

console.log('\n--- the module loads and exposes its surface ---');
t('VTTImagePicker is defined', !!P);
t('open is a function', typeof P.open === 'function');
t('attach is a function', typeof P.attach === 'function');
// Compare against the SERVER's live allow-list rather than a hardcoded string,
// so this stays correct as kinds are added (e.g. cover). The picker clamps
// unknown kinds to 'portrait', so any divergence from the server would silently
// break a real kind — hence asserting they are identical.
const serverKinds = require('./src/services/storage.js').KINDS;
t('the kinds match the server allow-list',
  P.KINDS.slice().sort().join(',') === serverKinds.slice().sort().join(','),
  `picker=[${P.KINDS.join(',')}] server=[${serverKinds.join(',')}]`);

console.log('\n--- attach adds a button WITHOUT touching the page markup ---');
// The picker builds its own DOM precisely so that pages covered by jsdom
// assertions do not need new elements. Attaching must add exactly one button
// beside the field and change nothing else.
const before = document.body.querySelectorAll('input').length;
const btn = P.attach('target', { campaignId: 'C1', kind: 'portrait' });
t('a button is returned', !!btn);
t('...placed immediately after the field',
  document.getElementById('target').nextElementSibling === btn);
t('...and no input was added or removed',
  document.body.querySelectorAll('input').length === before);
t('attach is idempotent — a second call adds nothing',
  P.attach('target', { campaignId: 'C1', kind: 'portrait' }) === null
    && document.querySelectorAll('.vttpick-open').length === 1,
  String(document.querySelectorAll('.vttpick-open').length));
t('attaching to a missing element is a no-op, not a throw',
  P.attach('does-not-exist', { campaignId: 'C1', kind: 'portrait' }) === null);

console.log('\n--- the modal is built on first open, not at load ---');
t('no modal exists before opening', document.querySelector('.vttpick-back') === null);
btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const back = document.querySelector('.vttpick-back');
t('the modal exists after opening', !!back);
t('...and is visible', back.classList.contains('on'));
t('the file input excludes SVG', !back.querySelector('.vttpick-file').accept.includes('svg'),
  back.querySelector('.vttpick-file').accept);
t('...offering exactly the four allowed types',
  back.querySelector('.vttpick-file').accept.split(',').length === 4);

(async () => {
  await new Promise((r) => setTimeout(r, 10));

  console.log('\n--- it lists both quota scopes ---');
  const items = [...document.querySelectorAll('.vttpick-item')];
  t('campaign images and personal ones are both offered', items.length === 3, String(items.length));
  t('...fetched as two separate requests, because they are two separate scopes',
    calls.filter((c) => /\/api\/assets/.test(c.path) && c.method === 'GET').length === 2,
    calls.filter((c) => /\/api\/assets/.test(c.path)).map((c) => c.path).join(' | '));
  t('an external image is marked as such',
    items.some((i) => i.classList.contains('external')));
  t('...and suppresses the referrer',
    items.find((i) => i.classList.contains('external')).querySelector('img').referrerPolicy === 'no-referrer');
  t('a hosted image does not need to',
    !items.find((i) => !i.classList.contains('external')).querySelector('img').referrerPolicy);

  console.log('\n--- choosing fills the field and fires events ---');
  // Events matter: anything listening for edits — a live preview, a dirty flag —
  // must react exactly as it would to typing.
  let inputFired = 0; let changeFired = 0;
  const target = document.getElementById('target');
  target.addEventListener('input', () => { inputFired += 1; });
  target.addEventListener('change', () => { changeFired += 1; });

  items[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  t('the field receives the url',
    target.value === 'https://pub-x.r2.dev/c/C1/portrait/a.png', target.value);
  t('an input event fires', inputFired === 1, String(inputFired));
  t('a change event fires', changeFired === 1, String(changeFired));
  t('the modal closes after choosing', !back.classList.contains('on'));

  console.log('\n--- clearing the field is a supported choice ---');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  [...back.querySelectorAll('button')].find((b) => b.textContent === 'Clear the field')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  t('choosing "clear" empties the field', target.value === '', target.value);
  t('...and still fires the events', inputFired === 2 && changeFired === 2);

  console.log('\n--- the upload conversation, in the order the server expects ---');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  calls.length = 0;

  const fileInput = back.querySelector('.vttpick-file');
  // jsdom cannot populate a file input, so the FileList is substituted. What is
  // under test is the CONVERSATION — which requests, in which order, with what
  // body — not the browser's file plumbing.
  Object.defineProperty(fileInput, 'files', {
    configurable: true,
    value: [{ name: 'a.png', type: 'image/png', size: 4096 }],
  });
  [...back.querySelectorAll('button')].find((b) => b.textContent === 'Upload')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));

  const seq = calls.map((c) => `${c.method} ${c.path.replace(/^https?:\/\/[^/]+/, '')}`);
  t('presign, then the bucket, then confirm — in that order',
    /presign/.test(seq[0]) && /\/put/.test(seq[1]) && /confirm/.test(seq[2]),
    seq.join(' → '));
  const presignBody = calls[0].body;
  t('the declared size is sent, not guessed', presignBody.bytes === 4096);
  t('the declared type is sent', presignBody.mime === 'image/png');
  t('the campaign is sent for a campaign-scoped kind', presignBody.campaign_id === 'C1');
  t('the bytes go to the BUCKET, not to this server',
    calls[1].path === 'https://bucket.example/put', calls[1].path);
  t('the uploaded image is chosen immediately',
    target.value === 'https://pub-x.r2.dev/c/C1/portrait/new.png', target.value);

  console.log('\n--- an avatar is personal and carries no campaign ---');
  P.open({ campaignId: 'C1', kind: 'avatar', onChoose: () => {} });
  await new Promise((r) => setTimeout(r, 10));
  calls.length = 0;
  const linkInput = back.querySelector('.vttpick-link');
  linkInput.value = 'https://elsewhere.example/pasted.png';
  [...back.querySelectorAll('button')].find((b) => b.textContent === 'Add URL')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const extCall = calls.find((c) => /external$/.test(c.path));
  t('a link request is sent', !!extCall);
  t('...with kind avatar', extCall && extCall.body.kind === 'avatar');
  t('...and NO campaign_id, because the scopes are exclusive',
    extCall && !('campaign_id' in extCall.body), JSON.stringify(extCall && extCall.body));

  console.log('\n--- storage being unconfigured is reported, not swallowed ---');
  presignStatus = 503;
  P.open({ campaignId: 'C1', kind: 'portrait', onChoose: () => {} });
  await new Promise((r) => setTimeout(r, 10));
  const f2 = back.querySelector('.vttpick-file');
  Object.defineProperty(f2, 'files', {
    configurable: true, value: [{ name: 'a.png', type: 'image/png', size: 10 }],
  });
  [...back.querySelectorAll('button')].find((b) => b.textContent === 'Upload')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  t('a 503 tells the user to paste a link instead',
    /not configured/.test(back.querySelector('.msg').textContent),
    back.querySelector('.msg').textContent);
  presignStatus = 201;

  console.log('\n--- dismissal ---');
  P.open({ campaignId: 'C1', kind: 'portrait', onChoose: () => {} });
  await new Promise((r) => setTimeout(r, 10));
  t('the modal is open', back.classList.contains('on'));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  t('Escape closes it', !back.classList.contains('on'));

  P.open({ campaignId: 'C1', kind: 'portrait', onChoose: () => {} });
  await new Promise((r) => setTimeout(r, 10));
  back.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  t('clicking the backdrop closes it', !back.classList.contains('on'));

  P.open({ campaignId: 'C1', kind: 'portrait', onChoose: () => {} });
  await new Promise((r) => setTimeout(r, 10));
  back.querySelector('.vttpick').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  t('...but clicking the panel does NOT', back.classList.contains('on'));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  console.log('\n--- inside a modal dialog (top layer) ---');
  // A <dialog> opened modally lives in the top layer; a fixed overlay on <body>
  // would render behind it. The picker must mount INTO the open dialog instead,
  // and isOpen() must report its state for the dialog's cancel buckle.
  t('isOpen() is false before opening', P.isOpen() === false);
  const dlg = document.createElement('dialog');
  dlg.id = 'hostDialog';
  document.body.appendChild(dlg);
  dlg.setAttribute('open', '');   // jsdom has no showModal; [open] stands in
  P.open({ campaignId: 'C1', kind: 'portrait', onChoose: () => {} });
  await new Promise((r) => setTimeout(r, 10));
  t('the picker mounts inside the open dialog, not <body>', back.parentNode === dlg,
    back.parentNode && back.parentNode.tagName);
  t('isOpen() is true while shown', P.isOpen() === true);
  // Escape must close ONLY the picker; the host dialog stays open. We assert the
  // keydown default is prevented (so the dialog's cancel is buckled) and the
  // dialog is still open afterwards.
  const escEvt = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  document.dispatchEvent(escEvt);
  t('Escape closes the picker', back.classList.contains('on') === false);
  t('...and its default was prevented (buckles the dialog cancel)', escEvt.defaultPrevented === true);
  t('...leaving the host dialog open', dlg.hasAttribute('open') === true);
  t('isOpen() is false again after close', P.isOpen() === false);
  // A subsequent open with no dialog present falls back to <body>.
  dlg.removeAttribute('open');
  document.body.removeChild(dlg);
  P.open({ campaignId: 'C1', kind: 'portrait', onChoose: () => {} });
  await new Promise((r) => setTimeout(r, 10));
  t('with no open dialog, the picker falls back to <body>', back.parentNode === document.body,
    back.parentNode && back.parentNode.tagName);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  console.log('\n--- every stored image (hosted or pasted-link) can be deleted from the grid ---');
  P.open({ campaignId: 'C1', kind: 'portrait', onChoose: () => {} });
  await new Promise((r) => setTimeout(r, 10));
  {
    const gridItems = [...document.querySelectorAll('.vttpick-item')];
    const hostedItems = gridItems.filter((i) => !i.classList.contains('external'));
    const externalItem = gridItems.find((i) => i.classList.contains('external'));
    t('every hosted image has a delete control', hostedItems.length > 0 && hostedItems.every((i) => i.querySelector('.vttpick-del')));
    t('an external (pasted-link) image now has one too', externalItem && !!externalItem.querySelector('.vttpick-del'));

    // Deleting must not "choose" the image (no field fill).
    const tgt = document.getElementById('target');
    if (tgt) tgt.value = 'UNCHANGED';
    calls.length = 0;
    const before = document.querySelectorAll('.vttpick-item').length;
    hostedItems[0].querySelector('.vttpick-del').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    t('clicking the ✕ DELETEs that asset by id',
      calls.some((c) => c.method === 'DELETE' && /\/api\/assets\/A1$/.test(c.path)),
      calls.map((c) => c.method + ' ' + c.path).join(' | '));
    t('...and removes the tile from the grid',
      document.querySelectorAll('.vttpick-item').length === before - 1,
      String(document.querySelectorAll('.vttpick-item').length));
    t('...without choosing the image (field untouched)', !tgt || tgt.value === 'UNCHANGED', tgt && tgt.value);

    // External (pasted-link) images are real rows too — deleting one DELETEs it.
    calls.length = 0;
    const ext = [...document.querySelectorAll('.vttpick-item')].find((i) => i.classList.contains('external'));
    ext.querySelector('.vttpick-del').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    t('deleting an external image DELETEs it by id too',
      calls.some((c) => c.method === 'DELETE' && /\/api\/assets\/A2$/.test(c.path)),
      calls.map((c) => c.method + ' ' + c.path).join(' | '));
  }
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  console.log('\n--- the image currently in use is marked ---');
  // Open with `current` set to a known asset URL → that tile gets .current.
  P.open({ campaignId: 'C1', kind: 'portrait', current: 'https://pub-x.r2.dev/c/C1/portrait/a.png', onChoose: () => {} });
  await new Promise((r) => setTimeout(r, 10));
  {
    const marked = [...document.querySelectorAll('.vttpick-item.current')];
    t('exactly one tile is marked current', marked.length === 1, String(marked.length));
    t('...and it is the one whose url matches',
      marked[0] && marked[0].querySelector('img').src === 'https://pub-x.r2.dev/c/C1/portrait/a.png',
      marked[0] && marked[0].querySelector('img').src);
    // With no current set, nothing is marked.
    P.open({ campaignId: 'C1', kind: 'portrait', onChoose: () => {} });
  }
  await new Promise((r) => setTimeout(r, 10));
  t('with no current value, no tile is marked', document.querySelectorAll('.vttpick-item.current').length === 0);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
