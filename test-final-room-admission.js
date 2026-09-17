// Controlled scheduling: actual socket handlers, simulated DB/Socket.IO adapter.
const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
let passed=0,failed=0;
const check=(name,ok)=>{console.log(`  ${ok?'PASS':'FAIL'}  ${name}`);ok?passed++:failed++;};
function latch(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function run(lobby, revoked, action = "evict"){
 const gate=latch(),reached=latch(),handlers={},rooms=new Map(),sockets=new Map();
 let active=true,connection;
 const socket={id:'s',connected:true,request:{user:{id:'u',username:'member'}},data:{},rooms:new Set(['s']),
  on:(event,fn)=>{handlers[event]=fn;},emit(){},to:()=>({emit(){}}),
  join(room){this.rooms.add(room);if(!rooms.has(room))rooms.set(room,new Set());rooms.get(room).add(this.id);},
  leave(room){this.rooms.delete(room);rooms.get(room)?.delete(this.id);},
 };
 sockets.set('s',socket);
 const io={sockets:{sockets,adapter:{rooms}},on:(event,fn)=>{connection=fn;},to:()=>({emit(){}})};
 async function snapshot(value){const captured=value;reached.resolve();await gate.promise;return captured;}
 const knex=()=>{const q={join(){return q;},where(){return q;},andWhere(){return q;},whereNull(){return q;},select:()=>snapshot(active?[{id:'c'}]:[])};return q;};
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/src/socket.js','utf8'),{module,console:{log(){},error:console.error},require(name){
  if(name==='./db')return knex;
  if(name==='./services/socketSessions')return {createSocketSessions:()=>({attach:()=>true,disconnectSessions(){}})};
  if(name==='./middleware/campaignAuth')return {isActiveMember:()=>snapshot(active)};
  if(name==='./services/mediaGateway')return {rewritePayload:async()=>{}};
  if(name==='./routes/scenes')return {};
  if(name==='./services/sceneAccess')return {};
  throw new Error(name);
 }});
 const api=module.exports.initSockets(io);connection(socket);
 let response;
 const work=handlers[lobby?'lobby:subscribe':'campaign:join']({campaign_id:'c'},r=>{response=r;});
 await reached.promise;
 if(revoked){active=false;if(action==='delete')api.evictCampaign('c');else if(action==='close')api.evictGamePlayers('c','gm');else api.evictUser('c','u');}
 gate.resolve();await work;
 const joined=socket.rooms.has((lobby?'lobby:':'campaign:')+'c');
 check((lobby?'lobby':'game')+' '+action+(revoked?': pending join cannot undo eviction':': normal subscription works'),revoked?!joined:joined&&response?.ok===true);
}
(async()=>{try{for(const lobby of [false,true]){await run(lobby,false);await run(lobby,true);await run(lobby,true,'delete');}await run(false,true,'close');}catch(e){failed++;console.error('SUITE ERROR:',e);}console.log(`\n${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;})();
