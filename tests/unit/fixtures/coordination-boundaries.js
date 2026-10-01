const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
// Transport boundary double: this does NOT execute Redis or the Lua script.
function broker() {
  const clients = [], nodes = new Map(); let epoch, full = false;
  function createClient(options) {
    assert.equal(options.disableOfflineQueue,true); assert.equal(options.socket.reconnectStrategy,false);
    const c = new EventEmitter(); clients.push(c);
    c.connect = async()=>{};
    c.subscribe = async(channel,receiver)=>{c.receiver=receiver;};
    c.publish = async(channel,value)=>{
      if(full) throw Error('simulated-full');
      for(const c of clients) if(c.receiver) queueMicrotask(()=>c.receiver?.(value));
      return clients.filter(c=>c.receiver).length;
    };
    c.eval = async(script,options)=>{
      if(full) throw Error('simulated-full');
      epoch ||= options.arguments[2]; nodes.set(options.arguments[0],options.arguments[1]);
      return [epoch,...nodes.values()];
    };
    c.destroy=()=>{c.receiver=null;}; return c;
  }
  return {createClient,clients,reset(){epoch=null;nodes.clear();},full(){full=true;}};
}
const user='11111111-1111-4111-8111-111111111111', campaignId='22222222-2222-4222-8222-222222222222';
const socket=()=>({connected:true,data:{userId:user,authSessionId:'fixture-session'}});
// Database double for the authorization checks. access() reads single rows
// with first(); accessMany() reads several with whereIn()/select(). Per-user
// overrides (`users`) let one batch mix allowed and refused recipients:
//   users: { [userId]: { session: false | 'locked', member: 'banned', sessionUser } }
// 'locked' models a session row another transaction holds: SKIP LOCKED leaves
// it out of the batch read, while access() (which waits) still sees it.
function database({session=true,member='active',open=true,owner=false,deleted=false,users={}}={}) {
  let locked=false;const queries=[];let transactions=0;
  const sessionRow=(sid,userId)=>{
    const o=users[userId]||{};const has=o.session===undefined?session:o.session;
    return has&&{sid,sess:{passport:{user:o.sessionUser||userId}},expire:new Date(Date.now()+60000)};
  };
  const db={transaction:async fn=>{
    transactions++;
    const trx=table=>{
      const filters={};let ins=null,skip=false;
      const q={
        where(k,v){if(typeof k==='object')Object.assign(filters,k);else filters[k]=v;return q;},
        whereIn(k,v){ins={k,v};return q;},orderBy(){return q;},skipLocked(){skip=true;return q;},
        forShare(){queries.push(table);return q;},
        first:async()=>{
          if(table==='campaigns')return {id:campaignId,owner_id:owner?user:'other',is_open:open,deleted_at:deleted?new Date():null};
          if(table==='session')return sessionRow(filters.sid,String(filters.sid).startsWith('sid-')?filters.sid.slice(4):user);
          if(table==='campaign_members')return {status:(users[filters.user_id||user]||{}).member||member};
        },
        select:async()=>{
          if(table==='session')return ins.v.map(sid=>{
            const userId=sid.replace(/^sid-/,'');const o=users[userId]||{};
            if(skip&&o.session==='locked')return null;
            return sessionRow(sid,userId);
          }).filter(Boolean);
          if(table==='campaign_members')return ins.v.map(id=>({user_id:id,status:(users[id]||{}).member||member}));
          return [];
        },
      };return q;
    };
    trx.fn={now:()=> 'DB_NOW'};trx.raw=async sql=>sql.startsWith('SELECT')?{rows:[{now:new Date()}]}:{};
    locked=true;try{return await fn(trx);}finally{locked=false;}
  }};
  return {db,queries,get locked(){return locked;},get transactions(){return transactions;}};
}
// A socket for user `id` whose session id is `sid-<id>` (the batch double's convention).
const socketFor=id=>({connected:true,data:{userId:id,authSessionId:'sid-'+id}});
module.exports = { broker, database, socket, socketFor, user, campaignId };
