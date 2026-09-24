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
function database({session=true,member='active',open=true,owner=false,deleted=false}={}) {
  let locked=false;const queries=[];
  const db={transaction:async fn=>{
    const trx=table=>{
      const q={where(){return q;},forShare(){queries.push(table);return q;},first:async()=>{
        if(table==='campaigns')return {id:campaignId,owner_id:owner?user:'other',is_open:open,deleted_at:deleted?new Date():null};
        if(table==='session')return session&&{sess:{passport:{user}},expire:new Date(Date.now()+60000)};
        if(table==='campaign_members')return {status:member};
      }};return q;
    };
    trx.fn={now:()=> 'DB_NOW'};trx.raw=async sql=>sql.startsWith('SELECT')?{rows:[{now:new Date()}]}:{};
    locked=true;try{return await fn(trx);}finally{locked=false;}
  }};
  return {db,queries,get locked(){return locked;}};
}
module.exports = { broker, database, socket, user, campaignId };
