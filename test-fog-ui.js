// Fog-of-war UI suite. jsdom only — no server and no database:
//   node test-fog-ui.js
//
// Loads the REAL public/scene.html + public/js/scene.js, like test-marquee.js
// and test-shortcuts.js do, and drives them with synthetic events.
//
// The two things most worth gating here:
//   1. The SUBTRACTIVE RENDER RULE — fog = union(covered) - union(revealed) —
//      expressed as an SVG mask. Covered regions paint white, revealed regions
//      paint black over them, and the result must not depend on draw order,
//      because the schema deliberately has no z_index.
//   2. MODE ISOLATION — with fog mode off, fog is inert and tokens behave
//      exactly as before; with it on, fog keystrokes and clicks never reach a
//      token. That isolation is the whole reason a mode exists instead of a
//      layer-priority rule.
// Network writes are stubbed: this suite asserts what the CLIENT decides, and
// what it sends. Whether the server accepts it is test-fog.js / break-fog.js.

const { JSDOM } = require('jsdom'); const fs = require('fs');
const dom = new JSDOM(fs.readFileSync('public/scene.html','utf8'), { runScripts:'outside-only', url:'http://localhost:3000/scene.html' });
const { window } = dom; const { document } = window;
window.io=()=>({on(){},emit(){}});
// Record every write the client attempts, so we can assert on payloads.
const calls = [];
window.__calls = calls;
window.fetch=async(path,opts={})=>{
  calls.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  return { status: opts.method === 'POST' ? 201 : 200, json: async()=>({ user:{id:'GM'}, fog:[], tokens:[] }) };
};
window.CSS={escape:s=>s};
window.PointerEvent=class extends window.MouseEvent{constructor(t,o={}){super(t,o);this.pointerId=o.pointerId||1;}};
window.Element.prototype.setPointerCapture=function(){}; window.Element.prototype.releasePointerCapture=function(){};
let pass=0, fail=0;
window.__check=(name,cond,d='')=>{ if(cond){pass++;console.log('  PASS  '+name);} else {fail++;console.log('  FAIL  '+name+'  '+d);} };

window.eval(fs.readFileSync('public/js/scene.js','utf8') + `
;(function(){
  scene={id:'S',width:1000,height:800,img_url:null}; currentCampaignOwnerId='GM'; me={id:'GM'};
  campaignId='C';
  const stg=document.getElementById('stage'), bg=document.getElementById('stage-bg');
  const layer=document.getElementById('fog-layer');
  const modeEl=document.getElementById('fog-mode'), toolEl=document.getElementById('fog-tool');
  const shapeEl=document.getElementById('fog-shape');
  stg.getBoundingClientRect=()=>({left:0,top:0,width:1000,height:800});
  const fire=(t,ty,x,y,ex={})=>t.dispatchEvent(new PointerEvent(ty,{bubbles:true,cancelable:true,clientX:x,clientY:y,pointerId:1,button:0,...ex}));
  const key=(k,ex={})=>document.dispatchEvent(new window.KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true,...ex}));
  const setMode=(on)=>{ modeEl.checked=on; modeEl.dispatchEvent(new window.Event('change')); };
  let clock=1000;
  const addFog=(id,type,points,revealed,at)=>{ fog.set(id,{id,scene_id:'S',type,points,revealed:!!revealed,created_at:new Date(at||(clock+=1000)).toISOString()}); };
  const lastCall=()=>__calls[__calls.length-1];
  const maskShapes=()=>[...layer.querySelectorAll('mask > *')];

  // ---------- geometry helpers ----------
  __check('rect hit test: inside', fogHitTest({type:'rect',points:[{x:0,y:0},{x:10,y:10}]},5,5));
  __check('rect hit test: outside', !fogHitTest({type:'rect',points:[{x:0,y:0},{x:10,y:10}]},11,5));
  __check('circle hit test: inside radius', fogHitTest({type:'circle',points:[{x:10,y:10},{x:15,y:10}]},12,10));
  __check('circle hit test: outside radius', !fogHitTest({type:'circle',points:[{x:10,y:10},{x:15,y:10}]},16,10));
  const tri=[{x:0,y:0},{x:10,y:0},{x:0,y:10}];
  __check('poly hit test: inside the triangle', fogHitTest({type:'poly',points:tri},2,2));
  __check('poly hit test: outside the hypotenuse', !fogHitTest({type:'poly',points:tri},9,9));
  const cb=fogBBox({type:'circle',points:[{x:10,y:10},{x:13,y:10}]});
  __check('circle bbox spans the diameter', cb.x0===7 && cb.x1===13 && cb.y0===7 && cb.y1===13, JSON.stringify(cb));
  const pb=fogBBox({type:'poly',points:tri});
  __check('poly bbox is the min/max of its points', pb.x0===0 && pb.y0===0 && pb.x1===10 && pb.y1===10);

  // ---------- the subtractive render rule ----------
  addFog('F1','rect',[{x:0,y:0},{x:20,y:16}],false);   // covers everything
  addFog('F2','rect',[{x:2,y:2},{x:4,y:4}],true);      // a window punched in it
  renderFog();
  const shapes=maskShapes();
  __check('mask starts from a black base rect',
    shapes[0].getAttribute('fill')==='black', shapes[0] && shapes[0].getAttribute('fill'));
  __check('covered regions paint WHITE (fog shows)',
    shapes.some(s=>s.getAttribute('fill')==='white'));
  __check('revealed regions paint BLACK (holes punched)',
    shapes.filter(s=>s.getAttribute('fill')==='black').length===2, 'base + 1 window');
  // Order independence: the revealed shape must be emitted after every covered
  // one regardless of insertion order, or a later-drawn fog would re-cover it.
  const fills=shapes.map(s=>s.getAttribute('fill'));
  __check('every revealed shape is emitted after every covered one',
    fills.lastIndexOf('white') < fills.lastIndexOf('black'), fills.join(','));
  fog.clear(); addFog('F2','rect',[{x:2,y:2},{x:4,y:4}],true); addFog('F1','rect',[{x:0,y:0},{x:20,y:16}],false);
  renderFog();
  const fills2=maskShapes().map(s=>s.getAttribute('fill'));
  __check('render is order-independent (no z_index needed)',
    fills2.lastIndexOf('white') < fills2.lastIndexOf('black'), fills2.join(','));

  // ---------- GM vs player rendering ----------
  const painted=()=>[...layer.children].find(c=>c.tagName.toLowerCase()==='rect');
  __check('GM sees through their own fog (semi-transparent)',
    parseFloat(painted().getAttribute('fill-opacity')) < 1, painted().getAttribute('fill-opacity'));
  me={id:'PLAYER'};
  renderFog();
  __check('players get opaque fog',
    parseFloat(painted().getAttribute('fill-opacity')) === 1, painted().getAttribute('fill-opacity'));
  __check('player gets no fog pointer surface at all', layer.querySelectorAll('.fog-catch').length===0);
  me={id:'GM'};

  // ---------- mode isolation: fog off ----------
  setMode(false);
  __check('fog layer is inert with fog mode off', !layer.classList.contains('editing'));
  __check('no pointer surface rendered with fog mode off', layer.querySelectorAll('.fog-catch').length===0);
  upsertToken({id:'T1',scene_id:'S',created_by:'GM',name:'A',x:1,y:1,width:1,height:1,rotation:0,hidden:false,locked:false,conditions:[]});
  fire(bg,'pointerdown',20,20); fire(stg,'pointermove',250,250); fire(stg,'pointerup',250,250);
  __check('marquee still selects TOKENS with fog mode off', selection.has('T1'), [...selection].join(','));
  __check('token marquee did not touch fog selection', fogSelection.size===0);

  // ---------- mode isolation: fog on ----------
  setMode(true);
  __check('entering fog mode clears the token selection', selection.size===0);
  __check('fog layer becomes interactive', layer.classList.contains('editing'));
  __check('outlines rendered for every region', layer.querySelectorAll('.fog-outline').length===2);
  __check('a single catch surface receives pointer events', layer.querySelectorAll('.fog-catch').length===1);

  // Selection is decided in JS from the geometry, so a click is just a point on
  // the stage — no DOM node needs to be located or held. Re-seed with explicit
  // timestamps: the order-independence check above left F1 as the newer row.
  fog.clear();
  addFog('F1','rect',[{x:0,y:0},{x:20,y:16}],false,1000);
  addFog('F2','rect',[{x:2,y:2},{x:4,y:4}],true,2000);
  renderFog(); setFogSelection([]);
  toolEl.value='select';
  fire(bg,'pointerdown',30,30); fire(stg,'pointerup',30,30);
  __check('clicking a region selects it', fogSelection.has('F1'), [...fogSelection].join(','));
  __check('selecting fog left tokens alone', selection.size===0);
  fire(bg,'pointerdown',110,110,{shiftKey:true}); fire(stg,'pointerup',110,110);
  __check('shift-click adds to the fog selection', fogSelection.size===2, [...fogSelection].join(','));
  // Clicking a region that is ALREADY selected keeps the whole group, so a
  // multi-region drag works — the same rule the token layer uses.
  fire(bg,'pointerdown',30,30); fire(stg,'pointerup',30,30);
  __check('clicking an already-selected region keeps the group', fogSelection.size===2, [...fogSelection].join(','));
  // Clicking a region that is NOT selected replaces the selection.
  setFogSelection(['F2']);
  fire(bg,'pointerdown',30,30); fire(stg,'pointerup',30,30);
  __check('clicking an unselected region replaces the selection',
    fogSelection.size===1 && fogSelection.has('F1'), [...fogSelection].join(','));

  // Overlaps resolve by MOST RECENTLY CREATED — the region the GM sees on top.
  fog.clear();
  addFog('OLD','rect',[{x:0,y:0},{x:10,y:10}],false,1000);
  addFog('NEW','rect',[{x:2,y:2},{x:4,y:4}],true,9000);
  renderFog();
  __check('overlap picks the most recently created region', fogPick(3,3).id==='NEW', fogPick(3,3).id);
  __check('outside the newer one, the older is still picked', fogPick(8,8).id==='OLD', fogPick(8,8).id);
  addFog('NEWEST','rect',[{x:2,y:2},{x:4,y:4}],false,20000);
  renderFog();
  __check('a later region takes precedence again', fogPick(3,3).id==='NEWEST', fogPick(3,3).id);

  // --- the bug found in the browser: drawing INSIDE an existing region ---
  fog.clear(); setFogSelection([]); addFog('BIG','rect',[{x:0,y:0},{x:20,y:16}],false); renderFog();
  toolEl.value='reveal'; shapeEl.value='rect';
  __calls.length=0;
  fire(bg,'pointerdown',100,100); fire(stg,'pointermove',200,200); fire(stg,'pointerup',200,200);
  __check('a reveal can be drawn INSIDE existing fog',
    lastCall() && lastCall().method==='POST' && lastCall().body.revealed===true, JSON.stringify(lastCall()));
  toolEl.value='cover';
  __calls.length=0;
  fire(bg,'pointerdown',100,100); fire(stg,'pointermove',200,200); fire(stg,'pointerup',200,200);
  __check('fog can be drawn on top of existing fog',
    lastCall() && lastCall().method==='POST' && lastCall().body.revealed===false, JSON.stringify(lastCall()));
  __check('a draw tool never selects what it starts on top of', fogSelection.size===0);

  // --- drag a region with the mouse ---
  fog.clear(); addFog('M1','rect',[{x:0,y:0},{x:4,y:4}],false); renderFog();
  toolEl.value='select';
  fire(bg,'pointerdown',30,30);
  __check('pointerdown on a region selects it before dragging', fogSelection.has('M1'));
  __calls.length=0;
  fire(stg,'pointermove',130,130);
  __check('drag transforms the live nodes instead of re-rendering',
    (fogNodes.get('M1')||[]).some(el=>el.getAttribute('transform')), JSON.stringify((fogNodes.get('M1')||[]).map(e=>e.getAttribute('transform'))));
  __check('nothing is written mid-drag', __calls.length===0, JSON.stringify(__calls));
  fire(stg,'pointerup',130,130);
  __check('drop PATCHes the moved region once', lastCall() && lastCall().method==='PATCH', JSON.stringify(lastCall()));
  __check('drop translates by the grid delta, not pixels',
    lastCall().body.points[0].x===2 && lastCall().body.points[0].y===2, JSON.stringify(lastCall().body.points));

  // A click that does not move must not be mistaken for a zero-distance drag.
  __calls.length=0;
  fire(bg,'pointerdown',30,30); fire(stg,'pointerup',31,31);
  __check('a click is not committed as a move', __calls.length===0, JSON.stringify(__calls));

  fog.clear(); addFog('F1','rect',[{x:0,y:0},{x:20,y:16}],false); addFog('F2','rect',[{x:2,y:2},{x:4,y:4}],true);
  renderFog(); setFogSelection([]);

  // marquee selects fog by bounding box (select tool)
  toolEl.value='select';
  setFogSelection([]);
  fire(bg,'pointerdown',0,0,{altKey:true}); fire(stg,'pointermove',300,300); fire(stg,'pointerup',300,300);
  __check('alt+drag marquees even over fully-covered ground', fogSelection.size===2, [...fogSelection].join(','));
  __check('fog marquee never selects tokens', selection.size===0);
  // With no region under the pointer, a plain drag marquees as usual.
  fog.clear(); setFogSelection([]);
  addFog('S1','rect',[{x:0,y:0},{x:2,y:2}],false,1000);
  addFog('S2','rect',[{x:3,y:3},{x:5,y:5}],false,2000);
  renderFog();
  fire(bg,'pointerdown',480,480); fire(stg,'pointermove',0,0); fire(stg,'pointerup',0,0);
  __check('plain drag from empty space still marquees', fogSelection.size===2, [...fogSelection].join(','));
  fog.clear(); setFogSelection([]);
  addFog('F1','rect',[{x:0,y:0},{x:20,y:16}],false,1000);
  addFog('F2','rect',[{x:2,y:2},{x:4,y:4}],true,2000);
  renderFog();

  // ---------- drawing ----------
  toolEl.value='cover'; shapeEl.value='rect';
  __calls.length=0;
  fire(bg,'pointerdown',100,100); fire(stg,'pointermove',300,250); fire(stg,'pointerup',300,250);
  __check('rect drag POSTs one region', lastCall() && lastCall().method==='POST', JSON.stringify(lastCall()));
  __check('rect is sent in GRID units, not pixels',
    lastCall().body.points[1].x===6 && lastCall().body.points[1].y===5, JSON.stringify(lastCall().body.points));
  __check('rect drawn covered by default', lastCall().body.revealed===false);

  toolEl.value='reveal';
  __calls.length=0;
  fire(bg,'pointerdown',0,0); fire(stg,'pointermove',100,100); fire(stg,'pointerup',100,100);
  __check('the reveal tool sends revealed:true', lastCall().body.revealed===true);
  toolEl.value='cover';

  shapeEl.value='circle';
  __calls.length=0;
  fire(bg,'pointerdown',250,250); fire(stg,'pointermove',400,250); fire(stg,'pointerup',400,250);
  __check('circle drag sends [centre, rim]',
    lastCall().body.type==='circle' && lastCall().body.points.length===2, JSON.stringify(lastCall().body));
  __check('circle radius derives from the drag distance',
    lastCall().body.points[0].x===5 && lastCall().body.points[1].x===8, JSON.stringify(lastCall().body.points));

  // a degenerate drag is a click, not a shape — nothing should be sent
  __calls.length=0;
  fire(bg,'pointerdown',500,500); fire(stg,'pointerup',500,500);
  __check('zero-size drag sends nothing', __calls.length===0, JSON.stringify(__calls));

  // polygon: click vertices, Enter closes
  shapeEl.value='poly';
  __calls.length=0;
  fire(bg,'pointerdown',0,0); fire(bg,'pointerdown',200,0); fire(bg,'pointerdown',0,200);
  __check('polygon collects vertices without posting', __calls.length===0);
  key('Enter');
  __check('Enter closes the polygon and POSTs it',
    lastCall() && lastCall().body.type==='poly' && lastCall().body.points.length===3, JSON.stringify(lastCall()));

  __calls.length=0;
  fire(bg,'pointerdown',0,0); fire(bg,'pointerdown',200,0);
  key('Enter');
  __check('a 2-point polygon is refused client-side', __calls.length===0);

  __calls.length=0;
  fire(bg,'pointerdown',0,0); fire(bg,'pointerdown',200,0); fire(bg,'pointerdown',0,200);
  key('Escape');
  key('Enter');
  __check('Escape cancels an in-progress polygon', __calls.length===0);
  toolEl.value='select'; shapeEl.value='rect';

  // ---------- keyboard, fog mode on ----------
  fog.clear(); addFog('F1','rect',[{x:0,y:0},{x:4,y:4}],false); addFog('F2','rect',[{x:8,y:8},{x:10,y:10}],true);
  renderFog();
  key('a',{ctrlKey:true});
  __check('Ctrl+A selects all fog', fogSelection.size===2);
  __check('Ctrl+A in fog mode does NOT select tokens', selection.size===0);

  setFogSelection(['F1']);
  __calls.length=0;
  key('ArrowRight');
  __check('arrow nudges fog via PATCH', lastCall() && lastCall().method==='PATCH', JSON.stringify(lastCall()));
  __check('nudge translates every point by 1',
    lastCall().body.points[0].x===1 && lastCall().body.points[1].x===5, JSON.stringify(lastCall().body.points));

  __calls.length=0;
  key('ArrowRight',{shiftKey:true});
  __check('shift+arrow nudges fog by 5', lastCall().body.points[0].x===5, JSON.stringify(lastCall().body.points));

  __calls.length=0;
  key('t');
  __check('T toggles cover/reveal', lastCall() && lastCall().body.revealed===true, JSON.stringify(lastCall()));

  __calls.length=0;
  key('Delete');
  __check('Delete batch-deletes the fog selection',
    lastCall() && lastCall().path.endsWith('/batch-delete') && lastCall().body.fog_ids.length===1, JSON.stringify(lastCall()));

  // clipboard: snapshots, not ids — so a cut is still pasteable
  setFogSelection(['F1']);
  key('c',{ctrlKey:true});
  __check('Ctrl+C snapshots the region', fogClipboard.length===1);
  __check('clipboard holds DATA, not an id',
    fogClipboard[0].id===undefined && Array.isArray(fogClipboard[0].points), JSON.stringify(fogClipboard[0]));
  fog.delete('F1');   // simulate the delete half of a cut
  __calls.length=0;
  cursorGrid={x:20,y:20};
  key('v',{ctrlKey:true});
  __check('paste STILL works after the source region is gone',
    lastCall() && lastCall().path.endsWith('/copy'), JSON.stringify(lastCall()));
  __check('paste lands at the cursor',
    lastCall().body.regions[0].points[0].x===20 && lastCall().body.regions[0].points[0].y===20,
    JSON.stringify(lastCall().body.regions[0].points));

  // ---------- token keys must not leak through fog mode ----------
  fog.clear(); addFog('F1','rect',[{x:0,y:0},{x:4,y:4}],false); renderFog();
  upsertToken({id:'T9',scene_id:'S',created_by:'GM',name:'Z',x:1,y:1,width:1,height:1,rotation:0,hidden:false,locked:false,conditions:[]});
  setSelection(['T9']); setFogSelection(['F1']);
  __calls.length=0;
  key('ArrowRight');
  const touchedToken=__calls.some(c=>c.path && c.path.indexOf('/tokens')!==-1);
  __check('an arrow in fog mode never moves a token', !touchedToken, JSON.stringify(__calls));

  // ---------- leaving fog mode drops fog state ----------
  setMode(false);
  __check('leaving fog mode clears the fog selection', fogSelection.size===0);
  __check('leaving fog mode makes the layer inert again', !layer.classList.contains('editing'));

  // ---------- the F shortcut (GM only) ----------
  me={id:'GM'}; setMode(false);
  key('f');
  __check('F enters fog mode', fogMode===true);
  __check('F keeps the checkbox in sync', modeEl.checked===true);
  __check('F entering fog mode makes the layer interactive', layer.classList.contains('editing'));
  key('f');
  __check('F leaves fog mode again (symmetric)', fogMode===false);
  __check('F unchecks the checkbox on the way out', modeEl.checked===false);

  // F must run the same cleanup the checkbox does.
  fog.clear(); addFog('K1','rect',[{x:0,y:0},{x:4,y:4}],false); 
  key('f'); setFogSelection(['K1']);
  __check('fog can be selected after entering with F', fogSelection.size===1);
  key('f');
  __check('leaving via F clears the fog selection', fogSelection.size===0);

  // F must not fire while typing — the same guard every other shortcut has.
  setMode(false);
  const box=document.getElementById('tok-name');
  box.dispatchEvent(new window.KeyboardEvent('keydown',{key:'f',bubbles:true,cancelable:true}));
  __check('F typed into an input does not toggle fog mode', fogMode===false);

  // Modified F is left alone, so Ctrl/Cmd+F stays the browser's find.
  key('f',{ctrlKey:true});
  __check('Ctrl+F does not toggle fog mode', fogMode===false);
  key('f',{metaKey:true});
  __check('Cmd+F does not toggle fog mode', fogMode===false);

  // ---------- a player can never enter fog mode ----------
  me={id:'PLAYER'};
  setMode(true);
  __check('a player toggling the checkbox stays out of fog mode', fogMode===false);
  __check('player gets no fog editing affordances', layer.querySelectorAll('.fog-catch').length===0);
  key('f');
  __check('a player pressing F does NOT enter fog mode', fogMode===false);
  __check('a player pressing F cannot even tick the checkbox', modeEl.checked===false);
  key('f'); key('f');
  __check('repeated F presses never let a player in', fogMode===false);
  __check('no editing surface appears for a player after F', layer.querySelectorAll('.fog-catch').length===0);
})();
`);
console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail===0?0:1);
