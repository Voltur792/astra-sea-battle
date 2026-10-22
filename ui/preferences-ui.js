/* Backend persistence survives Astra destroying/recreating the custom page. */
(function() {
  'use strict';
  let saveQueue = Promise.resolve();
  const touched = new Set();
  const values = {mode: '', nickname: '', alert: 'sound', notifications: true};
  async function api(method, params={}) {
    const bridge = window.astra || window.__astraBridge, fn = bridge && (bridge.callBackend || bridge.call);
    if (!fn) throw Error('Нет соединения с Astra.');
    let value = await fn.call(bridge, method, params);
    if (typeof value === 'string') value = JSON.parse(value);
    if (value?.result_json) value = JSON.parse(value.result_json);
    if (value?.error) throw Error(value.error);
    return value;
  }
  function apply() {
    const radio = [...document.querySelectorAll('input[name="gameMode"]')].find(r=>r.value===values.mode);
    if (radio && !radio.checked) { radio.checked=true; radio.dispatchEvent(new Event('change')); }
    document.getElementById('netNickname').value=values.nickname;
    document.getElementById('netAlert').value=values.alert;
    document.getElementById('netNotifications').checked=values.notifications;
  }
  function set(patch) {
    Object.keys(patch).forEach(key=>touched.add(key)); Object.assign(values, patch); apply();
    const pending = saveQueue.then(()=>api('sea_battle_preferences_save',{patch}));
    saveQueue = pending.catch(()=>{});
    return pending.catch(error=>{document.getElementById('netPreferencesMessage').textContent='Не удалось сохранить настройки: '+error.message;throw error;});
  }
  const ready=api('sea_battle_preferences_load').then(saved=>{for(const [key,value] of Object.entries(saved))if(!touched.has(key))values[key]=value;apply();}).catch(error=>{
    document.getElementById('netPreferencesMessage').textContent='Настройки не загружены: '+error.message;
  });
  window.SeaPreferences={values,ready,set};
  for(const radio of document.querySelectorAll('input[name="gameMode"]')) radio.addEventListener('change',()=>{
    if(radio.checked && radio.value!==values.mode) void set({mode:radio.value}).catch(()=>{});
  });
  document.getElementById('netNickname').addEventListener('change',event=>void set({nickname:event.target.value}).catch(()=>{}));
  document.getElementById('netAlert').addEventListener('change',event=>void set({alert:event.target.value}).catch(()=>{}));
  document.getElementById('netNotifications').addEventListener('change',event=>void set({notifications:event.target.checked}).catch(()=>{}));
})();
