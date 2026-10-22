const {test}=require('node:test');
const assert=require('node:assert/strict');
globalThis.crypto ||= require('node:crypto').webcrypto;
require('../ui/online-rules.js');
require('../ui/online-transport.js');
const {Queue}=require('../ui/matchmaking.js');
const N=globalThis.SeaOnlineTransport;
const config={key:'pk_live_fixture_only_123456'};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=1200){const start=Date.now();while(Date.now()-start<timeout){if(fn())return;await sleep(4)}throw Error('Queue did not converge');}
function hub(drop=()=>false){
  const clients=new Map(), packets=[];let index=0;
  const emit=(socket,data)=>queueMicrotask(()=>{if(socket.readyState===1&&!drop(data))socket.onmessage?.({data:JSON.stringify(data)})});
  class Socket {
    constructor(){this.id=`peer-${++index}`;this.readyState=1;clients.set(this.id,this);queueMicrotask(()=>emit(this,{type:'welcome',peerId:this.id}));}
    send(text){const msg=JSON.parse(text);packets.push({from:this.id,...structuredClone(msg)});
      if(msg.type==='subscribe'){
        this.channel=msg.channel;emit(this,{type:'ack',requestId:msg.requestId});
        for(const s of clients.values())if(s.channel===this.channel)emit(s,{type:'presence',channel:this.channel,joined:[{peerId:this.id}]});
      }else if(msg.type==='publish'){
        for(const s of clients.values())if(s.channel===msg.channel)emit(s,{type:'message',channel:msg.channel,from:this.id,data:msg.data});
      }else if(msg.type==='send'){
        const s=clients.get(msg.to);if(s)emit(s,{type:'direct',from:this.id,data:msg.data});else emit(this,{type:'error',code:'peer_not_found'});
      }
    }
    close(){this.readyState=3;clients.delete(this.id);for(const s of clients.values())if(s.channel===this.channel)emit(s,{type:'presence',channel:this.channel,left:[{peerId:this.id}]});}
  }
  return {Socket,packets,emit,clients};
}
test('two strangers pair privately, same room and pinned opposite identities',async()=>{
  const h=hub(),found=[],counts=[];
  const a=new Queue(config,{matched:s=>found.push(s),count:n=>counts.push(n)},{WebSocket:h.Socket});
  const b=new Queue(config,{matched:s=>found.push(s)},{WebSocket:h.Socket});
  try{
    await a.connect();await until(()=>counts.includes(1));await b.connect();await until(()=>found.length===2);
    const [x,y]=found;assert.equal(x.room,y.room);assert.equal(x.secret,y.secret);assert.notEqual(x.role,y.role);
    assert.equal(x.opponent,y.id);assert.equal(y.opponent,x.id);assert.ok(counts.some(n=>n>=2));
    const publicPackets=h.packets.filter(p=>p.type==='publish');
    assert.ok(publicPackets.length);assert.ok(publicPackets.every(p=>!JSON.stringify(p).includes('SB2.')));
    assert.ok(publicPackets.every(p=>!JSON.stringify(p).includes(x.secret)));
  }finally{a.close();b.close();}
});
test('four concurrent searches produce two disjoint matches',async()=>{
  const h=hub(),found=[],queues=Array.from({length:4},()=>new Queue(config,{matched:s=>found.push(s)},{WebSocket:h.Socket}));
  try{await Promise.all(queues.map(q=>q.connect()));await until(()=>found.length===4);
    const groups=new Map();for(const s of found){if(!groups.has(s.room))groups.set(s.room,[]);groups.get(s.room).push(s);}assert.equal(groups.size,2);
    for(const pair of groups.values()){assert.equal(pair.length,2);assert.notEqual(pair[0].role,pair[1].role);}
  }finally{queues.forEach(q=>q.close());}
});
test('cancel removes waiting player; broadcast invitation never starts a game',async()=>{
  const h=hub();let matched=0,lastCount;
  const a=new Queue(config,{matched:()=>matched++,count:n=>lastCount=n},{WebSocket:h.Socket});
  const b=new Queue(config,{matched:()=>matched++},{WebSocket:h.Socket});
  try{
    await a.connect();await until(()=>a.healthy);await b.connect();b.close();await sleep(25);assert.equal(matched,0);
    const fake=await N.createSession(config);
    h.emit(a.ws,{type:'message',channel:'sea-battle/matchmaking-v1',from:'peer-fake',data:{sbq:1,kind:'offer',id:'a'.repeat(64),token:'b'.repeat(64),invite:N.invitation(fake)}});
    await sleep(15);assert.equal(matched,0);assert.equal(a.lock,null);assert.equal(lastCount,1);
    assert.equal(a.timers.size>0,true);a.close();assert.equal(a.timers.size,0);
  }finally{a.close();b.close();}
});
test('invalid subscription reports unknown count, not zero online',async()=>{
  const h=hub(),counts=[];let stopped=0;
  const a=new Queue(config,{count:n=>counts.push(n),stopped:()=>stopped++},{WebSocket:h.Socket});
  await a.connect();await until(()=>a.healthy);
  h.emit(a.ws,{type:'error',code:'channel_not_authorized'});await until(()=>stopped===1);
  assert.equal(a.closed,true);assert.equal(counts.at(-1),null);assert.ok(!counts.includes(0));
});
test('lost final readiness is retried without matching either player twice',async()=>{
  let lost=false;const h=hub(data=>{if(!lost&&data.data?.kind==='ready'){lost=true;return true}return false}),found=[];
  const players=Array.from({length:2},()=>new Queue(config,{matched:s=>found.push(s)},{WebSocket:h.Socket}));
  try{await Promise.all(players.map(q=>q.connect()));await until(()=>found.length===2,4000);assert.equal(lost,true);assert.equal(found[0].room,found[1].room);await sleep(20);assert.equal(found.length,2);}
  finally{players.forEach(q=>q.close());}
});
