// Headless DOM tests for bulk token placement: compact packing, auto-numbering,
// size presets, edge clamping, and the single-vs-bulk endpoint split.
const { JSDOM } = require('jsdom'); const fs = require('fs');
const dom = new JSDOM(fs.readFileSync('public/scene.html','utf8'), { runScripts:'outside-only', url:'http://localhost:3000/scene.html' });
const { window } = dom; const { document } = window;
const calls = { fetch: [] };
window.__uid = 'GM';
window.fetch = async (path, opts) => {
  const call = { path, method: opts && opts.method, body: opts && opts.body ? JSON.parse(opts.body) : null };
  calls.fetch.push(call);
  if (window.__onFetch) window.__onFetch(call);
  // /api/auth/me drives whoami(); return whoever the test currently is, so the
  // load-time whoami() doesn't clobber the identity under test.
  // The character picker reads /actors. Two entries so the probe below can show
  // it renders from THIS endpoint rather than from the scene load's own actors
  // array — which holds only characters already on the board, and was the
  // source the first version wrongly used.
  return { status: 201, json: async () => ({
    user: { id: window.__uid }, tokens: [], token: {},
    actors: [
      // Belongs to whoever the test currently is, so the role filter can be
      // probed from both sides.
      { id: 'PA1', name: 'Aria', user_id: window.__uid, is_npc: false },
      { id: 'PA2', name: 'Goblin', user_id: 'GM', is_npc: true },
    ],
  }) };
};
window.io = () => ({ on(){}, emit(ev,p,cb){ if(cb) cb({ok:true}); } });
window.CSS = { escape: s => s };
window.PointerEvent = class extends window.MouseEvent { constructor(t,o={}){super(t,o);this.pointerId=o.pointerId||1;} };
window.Element.prototype.setPointerCapture=function(){}; window.Element.prototype.releasePointerCapture=function(){};
let pass=0, fail=0;
window.__check=(n,c,d='')=>{ if(c){pass++;console.log('  PASS  '+n);} else {fail++;console.log('  FAIL  '+n+'  '+d);} };
// The tests run inside the jsdom sandbox, which has no `process`. They signal
// completion here so the summary and exit code happen in Node scope.
window.__done=()=>{
  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail===0?0:1);
};
window.__calls = calls;

window.eval(fs.readFileSync('public/js/scene.js','utf8') + `
;(function(){
  const calls = window.__calls;
  campaignId='C'; scene={id:'S',width:1000,height:800,img_url:null};  // 20x16 grid
  currentCampaignOwnerId='GM'; me={id:'GM'};

  // Simple and robust: clear the log, click, wait long enough for the async
  // handler's fetch to land, read the last fetch. No promise hooks to race.
  // Re-assert identity on every placement: whoami() fires asynchronously on load
  // and would otherwise clobber a manually-set me. Setting it here (and keeping
  // window.__uid in sync so the /me stub agrees) makes each call deterministic.
  const asUser = (id) => { me = { id }; window.__uid = id; };
  asUser('GM');

  const place = async (name, count, size, cursor={x:0,y:0}) => {
    document.getElementById('tok-name').value = name;
    document.getElementById('tok-img').value = '';
    document.getElementById('tok-count').value = String(count);
    document.getElementById('tok-size').value = size;
    cursorGrid = cursor;
    me = { id: window.__uid };   // defeat any load-time whoami() that clobbered me
    calls.fetch.length = 0;
    document.getElementById('place-token').dispatchEvent(
      new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 80));
    const placement = calls.fetch.filter(c => c.path.includes('/tokens'));
    return placement[placement.length - 1];
  };

  (async () => {
    // --- single token uses the NORMAL placement endpoint (players can use it) ---
    let c = await place('Goblin', 1, 'medium', {x:3,y:4});
    __check('count=1 uses the normal /tokens endpoint',
      c && c.path.endsWith('/tokens') && !c.path.includes('copy'), c && c.path);
    __check('single token placed at the cursor', c && c.body.x === 3 && c.body.y === 4, JSON.stringify(c && c.body));
    __check('single token is NOT numbered', c && c.body.name === 'Goblin', c && c.body.name);

    // --- bulk uses the paste endpoint ---
    c = await place('Goblin', 6, 'medium', {x:0,y:0});
    __check('count>1 uses the /tokens/copy endpoint', c && c.path.includes('/tokens/copy'), c && c.path);
    __check('creates exactly N specs', c && c.body.tokens.length === 6, 'n='+(c&&c.body.tokens.length));

    // numbering: first bare, rest from 2
    const names = c.body.tokens.map(t => t.name);
    __check('first instance is unnumbered', names[0] === 'Goblin', names[0]);
    __check('extras numbered from 2', names.join(',') === 'Goblin,Goblin 2,Goblin 3,Goblin 4,Goblin 5,Goblin 6', names.join(','));

    // packing: 6 -> 3 cols x 2 rows, compact not a line
    const xs = c.body.tokens.map(t=>t.x), ys = c.body.tokens.map(t=>t.y);
    const width = Math.max(...xs) - Math.min(...xs) + 1;
    const height = Math.max(...ys) - Math.min(...ys) + 1;
    __check('6 tokens pack into a 3x2 block (not a line)', width === 3 && height === 2, width+'x'+height);

    c = await place('Orc', 9, 'medium', {x:0,y:0});
    const xs9 = c.body.tokens.map(t=>t.x), ys9 = c.body.tokens.map(t=>t.y);
    __check('9 tokens pack into a 3x3 square',
      (Math.max(...xs9)-Math.min(...xs9)+1) === 3 && (Math.max(...ys9)-Math.min(...ys9)+1) === 3);

    c = await place('Rat', 4, 'medium', {x:0,y:0});
    const xs4 = c.body.tokens.map(t=>t.x), ys4 = c.body.tokens.map(t=>t.y);
    __check('4 tokens pack into a 2x2 square',
      (Math.max(...xs4)-Math.min(...xs4)+1) === 2 && (Math.max(...ys4)-Math.min(...ys4)+1) === 2);

    // no two tokens share a cell
    c = await place('Kobold', 12, 'medium', {x:0,y:0});
    const cells = new Set(c.body.tokens.map(t => t.x+','+t.y));
    __check('12 tokens never overlap', cells.size === 12, 'unique='+cells.size);

    // --- size presets drive footprint AND spacing ---
    c = await place('Ogre', 4, 'large', {x:0,y:0});
    __check('large tokens are 2x2 each', c.body.tokens.every(t => t.width === 2 && t.height === 2));
    const lx = [...new Set(c.body.tokens.map(t=>t.x))].sort((a,b)=>a-b);
    __check('large tokens are spaced 2 apart (no overlap)', lx[1] - lx[0] === 2, JSON.stringify(lx));

    c = await place('Sprite', 4, 'tiny', {x:0,y:0});
    __check('tiny tokens are 0.5x0.5 and spaced 0.5', c.body.tokens.every(t=>t.width===0.5) &&
      [...new Set(c.body.tokens.map(t=>t.x))].sort((a,b)=>a-b)[1] === 0.5);

    // --- edge clamping: a block placed at the far corner stays on canvas ---
    c = await place('Zombie', 9, 'medium', {x:19,y:15});   // scene is 20x16 grid
    const maxX = Math.max(...c.body.tokens.map(t=>t.x+1));
    const maxY = Math.max(...c.body.tokens.map(t=>t.y+1));
    __check('block clamped inside the scene bounds', maxX <= 20 && maxY <= 16, 'maxX='+maxX+' maxY='+maxY);
    __check('clamped block keeps all N tokens', c.body.tokens.length === 9);

    // --- unnamed tokens stay unnamed (no bare " 2") ---
    c = await place('', 3, 'medium', {x:0,y:0});
    __check('unnamed bulk tokens are not given numbers',
      c.body.tokens.every(t => !t.name), JSON.stringify(c.body.tokens.map(t=>t.name)));

    // --- count bounds ---
    c = await place('Horde', 999, 'medium', {x:0,y:0});
    __check('count clamped to 50', c.body.tokens.length === 50, 'n='+c.body.tokens.length);

    // --- a PLAYER cannot bulk place ---
    asUser('OTHER');
    c = await place('Sneaky', 5, 'medium', {x:0,y:0});
    __check('player bulk placement is refused client-side', c === undefined, JSON.stringify(c && c.path));
    // ...but a player CAN still place one
    c = await place('Mine', 1, 'medium', {x:2,y:2});
    // --- M6: placing a token FOR a character -------------------------------
  // The picker is what finally lets the client send actor_id; the server has
  // accepted it since M4 and nothing ever did.
  const picker = document.getElementById('tok-actor');
  __check('the placement bar offers a character picker', !!picker);
  __check('...defaulting to no character', picker && picker.value === '');
  // The picker's SOURCE was the defect, so probe the source — and the role
  // filter, since these lines run while the test is acting as a PLAYER.
  await window.loadActorPicker();
  const playerOpts = [...document.getElementById('tok-actor').options].map(o => o.textContent);
  __check('a player is offered their OWN character',
    playerOpts.includes('Aria'), playerOpts.join(' | '));
  __check('...and NOT an NPC belonging to the GM',
    !playerOpts.some(o => /Goblin/.test(o)), playerOpts.join(' | '));
  __check('the picker reads /actors, not the scene load',
    calls.fetch.some(c => c.path.slice(-7) === '/actors'),
    calls.fetch.map(c => c.path).join(' | '));
  __check('...and still offers "no character" first',
    document.getElementById('tok-actor').options[0].value === '');

  // As the GM the same list yields both.
  asUser('GM');
  await window.loadActorPicker();
  const gmOpts = [...document.getElementById('tok-actor').options].map(o => o.textContent);
  __check('the GM is offered every character, NPCs included',
    gmOpts.includes('Aria') && gmOpts.includes('Goblin (NPC)'), gmOpts.join(' | '));

  __check('the size select offers "from character"',
    [...document.getElementById('tok-size').options].some(o => o.value === ''),
    [...document.getElementById('tok-size').options].map(o=>o.value).join(','));

  __check('player can still place a single token', c && c.path.endsWith('/tokens'), c && c.path);

    window.__done();
  })();
})();
`);
