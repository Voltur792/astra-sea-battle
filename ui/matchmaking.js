/* Anonymous, opt-in queue. Private invitations use Metered direct messages only. */
(function(root) {
  'use strict';
  const N = root.SeaOnlineTransport, R = root.SeaOnlineRules;
  const CHANNEL = 'sea-battle/matchmaking-v1';
  const validId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  class Queue extends N.Transport {
    constructor(config, hooks = {}, dependencies = {}) {
      super({config: N.configuration(config)}, hooks, dependencies);
      this.members = new Map(); this.lock = null; this.done = false;
    }
    async connect() {
      this.close(); this.closed = false; this.failedOnce = false; this.healthy = false;
      this.members.clear(); this.lock = null; this.done = false; this.queueId = R.random();
      this.status('Подключаемся к очереди поиска…'); this.hooks.count?.(null);
      this.openSocket();
      this.schedule(() => { this.status('Поиск остановлен через 3 минуты. Можно повторить поиск или пригласить друга.'); this.close(); this.hooks.count?.(null); this.hooks.stopped?.(); }, 180000);
    }
    unavailable() {
      if (this.closed) return;
      this.close(); this.hooks.count?.(null);
      this.status('Очередь поиска недоступна. Попробуй позже или создай комнату для друга.', true);
      this.hooks.stopped?.();
    }
    sendQueueMessage(data, peer = '') {
      return this.requestServer(peer ? 'send' : 'publish', peer ? {to: peer, data: {sbq: 1, ...data}}
        : {channel: CHANNEL, data: {sbq: 1, ...data}});
    }
    advertise() { this.sendQueueMessage({kind: 'waiting', id: this.queueId, busy: !!this.lock || this.done}); }
    count() {
      const now = Date.now();
      for (const [peer, member] of this.members) if (now - member.seen > 70000) this.members.delete(peer);
      this.hooks.count?.(this.healthy && !this.closed ? 1 + [...this.members.values()].filter(m => !m.busy).length : null);
    }
    pulse() {
      if (this.closed || this.done) return;
      this.advertise(); this.count();
      this.schedule(() => this.pulse(), 30000);
    }
    async consider() {
      if (this.closed || this.done || this.lock || !this.healthy) return;
      this.count();
      const candidates = [...this.members].filter(([peer, m]) => !m.busy && this.localPeer < peer);
      if (!candidates.length) return;
      const [peer, member] = candidates[crypto.getRandomValues(new Uint32Array(1))[0] % candidates.length];
      const lock = this.lock = {peer, id: member.id, token: R.random(), phase: 'offer'};
      this.advertise();
      const session = await N.createSession(this.session.config);
      if (this.closed || this.lock !== lock) return;
      session.id = this.queueId; session.opponent = member.id; lock.session = session;
      lock.packet = {kind: 'offer', token: lock.token, id: this.queueId, invite: N.invitation(session)};
      this.retryLock(lock);
      this.status('Соперник найден. Подтверждаем подключение…');
    }
    retryLock(lock, attempt = 0) {
      if (this.closed || this.lock !== lock || this.done) return;
      if (attempt >= 8) { this.release(); return; }
      this.sendQueueMessage(lock.packet, lock.peer);
      this.schedule(() => this.retryLock(lock, attempt + 1), 1500);
    }
    release() {
      if (this.closed || this.done) return;
      this.lock = null; this.advertise(); this.count();
      this.status('Соперник не подтвердил подключение. Продолжаем поиск…');
      this.schedule(() => this.consider(), 700 + crypto.getRandomValues(new Uint32Array(1))[0] % 1500);
    }
    async matched(lock) {
      if (this.closed || this.done || this.lock !== lock) return;
      this.done = true; this.advertise(); this.hooks.count?.(null);
      // Keep the queue socket briefly to answer a duplicated commit if READY was lost.
      this.schedule(() => this.close(), 8000);
      await this.hooks.matched?.(lock.session);
    }
    async onServer(message) {
      if (this.closed) return;
      if (message.type === 'welcome') {
        this.localPeer = message.peerId;
        this.requestServer('subscribe', {channel: CHANNEL}); this.subscribeRequest = String(this.request);
      } else if (message.type === 'ack' && message.requestId === this.subscribeRequest && !this.healthy) {
        this.healthy = true; this.pulse(); this.status('Ищем соперника. Оставь вкладку открытой.');
      } else if (message.type === 'presence' && message.channel === CHANNEL) {
        for (const peer of message.left || []) {
          const id = typeof peer === 'string' ? peer : peer.peerId;
          this.members.delete(id);
          if (this.lock?.peer === id && !this.done) this.release();
        }
        if (!this.done && !this.lock && (message.joined || []).some(p => p.peerId !== this.localPeer)) this.advertise();
        this.count();
      } else if (message.type === 'error') {
        if (message.code === 'peer_not_found') this.release(); else this.unavailable();
      } else if (message.type === 'direct' || (message.type === 'message' && message.channel === CHANNEL)) {
        const data = message.data, peer = message.from;
        if (!data || data.sbq !== 1 || typeof peer !== 'string' || !peer || peer.length > 200 || peer === this.localPeer) return;
        if (data.kind === 'waiting' && message.type === 'message' && validId(data.id) && typeof data.busy === 'boolean') {
          if (this.done) return;
          if (!this.members.has(peer) && this.members.size >= 100) return;
          this.members.set(peer, {id: data.id, busy: data.busy, seen: Date.now()}); this.count();
          await this.consider(); return;
        }
        // Never accept invitations broadcast to the public queue.
        if (message.type !== 'direct' || !validId(data.token)) return;
        if (data.kind === 'offer') {
          if (this.done || this.lock) {
            if (this.lock?.peer === peer && this.lock.token === data.token && this.lock.phase === 'accept') this.sendQueueMessage(this.lock.packet, peer);
            else this.sendQueueMessage({kind: 'busy', token: data.token}, peer);
            return;
          }
          const member = this.members.get(peer);
          if (!member || member.id !== data.id || this.localPeer < peer || typeof data.invite !== 'string' || data.invite.length > 1600) return;
          const lock = this.lock = {peer, id: data.id, token: data.token, phase: 'accept'};
          try {
            const session = await N.joinSession(data.invite, this.session.config);
            if (this.closed || this.lock !== lock) return;
            session.id = this.queueId; session.opponent = data.id; lock.session = session;
            lock.packet = {kind: 'accept', token: lock.token, id: this.queueId};
            this.advertise(); this.retryLock(lock);
          } catch (_) { this.release(); }
          return;
        }
        const lock = this.lock;
        if (!lock || lock.peer !== peer || lock.token !== data.token) return;
        if (data.kind === 'accept' && lock.phase === 'offer' && data.id === lock.id) {
          lock.phase = 'commit'; lock.packet = {kind: 'commit', token: lock.token}; this.sendQueueMessage(lock.packet, peer);
        } else if (data.kind === 'commit' && lock.phase === 'accept') {
          this.sendQueueMessage({kind: 'ready', token: lock.token}, peer); await this.matched(lock);
        } else if (data.kind === 'ready' && lock.phase === 'commit') await this.matched(lock);
        else if (data.kind === 'busy' && !this.done) { this.members.delete(peer); this.release(); }
      }
    }
    close() {
      if (!this.closed && this.queueId) this.sendQueueMessage({kind: 'waiting', id: this.queueId, busy: true});
      super.close();
    }
  }
  root.SeaMatchmaking = {Queue};
  if (typeof module !== 'undefined') module.exports = root.SeaMatchmaking;
})(globalThis);
