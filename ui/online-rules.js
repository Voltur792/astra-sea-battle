/* Two independent local fleets; only moves and salted commitments cross the wire. */
(function (root) {
  'use strict';
  const FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
  const LETTERS = 'АБВГДЕЖЗИК';
  const clone = value => JSON.parse(JSON.stringify(value));
  const other = role => role === 'host' ? 'guest' : 'host';
  const hex = bytes => Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
  const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
  const assert = (ok, text) => { if (!ok) throw new Error(text); };
  const canonical = fleet => fleet.map(ship => [...ship].sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
  const label = cell => `${LETTERS[cell % 10]}${Math.floor(cell / 10) + 1}`;
  const neighbors = cell => {
    const found = [];
    for (let r = -1; r <= 1; r++) for (let c = -1; c <= 1; c++) {
      const row = Math.floor(cell / 10) + r, col = cell % 10 + c;
      if (row >= 0 && row < 10 && col >= 0 && col < 10) found.push(row * 10 + col);
    }
    return found;
  };
  function validate(fleet, complete = true) {
    assert(Array.isArray(fleet) && fleet.length <= 10, 'На поле может быть не больше 10 кораблей.');
    const remaining = [...FLEET], occupied = new Set();
    for (const ship of fleet) {
      assert(Array.isArray(ship) && remaining.includes(ship.length), 'Неверный состав флота.');
      remaining.splice(remaining.indexOf(ship.length), 1);
      const cells = [...ship].sort((a, b) => a - b);
      assert(cells.every(c => Number.isInteger(c) && c >= 0 && c < 100), 'Корабль выходит за границы поля.');
      const horizontal = cells.every(c => Math.floor(c / 10) === Math.floor(cells[0] / 10));
      const step = horizontal ? 1 : 10;
      assert(cells.every((c, i) => c === cells[0] + step * i), 'Корабль должен быть прямым, без пропусков.');
      assert(cells.every(c => !neighbors(c).some(n => occupied.has(n))), 'Корабли не должны соприкасаться даже углами.');
      cells.forEach(c => occupied.add(c));
    }
    assert(!complete || remaining.length === 0, 'Расставь все 10 кораблей перед готовностью.');
    return canonical(fleet);
  }
  function randomFleet() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const fleet = [];
      for (const length of FLEET) {
        const choices = [];
        for (let cell = 0; cell < 100; cell++) for (const step of [1, 10]) {
          const ship = Array.from({length}, (_, i) => cell + i * step);
          if (step === 1 && Math.floor(ship.at(-1) / 10) !== Math.floor(cell / 10)) continue;
          try { validate([...fleet, ship], false); choices.push(ship); } catch (_) { /* invalid position */ }
        }
        if (!choices.length) break;
        const n = crypto.getRandomValues(new Uint32Array(1))[0] % choices.length;
        fleet.push(choices[n]);
      }
      if (fleet.length === 10) return validate(fleet);
    }
    throw new Error('Не удалось расставить флот. Попробуй ещё раз.');
  }
  async function commitment(room, role, fleet, salt) {
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
      JSON.stringify(['sea-battle-v1', room, role, validate(fleet), salt])
    ))));
  }
  class Match {
    constructor(room, role, state = null) {
      assert(/^[a-f0-9]{64}$/.test(room) && ['host', 'guest'].includes(role), 'Некорректная сетевая партия.');
      this.room = room; this.role = role;
      this.s = state ? clone(state) : {
        fleet: [], salt: '', commits: {}, seq: {host: 0, guest: 0}, history: [],
        shots: {host: [], guest: []}, turn: '', move: 0, pending: null,
        over: false, winner: '', surrenders: {}, reveals: {}, verification: 'pending'
      };
      this.s.surrenders ||= {};
    }
    export() { return clone(this.s); }
    get ready() { return !!this.s.commits[this.role]; }
    get started() { return !!this.s.turn; }
    get canFire() { return this.started && !this.s.over && !this.s.pending && this.s.turn === this.role; }
    place(cell, length, vertical) {
      assert(!this.ready && !this.s.over, 'Расстановка уже зафиксирована.');
      assert(Number.isInteger(cell) && cell >= 0 && cell < 100, 'Неверная клетка.');
      const index = this.s.fleet.findIndex(ship => ship.includes(cell));
      if (index !== -1) { this.s.fleet.splice(index, 1); return; }
      assert(Number.isInteger(length) && FLEET.includes(length), 'Выбери длину корабля.');
      const ship = Array.from({length}, (_, i) => cell + (vertical ? 10 : 1) * i);
      assert(vertical || Math.floor(ship.at(-1) / 10) === Math.floor(cell / 10), 'Корабль выходит за край поля.');
      this.s.fleet = validate([...this.s.fleet, ship], false);
    }
    randomize() { assert(!this.ready && !this.s.over, 'Расстановка уже зафиксирована.'); this.s.fleet = randomFleet(); }
    clear() { assert(!this.ready && !this.s.over, 'Расстановка уже зафиксирована.'); this.s.fleet = []; }
    async seal() {
      assert(!this.ready && !this.s.over, 'Готовность уже подтверждена.');
      validate(this.s.fleet);
      this.s.salt = random();
      const commit = await commitment(this.room, this.role, this.s.fleet, this.s.salt);
      await this._emit('ready', {commit});
    }
    async fire(cell) {
      assert(this.canFire, 'Сейчас нельзя стрелять: дождись соединения и своего хода.');
      await this._emit('shot', {cell, move: this.s.move});
    }
    async surrender() { assert(!this.s.over, 'Партия уже завершена.'); await this._emit('surrender', {}); await this.settle(); }
    async _emit(kind, data) {
      const packet = {v: 1, room: this.room, role: this.role, seq: this.s.seq[this.role] + 1,
        seen: this.s.seq[other(this.role)], kind, data};
      await this._apply(packet);
    }
    async receive(packet) {
      assert(packet && packet.v === 1 && packet.room === this.room && packet.role === other(this.role), 'Сообщение другой партии.');
      assert(Number.isInteger(packet.seq) && packet.seq > 0, 'Неверный номер сообщения.');
      assert(Number.isInteger(packet.seen) && packet.seen >= 0 && packet.seen <= this.s.seq[this.role], 'Неверное подтверждение очереди ходов.');
      if (packet.seq <= this.s.seq[packet.role]) {
        const old = this.s.history.find(p => p.role === packet.role && p.seq === packet.seq);
        assert(JSON.stringify(old) === JSON.stringify(packet), 'Соперник изменил уже принятый ход.');
        await this.settle(); return;
      }
      assert(packet.seq === this.s.seq[packet.role] + 1, 'Пропущено сообщение. Переподключись для восстановления партии.');
      const before = this.export();
      try { await this._apply(packet); await this.settle(); }
      catch (error) { this.s = before; throw error; }
    }
    async settle() {
      const pending = this.s.pending;
      if (pending && pending.by !== this.role && !this.s.over) {
        const ship = this.s.fleet.find(ship => ship.includes(pending.cell));
        const fired = new Set(this.s.shots[pending.by].map(shot => shot.cell)); fired.add(pending.cell);
        const sunk = ship && ship.every(c => fired.has(c));
        await this._emit('result', {move: pending.move, cell: pending.cell,
          result: !ship ? 'miss' : sunk ? 'sunk' : 'hit', ship: sunk ? ship : []});
      }
      if (this.s.over && this.ready && !this.s.reveals[this.role]) {
        await this._emit('reveal', {fleet: this.s.fleet, salt: this.s.salt});
      }
    }
    async _apply(packet) {
      const {kind, role, data} = packet;
      assert(data && typeof data === 'object' && !Array.isArray(data), 'Неверный формат хода.');
      assert(this.s.history.length < 430, 'Превышен размер партии.');
      const s = this.s;
      // In-flight actions can cross a local surrender. They still consume their
      // sequence number, but must not restart a finished game or block replay.
      const localSurrender = s.surrenders[this.role];
      if (s.over && ['shot', 'result', 'ready'].includes(kind) && localSurrender && role !== this.role && packet.seen < localSurrender) {
        s.seq[role] = packet.seq; s.history.push(clone(packet)); return;
      }
      if (kind === 'ready') {
        assert(!s.over && !s.commits[role] && /^[a-f0-9]{64}$/.test(data.commit), 'Некорректная готовность.');
        s.commits[role] = data.commit;
        if (s.commits.host && s.commits.guest) {
          s.turn = ((parseInt(s.commits.host.slice(0, 8), 16) ^ parseInt(s.commits.guest.slice(0, 8), 16)) & 1) ? 'guest' : 'host';
        }
      } else if (kind === 'shot') {
        assert(s.turn === role && !s.over && !s.pending && data.move === s.move, 'Выстрел вне очереди.');
        assert(Number.isInteger(data.cell) && data.cell >= 0 && data.cell < 100, 'Недопустимая клетка.');
        assert(!s.shots[role].some(shot => shot.cell === data.cell), 'По этой клетке уже стреляли.');
        s.pending = {by: role, cell: data.cell, move: data.move};
      } else if (kind === 'result') {
        const p = s.pending;
        assert(p && !s.over && p.by !== role && p.cell === data.cell && p.move === data.move, 'Результат не соответствует выстрелу.');
        assert(['miss', 'hit', 'sunk'].includes(data.result) && Array.isArray(data.ship), 'Неверный результат выстрела.');
        const hits = new Set(s.shots[p.by].filter(shot => shot.result !== 'miss').map(shot => shot.cell));
        if (data.result !== 'miss') hits.add(data.cell);
        if (data.result === 'sunk') {
          validate([data.ship], false);
          assert(data.ship.includes(data.cell) && data.ship.every(c => hits.has(c)), 'Соперник сообщил неверное потопление.');
          const sunkBefore = s.shots[p.by].filter(shot => shot.result === 'sunk');
          assert(!sunkBefore.some(shot => shot.ship.some(c => neighbors(c).some(n => data.ship.includes(n)))), 'Потопленные корабли соприкасаются.');
          const lengths = sunkBefore.map(shot => shot.ship.length).concat(data.ship.length);
          const remaining = [...FLEET];
          for (const n of lengths) { assert(remaining.includes(n), 'Неверный состав потопленного флота.'); remaining.splice(remaining.indexOf(n), 1); }
        } else assert(data.ship.length === 0, 'Координаты передаются только для потопленного корабля.');
        s.shots[p.by].push(clone(data)); s.pending = null; s.move++;
        s.turn = data.result === 'miss' ? role : p.by;
        if (hits.size === 20) {
          assert(s.shots[p.by].filter(shot => shot.result === 'sunk').length === 10, 'Не подтверждено потопление полного флота.');
          s.over = true; s.winner = p.by;
        }
      } else if (kind === 'surrender') {
        assert(!s.surrenders[role], 'Повторная сдача.');
        const rivalSurrender = s.surrenders[other(role)];
        assert(!s.over || (rivalSurrender && packet.seen < rivalSurrender) || (!rivalSurrender && s.winner === other(role)), 'Партия уже завершена.');
        s.surrenders[role] = packet.seq;
        s.over = true; s.winner = rivalSurrender ? 'draw' : other(role); s.pending = null;
      } else if (kind === 'reveal') {
        assert(s.over && s.commits[role] && !s.reveals[role] && /^[a-f0-9]{64}$/.test(data.salt), 'Нельзя раскрыть флот сейчас.');
        const fleet = validate(data.fleet);
        const valid = (await commitment(this.room, role, fleet, data.salt)) === s.commits[role];
        let consistent = valid;
        const fired = new Set();
        for (const shot of s.shots[other(role)]) {
          fired.add(shot.cell);
          const ship = fleet.find(ship => ship.includes(shot.cell));
          const result = !ship ? 'miss' : ship.every(c => fired.has(c)) ? 'sunk' : 'hit';
          if (result !== shot.result || (result === 'sunk' && JSON.stringify(canonical([shot.ship])) !== JSON.stringify(canonical([ship])))) consistent = false;
        }
        s.reveals[role] = {fleet, valid: consistent};
        s.verification = Object.values(s.reveals).some(reveal => !reveal.valid) ? 'failed'
          : s.reveals.host && s.reveals.guest ? 'verified' : 'pending';
      } else throw new Error('Неизвестный тип игрового сообщения.');
      s.seq[role] = packet.seq; s.history.push(clone(packet));
    }
    outgoing(after = 0) { return this.s.history.filter(p => p.role === this.role && p.seq > after).map(clone); }
    map(own) {
      const role = own ? other(this.role) : this.role;
      const cells = Array(100).fill('unknown');
      const fleet = own ? this.s.fleet : this.s.over ? this.s.reveals[other(this.role)]?.fleet || [] : [];
      fleet.flat().forEach(c => { cells[c] = 'ship'; });
      for (const shot of this.s.shots[role]) {
        cells[shot.cell] = shot.result === 'miss' ? 'miss' : 'hit';
        if (shot.result === 'sunk') shot.ship.forEach(c => { cells[c] = 'sunk'; });
      }
      return cells;
    }
  }
  const api = {Match, FLEET, validate, randomFleet, commitment, other, label, random, canonical};
  root.SeaOnlineRules = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
