/* Run with node --test tests/test_online_rules.cjs. No provider/network required. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
globalThis.crypto ||= require('node:crypto').webcrypto;
const R = require('../ui/online-rules.js');
const N = require('../ui/online-transport.js');
const room = 'a'.repeat(64);
const key = 'pk_live_offline_testing_12345678';
globalThis.SeaOnlineConfig = {key};

async function synchronize(a, b) {
  for (let i = 0; i < 450; i++) {
    let moved = false;
    for (const [source, target] of [[a, b], [b, a]]) {
      for (const packet of source.outgoing(target.s.seq[source.role])) {
        await target.receive(packet); moved = true;
      }
    }
    if (!moved) return;
  }
  throw new Error('Protocol did not converge');
}
async function pair() {
  const a = new R.Match(room, 'host'), b = new R.Match(room, 'guest');
  a.randomize(); b.randomize(); await a.seal(); await b.seal(); await synchronize(a, b);
  return [a, b];
}

test('manual placement checks edges, diagonal contact, stock, remove and readiness', async () => {
  const a = new R.Match(room, 'host');
  assert.throws(() => a.place(9, 4, false), /край/);
  assert.throws(() => a.place(99, 4, true), /границ/);
  a.place(0, 4, false);
  assert.throws(() => a.place(14, 3, false), /соприкасаться/);
  assert.throws(() => a.place(20, 4, false), /состав/);
  a.place(2, 4, false); assert.equal(a.s.fleet.length, 0);
  await assert.rejects(a.seal(), /все 10/);
  a.randomize(); await a.seal(); assert.throws(() => a.clear(), /зафиксирована/);
});

test('generated fleet is legal and commitment canonical, role/room/salt bound', async () => {
  for (let i = 0; i < 12; i++) R.validate(R.randomFleet());
  const fleet = R.randomFleet(), salt = R.random();
  const a = await R.commitment(room, 'host', fleet, salt);
  assert.equal(a, await R.commitment(room, 'host', fleet.reverse().map(ship => ship.reverse()), salt));
  assert.notEqual(a, await R.commitment(room, 'guest', fleet, salt));
  assert.notEqual(a, await R.commitment(room, 'host', fleet, R.random()));
});

test('both peers start same turn; ready packet contains no fleet or salt', async () => {
  const [a, b] = await pair(); assert.equal(a.s.turn, b.s.turn);
  const packet = a.outgoing()[0]; assert.equal(packet.kind, 'ready');
  assert.deepEqual(Object.keys(packet.data), ['commit']);
  assert.equal(b.s.reveals.host, undefined);
});

test('miss passes turn, hit retains it, repeated cell and wrong turn rejected', async () => {
  const [a, b] = await pair();
  const [shooter, defender] = a.canFire ? [a, b] : [b, a];
  await assert.rejects(defender.fire(0), /нельзя/);
  const hit = defender.s.fleet[0][0]; await shooter.fire(hit); await synchronize(a, b);
  assert.equal(shooter.canFire, true);
  await assert.rejects(shooter.fire(hit), /уже стреляли/);
  const empty = Array.from({length: 100}, (_, i) => i).find(c => !defender.s.fleet.flat().includes(c));
  await shooter.fire(empty); await synchronize(a, b);
  assert.equal(defender.canFire, true); assert.equal(a.s.move, b.s.move);
});

test('duplicate packets idempotent; altered duplicate and missing seq rejected', async () => {
  const [a, b] = await pair(); const packet = a.outgoing()[0];
  const before = b.export(); await b.receive(packet); assert.deepEqual(b.export(), before);
  await assert.rejects(b.receive({...packet, data: {commit: 'b'.repeat(64)}}), /изменил/);
  await assert.rejects(b.receive({...packet, seq: 12}), /Пропущено/);
  await assert.rejects(b.receive({...packet, room: 'b'.repeat(64)}), /другой партии/);
});

test('pending shot survives reload and defender recovers result after disconnect', async () => {
  let [a, b] = await pair(); const shooter = a.canFire ? a : b;
  await shooter.fire(0);
  a = new R.Match(room, 'host', a.export()); b = new R.Match(room, 'guest', b.export());
  await synchronize(a, b);
  assert.equal(a.s.pending, null); assert.equal(b.s.pending, null); assert.equal(a.s.move, 1); assert.equal(b.s.move, 1);
  assert.equal(a.s.turn, b.s.turn);
});

test('entire game converges, ten sunk ships and final fleets verify', async () => {
  const [a, b] = await pair();
  for (let move = 0; move < 200 && !a.s.over; move++) {
    const [shooter, defender] = a.canFire ? [a, b] : [b, a];
    const fired = new Set(shooter.s.shots[shooter.role].map(s => s.cell));
    // Test fixture chooses known ship cells to complete a full game quickly.
    const cell = defender.s.fleet.flat().find(c => !fired.has(c));
    await shooter.fire(cell); await synchronize(a, b);
  }
  assert.equal(a.s.over, true); assert.equal(b.s.over, true); assert.equal(a.s.winner, b.s.winner);
  assert.equal(a.s.verification, 'verified'); assert.equal(b.s.verification, 'verified');
  assert.equal(a.s.shots[a.s.winner].filter(s => s.result === 'sunk').length, 10);
});

test('surrender reveals only at end; modified opening fails verification', async () => {
  const [a, b] = await pair(); await a.surrender();
  const packets = a.outgoing(b.s.seq.host);
  await b.receive(packets[0]);
  const reveal = structuredClone(packets[1]); reveal.data.salt = R.random();
  await b.receive(reveal); assert.equal(b.s.verification, 'failed');
});

test('impossible result rolls back all mutation', async () => {
  const [a, b] = await pair(); const [shooter, defender] = a.canFire ? [a, b] : [b, a];
  await shooter.fire(0); const before = shooter.export();
  await assert.rejects(shooter.receive({v: 1, room, role: defender.role, seen: shooter.s.seq[shooter.role], seq: defender.s.seq[defender.role] + 1,
    kind: 'result', data: {cell: 0, move: 0, result: 'sunk', ship: [0, 1]}}), /неверное потопление/);
  assert.deepEqual(shooter.export(), before);
});

test('simultaneous surrender converges to draw; in-flight shot cannot restart match', async () => {
  const [a, b] = await pair(); await Promise.all([a.surrender(), b.surrender()]); await synchronize(a, b);
  assert.equal(a.s.winner, 'draw'); assert.equal(b.s.winner, 'draw');
  const [c, d] = await pair(), [shooter, defender] = c.canFire ? [c, d] : [d, c];
  await shooter.fire(0); await defender.surrender(); await synchronize(c, d);
  assert.equal(c.s.winner, shooter.role); assert.equal(d.s.winner, shooter.role);
});

test('invitation shares room secret only, never service keys, fleet or identity', async () => {
  const host = await N.createSession({key}); host.match = {fleet: [[0]]};
  const invite = N.invitation(host), guest = await N.joinSession(invite);
  const decoded = Buffer.from(invite.slice(4), 'base64url').toString('utf8');
  assert.equal(decoded.includes(key), false); assert.equal(decoded.includes('fleet'), false);
  assert.equal(guest.room, host.room); assert.equal(guest.secret, host.secret);
  assert.equal(guest.role, 'guest'); assert.notEqual(guest.id, host.id); assert.equal(guest.match, null);
  await assert.rejects(N.joinSession('SB1.not-a-valid-invitation'));
  assert.throws(() => N.configuration({key: 'sk_secret_1234567890'}), /публичный/);
});

test('transport encrypts signaling and pins opponent, wrong secret rejected', async () => {
  const host = await N.createSession({key}), guest = await N.joinSession(N.invitation(host));
  const a = new N.Transport(host), b = new N.Transport(guest);
  const importKey = secret => crypto.subtle.importKey('raw', Buffer.from(secret, 'hex'), 'AES-GCM', false, ['encrypt', 'decrypt']);
  a.key = await importKey(host.secret); b.key = await importKey(guest.secret);
  const encoded = await a.encrypt('hello', {}); assert.equal(JSON.stringify(encoded).includes(host.id), false);
  assert.equal((await b.decrypt(encoded)).id, host.id);
  guest.opponent = '0'.repeat(64); assert.equal(await b.decrypt(encoded), null);
  guest.opponent = ''; b.key = await importKey(R.random()); assert.equal(await b.decrypt(encoded), null);
});
