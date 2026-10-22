const {test} = require('node:test');
const assert = require('node:assert/strict');
globalThis.crypto ||= require('node:crypto').webcrypto;
require('../ui/online-rules.js');
require('../ui/online-transport.js');
const {Router} = require('../ui/online-router.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class Fake {
  constructor(s, hooks) { this.hooks=hooks; this.iceServers=[]; this.connected=false; this.closed=false; }
  close() { this.closed=true; this.connected=false; }
  async connect() { this.closed=false; }
  async send() { return this.connected; }
}
test('bad or unavailable Metered advances to PeerJS, then manual without changing match', async () => {
  const session = {id:'stable',match:{fleet:'private'}}, notices=[];
  const router = new Router(session,{status:t=>notices.push(t)},{Primary:Fake,Backup:Fake,waitMs:100});
  await router.connect(); assert.equal(router.route,'metered');
  const first=router.active; first.hooks.unavailable(); await sleep(1);
  assert.equal(router.route,'peerjs'); assert.equal(first.closed,true);
  router.active.hooks.unavailable(); assert.equal(router.route,'manual'); assert.equal(router.needsManual,true);
  assert.deepEqual(session.match,{fleet:'private'}); router.close();
});
test('Metered waiting timeout also lets peers on different providers meet on PeerJS', async () => {
  const router=new Router({}, {}, {Primary:Fake,Backup:Fake,waitMs:8});
  await router.connect(); await sleep(25); assert.equal(router.route,'peerjs'); router.close();
});
test('established game survives signaling outage; stale old route cannot switch live route', async () => {
  const router=new Router({}, {}, {Primary:Fake,Backup:Fake,waitMs:100});
  await router.connect(); const first=router.active;
  const lateUnavailable=first.hooks.unavailable;
  lateUnavailable(); await sleep(1); const backup=router.active;
  backup.connected=true; backup.hooks.connection(true);
  lateUnavailable(); backup.hooks.unavailable(); await sleep(1);
  assert.equal(router.route,'peerjs'); assert.equal(router.connected,true); router.close();
});
test('lost established route resumes fallback instead of waiting forever', async () => {
  const router=new Router({}, {}, {Primary:Fake,Backup:Fake,waitMs:8});
  await router.connect(); const primary=router.active;
  primary.connected=true; primary.hooks.connection(true);
  primary.connected=false; primary.hooks.connection(false);
  await sleep(25); assert.equal(router.route,'peerjs'); router.close();
});
test('closing during async startup cancels all fallback timers', async () => {
  let release;
  class Slow extends Fake { async connect(){await new Promise(r=>release=r);} }
  const router=new Router({}, {}, {Primary:Slow,Backup:Fake,waitMs:2});
  const promise=router.connect(); router.close(); release(); await promise; await sleep(10);
  assert.equal(router.active,null); assert.equal(router.timer,null);
});
