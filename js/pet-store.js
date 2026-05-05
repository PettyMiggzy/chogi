/* Chogi Pet Store v2 — multi-pet support
   ────────────────────────────────────────
   Each pet has its own pet_id (UUID). Wallet owns 0..3 pets.
*/
(function(){
  if(window.ChogiPetStore && window.ChogiPetStore._v >= 2) return;

  var STORE_KEY = 'chogi_pets_v2';
  var LEGACY_KEY = 'chogi_pet_v1';
  var ACTIVE_KEY = 'chogi_active_pet_id';
  var SB_URL = null;
  var SB_KEY = null;

  function uuid(){
    if(typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){
      var r = Math.random() * 16 | 0;
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function loadAllLocal(){
    try {
      var raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch(e){ return []; }
  }
  function saveAllLocal(arr){
    try { localStorage.setItem(STORE_KEY, JSON.stringify(arr)); }
    catch(e){ console.warn('saveAllLocal:', e); }
  }
  function getLocalAll(wallet){
    if(!wallet) return [];
    var w = wallet.toLowerCase();
    return loadAllLocal().filter(function(p){ return (p.wallet||'').toLowerCase() === w; });
  }
  function getLocalById(pet_id){
    if(!pet_id) return null;
    return loadAllLocal().find(function(p){ return p.pet_id === pet_id; }) || null;
  }
  function saveLocal(pet){
    if(!pet || !pet.pet_id) return;
    var all = loadAllLocal();
    var i = all.findIndex(function(p){ return p.pet_id === pet.pet_id; });
    if(i >= 0) all[i] = pet;
    else all.push(pet);
    saveAllLocal(all);
  }

  function getActivePetId(){
    try { return localStorage.getItem(ACTIVE_KEY); } catch(e){ return null; }
  }
  function setActivePetId(pet_id){
    try { localStorage.setItem(ACTIVE_KEY, pet_id || ''); } catch(e){}
  }

  /* ─── one-time legacy migration ─── */
  function migrateLegacy(){
    try {
      var legacy = localStorage.getItem(LEGACY_KEY);
      if(!legacy) return;
      var obj = JSON.parse(legacy);
      if(!obj || typeof obj !== 'object') return;
      var v2 = loadAllLocal();
      var migrated = 0;
      for(var wallet in obj){
        var pet = obj[wallet];
        if(!pet || typeof pet !== 'object') continue;
        if(v2.find(function(p){ return p.wallet === wallet && p.born_at === pet.born_at; })) continue;
        pet.pet_id = pet.pet_id || uuid();
        pet.wallet = wallet.toLowerCase();
        v2.push(pet);
        migrated++;
      }
      if(migrated > 0){
        saveAllLocal(v2);
        console.info('[ChogiPetStore] migrated', migrated, 'legacy pet(s)');
      }
    } catch(e){ console.warn('legacy migration failed:', e); }
  }
  migrateLegacy();

  /* ─── Supabase REST ─── */
  function sbConfigured(){ return !!(SB_URL && SB_KEY); }
  function sbHeaders(extra){
    var h = {
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json'
    };
    if(extra) for(var k in extra) h[k] = extra[k];
    return h;
  }
  async function sbFetchAll(wallet){
    if(!sbConfigured()) return [];
    try {
      var url = SB_URL + '/rest/v1/chogi_pets?wallet=eq.' + encodeURIComponent(wallet.toLowerCase()) + '&select=*&order=created_at.asc';
      var r = await fetch(url, { headers: sbHeaders() });
      if(!r.ok) return [];
      var rows = await r.json();
      return (rows || []).map(rowToPet);
    } catch(e){ return []; }
  }
  async function sbFetchById(pet_id){
    if(!sbConfigured()) return null;
    try {
      var url = SB_URL + '/rest/v1/chogi_pets?pet_id=eq.' + encodeURIComponent(pet_id) + '&select=*&limit=1';
      var r = await fetch(url, { headers: sbHeaders() });
      if(!r.ok) return null;
      var rows = await r.json();
      return rows && rows[0] ? rowToPet(rows[0]) : null;
    } catch(e){ return null; }
  }
  async function sbUpsert(pet){
    if(!sbConfigured()) return false;
    try {
      var r = await fetch(SB_URL + '/rest/v1/chogi_pets', {
        method: 'POST',
        headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(petToRow(pet))
      });
      if(!r.ok) console.warn('sbUpsert failed:', r.status);
      return r.ok;
    } catch(e){ return false; }
  }
  async function sbBury(pet_id){
    if(!sbConfigured()) return false;
    try {
      var r = await fetch(SB_URL + '/rest/v1/chogi_pets?pet_id=eq.' + encodeURIComponent(pet_id), {
        method: 'PATCH',
        headers: sbHeaders({ 'Prefer': 'return=minimal' }),
        body: JSON.stringify({ buried: true })
      });
      return r.ok;
    } catch(e){ return false; }
  }
  async function sbLogEvent(pet_id, wallet, evt){
    if(!sbConfigured()) return false;
    try {
      var r = await fetch(SB_URL + '/rest/v1/chogi_pet_events', {
        method: 'POST',
        headers: sbHeaders({ 'Prefer': 'return=minimal' }),
        body: JSON.stringify({
          pet_id: pet_id || null,
          wallet: (wallet || '').toLowerCase(),
          event_type: evt.type,
          item_id: evt.item_id || null,
          burn_amount: evt.burn_amount || 0,
          tx_hash: evt.tx_hash || null,
          metadata: evt.metadata || {}
        })
      });
      return r.ok;
    } catch(e){ return false; }
  }

  function petToRow(p){
    return {
      pet_id: p.pet_id,
      wallet: (p.wallet || '').toLowerCase(),
      type: p.type,
      name: p.name || 'Unnamed',
      born_at: p.born_at,
      last_fed_at: p.last_fed_at,
      last_watered_at: p.last_watered_at,
      last_updated_at: p.last_updated_at || Date.now(),
      hunger: p.hunger,
      thirst: p.thirst,
      happiness: p.happiness,
      stage: p.stage || 'baby',
      days_alive: p.days_alive || 1,
      total_burned: p.total_burned || 0,
      feed_count: p.feed_count || 0,
      water_count: p.water_count || 0,
      hungry_events: p.hungry_events || 0,
      thirsty_events: p.thirsty_events || 0,
      cosmetics: p.cosmetics || {head:null, outfit:null, boots:null, acc:null},
      owned_items: p.owned_items || [],
      hatch_tx: p.hatch_tx || null,
      bonded: !!p.bonded,
      bonded_at: p.bonded_at || null,
      bond_tx: p.bond_tx || null,
      died_at: p.died_at || null,
      death_cause: p.death_cause || null,
      revived_count: p.revived_count || 0,
      buried: !!p.buried,
      critical_since: p.critical_since || null
    };
  }
  function rowToPet(r){
    return {
      pet_id: r.pet_id,
      wallet: r.wallet,
      type: r.type,
      name: r.name,
      born_at: Number(r.born_at),
      last_fed_at: Number(r.last_fed_at),
      last_watered_at: Number(r.last_watered_at),
      last_updated_at: Number(r.last_updated_at),
      hunger: Number(r.hunger),
      thirst: Number(r.thirst),
      happiness: Number(r.happiness),
      stage: r.stage,
      days_alive: r.days_alive,
      total_burned: Number(r.total_burned),
      feed_count: r.feed_count,
      water_count: r.water_count,
      hungry_events: r.hungry_events,
      thirsty_events: r.thirsty_events,
      cosmetics: r.cosmetics || {head:null, outfit:null, boots:null, acc:null},
      owned_items: r.owned_items || [],
      hatch_tx: r.hatch_tx,
      bonded: !!r.bonded,
      bonded_at: r.bonded_at,
      bond_tx: r.bond_tx,
      died_at: r.died_at,
      death_cause: r.death_cause,
      revived_count: r.revived_count || 0,
      buried: !!r.buried,
      critical_since: r.critical_since ? Number(r.critical_since) : null
    };
  }

  async function fetchAll(wallet){
    if(!wallet) return [];
    var local = getLocalAll(wallet);
    if(!sbConfigured()) return local;
    var remote = await sbFetchAll(wallet);
    var byId = {};
    local.forEach(function(p){ byId[p.pet_id] = p; });
    remote.forEach(function(rp){
      var lp = byId[rp.pet_id];
      if(!lp || (rp.last_updated_at || 0) > (lp.last_updated_at || 0)){
        byId[rp.pet_id] = rp;
      }
    });
    var merged = Object.values(byId);
    local.forEach(function(lp){
      if(!remote.find(function(rp){ return rp.pet_id === lp.pet_id; })){
        sbUpsert(lp).catch(function(){});
      }
    });
    var others = loadAllLocal().filter(function(p){ return (p.wallet||'').toLowerCase() !== wallet.toLowerCase(); });
    saveAllLocal(others.concat(merged));
    return merged;
  }
  async function fetchById(pet_id){
    if(!pet_id) return null;
    var local = getLocalById(pet_id);
    if(!sbConfigured()) return local;
    var remote = await sbFetchById(pet_id);
    if(remote && local){
      if((remote.last_updated_at||0) >= (local.last_updated_at||0)){
        saveLocal(remote); return remote;
      } else {
        sbUpsert(local).catch(function(){});
        return local;
      }
    }
    if(remote){ saveLocal(remote); return remote; }
    if(local){ sbUpsert(local).catch(function(){}); return local; }
    return null;
  }
  async function savePet(pet){
    if(!pet || !pet.pet_id || !pet.wallet) return false;
    pet.last_updated_at = Date.now();
    saveLocal(pet);
    if(sbConfigured()){
      try { return await sbUpsert(pet); }
      catch(e){ return false; }
    }
    return true;
  }
  async function createPet(wallet, partial){
    var pet = Object.assign({
      pet_id: uuid(),
      wallet: wallet.toLowerCase(),
      born_at: Date.now(),
      last_fed_at: Date.now(),
      last_watered_at: Date.now(),
      last_updated_at: Date.now(),
      hunger: 100,
      thirst: 100,
      happiness: 80,
      stage: 'baby',
      days_alive: 1,
      total_burned: 10000,
      feed_count: 0,
      water_count: 0,
      hungry_events: 0,
      thirsty_events: 0,
      cosmetics: {head:null, outfit:null, boots:null, acc:null},
      owned_items: [],
      bonded: false,
      revived_count: 0,
      buried: false
    }, partial || {});
    await savePet(pet);
    setActivePetId(pet.pet_id);
    return pet;
  }
  async function buryPet(pet_id){
    var p = getLocalById(pet_id);
    if(p){
      p.buried = true;
      p.last_updated_at = Date.now();
      saveLocal(p);
    }
    if(sbConfigured()) await sbBury(pet_id);
    return true;
  }

  function init(url, key){
    SB_URL = (url || '').replace(/\/+$/, '');
    SB_KEY = key || '';
    if(sbConfigured()) console.info('[ChogiPetStore v2] cloud sync enabled');
    else console.warn('[ChogiPetStore v2] cloud sync disabled');
  }

  window.ChogiPetStore = {
    _v: 2,
    init: init,
    fetchAll: fetchAll,
    fetch: fetchById,
    save: savePet,
    create: createPet,
    bury: buryPet,
    logEvent: function(pet_id, evt){
      var p = getLocalById(pet_id);
      return sbLogEvent(pet_id, p ? p.wallet : null, evt);
    },
    getActivePetId: getActivePetId,
    setActivePetId: setActivePetId,
    getLocalAll: getLocalAll,
    getLocal: getLocalById,
    saveLocal: saveLocal,
    isCloudEnabled: sbConfigured,
    uuid: uuid
  };

  if(window.ChogiConfig){
    init(window.ChogiConfig.SUPABASE_URL, window.ChogiConfig.SUPABASE_ANON_KEY);
  }
})();
