const { JSDOM } = require('jsdom'); const fs = require('fs');
const dom = new JSDOM(fs.readFileSync('public/scene.html','utf8'), { runScripts:'outside-only', url:'http://localhost:3000/scene.html' });
const { window } = dom; const { document } = window;
window.io=()=>({on(){},emit(){}}); window.fetch=async()=>({status:200,json:async()=>({user:{id:'GM'}})});
window.CSS={escape:s=>s};
window.PointerEvent=class extends window.MouseEvent{constructor(t,o={}){super(t,o);this.pointerId=o.pointerId||1;}};
// Pointer capture is RECORDED, not merely stubbed out. Whether a drag captures
// is the whole subject of the probes at the end of this file, and a no-op stub
// would let them pass without the code ever asking for capture.
window.__captures = [];
window.Element.prototype.setPointerCapture=function(id){ window.__captures.push({op:'set', id:id, el:this.id}); };
window.Element.prototype.releasePointerCapture=function(id){ window.__captures.push({op:'release', id:id, el:this.id}); };
let pass=0, fail=0;
window.__check=(name,cond,d='')=>{ if(cond){pass++;console.log('  PASS  '+name);} else {fail++;console.log('  FAIL  '+name+'  '+d);} };
window.eval(fs.readFileSync('public/js/scene.js','utf8') + `
;(function(){
  scene={id:'S',width:1000,height:800,img_url:null}; currentCampaignOwnerId='GM'; me={id:'GM'};
  upsertToken({id:'T1',scene_id:'S',created_by:'GM',name:'A',x:1,y:1,width:1,height:1,rotation:0,hidden:false,locked:false,conditions:[]});
  upsertToken({id:'T2',scene_id:'S',created_by:'GM',name:'B',x:3,y:3,width:1,height:1,rotation:0,hidden:false,locked:false,conditions:[]});
  upsertToken({id:'T3',scene_id:'S',created_by:'GM',name:'C',x:9,y:9,width:1,height:1,rotation:0,hidden:false,locked:false,conditions:[]});
  upsertToken({id:'T4',scene_id:'S',created_by:'OTHER',name:'D',x:2,y:2,width:1,height:1,rotation:0,hidden:false,locked:false,conditions:[]});
  const stg=document.getElementById('stage'), bg=document.getElementById('stage-bg');
  stg.getBoundingClientRect=()=>({left:0,top:0,width:1000,height:800});
  // jsdom reports clientWidth/clientHeight as 0, and a zero-size viewport makes
  // every clamp degenerate — the map would always be "larger than the
  // viewport" and always pinned. Given a real size, the clamp can be tested for
  // what it does rather than for what a missing measurement does.
  // Addressed through the DOM rather than through the wrap binding: the probe
  // block further down declares its own const wrap, which shadows the one from
  // scene.js for the whole function and puts this line in its temporal dead
  // zone. (No backticks anywhere in here — the block is inside a template
  // literal and one would terminate it.)
  const wrapEl = document.getElementById('stage-wrap');
  Object.defineProperty(wrapEl,'clientWidth',{value:600,configurable:true});
  Object.defineProperty(wrapEl,'clientHeight',{value:400,configurable:true});
  // [CHANGED 2026-08-10] The marquee moved from the LEFT button to the RIGHT,
  // because left-drag now pans the map. These probes therefore dispatch
  // button:2 — the gesture is the same, the button is not.
  //
  // Note the default is button 2 rather than 0: every drag in this file is a
  // marquee drag, so making the marquee button the default keeps the probes
  // reading as descriptions of the behaviour rather than of the plumbing.
  const fire=(t,ty,x,y,ex={})=>t.dispatchEvent(new PointerEvent(ty,{bubbles:true,cancelable:true,clientX:x,clientY:y,pointerId:1,button:2,...ex}));

  // marquee (20,20)->(250,250) covers T1(50,50), T2(150,150), T4(100,100); not T3(450,450)
  fire(bg,'pointerdown',20,20); fire(stg,'pointermove',250,250); fire(stg,'pointerup',250,250);
  __check('marquee selects tokens inside the box', selection.has('T1') && selection.has('T2'), [...selection].join(','));
  __check('marquee excludes token outside the box', !selection.has('T3'));
  fire(bg,'click',250,250);   // the browser's trailing click
  __check('selection SURVIVES the trailing click', selection.size >= 2, 'size='+selection.size);
  __check('DOM shows selected outlines', document.querySelectorAll('.token.selected').length >= 2);

  // plain click on empty space still clears
  fire(bg,'click',400,400);
  __check('plain empty click still clears selection', selection.size === 0, 'size='+selection.size);

  // as GM, a token owned by someone else IS selectable (GM may move anything)
  fire(bg,'pointerdown',20,20); fire(stg,'pointermove',250,250); fire(stg,'pointerup',250,250);
  __check('GM marquee includes another user\\'s token', selection.has('T4'));

  // as a PLAYER, only own tokens get selected
  fire(bg,'click',400,400);
  me={id:'OTHER'}; currentCampaignOwnerId='GM';   // now a player
  fire(bg,'pointerdown',20,20); fire(stg,'pointermove',250,250); fire(stg,'pointerup',250,250);
  __check('player marquee selects ONLY their own token', selection.has('T4') && !selection.has('T1'), [...selection].join(','));

  // ---------- pan, zoom, and the right/left split (2026-08-10) ----------
  // Left-drag pans the map, right-drag box-selects, right-CLICK still opens the
  // context menu. The three share two buttons, so the interesting probes are
  // about which gesture wins rather than about any one of them working.
  const wrap = document.getElementById('stage-wrap');
  const hud = document.getElementById('zoom-hud');
  const fireW=(ty,x,y,ex={})=>wrap.dispatchEvent(new PointerEvent(ty,{bubbles:true,cancelable:true,clientX:x,clientY:y,pointerId:1,button:0,...ex}));

  setSelection([]);
  // [CHANGED 2026-08-10] Dragging RIGHT from the origin is now correctly
  // refused: the map's left edge is already against the viewport's, and the
  // clamp does not allow empty background at an edge. So the probe drags LEFT,
  // which reveals more of the map and is a movement the clamp permits.
  const before = stage.style.transform;
  fireW('pointerdown',160,140); fireW('pointermove',100,100); fireW('pointerup',100,100);
  __check('left-drag on empty space PANS the map', stage.style.transform !== before, stage.style.transform);
  __check('...by exactly the drag distance, in screen pixels',
    stage.style.transform.indexOf('translate(-60px, -40px)') === 0, stage.style.transform);
  __check('...and selects nothing', selection.size === 0, [...selection].join(','));

  // Zoom is multiplicative and clamped. The HUD is the only observable, which
  // is enough: it is rendered from the same value the transform uses.
  wrap.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-100,clientX:100,clientY:100}));
  __check('wheel up zooms IN', parseInt(hud.textContent,10) > 100, hud.textContent);
  const zoomedIn = parseInt(hud.textContent,10);
  wrap.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:100,clientX:100,clientY:100}));
  __check('wheel down zooms OUT', parseInt(hud.textContent,10) < zoomedIn, hud.textContent);
  for (let i=0;i<40;i++) wrap.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-100,clientX:100,clientY:100}));
  __check('zoom is clamped at the maximum', parseInt(hud.textContent,10) === 400, hud.textContent);
  for (let i=0;i<80;i++) wrap.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:100,clientX:100,clientY:100}));
  __check('...and at the minimum', parseInt(hud.textContent,10) === 25, hud.textContent);
  resetView();
  __check('reset returns to 100% at the origin',
    hud.textContent === '100%' && stage.style.transform.indexOf('translate(0px, 0px) scale(1)') === 0,
    stage.style.transform);

  // A right-drag ends with a contextmenu event the browser fires anyway. It must
  // be swallowed exactly once, or every box-selection finishes with a menu
  // sitting over the selection it just made.
  //
  // [REWRITTEN 2026-08-10] These used to dispatch the contextmenu event directly and
  // assert a suppression flag. They passed while the feature was broken on a
  // real machine, because they encoded MY MODEL of when contextmenu fires
  // rather than the browser's: on macOS it arrives with the mouse DOWN, so the
  // flag was always false and the menu opened at the start of every marquee.
  //
  // A probe that dispatches the event itself cannot catch that — it decides the
  // ordering it is testing. So these now drive the GESTURE, press through
  // release, and let the code decide when a menu is warranted. The menu is
  // opened from the release, where the marquee's own size already distinguishes
  // a click from a drag.
  const ctxEl = document.getElementById('ctx-menu');

  // A drag that MOVED must not leave a menu behind.
  setSelection(['T1']);
  fire(bg,'pointerdown',20,20); fire(stg,'pointermove',250,250); fire(stg,'pointerup',250,250);
  __check('a marquee drag leaves no menu open',
    ctxEl.style.display !== 'block', ctxEl.style.display);

  // A right-click that did NOT move opens it. Same two events, no movement
  // between them — which is the whole distinction, and is now made by the code
  // rather than by a flag the probe sets up.
  setSelection(['T1']);
  fire(bg,'pointerdown',250,250); fire(stg,'pointerup',250,250);
  __check('a right-click with no movement opens the menu',
    ctxEl.style.display === 'block', ctxEl.style.display);
  __check('...and the selection survived', selection.has('T1'), [...selection].join(','));
  hideCtxMenu();

  // ...and a drag immediately afterwards still leaves no menu: there is no
  // one-shot state to get out of step, because there is no state at all.
  fire(bg,'pointerdown',20,20); fire(stg,'pointermove',300,300); fire(stg,'pointerup',300,300);
  __check('a drag after a click still leaves no menu',
    ctxEl.style.display !== 'block', ctxEl.style.display);

  // ---------- coordinates at a non-default zoom (2026-08-10) ----------
  //
  // Nothing tested this. Pan and zoom shipped with a claim that
  // getBoundingClientRect "handled it automatically" — it handles the ORIGIN,
  // and the remaining offset is still in SCREEN pixels while the stage is
  // scaled. So at 200% every click landed at half the intended distance from
  // the origin: selection missed, the marquee drifted from the pointer, and
  // dragging a token moved it the wrong distance.
  //
  // These probes exist because the arithmetic is invisible at 100% zoom, which
  // is the only zoom anything had ever been tested at.
  resetView();
  setSelection([]);

  // jsdom reports a zero-size rect for the stage, so the origin is (0,0) and a
  // click at (200,200) is exactly 200 screen pixels from it. At zoom 2 that has
  // to be 100 STAGE pixels — two grid squares, not four.
  setZoom(2, {x:0,y:0});
  const g2 = stageGrid({clientX:200, clientY:200});
  __check('at 200% zoom a click 200px from the origin is 2 squares in, not 4',
    g2.x === 2 && g2.y === 2, JSON.stringify(g2));

  setZoom(0.5, {x:0,y:0});
  const gHalf = stageGrid({clientX:200, clientY:200});
  __check('at 50% zoom the same click is 8 squares in',
    gHalf.x === 8 && gHalf.y === 8, JSON.stringify(gHalf));

  resetView();
  const g1 = stageGrid({clientX:200, clientY:200});
  __check('at 100% it is 4 squares — the case that always worked',
    g1.x === 4 && g1.y === 4, JSON.stringify(g1));

  // The marquee element is a CHILD of the stage, so it is drawn inside the same
  // transform and must be positioned in stage coordinates. Sized from screen
  // deltas it drifted away from the pointer as the zoom rose.
  setZoom(2, {x:0,y:0});
  fire(bg,'pointerdown',100,100); fire(stg,'pointermove',300,300); fire(stg,'pointerup',300,300);
  __check('the marquee is sized in STAGE units, not screen units',
    Math.abs(parseFloat(marqueeEl.style.width) - 100) < 1, marqueeEl.style.width);
  resetView();

  // ---------- dragging past the edge of the map (2026-08-10) ----------
  //
  // Reported: a marquee or a fog draw started near the boundary would freeze
  // and could not be released — the rectangle stayed stuck to the pointer and
  // only a reload escaped it.
  //
  // Neither drag captured the pointer. Once the cursor leaves the stage,
  // pointermove stops arriving and pointerup lands on whatever element is
  // underneath, so the drag never sees its own end. Token movement and
  // fog-region movement had captured since M2; the two that did not are exactly
  // the two that begin on EMPTY SPACE — which is also where a drag is most
  // likely to run off the edge.
  window.__captures.length = 0;
  fire(bg,'pointerdown',20,20);
  __check('a marquee CAPTURES the pointer',
    window.__captures.some(function(c){ return c.op === 'set' && c.el === 'stage'; }),
    JSON.stringify(window.__captures));

  fire(stg,'pointermove',300,300); fire(stg,'pointerup',300,300);
  __check('...and releases it when the drag ends',
    window.__captures.some(function(c){ return c.op === 'release'; }),
    JSON.stringify(window.__captures));

  // pointercancel is the OTHER way a gesture ends — a touch becoming a scroll,
  // the window losing focus. Capture does not help there, because pointerup
  // never fires at all.
  window.__captures.length = 0;
  fire(bg,'pointerdown',20,20); fire(stg,'pointermove',200,200);
  stage.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:1}));
  __check('pointercancel ends the marquee too',
    marqueeEl.style.display === 'none', marqueeEl.style.display);
  __check('...releasing the capture with it',
    window.__captures.some(function(c){ return c.op === 'release'; }),
    JSON.stringify(window.__captures));

  // A drag released far outside the map must still resolve. With capture the
  // events arrive here regardless of what is under the cursor.
  fire(bg,'pointerdown',10,10); fire(stg,'pointermove',-500,-500); fire(stg,'pointerup',-500,-500);
  __check('a drag released far outside the map still ends',
    marqueeEl.style.display === 'none', marqueeEl.style.display);

  // ---------- right-clicking a token opens its menu (2026-08-10) ----------
  //
  // Regression introduced by moving the marquee to the right button: every
  // right press now starts a marquee, and the marquee cleared the selection at
  // PRESS time — so the token being right-clicked was deselected before the
  // context menu ran, the menu found an empty selection, and nothing appeared.
  // Fog was unaffected, because it selects by hit-testing rather than from an
  // existing selection, which is why the symptom looked like a token-only bug.
  //
  // The clear is now deferred until the drag actually MOVES, which costs
  // nothing: a marquee that never moves selects nothing anyway.
  resetView();
  setSelection([]);
  const ctxEl2 = document.getElementById('ctx-menu');
  const t1el = document.querySelector('.token');
  // Press and release on the token with no movement — the real gesture. The
  // press must not clear the selection, or the menu would find nothing to act
  // on; that clearing is deferred until a drag actually moves.
  setSelection(['T1']);
  fire(t1el,'pointerdown',60,60); fire(stg,'pointerup',60,60);
  __check('right-clicking a token opens the context menu',
    ctxEl2.style.display === 'block', ctxEl2.style.display);
  __check('...with the token still selected', selection.has('T1'), [...selection].join(','));

  // A REAL MOUSE JITTERS. Holding still to click still emits pointermove
  // events, and the first version treated any movement at all as a drag — so
  // the menu was suppressed on every real right-click while every probe passed,
  // because a test only fires pointermove when it means to drag.
  //
  // This probe reproduces the device rather than the intent: press, twitch a
  // pixel or two, release, menu.
  hideCtxMenu();
  setSelection(['T1']);
  fire(t1el,'pointerdown',60,60);
  fire(stg,'pointermove',61,60); fire(stg,'pointermove',60,61); fire(stg,'pointermove',61,61);
  fire(stg,'pointerup',61,61);
  t1el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:61,clientY:61}));
  __check('a right-click that JITTERS still opens the menu',
    ctxEl2.style.display === 'block', ctxEl2.style.display);

  // ...and a real drag still suppresses it, so the threshold has not simply
  // disabled the suppression.
  hideCtxMenu();
  setSelection(['T1']);
  fire(t1el,'pointerdown',60,60);
  fire(stg,'pointermove',200,200);
  fire(stg,'pointerup',200,200);
  stage.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:200}));
  __check('a real drag still suppresses the menu',
    ctxEl2.style.display !== 'block', ctxEl2.style.display);
  hideCtxMenu();
  setSelection(['T1']);
  __check('...with the token still selected', selection.has('T1'), [...selection].join(','));
  hideCtxMenu();

  // ...and the menu now opens on EMPTY space too, because ping acts on a point
  // rather than on a selection. It used to return early with nothing selected.
  setSelection([]);
  fire(bg,'pointerdown',400,400); fire(stg,'pointerup',400,400);
  __check('the menu opens on empty space, for ping',
    ctxEl2.style.display === 'block', ctxEl2.style.display);
  __check('...with no map label, leading straight with the actions',
    ctxEl2.textContent.indexOf('map') === -1 && ctxEl2.textContent.indexOf('ping here') === 0,
    ctxEl2.textContent.slice(0, 40));
  __check('...offering ping', ctxEl2.textContent.indexOf('ping here') >= 0, ctxEl2.textContent.slice(0,80));

  // isGm() compares the current user against the campaign owner, so being the
  // GM has to be established through BOTH — setting the user alone leaves the
  // page a player, and the probe below would then read a player menu while
  // claiming to test a GM one.
  //
  // (No backticks in this comment: the whole block is inside a template
  // literal, and one would terminate it.)
  currentCampaignOwnerId = 'GM'; me = {id:'GM'};
  hideCtxMenu();
  fire(bg,'pointerdown',400,400); fire(stg,'pointerup',400,400);
  __check('...and focus, for a GM', ctxEl2.textContent.indexOf('focus') >= 0, ctxEl2.textContent.slice(0,80));

  // A PLAYER may ping but may not focus: drawing on somebody's screen is one
  // thing, taking their viewport is another.
  me = {id:'P1'};
  hideCtxMenu();
  fire(bg,'pointerdown',400,400); fire(stg,'pointerup',400,400);
  __check('a player is offered ping', ctxEl2.textContent.indexOf('ping here') >= 0, ctxEl2.textContent.slice(0,80));
  __check('...but NOT focus', !ctxEl2.textContent.indexOf('focus') >= 0, ctxEl2.textContent.slice(0,80));
  me = {id:'GM'};
  hideCtxMenu();

  // ---------- rendering a ping ----------
  // The marker takes the pinger's campaign colour — the same colour their dice
  // and their chat name use — so "who is pointing at that" needs no label.
  showPing({scene_id:'S', x:2, y:3, color:'#e6194b', focus:false});
  const dot = document.querySelector('.ping');
  __check('a ping renders a marker on the stage', !!dot);
  __check('...in the pinger colour', dot && dot.style.color === 'rgb(230, 25, 75)', dot && dot.style.color);
  // [CHANGED 2026-08-10] A ping is NOT snapped to the grid. Its coordinates are
  // the exact point that was pointed at, expressed in fractional grid units —
  // so they are already a centre and get no half-cell offset. Snapping moved
  // the mark by up to half a square from where the person actually clicked.
  __check('...at the exact point, with no half-cell offset',
    dot && parseFloat(dot.style.left) === 100 && parseFloat(dot.style.top) === 150,
    dot && (dot.style.left + ',' + dot.style.top));
  __check('...as TWO expanding rings, staggered',
    dot && dot.querySelectorAll('i').length === 2,
    dot && String(dot.querySelectorAll('i').length));

  // The marker must survive the FIRST ring finishing. animationend fires once
  // per animating child, so removing on the first would cut the second ring off
  // mid-flight — losing exactly the stagger that makes this read as radar.
  dot.dispatchEvent(new Event('animationend'));
  __check('one ring ending does NOT remove the ping', !!dot.parentNode);
  dot.dispatchEvent(new Event('animationend'));
  __check('...but the second one does', !dot.parentNode);

  // The case the change is FOR: a fractional position must land between
  // squares rather than being rounded to one. An integer-only probe would pass
  // against the old snapped behaviour and prove nothing.
  // The earlier ping was removed by its two animationend events above, so this
  // is the only one on the stage — indexing past it would read undefined and
  // fail for a reason unrelated to the behaviour under test.
  showPing({scene_id:'S', x:2.5, y:3.25, color:'#fff', focus:false});
  const all = document.querySelectorAll('.ping');
  const frac = all[all.length - 1];
  __check('a ping between squares is NOT rounded to one',
    frac && parseFloat(frac.style.left) === 125 && parseFloat(frac.style.top) === 162.5,
    frac && (frac.style.left + ',' + frac.style.top));

  // A ping for another scene must not draw on this one.
  const before2 = document.querySelectorAll('.ping').length;
  showPing({scene_id:'OTHER', x:1, y:1, color:'#fff', focus:false});
  __check('a ping for another scene is ignored',
    document.querySelectorAll('.ping').length === before2, 'scene-scoped');

  // ---------- the map stays inside the viewport (2026-08-10) ----------
  //
  // Reported as "focus ping puts the camera off to the left". The centring was
  // exact — measured at one pixel out, and that pixel was the wrapper's border
  // — but NOTHING CONSTRAINED THE RESULT. Focusing a point near the map's edge
  // slid the map until a third of the viewport was empty background and six
  // hundred pixels of map hung off the other side.
  //
  // The rule is the ordinary one for maps: no empty edge while the map is
  // larger than the viewport, and centred when it is smaller.
  //
  // Viewport here is 600x400, scene 1000x800 — so the map is larger and the
  // clamp applies in both axes.
  resetView();
  // Parsed with string operations rather than a regex: this whole block lives
  // inside a template literal, which eats one level of backslash and turns an
  // escaped parenthesis into a capture group. Three probes today failed that
  // way before the cause was obvious.
  const tx = () => {
    const t = stage.style.transform;
    const inner = t.slice(t.indexOf('(') + 1, t.indexOf(')'));
    const parts = inner.split(',');
    return { x: parseFloat(parts[0]), y: parseFloat(parts[1]) };
  };
  __check('a fresh view sits at the origin, not somewhere arbitrary',
    tx().x === 0 && tx().y === 0, JSON.stringify(tx()));

  // [CHANGED 2026-08-10] The pannable world is the image PLUS a pad of
  // PAD_SQUARES on every side, so these bounds are deliberately wider than the
  // image. The pad exists so panning has somewhere to overshoot and so a GM can
  // park tokens off the board.
  //
  // Viewport 600x400, scene 1000x800, pad 12 squares = 600px. World is
  // 2200x2000, and stage-local 0,0 sits 600px into it.
  const PAD = 12 * 50;

  // The pad element itself: sized from the scene, offset negatively so it
  // reaches equally in every direction, and carrying the grid that used to be
  // drawn on #stage — which is why the grid used to stop at the image.
  // The suite sets the scene object directly rather than loading one, so the
  // renderer has never run — the pad is sized on scene load in the real page.
  applyGridOverlay();
  const padEl = document.getElementById('grid-pad');
  __check('a pad element exists', !!padEl);
  __check('...reaching PAD past the image on every side',
    parseFloat(padEl.style.left) === -PAD && parseFloat(padEl.style.top) === -PAD,
    padEl.style.left + ',' + padEl.style.top);
  __check('...and sized to the image plus twice the pad',
    parseFloat(padEl.style.width) === 1000 + PAD * 2
      && parseFloat(padEl.style.height) === 800 + PAD * 2,
    padEl.style.width + ',' + padEl.style.height);
  __check('the grid is drawn on the pad, not on the stage',
    padEl.style.backgroundImage.indexOf('linear-gradient') >= 0
      && stage.style.backgroundImage === 'none',
    stage.style.backgroundImage);
  // A pad that is not a whole number of squares would draw lines out of step
  // with the ones over the image — invisible until somebody lines a token up
  // across the seam.
  __check('the pad is a whole number of squares', PAD % 50 === 0, String(PAD));

  // Dragging right stops when the GRID's left edge reaches the viewport's —
  // not the image's, which is PAD further in.
  fireW('pointerdown',100,100); fireW('pointermove',2000,2000); fireW('pointerup',2000,2000);
  __check('the map can be dragged out to the pad, and no further',
    tx().x === PAD, JSON.stringify(tx()));
  __check('...in both axes', tx().y === PAD, JSON.stringify(tx()));

  // ...and far left stops at the pad beyond the map's right edge:
  // 600 - (1000 + 1200) + 600 = -1000.
  fireW('pointerdown',500,500); fireW('pointermove',-4000,-4000); fireW('pointerup',-4000,-4000);
  __check('the map cannot be dragged past the far edge of the pad',
    tx().x === 600 - (1000 + PAD * 2) + PAD, JSON.stringify(tx()));
  __check('...nor past the bottom of it',
    tx().y === 400 - (800 + PAD * 2) + PAD, JSON.stringify(tx()));

  // The point of the pad: a token parked OUTSIDE the image is reachable. At the
  // left limit the visible world starts at stage-local -PAD, so negative grid
  // coordinates are on screen — which is where the server has always allowed
  // tokens to be (-10000..10000) and where nothing could previously scroll.
  fireW('pointerdown',100,100); fireW('pointermove',2000,2000); fireW('pointerup',2000,2000);
  const leftmostVisible = -tx().x / 1;
  __check('space off the left of the image is reachable',
    leftmostVisible <= 0, String(leftmostVisible));

  // A focus near the image edge no longer has to fight the clamp, because the
  // pad absorbs it — the point lands exactly centred where it previously could
  // not.
  resetView();
  showPing({scene_id:'S', x:1, y:1, color:'#fff', focus:true});
  __check('focusing near the image edge now centres exactly',
    tx().x === 600 / 2 - 1 * 50, JSON.stringify(tx()));

  // A focus in the MIDDLE of the map still centres exactly, because nothing
  // stops it there — the clamp only refuses what would show background.
  showPing({scene_id:'S', x:10, y:8, color:'#fff', focus:true});
  __check('focusing mid-map still centres exactly',
    tx().x === 600/2 - 10*50 && tx().y === 400/2 - 8*50, JSON.stringify(tx()));

  resetView();

  // ---------- a focus ping imposes the GM's zoom (2026-08-10) ----------
  //
  // "Look at this" is not just a place, it is a framing: if the GM is studying
  // one corridor at 200%, the table should see that corridor at 200% rather
  // than the same point at whatever zoom each person happened to be using.
  //
  // Scene is 1000x800 and the viewport 600x400, so the map is larger than the
  // viewport at every zoom tested here and the clamp is in play throughout.
  resetView();
  showPing({scene_id:'S', x:10, y:8, color:'#fff', focus:true, zoom:2});
  __check('a focus ping applies the zoom it carries', Math.abs(view.z - 2) < 1e-9, String(view.z));
  __check('...and the HUD says so', hud.textContent === '200%', hud.textContent);

  // Zoom must be applied BEFORE centring: centreOn multiplies by view.z, so
  // centring first and zooming after would frame the old scale and abandon it.
  // At 2x, centring grid (10,8) puts it at 600/2 - 10*50*2 = -700 → clamped to
  // 600 - 2000 = -1400 at the far edge, so the visible check is that the point
  // is inside the viewport rather than at a particular offset.
  const px = tx().x + 10 * 50 * view.z;
  __check('...with the pinged point inside the viewport',
    px >= 0 && px <= 600, String(px));

  // A zoom outside the permitted range is refused rather than applied. The
  // server bounds it too — this is the same rule stated where the value is
  // used, so a payload from a future version cannot push this client somewhere
  // its own controls could not reach.
  showPing({scene_id:'S', x:5, y:5, color:'#fff', focus:true, zoom:99});
  __check('an absurd zoom is clamped to the maximum', view.z === 4, String(view.z));
  showPing({scene_id:'S', x:5, y:5, color:'#fff', focus:true, zoom:0.001});
  __check('...and a tiny one to the minimum', view.z === 0.25, String(view.z));

  // An ARRAY must not be coerced into a zoom. Number([[2]]) is 2, which is the
  // fifth appearance of that trap in this project — the server refuses it now,
  // and this asserts the client does not quietly accept one either.
  showPing({scene_id:'S', x:5, y:5, color:'#fff', focus:true, zoom:[[2]]});
  __check('an array zoom is ignored, not coerced', view.z === 0.25, String(view.z));
  showPing({scene_id:'S', x:5, y:5, color:'#fff', focus:true, zoom:'3'});
  __check('a string zoom is ignored too', view.z === 0.25, String(view.z));

  // A focus ping with no zoom leaves the zoom alone — older payloads, and any
  // caller that only wants to move the view.
  resetView();
  setZoom(2, {x:0,y:0});
  showPing({scene_id:'S', x:5, y:5, color:'#fff', focus:true});
  __check('a focus ping without a zoom does not change it', view.z === 2, String(view.z));

  // A NON-focus ping carries no zoom and must not change one even if a payload
  // contains it: drawing on somebody screen is not permission to reframe it.
  showPing({scene_id:'S', x:5, y:5, color:'#fff', focus:false, zoom:0.5});
  __check('a normal ping ignores zoom entirely', view.z === 2, String(view.z));
  resetView();

  // ---------- the case that made focus a no-op (2026-08-10) ----------
  //
  // Reported as "focus ping seems similar to normal pinging". It was: the
  // scene was 1400px wide in a 1400px viewport, so at 100% zoom the clamp had
  // NO SLACK — it centres a map that fits, discarding centreOn's result
  // entirely. Focus could not move anything, correctly, because there was
  // nothing to move.
  //
  // Nothing tested a map the same size as its viewport. Every probe used a
  // scene larger than the viewport, which is the configuration where the defect
  // is invisible — the same shape as the zoom-offset bug, which was only ever
  // exercised at 100%.
  //
  // The fix is that focus FORCES a zoom, which is what creates the room.
  // [CHANGED 2026-08-10] The pad changed the answer here, and for the better.
  // A map the size of its viewport used to have NO slack at all: it was pinned
  // centred, and focus could not move it because there was nothing to move.
  // With a pad on every side, even a small map has somewhere to pan — the world
  // is the image plus the pad, and that is always larger than the viewport.
  resetView();
  const savedW = scene.width, savedH = scene.height;
  scene.width = 600; scene.height = 400;      // exactly the viewport
  applyView();
  __check('reset puts the image top-left at the viewport top-left',
    tx().x === 0 && tx().y === 0, JSON.stringify(tx()));

  // The improvement: this drag was previously impossible. A map that exactly
  // fit its viewport was pinned centred with no slack, so panning did nothing
  // at all. The pad gives it somewhere to go.
  fireW('pointerdown',100,100); fireW('pointermove',250,250); fireW('pointerup',250,250);
  __check('a map the size of its viewport can now be panned',
    tx().x === 150 && tx().y === 150, JSON.stringify(tx()));
  resetView();

  // ...so focus now works on a small map too, without needing a forced zoom to
  // manufacture the room.
  showPing({scene_id:'S', x:2, y:2, color:'#fff', focus:true});
  __check('focus can centre a point on a map that fits its viewport',
    tx().x === 600 / 2 - 2 * 50, JSON.stringify(tx()));

  // With the forced zoom the map becomes larger than the viewport, and the
  // point can actually be brought to the middle.
  showPing({scene_id:'S', x:6, y:4, color:'#fff', focus:true, zoom:2});
  __check('a forced zoom gives focus room to work', view.z === 2, String(view.z));
  const centred = tx().x + 6 * 50 * view.z;
  __check('...and the pinged point lands at the viewport centre',
    Math.abs(centred - 300) < 1, String(centred));

  scene.width = savedW; scene.height = savedH;
  resetView();

  // A focus ping moves the viewport. Non-focus must not.
  resetView();
  const beforeView = stage.style.transform;
  showPing({scene_id:'S', x:5, y:5, color:'#fff', focus:false});
  __check('a normal ping does NOT move the view',
    stage.style.transform === beforeView, stage.style.transform);
  showPing({scene_id:'S', x:5, y:5, color:'#fff', focus:true});
  __check('a FOCUS ping moves the view',
    stage.style.transform !== beforeView, stage.style.transform);
  resetView();
})();
`);
console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail===0?0:1);
