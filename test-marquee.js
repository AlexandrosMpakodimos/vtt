const { JSDOM } = require('jsdom'); const fs = require('fs');
const dom = new JSDOM(fs.readFileSync('public/scene.html','utf8'), { runScripts:'outside-only', url:'http://localhost:3000/scene.html' });
const { window } = dom; const { document } = window;
window.io=()=>({on(){},emit(){}}); window.fetch=async()=>({status:200,json:async()=>({user:{id:'GM'}})});
window.CSS={escape:s=>s};
window.PointerEvent=class extends window.MouseEvent{constructor(t,o={}){super(t,o);this.pointerId=o.pointerId||1;}};
window.Element.prototype.setPointerCapture=function(){}; window.Element.prototype.releasePointerCapture=function(){};
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
  const fire=(t,ty,x,y,ex={})=>t.dispatchEvent(new PointerEvent(ty,{bubbles:true,cancelable:true,clientX:x,clientY:y,pointerId:1,button:0,...ex}));

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
})();
`);
console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail===0?0:1);
