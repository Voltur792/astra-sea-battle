/* Sequential rendezvous routes. The authenticated game protocol is unchanged. */
(function (root) {
  'use strict';
  const R = root.SeaOnlineRules, N = root.SeaOnlineTransport;
  class PeerTransport extends N.Transport {
    async connect(forceRelay = false) {
      this.close(); this.closed = false; this.manual = false; this.failedOnce = false;
      this.forceRelay = forceRelay;
      const Peer = this.dep.Peer || root.Peer;
      if (!Peer) throw new Error('Резервный модуль PeerJS не загрузился. Обнови плагин.');
      this.key = await crypto.subtle.importKey('raw', Uint8Array.from(this.session.secret.match(/../g), x => parseInt(x, 16)), 'AES-GCM', false, ['encrypt', 'decrypt']);
      this.iceServers = this.dep.iceServers || await this.fetchIce();
      if (this.closed) return;
      const id = role => `sb-${this.session.room.slice(0, 40)}-${role}`;
      const client = this.client = new Peer(id(this.session.role), {debug: 0, secure: true,
        config: {iceServers: this.iceServers, iceTransportPolicy: forceRelay ? 'relay' : 'all'}});
      const timeout = this.schedule(() => this.unavailable('PeerJS не ответил за 15 секунд.'), 15000);
      client.on('open', () => {
        if (this.closed || this.client !== client) return;
        clearTimeout(timeout); this.timers.delete(timeout); this.healthy = true; this.hooks.health?.(true);
        this.status('PeerJS доступен. Ожидаем второго игрока…');
        if (this.session.role === 'guest') this.dial();
      });
      client.on('connection', link => {
        if (this.closed || link.peer !== id(R.other(this.session.role)) || this.link?.open) { link.close(); return; }
        this.attachLink(link);
      });
      client.on('error', error => {
        if (this.closed || this.client !== client) return;
        this.hooks.diagnostic?.({route: 'peerjs', errorType: String(error.type || 'unknown')});
        if (error.type === 'peer-unavailable') {
          if (!this.connected && this.session.role === 'guest') this.schedule(() => this.dial(), 5000);
          this.status('PeerJS доступен. Создатель комнаты пока не найден; ждём подключения.');
        } else this.unavailable(error.type === 'unavailable-id' ? 'Эта комната уже открыта в другой вкладке.' : 'Не удалось подключиться через PeerJS.');
      });
      client.on('disconnected', () => {
        if (this.closed || this.client !== client) return;
        if (this.connected) this.status('Сервис PeerJS отключился; установленное соединение продолжает передавать ходы.');
        else this.unavailable('Сервис PeerJS разорвал соединение.');
      });
    }
    dial() {
      if (this.closed || !this.client?.open || this.connected || this.link?.open) return;
      this.link?.close();
      const id = `sb-${this.session.room.slice(0, 40)}-host`;
      this.attachLink(this.client.connect(id, {reliable: true, serialization: 'json', label: 'sea-battle-v1',
        metadata: {v: 1, room: this.session.room}}));
    }
    attachLink(link) {
      if (!link || link.label !== 'sea-battle-v1') { link?.close(); return; }
      this.link = link; this.authenticated = false;
      link.on('open', async () => {
        if (this.closed || this.link !== link) return;
        this.pc = link.peerConnection;
        try { link.send(JSON.stringify(await this.encrypt('peer-hello', {name:N.nickname(this.session.name)}))); }
        catch (_) { this.unavailable('Не удалось подтвердить соединение PeerJS.'); }
      });
      link.on('data', encoded => {
        this.serial = this.serial.then(async () => {
          if (this.closed || this.link !== link) return;
          if (typeof encoded !== 'string' || encoded.length > 60000) throw new Error('Неверный размер игрового сообщения.');
          const value = await this.decrypt(JSON.parse(encoded));
          if (!value) throw new Error('Не удалось проверить сообщение PeerJS.');
          if (value.kind === 'peer-hello') {
            this.session.opponent_name=N.nickname(value.data?.name);await this.hooks.identity?.();
            if (this.connected) return;
            if (!this.session.opponent) { this.session.opponent = value.id; await this.hooks.identity?.(); }
            this.authenticated = true; this.connected = true; this.hooks.connection?.(true);
            this.status('Игрок подключён через PeerJS.');
            await this.hooks.open?.();
          } else if (value.kind === 'game' && this.connected && value.id === this.session.opponent) await this.hooks.message?.(value.data);
        }).catch(error => this.status(error.message || 'Ошибка игрового протокола PeerJS.', true));
      });
      link.on('close', () => {
        if (this.closed || this.link !== link) return;
        this.connected = false; this.hooks.connection?.(false);
        this.status('Соединение PeerJS прервалось. Партия сохранена; ждём повторного подключения.', true);
        if (this.session.role === 'guest') this.schedule(() => this.dial(), 2500);
      });
      link.on('error', () => { if (!this.closed && this.link === link) this.unavailable('Ошибка канала PeerJS.'); });
      link.on('iceStateChanged', state => {
        if (this.closed || this.link !== link) return;
        if (['disconnected', 'failed'].includes(state) && this.connected) {
          this.connected = false; this.hooks.connection?.(false);
          this.status('Соединение PeerJS временно потеряно. Ожидаем восстановления…', true);
        } else if (['connected', 'completed'].includes(state) && !this.connected && this.authenticated && link.open) {
          this.connected = true; this.hooks.connection?.(true);
          Promise.resolve(this.hooks.open?.()).catch(error => this.status(error.message, true));
        }
      });
    }
    async send(data) {
      if (!this.connected || !this.link?.open) return false;
      const link = this.link, encoded = JSON.stringify(await this.encrypt('game', data));
      if (this.closed || this.link !== link || !link.open) return false;
      if (link.dataChannel?.bufferedAmount > 512000) throw new Error('Передача ходов задерживается. Дождись восстановления связи.');
      link.send(encoded); return true;
    }
    close() {
      this.closed = true;
      if (this.link) { this.link.close(); this.link = null; }
      if (this.client) { this.client.destroy(); this.client = null; }
      super.close();
    }
  }
  class Router {
    constructor(session, hooks = {}, dependencies = {}) {
      this.session = session; this.hooks = hooks; this.dep = dependencies;
      this.closed = true; this.active = null; this.route = ''; this.timer = null; this.epoch = 0;
      this.needsManual = false; this.cachedIce = []; this.wasConnected = false;
    }
    get connected() { return !!this.active?.connected; }
    get manual() { return !!this.active?.manual; }
    status(text, error = false) { this.hooks.status?.(text, error); }
    cancelTimer() { clearTimeout(this.timer); this.timer = null; }
    hooksFor(instance, route) {
      const current = () => !this.closed && this.active === instance;
      return {
        status: (text, error) => { if (current()) this.status(text, error); },
        diagnostic: value => { if (current()) this.hooks.diagnostic?.(value); },
        identity: async () => { if (current()) await this.hooks.identity?.(); },
        message: async data => { if (current()) await this.hooks.message?.(data); },
        health: () => { if (current()) this.status(`${route === 'metered' ? 'Metered: ключ проверен, комнаты доступны' : 'PeerJS доступен'}. Ожидаем соперника…`); },
        connection: value => {
          if (!current()) return;
          if (value) { this.cancelTimer(); this.needsManual = false; this.wasConnected = true; }
          else if (this.wasConnected && !this.timer) {
            this.wasConnected = false;
            this.timer = setTimeout(() => { if (current() && !this.connected) this.advance(); }, this.dep.waitMs ?? 23000);
          }
          this.hooks.connection?.(value);
        },
        open: async () => { if (current()) { this.cancelTimer(); await this.hooks.open?.(); } },
        unavailable: () => { if (current() && !this.connected) this.advance(); }
      };
    }
    async connect(forceRelay = false) {
      this.close(); this.closed = false; this.forceRelay = forceRelay; this.needsManual = false;
      return this.start('metered');
    }
    async start(route) {
      if (this.closed) return;
      const epoch = ++this.epoch;
      this.cancelTimer();
      if (this.active) { this.cachedIce = this.active.iceServers || this.cachedIce; this.active.hooks = {}; this.active.close(); }
      this.wasConnected = false;
      this.route = route;
      const Constructor = route === 'metered' ? this.dep.Primary || N.Transport : this.dep.Backup || PeerTransport;
      const instance = new Constructor(this.session, {}, this.dep.transport || {});
      this.active = instance; instance.hooks = this.hooksFor(instance, route);
      this.status(route === 'metered' ? 'Проверяем ключ и комнаты Metered…' : 'Metered не соединил игроков. Пробуем резерв PeerJS…');
      try {
        await instance.connect(this.forceRelay);
        if (this.closed || epoch !== this.epoch) return;
        if (route === 'metered') this.timer = setTimeout(() => { if (!this.closed && !this.connected) this.advance(); }, this.dep.waitMs ?? 23000);
      } catch (_) { if (!this.closed && epoch === this.epoch) this.advance(); }
    }
    advance() {
      if (this.closed || this.connected) return;
      if (this.route === 'metered') { void this.start('peerjs'); return; }
      this.cancelTimer();
      this.cachedIce = this.active?.iceServers || this.cachedIce;
      if (this.active) { this.active.hooks = {}; this.active.close(); } this.active = null; this.route = 'manual'; this.needsManual = true;
      this.status('Metered и PeerJS недоступны. Открой резервное прямое соединение и обменяйтесь кодами через мессенджер.', true);
      this.hooks.manual?.();
    }
    prepareManual() {
      this.cancelTimer();
      if (this.route === 'manual' && this.active) return this.active;
      this.cachedIce = this.active?.iceServers || this.cachedIce;
      this.active?.close(); this.closed = false; this.route = 'manual'; this.needsManual = false; this.epoch++;
      const instance = new N.Transport(this.session, {}, this.dep.transport || {});
      this.active = instance; instance.hooks = this.hooksFor(instance, 'manual'); instance.iceServers = this.cachedIce;
      return instance;
    }
    manualOffer(force = false) { return this.prepareManual().manualOffer(force); }
    manualAnswer(text, force = false) { return this.prepareManual().manualAnswer(text, force); }
    acceptManualAnswer(text) {
      if (this.route !== 'manual' || !this.active) throw new Error('Сначала создай резервное приглашение.');
      return this.active.acceptManualAnswer(text);
    }
    send(data) { return this.active?.send(data) || Promise.resolve(false); }
    close() { this.closed = true; this.epoch++; this.cancelTimer(); this.active?.close(); this.active = null; this.hooks.connection?.(false); }
  }
  root.SeaOnlineRouter = {Router, PeerTransport};
  if (typeof module !== 'undefined') module.exports = root.SeaOnlineRouter;
})(globalThis);
