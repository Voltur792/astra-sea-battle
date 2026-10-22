/* UI owns the live WebRTC connection; Python only persists this player's state. */
(function () {
  'use strict';
  const R = window.SeaOnlineRules, N = window.SeaOnlineTransport;
  const ids = ['onlineView',
    'netSearchPanel','netFind','netCancelSearch','netOnlineCount','netSearchState','netPlayerSettings','netNickname','netAlert','netNotifications','netOpponent',
    'netLobby','netSession','netCreate','netJoinCode','netJoin','netInviteGroup','netInvite','netCopy',
    'netReconnect','netSurrender','netLeave','netLeaveConfirm','netLeaveYes','netLeaveNo',
    'netSurrenderConfirm','netSurrenderYes','netSurrenderNo','netPhase','netReadyStatus','netScore',
    'netPlacement','netLength','netRotate','netRandom','netClear','netReady','netRemaining',
    'netManual','netManualOffer','netManualInput','netManualAccept','netManualOutput','netManualCopy',
    'netTargetMap','netOwnMap','netOwnHint','netVerification','netHistory','netConnection','netMessage'];
  const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const symbols = {unknown: '□', ship: '■', hit: '×', sunk: '◆', miss: '·'};
  const names = {unknown: 'неизвестно', ship: 'корабль', hit: 'попадание', sunk: 'потоплено', miss: 'мимо'};
  let revision = 0, config = {...window.SeaOnlineConfig}, session = null, match = null, transport = null;
  let vertical = false, connected = false, busy = false, loaded = false, fatal = false;
  let queue = Promise.resolve(), lastSent = 0, peerAck = 0;
  let searching = false, searchState = {status:'idle',count:null}, backgroundRoom = '', backgroundPending = false, polling = false;
  async function cancelSearch() { await api('sea_battle_search_cancel'); await pollSearch(); }
  async function adopt(saved) {
    revision = saved.revision;
    session = saved.session;
    if (!session) return;
    session.config = {...config}; session.name = N.nickname(window.SeaPreferences.values.nickname);
    if (await N.roomId(session.secret) !== session.room) throw Error('Повреждено приглашение сохранённой партии.');
    match = new R.Match(session.room,session.role,session.match);
  }
  async function resumeFound() {
    if (!backgroundPending || !mode() || document.hidden || busy || !session) return;
    backgroundPending = false;
    await persist(); await connect(); render();
  }
  async function pollSearch() {
    if (polling || fatal || busy) return;
    polling = true;
    try {
      searchState = await api('sea_battle_search_state');
      searching = ['connecting','waiting','pairing'].includes(searchState.status);
      ui.netSearchState.textContent = searchState.message || 'Поиск выключен.';
      ui.netOnlineCount.textContent = searchState.count !== null ? `В поиске: ${searchState.count}`
        : searchState.status==='connecting' ? 'В поиске: подключение…' : searchState.status==='error' ? 'В поиске: нет связи' : 'В поиске: —';
      if (searching || searchState.status==='error') connection(searchState.message,searchState.status==='error');
      if (searchState.status==='found' && searchState.room!==backgroundRoom) {
        backgroundRoom=searchState.room;
        const saved=await api('sea_battle_online_load');
        if (saved.session?.room===backgroundRoom && (!session || session.room===backgroundRoom)) {
          await adopt(saved); backgroundPending=true;
          message(`Соперник найден: ${session.opponent_name || 'Игрок'}. Расставьте корабли.`);
        }
      }
      render(); await resumeFound();
    } catch (error) { ui.netSearchState.textContent='Нет связи с фоновым поиском: '+error.message; ui.netOnlineCount.textContent='В поиске: нет связи'; }
    finally { polling=false; }
  }
  const mode = () => document.querySelector('input[name="gameMode"]:checked')?.value === 'online';
  function message(text, error = false) { ui.netMessage.textContent = text; ui.netMessage.classList.toggle('error', error); }
  function connection(text, error = false) { ui.netConnection.textContent = text; ui.netConnection.classList.toggle('error', error); }
  async function api(method, params = {}) {
    const bridge = window.astra || window.__astraBridge;
    const fn = bridge && (bridge.callBackend || bridge.call);
    if (!fn) throw new Error('Нет соединения с Astra. Открой вкладку из плагина Морской бой.');
    const result = await fn.call(bridge, method, params);
    if (result.error) throw new Error(result.error);
    return result;
  }
  async function persist() {
    if (fatal) throw new Error('Сохранение заблокировано. Закрой вторую вкладку и заново открой Морской бой.');
    if (session && match) session.match = match.export();
    try {
      const result = await api('sea_battle_online_save', {revision, config, session});
      revision = result.revision;
    } catch (error) {
      fatal = true; connected = false; transport?.close();
      throw new Error(`Не удалось сохранить партию. Игра приостановлена: ${error.message}`);
    }
  }
  function action(operation) {
    const next = queue.then(async () => {
      if (!loaded || fatal) throw new Error('Сетевой режим ещё не загружен или сохранение недоступно.');
      busy = true; render();
      try { return await operation(); } finally { busy = false; render(); }
    });
    queue = next.catch(error => message(error.message || 'Не удалось выполнить действие.', true));
    return queue;
  }
  async function flush() {
    if (!transport?.connected || !match) return;
    for (const packet of match.outgoing(lastSent)) {
      if (!await transport.send({type: 'event', packet})) return;
      lastSent = packet.seq;
    }
  }
  async function connect(manual = false) {
    if (!session) return;
    transport?.close(); connected = false; lastSent = 0; peerAck = 0;
    const instance = new window.SeaOnlineRouter.Router(session, {
      status: connection,
      connection(value) { if (transport === instance) { connected = value; if (value) ui.netInviteGroup.open = false; render(); } },
      identity: () => action(persist),
      manual: () => { ui.netManual.open = true; render(); },
      open: () => action(async () => {
        if (transport !== instance) return;
        await match.settle(); await persist(); lastSent = 0;
        await instance.send({type: 'sync', received: match.s.seq[R.other(session.role)]});
        await flush();
      }),
      message: data => action(async () => {
        if (transport !== instance || !data || !match) return;
        if (data.type === 'event') {
          await match.receive(data.packet); await persist();
          if (data.packet.kind === 'result') {
            const shot = data.packet.data;
            message(`Твой выстрел ${R.label(shot.cell)}: ${names[shot.result]}.`);
          } else if (data.packet.kind === 'shot') {
            const reply = match.s.shots[R.other(session.role)].at(-1);
            if (reply) message(`Соперник стреляет ${R.label(reply.cell)}: ${names[reply.result]}.`);
          }
          await instance.send({type: 'ack', received: match.s.seq[R.other(session.role)]});
          await flush();
        } else if (data.type === 'sync' || data.type === 'ack') {
          if (!Number.isInteger(data.received) || data.received < 0 || data.received > match.s.seq[session.role]) throw new Error('Состояния партии разошлись. Проверь, что соперник открыл прежнее сохранение.');
          peerAck = Math.max(peerAck, data.received);
          if (data.type === 'sync') { lastSent = data.received; await flush(); }
        } else throw new Error('Неизвестное игровое сообщение. Обновите плагин у обоих игроков.');
        render();
      })
    });
    transport = instance;
    if (!manual) await instance.connect(false);
  }
  function draw(root, own) {
    root.replaceChildren();
    const heading = value => { const span = document.createElement('span'); span.className = 'coord'; span.textContent = value; span.setAttribute('aria-hidden', 'true'); return span; };
    root.append(heading('')); for (const letter of 'АБВГДЕЖЗИК') root.append(heading(letter));
    const cells = match.map(own);
    for (let row = 0; row < 10; row++) {
      root.append(heading(row + 1));
      for (let col = 0; col < 10; col++) {
        const cell = row * 10 + col, value = cells[cell];
        const button = document.createElement('button'); button.type = 'button';
        const canPlace = own && !match.ready && !match.s.over;
        const canShoot = !own && connected && match.canFire && value === 'unknown';
        button.disabled = busy || fatal || !(canPlace || canShoot);
        button.className = `cell ${value}${!button.disabled ? ' available' : ''}`;
        button.textContent = symbols[value]; button.title = `${R.label(cell)} · ${names[value]}`;
        button.setAttribute('aria-label', `${R.label(cell)}: ${names[value]}${canPlace ? ', поставить или убрать корабль' : canShoot ? ', выстрелить' : ''}`);
        if (!button.disabled) button.addEventListener('click', () => action(async () => {
          if (own) { match.place(cell, Number(ui.netLength.value), vertical); await persist(); message('Расстановка сохранена.'); }
          else { await match.fire(cell); await persist(); await flush(); message(`Выстрел ${R.label(cell)} отправлен. Ждём результат.`); }
        }));
        root.append(button);
      }
    }
  }
  function render() {
    const online = mode(); document.body.classList.toggle('online-mode', online);
    document.body.classList.toggle('net-in-game', online && !!match?.started);
    ui.onlineView.classList.toggle('hidden', !online);
    if (!online) return;
    ui.netLobby.classList.toggle('hidden', !!session);
    ui.netSearchPanel.classList.toggle('hidden', !!session);
    ui.netFind.classList.toggle('hidden', searching);
    ui.netCancelSearch.classList.toggle('hidden', !searching);
    ui.netFind.disabled = busy || !loaded || fatal;
    ui.netSession.classList.toggle('hidden', !session);
    for (const id of ['netCreate','netJoin']) ui[id].disabled = busy || !loaded || fatal || searching;
    ui.netNickname.disabled = searching || !!session;
    if (!session || !match) return;
    ui.netOpponent.textContent = `Соперник: ${session.opponent_name || 'Игрок'}`;
    ui.netInviteGroup.classList.toggle('hidden', session.role !== 'host');
    if (session.role === 'host') ui.netInvite.value = N.invitation(session);
    ui.netReconnect.disabled = busy || fatal;
    ui.netManualOffer.classList.toggle('hidden', session.role !== 'host');
    ui.netManualOffer.disabled = ui.netManualAccept.disabled = busy || fatal || connected;
    ui.netManualCopy.disabled = !ui.netManualOutput.value;
    ui.netLeave.disabled = busy;
    ui.netSurrender.disabled = busy || fatal || match.s.over || !connected;
    ui.netPlacement.classList.toggle('hidden', match.ready || match.s.over);
    for (const id of ['netRotate','netRandom','netClear','netReady','netLength']) ui[id].disabled = busy || fatal || match.ready || match.s.over;
    ui.netReady.disabled ||= match.s.fleet.length !== 10;
    ui.netRotate.textContent = vertical ? 'Вертикально' : 'Горизонтально'; ui.netRotate.setAttribute('aria-pressed', String(vertical));
    const left = [...R.FLEET]; for (const ship of match.s.fleet) left.splice(left.indexOf(ship.length), 1);
    ui.netRemaining.textContent = left.length ? `Осталось поставить: ${left.join(', ')} клеток.` : 'Все 10 кораблей расставлены. Можно подтвердить готовность.';
    ui.netOwnHint.textContent = match.ready ? 'только ты видишь свои корабли' : 'нажми на начало корабля';
    ui.netReadyStatus.textContent = `Ты: ${match.ready ? 'готов' : 'расставляешь'} · Соперник: ${match.s.commits[R.other(session.role)] ? 'готов' : 'ещё не готов'}`;
    let phase = match.ready ? 'Ожидаем готовности соперника' : 'Расстановка кораблей';
    if (match.started) phase = !connected ? 'Связь потеряна · партия на паузе' : match.s.pending ? 'Ожидаем результат выстрела' : match.canFire ? 'Твой ход' : 'Ход соперника';
    if (match.s.over) phase = match.s.winner === 'draw' ? 'Оба игрока сдались · ничья' : match.s.winner === session.role ? 'Ты победил' : 'Победил соперник';
    ui.netPhase.textContent = phase;
    const sunk = role => match.s.shots[role].filter(s => s.result === 'sunk').length;
    ui.netScore.textContent = `Потоплено тобой: ${sunk(session.role)}/10 · соперником: ${sunk(R.other(session.role))}/10`;
    ui.netVerification.textContent = match.s.over ? ({verified: 'Оба флота раскрыты: расстановки и результаты выстрелов прошли проверку.', failed: 'Проверка не пройдена: расстановка или ответы соперника не совпали с зафиксированными данными.', pending: 'Ожидаем раскрытие флотa. Пока оно не получено, честность партии не подтверждена.'})[match.s.verification]
      : 'Расстановка скрыта от соперника. После окончания проверим, что корабли не перемещались и ответы соответствовали полю.';
    ui.netVerification.classList.toggle('error', match.s.verification === 'failed');
    ui.netHistory.replaceChildren();
    for (const packet of match.s.history.filter(p => p.kind === 'result')) {
      const item = document.createElement('li'), shot = packet.data;
      item.textContent = `${R.other(packet.role) === session.role ? 'Ты' : 'Соперник'}: ${R.label(shot.cell)} — ${names[shot.result]}`;
      ui.netHistory.append(item);
    }
    draw(ui.netTargetMap, false); draw(ui.netOwnMap, true);
  }
  function hook(id, fn) { ui[id].addEventListener('click', () => action(fn)); }
  hook('netFind', async () => {
    if (session || searching) return;
    await window.SeaPreferences.set({nickname:ui.netNickname.value,alert:ui.netAlert.value,notifications:ui.netNotifications.checked});
    searchState = await api('sea_battle_search_start',{config}); searching=true;
    ui.netSearchState.textContent=searchState.message; connection(searchState.message);
  });
  ui.netCancelSearch.addEventListener('click', () => void cancelSearch().catch(error=>message(error.message,true)));
  hook('netCreate', async () => {
    if (session) throw new Error('Сначала покинь текущую комнату.');
    session = await N.createSession(config); match = new R.Match(session.room, session.role);
    session.name = N.nickname(window.SeaPreferences.values.nickname);
    await persist(); message('Комната создана. Отправь приглашение другу.'); await connect();
  });
  hook('netJoin', async () => {
    if (session) throw new Error('Сначала покинь текущую комнату.');
    const joined = await N.joinSession(ui.netJoinCode.value);
    joined.name = N.nickname(window.SeaPreferences.values.nickname);
    session = joined; match = new R.Match(session.room, session.role);
    await persist(); ui.netJoinCode.value = ''; message('Приглашение принято. Подключаемся…'); await connect();
  });
  hook('netReconnect', () => connect());
  hook('netManualOffer', async () => {
    if (connected) throw new Error('Соединение уже работает.');
    if (!transport) await connect(true);
    connection('Собираем адреса для резервного соединения…');
    ui.netManualOutput.value = await transport.manualOffer(false);
    await persist(); connection('Резервное приглашение готово. Ожидаем ответный код друга.'); message('Отправь резервное приглашение другу и дождись ответного кода. Вкладку не закрывай.');
  });
  hook('netManualAccept', async () => {
    if (connected) throw new Error('Соединение уже работает.');
    if (!transport) await connect(true);
    if (session.role === 'guest') {
      connection('Готовим ответ на резервное приглашение…');
      ui.netManualOutput.value = await transport.manualAnswer(ui.netManualInput.value, false);
      connection('Резервный ответ готов. Ожидаем, когда создатель комнаты примет его.'); message('Отправь полученный ответ создателю комнаты. Вкладку не закрывай.');
    } else {
      await transport.acceptManualAnswer(ui.netManualInput.value); message('Ответ принят. Устанавливаем резервное соединение…');
    }
    await persist();
  });
  hook('netManualCopy', async () => {
    if (!ui.netManualOutput.value) throw new Error('Сначала получи резервный код.');
    try { await copyInvite(ui.netManualOutput); message('Резервный код скопирован.'); }
    catch (_) { ui.netManualOutput.focus(); ui.netManualOutput.select(); message('Код выделен. Скопируй его сочетанием Ctrl+C или ⌘C.'); }
  });
  hook('netReady', async () => { await match.seal(); await persist(); await flush(); message('Флот зафиксирован. После готовности обоих первый ход определится автоматически.'); });
  hook('netRandom', async () => { match.randomize(); await persist(); message('Корабли расставлены случайно.'); });
  hook('netClear', async () => { match.clear(); await persist(); message('Поле очищено.'); });
  hook('netRotate', async () => { vertical = !vertical; });
  hook('netSurrender', async () => { ui.netSurrenderConfirm.classList.remove('hidden'); });
  hook('netSurrenderNo', async () => { ui.netSurrenderConfirm.classList.add('hidden'); });
  hook('netSurrenderYes', async () => {
    if (!connected) throw new Error('Сначала восстанови соединение, чтобы соперник получил сдачу.');
    await match.surrender(); await persist(); await flush(); ui.netSurrenderConfirm.classList.add('hidden'); message('Ты сдался. Проверяем расстановки.');
  });
  hook('netLeave', async () => { ui.netLeaveConfirm.classList.remove('hidden'); });
  hook('netLeaveNo', async () => { ui.netLeaveConfirm.classList.add('hidden'); });
  hook('netLeaveYes', async () => {
    transport?.close(); transport = null; session = null; match = null; connected = false;
    await persist(); ui.netLeaveConfirm.classList.add('hidden'); ui.netSurrenderConfirm.classList.add('hidden');
    connection('Комната закрыта у тебя. Можно создать новую или принять приглашение.'); message('Локальное сохранение сетевой партии удалено.');
  });
  hook('netCopy', async () => {
    try { await copyInvite(ui.netInvite); message('Приглашение скопировано. Отправь его другу.'); }
    catch (_) { ui.netInvite.focus(); ui.netInvite.select(); message('Приглашение выделено. Нажми Ctrl+C или ⌘C, чтобы скопировать.'); }
  });
  for (const radio of document.querySelectorAll('input[name="gameMode"]')) radio.addEventListener('change', () => {
    if (!mode()) {
      transport?.close(); connected = false;
      if (session) connection('Сетевая партия приостановлена. Вернись в сетевой режим для продолжения.');
    } else {
      if (!session && !searching) connection('Маршрут выбирается автоматически: Metered → PeerJS → резервное прямое соединение.');
      void resumeFound().catch(error=>message(error.message,true));
    }
    render();
  });
  async function initialize() {
    try {
      await window.SeaPreferences.ready;
      const saved = await api('sea_battle_online_load'); revision = saved.revision;
      if (saved.session) {
        await adopt(saved);
        connection('Найдена сохранённая комната. Нажми «Переподключиться» для продолжения.');
      }
      loaded = true;
      await pollSearch();
    } catch (error) { fatal = true; message(error.message, true); }
    render();
  }
  initialize();
  async function copyInvite(field) {
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(field.value); return; } } catch (_) { /* host iframe policy */ }
    await api('sea_battle_copy_invite',{text:field.value});
  }
  window.setInterval(()=>{if(loaded) void pollSearch();},2000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden) void pollSearch();});
  window.addEventListener('pagehide', () => transport?.close());
})();
