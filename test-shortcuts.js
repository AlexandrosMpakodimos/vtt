// Headless DOM tests for the canvas keyboard shortcuts, against the REAL
// scene.html + scene.js. No server/DB needed: these assert the client's
// intent (what it selects, what request/emit it fires), not server behaviour —
// the server rules are covered by test-token-ops.js.
const { JSDOM } = require('jsdom'); const fs = require('fs');
const dom = new JSDOM(fs.readFileSync('public/scene.html','utf8'), { runScripts:'outside-only', url:'http://localhost:3000/scene.html' });
const { window } = dom; const { document } = window;

// Capture outbound calls instead of hitting the network.
const calls = { fetch: [], emit: [] };
window.fetch = async (path, opts) => {
  calls.fetch.push({ path, method: opts && opts.method, body: opts && opts.body ? JSON.parse(opts.body) : null });
  return { status: 200, json: async () => ({ user:{id:'GM'}, tokens: [], token: {} }) };
};
window.io = () => ({ on(){}, emit(ev, payload, cb){
  calls.emit.push({ ev, payload });
  if (!cb) return;
  // Mirror the real server's ack shape so the client's success path (which
  // upserts the returned row) runs exactly as it does in production.
  if (ev === 'token:move') {
    cb({ ok:true, token:{ id: payload.token_id, scene_id: payload.scene_id, created_by:'GM',
      name:'x', img_url:null, x: payload.x, y: payload.y, width:1, height:1, rotation:0,
      hidden:false, locked:false, bar1_value:null, bar1_max:null, conditions:[] } });
  } else if (ev === 'token:move-batch') {
    cb({ ok:true, applied: (payload.moves||[]).map(m => ({ id:m.token_id, scene_id:payload.scene_id,
      created_by:'GM', name:'x', img_url:null, x:m.x, y:m.y, width:1, height:1, rotation:0,
      hidden:false, locked:false, bar1_value:null, bar1_max:null, conditions:[] })), rejected: [] });
  } else { cb({ ok:true }); }
} });
window.CSS = { escape: s => s };
window.PointerEvent = class extends window.MouseEvent { constructor(t,o={}){super(t,o);this.pointerId=o.pointerId||1;} };
window.Element.prototype.setPointerCapture=function(){}; window.Element.prototype.releasePointerCapture=function(){};

let pass=0, fail=0;
window.__check=(n,c,d='')=>{ if(c){pass++;console.log('  PASS  '+n);} else {fail++;console.log('  FAIL  '+n+'  '+d);} };
window.__calls = calls;

window.eval(fs.readFileSync('public/js/scene.js','utf8') + `
;(function(){
  const calls = window.__calls;
  campaignId='C'; scene={id:'S',width:1000,height:800,img_url:null};
  currentCampaignOwnerId='GM'; me={id:'GM'};
  upsertToken({id:'T1',scene_id:'S',created_by:'GM',name:'A',x:1,y:1,width:1,height:1,rotation:0,hidden:false,locked:false,conditions:[]});
  upsertToken({id:'T2',scene_id:'S',created_by:'GM',name:'B',x:3,y:3,width:1,height:1,rotation:0,hidden:false,locked:false,conditions:[]});
  upsertToken({id:'T3',scene_id:'S',created_by:'OTHER',name:'C',x:5,y:5,width:1,height:1,rotation:0,hidden:false,locked:false,conditions:[]});

  const key = (k, opts={}) => document.dispatchEvent(new window.KeyboardEvent('keydown',
    { key:k, bubbles:true, cancelable:true, ...opts }));

  // --- select all (must work from an EMPTY selection) ---
  setSelection([]);
  key('a', { ctrlKey:true });
  __check('Ctrl+A selects all (GM gets every token)', selection.size === 3, 'size='+selection.size);

  // --- escape clears ---
  key('Escape');
  __check('Escape clears the selection', selection.size === 0);

  // --- escape closes the context menu first, without clearing ---
  setSelection(['T1']);
  openCtxMenu(10, 10);
  key('Escape');
  __check('Escape closes ctx menu but keeps selection',
    ctxMenu.style.display === 'none' && selection.size === 1, 'sel='+selection.size);

  // --- nudge: normal vs shift ---
  setSelection(['T1']);
  calls.emit.length = 0;
  const beforeX = Number(tokens.get('T1').row.x);
  key('ArrowRight');
  const n1 = calls.emit.find(c => c.ev === 'token:move');
  __check('arrow nudges by 1', n1 && n1.payload.x === beforeX + 1, JSON.stringify(n1 && n1.payload));
  calls.emit.length = 0;
  const beforeX2 = Number(tokens.get('T1').row.x);   // the ack applied the first nudge
  key('ArrowRight', { shiftKey:true });
  const n5 = calls.emit.find(c => c.ev === 'token:move');
  __check('shift+arrow nudges by 5', n5 && n5.payload.x === beforeX2 + 5,
    'from ' + beforeX2 + ' -> ' + JSON.stringify(n5 && n5.payload));

  // --- copy / cut / duplicate / paste ---
  setSelection(['T1','T2']);
  key('c', { ctrlKey:true });
  __check('Ctrl+C fills the clipboard', clipboard.length === 2, 'clip='+clipboard.length);
  __check('clipboard holds SNAPSHOTS, not ids',
    typeof clipboard[0] === 'object' && 'name' in clipboard[0] && !('id' in clipboard[0]),
    JSON.stringify(clipboard[0]));

  calls.fetch.length = 0;
  const origs = [...selection].map(id => tokens.get(id).row);
  key('d', { ctrlKey:true });
  const dup = calls.fetch.find(c => c.path.includes('/tokens/copy'));
  __check('Ctrl+D duplicates the SELECTION', dup && dup.body.tokens.length === 2, JSON.stringify(dup && dup.body));
  // Every duplicate sits exactly +1/+1 from some original.
  const dupOffsetsOk = dup && dup.body.tokens.every(t =>
    origs.some(o => t.x === Number(o.x) + 1 && t.y === Number(o.y) + 1));
  __check('Ctrl+D offsets +1/+1 from each original', dupOffsetsOk,
    'dups=' + JSON.stringify(dup && dup.body.tokens.map(t=>[t.x,t.y])) +
    ' origs=' + JSON.stringify(origs.map(o=>[Number(o.x),Number(o.y)])));

  // paste lands at the CURSOR, not on top of the source
  cursorGrid = { x: 12, y: 9 };
  calls.fetch.length = 0;
  key('v', { ctrlKey:true });
  const paste = calls.fetch.find(c => c.path.includes('/tokens/copy'));
  const pts = paste ? paste.body.tokens : [];
  // The cluster's top-left corner must land exactly on the cursor.
  const minPx = Math.min(...pts.map(t => t.x)), minPy = Math.min(...pts.map(t => t.y));
  __check('Ctrl+V pastes AT THE CURSOR (cluster top-left on the pointer)',
    minPx === 12 && minPy === 9, JSON.stringify(pts.map(t=>[t.x,t.y])));
  // Relative layout preserved: the spread between pasted tokens matches the source.
  const clipMinX = Math.min(...clipboard.map(t=>t.x)), clipMinY = Math.min(...clipboard.map(t=>t.y));
  const layoutOk = clipboard.every(c =>
    pts.some(p => p.x === 12 + (c.x - clipMinX) && p.y === 9 + (c.y - clipMinY)));
  __check('multi-token paste preserves relative layout', layoutOk,
    'pasted=' + JSON.stringify(pts.map(t=>[t.x,t.y])) +
    ' clip=' + JSON.stringify(clipboard.map(c=>[c.x,c.y])));
  __check('paste and duplicate land in DIFFERENT places',
    dup && paste && dup.body.tokens[0].x !== paste.body.tokens[0].x);

  // cut, then paste AFTER the sources are gone — the bug this design fixes
  setSelection(['T1','T2']);
  calls.fetch.length = 0;
  key('x', { ctrlKey:true });
  const cutDel = calls.fetch.find(c => c.path.includes('batch-delete'));
  __check('Ctrl+X snapshots then deletes', clipboard.length === 2 && !!cutDel, 'clip='+clipboard.length+' del='+!!cutDel);
  // simulate the server's delete broadcast removing them locally
  removeToken('T1'); removeToken('T2');
  calls.fetch.length = 0;
  key('v', { ctrlKey:true });
  const pasteAfterCut = calls.fetch.find(c => c.path.includes('/tokens/copy'));
  __check('paste STILL works after cut removed the tokens',
    pasteAfterCut && pasteAfterCut.body.tokens.length === 2, JSON.stringify(pasteAfterCut && pasteAfterCut.body));

  // re-add for the remaining tests
  upsertToken({id:'T1',scene_id:'S',created_by:'GM',name:'A',x:1,y:1,width:1,height:1,rotation:0,hidden:false,locked:false,conditions:[]});
  upsertToken({id:'T2',scene_id:'S',created_by:'GM',name:'B',x:3,y:3,width:1,height:1,rotation:0,hidden:false,locked:false,conditions:[]});

  // paste must work even with nothing selected (clipboard is the input)
  setSelection([]);
  calls.fetch.length = 0;
  key('v', { ctrlKey:true });
  __check('Ctrl+V pastes with an empty selection',
    !!calls.fetch.find(c => c.path.includes('/tokens/copy')));

  // --- delete ---
  setSelection(['T1']);
  calls.fetch.length = 0;
  key('Delete');
  __check('Delete removes the selection', !!calls.fetch.find(c => c.path.includes('batch-delete')));

  // --- typing in a field must NOT trigger shortcuts ---
  setSelection(['T1','T2']);
  const input = document.getElementById('tok-name');
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key:'a', ctrlKey:true, bubbles:true, cancelable:true }));
  __check('shortcuts ignored while typing in an input', selection.size === 2, 'size='+selection.size);

  // --- PLAYER: Ctrl+A selects only their own; GM-only shortcuts do nothing ---
  me = { id:'OTHER' };            // now a player; GM is still 'GM'
  setSelection([]);
  key('a', { ctrlKey:true });
  __check('player Ctrl+A selects ONLY their own token',
    selection.size === 1 && selection.has('T3'), [...selection].join(','));

  calls.fetch.length = 0;
  key('Delete');
  __check('player Delete does nothing (GM-only)', calls.fetch.length === 0, 'calls='+calls.fetch.length);
  calls.fetch.length = 0;
  key('d', { ctrlKey:true });
  __check('player Ctrl+D does nothing (GM-only)', calls.fetch.length === 0);
  calls.fetch.length = 0;
  key('x', { ctrlKey:true });
  __check('player Ctrl+X does nothing (GM-only)', calls.fetch.length === 0);

  // player CAN still nudge their own token
  calls.emit.length = 0;
  key('ArrowDown');
  __check('player can still nudge their own token', calls.emit.some(c => c.ev === 'token:move'));
})();
`);
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail===0?0:1);
