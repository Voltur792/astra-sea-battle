(function () {
  'use strict';
  const R = window.SeaOnlineRules;
  const ui = Object.fromEntries(['localPlacement','localPlacementTitle','localLength','localRotate','localRandom','localClear','localRemaining','localPlacementMessage','localBegin','localCancel','localPlacementMap'].map(id => [id, document.getElementById(id)]));
  let draft = null, vertical = false, start = null;
  function error(text = '') { ui.localPlacementMessage.textContent = text; ui.localPlacementMessage.classList.toggle('error', !!text); }
  function close() { document.body.classList.remove('placing-local'); ui.localPlacement.classList.add('hidden'); draft = null; start = null; }
  function draw() {
    if (!draft) return;
    const map = ui.localPlacementMap; map.replaceChildren();
    const label = text => { const node = document.createElement('span'); node.className = 'coord'; node.textContent = text; node.setAttribute('aria-hidden', 'true'); return node; };
    map.append(label('')); for (const letter of 'АБВГДЕЖЗИК') map.append(label(letter));
    const ships = new Set(draft.s.fleet.flat());
    for (let row = 0; row < 10; row++) {
      map.append(label(row + 1));
      for (let col = 0; col < 10; col++) {
        const cell = row * 10 + col, ship = ships.has(cell), button = document.createElement('button');
        button.type = 'button'; button.className = `cell available ${ship ? 'ship' : 'unknown'}`; button.textContent = ship ? '■' : '□';
        button.setAttribute('aria-label', `${R.label(cell)}: ${ship ? 'убрать корабль' : 'поставить корабль'}`);
        button.addEventListener('click', () => {
          try { draft.place(cell, Number(ui.localLength.value), vertical); error(); draw(); }
          catch (e) { error(e.message); }
        }); map.append(button);
      }
    }
    const remaining = [...R.FLEET]; for (const ship of draft.s.fleet) remaining.splice(remaining.indexOf(ship.length), 1);
    ui.localRemaining.textContent = remaining.length ? `Осталось поставить корабли длиной: ${remaining.join(', ')}.` : 'Все корабли расставлены. Можно начинать.';
    ui.localBegin.disabled = remaining.length !== 0;
    ui.localRotate.textContent = vertical ? 'Вертикально' : 'Горизонтально'; ui.localRotate.setAttribute('aria-pressed', String(vertical));
  }
  ui.localRotate.onclick = () => { vertical = !vertical; draw(); };
  ui.localRandom.onclick = () => { draft.randomize(); error(); draw(); };
  ui.localClear.onclick = () => { draft.clear(); error(); draw(); };
  ui.localCancel.onclick = close;
  ui.localBegin.onclick = async () => {
    if (!draft || !start) return;
    try { const fleet = R.validate(draft.s.fleet); const operation = start; close(); await operation(fleet); }
    catch (e) { error(e.message || 'Не удалось начать партию.'); }
  };
  for (const radio of document.querySelectorAll('input[name="gameMode"]')) radio.addEventListener('change', close);
  window.SeaLocalPlacement = {open(mode, operation) {
    draft = new R.Match(R.random(), 'host'); start = operation; vertical = false;
    ui.localPlacementTitle.textContent = mode === 'ai' ? 'Твой флот · против ИИ Astra' : 'Твой флот · быстрая игра';
    document.body.classList.add('placing-local'); ui.localPlacement.classList.remove('hidden'); error(); draw();
    ui.localRandom.focus();
  }};
})();
