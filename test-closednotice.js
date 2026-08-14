// The closed-campaign notice. jsdom only:
//     node test-closednotice.js
//
// A small module, and worth probing for one reason: the thing it must NOT do is
// harder than the thing it must. Telling a player "this game is closed" when the
// game is open and they simply are not the GM would be worse than saying
// nothing at all — it would send them to ask the GM to open a table that is
// already open.
//
// So the interesting probes are the false-positive ones.

const { JSDOM } = require('jsdom');
const fs = require('fs');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  runScripts: 'outside-only',
  url: 'http://localhost:3000/scene.html',
});
const { window } = dom;
const { document } = window;

let pass = 0; let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL  ${name}  ${extra}`); }
};

window.eval(fs.readFileSync('public/js/closednotice.js', 'utf8'));
const N = window.VTTClosedNotice;
const banner = () => document.querySelector('.vtt-closed-notice');
const visible = () => !!banner() && banner().style.display === 'block';

console.log('\n--- the module loads ---');
t('VTTClosedNotice is defined', !!N);
t('check, show and hide are functions',
  typeof N.check === 'function' && typeof N.show === 'function' && typeof N.hide === 'function');
t('nothing is added to the page until it is needed', banner() === null);

console.log('\n--- it fires on a closed-campaign refusal ---');
const closed = { status: 403, data: { error: 'this campaign is closed — the GM has not opened the game' } };
t('check reports a closed refusal', N.check(closed) === true);
t('...and shows the banner', visible(), banner() && banner().style.display);
t('...carrying the server\'s own words',
  /has not opened/.test(banner().textContent), banner().textContent);
t('...and saying plainly what is wrong',
  /This game is closed/.test(banner().textContent), banner().textContent);

console.log('\n--- what it must NOT do ---');
// 403 is also what a player gets for a GM-only action on an OPEN campaign.
// Matching on status alone would tell them the game is closed when it is not.
N.hide();
const gmOnly = { status: 403, data: { error: 'only the GM may upload a map' } };
t('a GM-only refusal is NOT reported as closed', N.check(gmOnly) === false);
t('...and shows no banner', !visible(), banner().style.display);

const forbidden = { status: 403, data: { error: 'forbidden' } };
t('a bare 403 is not assumed to be closure', N.check(forbidden) === false);
t('a 404 is not', N.check({ status: 404, data: { error: 'campaign not found' } }) === false);
t('a 200 is not', N.check({ status: 200, data: {} }) === false);
t('a malformed response does not throw', N.check(null) === false && N.check({}) === false);
t('a 403 with no body does not throw', N.check({ status: 403 }) === false);

console.log('\n--- the message is inserted as TEXT ---');
// The string comes from the server. A banner is not a reason to relax the rule
// the rest of this client follows.
N.hide();
N.check({ status: 403, data: { error: 'closed <img src=x onerror=alert(1)>' } });
t('markup in the message is not parsed',
  banner().querySelector('img') === null, banner().innerHTML.slice(0, 60));
t('...and appears as literal text',
  /<img/.test(banner().textContent), banner().textContent.slice(0, 60));

console.log('\n--- dismissal ---');
N.check(closed);
t('the banner is showing again', visible());
banner().querySelector('.x').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
t('clicking the close control hides it', !visible(), banner().style.display);
// It must come back: somebody who dismissed it and then clicked something else
// should be told again rather than left wondering why nothing happened.
N.check(closed);
t('...and the next refusal brings it back', visible());

console.log('\n--- it clears itself when the game reopens ---');
// api() hides the banner on any successful response, which is what makes the
// notice disappear the moment the GM opens the table rather than lingering
// until a reload.
N.hide();
t('hide() clears it', !visible());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
