/* Metered's documented JSON wire protocol, no remote scripts or account secrets. */
(function (root) {
  'use strict';
  const R = root.SeaOnlineRules;
  const bytes = hex => Uint8Array.from(hex.match(/../g), x => parseInt(x, 16));
  const b64 = data => btoa(String.fromCharCode(...data)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const unb64 = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  const encode = value => b64(new TextEncoder().encode(JSON.stringify(value)));
  const nickname = value => typeof value==='string' ? value.replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g,'').trim().slice(0,32) : '';
  function configuration(value) {
    if (!value || !/^pk_live_[A-Za-z0-9_-]{8,180}$/.test(value.key || '')) throw new Error('Укажи публичный ключ комнат pk_live_… в настройках сети.');
    const app = value.app || '', turn = value.turn || '';
    if (app && !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(app)) throw new Error('Неверное имя проекта Metered.');
    if (turn && (!app || !/^[A-Za-z0-9_-]{8,240}$/.test(turn))) throw new Error('Неверный ключ отдельного TURN credential.');
    return {key: value.key, app, turn};
  }
  async function roomId(secret) {
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Повреждён секрет приглашения.');
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(secret))), x => x.toString(16).padStart(2, '0')).join('');
  }
  async function createSession(config) {
    const secret = R.random(), room = await roomId(secret);
    return {v: 1, config: configuration(config), secret, room, role: 'host', id: R.random(), opponent: '', match: null};
  }
  function invitation(session) { return 'SB2.' + encode({v: 2, secret: session.secret, name:nickname(session.name)}); }
  async function joinSession(text, config = root.SeaOnlineConfig) {
    try {
      const code = text.trim();
      if (!/^SB[12]\.[A-Za-z0-9_-]{40,1500}$/.test(code)) throw new Error();
      const data = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(unb64(code.slice(4))));
      if (![1, 2].includes(data.v)) throw new Error();
      return {v: 1, config: configuration(config), secret: data.secret, room: await roomId(data.secret),
        role: 'guest', id: R.random(), opponent: '', opponent_name:nickname(data.name), match: null};
    } catch (_) { throw new Error('Не удалось прочитать приглашение. Скопируй его целиком, начиная с SB2. Оба игрока должны обновить плагин.'); }
  }
  class Transport {
    constructor(session, hooks = {}, dependencies = {}) {
      this.session = session; this.hooks = hooks; this.dep = dependencies;
      this.closed = true; this.connected = false; this.retry = 0; this.serial = Promise.resolve();
      this.sendQueue = Promise.resolve(); this.request = 0; this.pendingIce = [];
      this.iceServers = []; this.peer = ''; this.negotiation = ''; this.timers = new Set();
    }
    status(message, error = false) { this.hooks.status?.(message, error); }
    unavailable(message) {
      if (this.closed || this.failedOnce) return;
      if (this.connected) { this.status('Сервис комнат недоступен, но передача ходов продолжается по установленному соединению.'); return; }
      this.failedOnce = true; this.status(message, true); this.hooks.unavailable?.(message);
    }
    schedule(fn, delay) {
      const id = setTimeout(() => { this.timers.delete(id); if (!this.closed) fn(); }, delay);
      this.timers.add(id); return id;
    }
    async connect(forceRelay = false) {
      this.close(); this.closed = false; this.manual = false; this.failedOnce = false; this.healthy = false; this.forceRelay = forceRelay;
      if (!root.RTCPeerConnection && !this.dep.RTCPeerConnection) throw new Error('В этом окне Astra недоступен WebRTC. Обнови Astra или используй другой поддерживаемый хост.');
      if (!crypto.subtle) throw new Error('В этом окне недоступно безопасное шифрование WebRTC.');
      this.key = await crypto.subtle.importKey('raw', bytes(this.session.secret), 'AES-GCM', false, ['encrypt', 'decrypt']);
      this.status('Подключаемся к сервису комнат…');
      this.iceServers = await this.fetchIce();
      if (this.closed) return;
      this.openSocket();
    }
    async prepareManual(forceRelay) {
      const cached = this.iceServers;
      this.close(); this.closed = false; this.manual = true; this.forceRelay = forceRelay;
      if (!root.RTCPeerConnection && !this.dep.RTCPeerConnection) throw new Error('В этом окне недоступен WebRTC.');
      this.key = await crypto.subtle.importKey('raw', bytes(this.session.secret), 'AES-GCM', false, ['encrypt', 'decrypt']);
      // A recent auto-injected credential can survive loss of the signaling quota.
      // Otherwise use the explicit TURN credential, or STUN/direct connectivity.
      this.iceServers = cached.some(s => [].concat(s.urls).some(u => /^turns?:/.test(u))) ? cached : await this.fetchIce();
      if (forceRelay && !this.iceServers.some(s => [].concat(s.urls).some(u => /^turns?:/.test(u)))) throw new Error('Без сервиса комнат доступен прямой резерв. Для TURN добавь отдельный TURN credential или сначала получи автоматические credentials.');
    }
    async gather(pc) {
      if (pc.iceGatheringState === 'complete') return;
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', changed); resolve(); };
        const changed = () => { if (pc.iceGatheringState === 'complete') finish(); };
        const timer = setTimeout(finish, 12000);
        pc.addEventListener('icegatheringstatechange', changed);
      });
      if (pc !== this.pc || this.closed) throw new Error('Подготовка резервного соединения отменена.');
    }
    async manualOffer(forceRelay = false) {
      if (this.session.role !== 'host') throw new Error('Резервное приглашение создаёт автор комнаты.');
      await this.prepareManual(forceRelay);
      const pc = this.makePeer(R.random());
      this.attach(pc.createDataChannel('sea-battle-v1', {ordered: true}));
      await pc.setLocalDescription(await pc.createOffer()); await this.gather(pc);
      return 'SBM1.' + encode(await this.encrypt('manual-offer', {epoch: this.negotiation, sdp: pc.localDescription.sdp,name:nickname(this.session.name)}));
    }
    async manualDecode(text, kind) {
      const code = text.trim();
      if (!/^SBM1\.[A-Za-z0-9_-]{30,50000}$/.test(code)) throw new Error('Скопируй резервный код целиком, начиная с SBM1.');
      let value;
      try { value = await this.decrypt(JSON.parse(new TextDecoder().decode(unb64(code.slice(5))))); } catch (_) { /* validation below */ }
      if (!value || value.kind !== kind || typeof value.data?.sdp !== 'string' || value.data.sdp.length > 24000) throw new Error('Это резервный код другой комнаты или неверного шага.');
      this.session.opponent ||= value.id;
      this.session.opponent_name=nickname(value.data.name);
      return value.data;
    }
    async manualAnswer(text, forceRelay = false) {
      if (this.session.role !== 'guest') throw new Error('Резервное приглашение принимает второй игрок.');
      await this.prepareManual(forceRelay);
      const data = await this.manualDecode(text, 'manual-offer');
      const pc = this.makePeer(data.epoch);
      await pc.setRemoteDescription({type: 'offer', sdp: data.sdp});
      await pc.setLocalDescription(await pc.createAnswer()); await this.gather(pc);
      return 'SBM1.' + encode(await this.encrypt('manual-answer', {epoch: this.negotiation, sdp: pc.localDescription.sdp,name:nickname(this.session.name)}));
    }
    async acceptManualAnswer(text) {
      if (!this.manual || !this.pc || this.session.role !== 'host' || this.pc.signalingState !== 'have-local-offer') throw new Error('Сначала создай резервное приглашение в этой вкладке.');
      const data = await this.manualDecode(text, 'manual-answer');
      if (data.epoch !== this.negotiation) throw new Error('Это ответ на прежнее приглашение. Попроси друга принять последний код.');
      await this.pc.setRemoteDescription({type: 'answer', sdp: data.sdp});
    }
    async fetchIce() {
      if (this.dep.iceServers) return this.dep.iceServers;
      const {app, turn} = this.session.config;
      const fallback = [{urls: 'stun:stun.relay.metered.ca:80'}];
      if (!app || !turn) return fallback;
      try {
        const response = await fetch(`https://${app}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(turn)}`,
          {signal: AbortSignal.timeout(12000), referrerPolicy: 'no-referrer', credentials: 'omit'});
        if (!response.ok) throw new Error();
        const servers = await response.json();
        if (!Array.isArray(servers) || servers.length > 20 || !servers.length || !servers.every(s =>
          s && [].concat(s.urls).length <= 8 && [].concat(s.urls).every(u => typeof u === 'string' && /^(stun|turn|turns):[^\s]{1,500}$/.test(u)))) throw new Error();
        return servers;
      } catch (_) {
        this.status('Не удалось получить TURN. Пробуем прямое соединение; проверь TURN credential, если связь не установится.', true);
        return fallback;
      }
    }
    openSocket() {
      if (this.closed) return;
      const WS = this.dep.WebSocket || root.WebSocket;
      const endpoint = this.dep.endpoint || 'wss://rms.metered.ca/v1';
      const ws = this.ws = new WS(`${endpoint}?key=${encodeURIComponent(this.session.config.key)}`);
      const welcomeTimeout = this.schedule(() => { if (this.ws === ws && !this.healthy) {
        this.unavailable('Не удалось проверить ключ и доступ к комнатам Metered за 15 секунд.');
        if (!this.hooks.unavailable) ws.close();
      } }, 15000);
      this.welcomed = false;
      ws.onmessage = event => {
        this.serial = this.serial.then(async () => {
          if (this.ws !== ws || this.closed) return;
          if (typeof event.data !== 'string' || event.data.length > 65536) throw new Error('Сервис прислал слишком большое сообщение.');
          await this.onServer(JSON.parse(event.data));
        }).catch(error => this.status(error.message || 'Не удалось обработать ответ сервиса.', true));
      };
      ws.onerror = () => this.unavailable('Сервис комнат Metered недоступен или отклонил ключ.');
      ws.onclose = event => {
        clearTimeout(welcomeTimeout); this.timers.delete(welcomeTimeout);
        if (this.ws !== ws || this.closed) return;
        if ([4001, 4002, 4003, 4004, 4010, 4011, 4012, 1008].includes(event.code)) {
          this.unavailable(`Сервис Metered отклонил подключение (${event.code}).`);
          return;
        }
        if (this.hooks.unavailable && !this.connected) { this.unavailable('Связь с сервисом Metered прервалась.'); return; }
        if (!this.connected) this.status('Связь с комнатой прервалась. Переподключаемся…', true);
        this.schedule(() => this.openSocket(), Math.min(30000, 1500 * 2 ** Math.min(this.retry++, 5)));
      };
    }
    requestServer(type, fields = {}) {
      if (this.ws?.readyState !== 1) return false;
      this.ws.send(JSON.stringify({type, ...fields, requestId: String(++this.request)})); return true;
    }
    async encrypt(kind, data) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plain = new TextEncoder().encode(JSON.stringify({v: 1, room: this.session.room,
        role: this.session.role, id: this.session.id, kind, data}));
      const cipher = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, this.key, plain);
      return {iv: b64(iv), cipher: b64(new Uint8Array(cipher))};
    }
    async decrypt(data) {
      if (!data || typeof data.iv !== 'string' || typeof data.cipher !== 'string' || data.cipher.length > 60000) return null;
      try {
        const iv = unb64(data.iv); if (iv.length !== 12) return null;
        const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv}, this.key, unb64(data.cipher));
        const value = JSON.parse(new TextDecoder().decode(plain));
        if (value.v !== 1 || value.room !== this.session.room || value.role !== R.other(this.session.role) || !/^[a-f0-9]{64}$/.test(value.id)) return null;
        if (this.session.opponent && value.id !== this.session.opponent) return null;
        return value;
      } catch (_) { return null; }
    }
    signal(kind, data, peer = this.peer) {
      this.sendQueue = this.sendQueue.then(async () => {
        if (this.closed) return;
        const encrypted = await this.encrypt(kind, data);
        this.requestServer(peer ? 'send' : 'publish', peer ? {to: peer, data: encrypted}
          : {channel: `sea-battle/${this.session.room}`, data: encrypted});
      }).catch(() => this.status('Не удалось отправить данные соединения. Переподключись.', true));
      return this.sendQueue;
    }
    async onServer(message) {
      const channel = `sea-battle/${this.session.room}`;
      if (message.type === 'welcome') {
        this.welcomed = true; this.localPeer = message.peerId; this.retry = 0;
        const injected = message.metadata?.iceServers;
        if (Array.isArray(injected) && injected.length > 0 && injected.length <= 20 && injected.every(s =>
          s && [].concat(s.urls).length <= 8 && [].concat(s.urls).every(u => typeof u === 'string' && /^(stun|turn|turns):[^\s]{1,500}$/.test(u)))) this.iceServers = injected;
        if (this.forceRelay && !this.iceServers.some(s => [].concat(s.urls).some(url => /^turns?:/.test(url)))) {
          this.close(); throw new Error('Сервис не выдал TURN. Включи Auto-inject TURN credentials у публичного ключа или добавь отдельный TURN credential.');
        }
        this.requestServer('subscribe', {channel});
        this.subscribeRequest = String(this.request);
        this.status('Комната открыта. Ожидаем второго игрока…');
      } else if (message.type === 'presence' && message.channel === channel) {
        if ((message.joined || []).some(p => p.peerId !== this.localPeer)) await this.signal('hello', {name:nickname(this.session.name)}, '');
      } else if (message.type === 'ack' && message.requestId === this.subscribeRequest) {
        this.healthy = true;
        this.hooks.health?.(true);
        await this.signal('hello', {name:nickname(this.session.name)}, '');
      } else if (message.type === 'error') {
        const descriptions = {
          channel_not_authorized: 'Ключ не разрешает игровые комнаты. В Metered укажи шаблон sea-battle/*.',
          action_not_permitted: 'Недостаточно прав ключа. Включи Publish, Subscribe, Presence и Send.',
          peer_not_found: 'Соперник отключился. Ожидаем повторного подключения.',
          rate_limited: 'Превышен лимит сервиса. Подожди и переподключись.'
        };
        this.status(descriptions[message.code] || 'Сервис отклонил запрос. Проверь права ключа и бесплатную квоту.', true);
        if (message.code !== 'peer_not_found') this.unavailable('Metered не разрешил обмен в игровой комнате.');
      } else if (message.type === 'direct' || (message.type === 'message' && message.channel === channel)) {
        const value = await this.decrypt(message.data); if (!value) return;
        if (!this.session.opponent) {
          if (value.kind !== 'hello') return;
          this.session.opponent = value.id; await this.hooks.identity?.();
        }
        if (value.kind === 'hello') {
          const name=nickname(value.data?.name);
          if(name!==this.session.opponent_name){this.session.opponent_name=name;await this.hooks.identity?.();}
          const changed = this.peer !== message.from; this.peer = message.from;
          if (this.session.role === 'host' && (!this.pc || changed || this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed')) await this.offer();
          if (this.session.role === 'guest' && (changed || !this.pc)) await this.signal('hello', {name:nickname(this.session.name)});
        } else if (value.kind === 'offer' && this.session.role === 'guest') {
          this.peer = message.from;
          this.makePeer(value.data.epoch);
          await this.pc.setRemoteDescription({type: 'offer', sdp: value.data.sdp});
          await this.flushIce();
          await this.pc.setLocalDescription(await this.pc.createAnswer());
          await this.signal('answer', {epoch: this.negotiation, sdp: this.pc.localDescription.sdp});
        } else if (value.kind === 'answer' && this.session.role === 'host' && value.data.epoch === this.negotiation && this.pc?.signalingState === 'have-local-offer') {
          await this.pc.setRemoteDescription({type: 'answer', sdp: value.data.sdp}); await this.flushIce();
        } else if (value.kind === 'ice' && value.data.epoch === this.negotiation && this.pc) {
          if (this.pc.remoteDescription) await this.pc.addIceCandidate(value.data.candidate);
          else if (this.pendingIce.length < 64) this.pendingIce.push(value.data.candidate);
        }
      }
    }
    makePeer(epoch) {
      if (!/^[a-f0-9]{64}$/.test(epoch)) throw new Error('Повреждены данные соединения.');
      this.dropPeer(); this.negotiation = epoch; this.pendingIce = [];
      const PC = this.dep.RTCPeerConnection || root.RTCPeerConnection;
      const pc = this.pc = new PC({iceServers: this.iceServers, iceTransportPolicy: this.forceRelay ? 'relay' : 'all'});
      pc.onicecandidate = event => { if (event.candidate && this.pc === pc && !this.manual) this.signal('ice', {epoch, candidate: event.candidate.toJSON()}); };
      pc.ondatachannel = event => { if (this.pc === pc) this.attach(event.channel); };
      pc.onconnectionstatechange = () => {
        if (this.pc !== pc || this.closed) return;
        if (pc.connectionState === 'connected' && !this.connected && this.channel?.readyState === 'open') {
          this.connected = true; this.hooks.connection?.(true);
          Promise.resolve(this.hooks.open?.()).catch(error => this.status(error.message, true));
        }
        if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
          this.connected = false; this.hooks.connection?.(false);
          this.status('Соединение с игроком прервалось. Партия сохранена; восстанавливаем связь…', true);
          if (!this.manual) this.schedule(() => { if (this.pc === pc && pc.connectionState !== 'connected') {
            this.dropPeer(); this.signal('hello', {}, '');
          } }, 4000);
        }
      };
      if (!this.manual) this.schedule(() => {
        if (this.pc === pc && !this.connected) {
          this.status('Не удалось соединиться с игроком. Проверь TURN credential или попробуй «Только ретранслятор».', true);
        }
      }, 25000);
      return pc;
    }
    async offer() {
      const pc = this.makePeer(R.random());
      this.attach(pc.createDataChannel('sea-battle-v1', {ordered: true}));
      await pc.setLocalDescription(await pc.createOffer());
      await this.signal('offer', {epoch: this.negotiation, sdp: pc.localDescription.sdp});
    }
    async flushIce() { for (const candidate of this.pendingIce.splice(0)) await this.pc.addIceCandidate(candidate); }
    attach(channel) {
      if (channel.label !== 'sea-battle-v1') { channel.close(); return; }
      this.channel = channel;
      channel.onopen = async () => {
        if (this.channel !== channel || this.closed) return;
        this.connected = true; this.hooks.connection?.(true);
        this.status('Игрок подключён. Можно расставлять корабли.');
        this.schedule(() => this.describePath().catch(() => {}), 800);
        try { await this.hooks.open?.(); } catch (error) { this.status(error.message, true); }
      };
      channel.onmessage = event => {
        this.serial = this.serial.then(async () => {
          if (typeof event.data !== 'string' || event.data.length > 60000) throw new Error('Слишком большое игровое сообщение.');
          const value = await this.decrypt(JSON.parse(event.data));
          if (!value || value.kind !== 'game' || value.id !== this.session.opponent) throw new Error('Не удалось проверить игровое сообщение.');
          await this.hooks.message?.(value.data);
        }).catch(error => this.status(error.message || 'Ошибка игрового протокола.', true));
      };
      channel.onclose = () => { if (this.channel === channel && !this.closed) {
        this.connected = false; this.hooks.connection?.(false);
        this.status('Канал передачи ходов закрыт. Переподключись для продолжения.', true);
      } };
      channel.onerror = () => { if (!this.closed && this.channel === channel) this.status('Ошибка передачи ходов. Партия сохранена; переподключись.', true); };
    }
    async send(data) {
      if (!this.connected || this.channel?.readyState !== 'open') return false;
      const channel = this.channel, encoded = JSON.stringify(await this.encrypt('game', data));
      if (channel !== this.channel || channel.readyState !== 'open') return false;
      if (channel.bufferedAmount > 512000) throw new Error('Передача ходов задерживается. Дождись восстановления связи.');
      channel.send(encoded); return true;
    }
    async describePath() {
      if (!this.pc || !this.connected) return;
      const reports = await this.pc.getStats(); let relay = false;
      for (const report of reports.values()) if (report.type === 'transport' && report.selectedCandidatePairId) {
        const pair = reports.get(report.selectedCandidatePairId);
        relay = reports.get(pair?.localCandidateId)?.candidateType === 'relay' || reports.get(pair?.remoteCandidateId)?.candidateType === 'relay';
      }
      this.status(relay ? 'Игрок подключён через ретранслятор TURN.' : 'Игрок подключён напрямую.');
    }
    dropPeer() {
      this.connected = false;
      const pc = this.pc; this.pc = null;
      if (this.channel) { this.channel.onclose = null; this.channel.close(); this.channel = null; }
      if (pc) { pc.onconnectionstatechange = null; pc.close(); }
    }
    close() {
      this.closed = true; this.timers.forEach(clearTimeout); this.timers.clear();
      if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
      this.dropPeer(); this.hooks.connection?.(false);
    }
  }
  const api = {Transport, createSession, joinSession, invitation, configuration, roomId, nickname};
  root.SeaOnlineTransport = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
