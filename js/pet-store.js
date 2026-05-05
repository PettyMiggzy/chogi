/* Chogi Pet Store
   ─────────────────
   Backend = Supabase (cloud, syncs across devices).
   Fallback = localStorage (offline / before connect).
   Source of truth = Supabase when reachable.

   Strategy:
   - On wallet connect: fetch pet from Supabase. If exists, merge with local copy
     (server timestamps win on conflicts).
   - On any save: write to BOTH localStorage (instant) AND Supabase (eventual).
   - If pet exists locally but not on server: push local to server (migration).

   Public API:
     ChogiPetStore.init(supabaseUrl, anonKey)
     await ChogiPetStore.fetch(wallet)               -> pet | null
     await ChogiPetStore.save(wallet, pet)           -> success bool
     await ChogiPetStore.logEvent(wallet, evt)       -> success bool
     ChogiPetStore.getLocal(wallet)                  -> pet | null  (sync, instant)
     ChogiPetStore.saveLocal(wallet, pet)            -> void        (sync, instant)
*/

(function(){
  if(window.ChogiPetStore) return;

  var STORE_KEY = 'chogi_pet_v1';
  var SB_URL = null;
  var SB_KEY = null;

  /* ─── localStorage helpers ─── */
  function loadAllLocal(){
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); }
    catch(e){ return {}; }
  }
  function saveAllLocal(all){
    try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); }
    catch(e){ console.warn('localStorage save failed:', e); }
  }
  function getLocal(wallet){
    if(!wallet) return null;
    var all = loadAllLocal();
    return all[wallet.toLowerCase()] || null;
  }
  function saveLocal(wallet, pet){
    if(!wallet || !pet) return;
    var all = loadAllLocal();
    all[wallet.toLowerCase()] = pet;
    saveAllLocal(all);
  }

  /* ─── Supabase REST helpers (no SDK needed) ─── */
  function sbConfigured(){
    return !!(SB_URL && SB_KEY);
  }
  function sbHeaders(extra){
    var h = {
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json'
    };
    if(extra) for(var k in extra) h[k] = extra[k];
    return h;
  }

  async function sbFetch(wallet){
    if(!sbConfigured()) return null;
    try {
      var url = SB_URL + '/rest/v1/chogi_pets?wallet=eq.' + encodeURIComponent(wallet.toLowerCase()) + '&select=*&limit=1';
      var r = await fetch(url, { headers: sbHeaders() });
      if(!r.ok) {
        console.warn('SB fetch failed:', r.status, await r.text());
        return null;
      }
      var rows = await r.json();
      return rows && rows[0] ? rowToPet(rows[0]) : null;
    } catch(e) {
      console.warn('SB fetch error:', e);
      return null;
    }
  }

  async function sbUpsert(wallet, pet){
    if(!sbConfigured()) return false;
    try {
      var url = SB_URL + '/rest/v1/chogi_pets';
      var row = petToRow(wallet, pet);
      var r = await fetch(url, {
        method: 'POST',
        headers: sbHeaders({
          'Prefer': 'resolution=merge-duplicates,return=minimal'
        }),
        body: JSON.stringify(row)
      });
      if(!r.ok){
        console.warn('SB upsert failed:', r.status, await r.text());
        return false;
      }
      return true;
    } catch(e) {
      console.warn('SB upsert error:', e);
      return false;
    }
  }

  async function sbLogEvent(wallet, evt){
    if(!sbConfigured()) return false;
    try {
      var url = SB_URL + '/rest/v1/chogi_pet_events';
      var body = {
        wallet: wallet.toLowerCase(),
        event_type: evt.type,
        item_id: evt.item_id || null,
        burn_amount: evt.burn_amount || 0,
        tx_hash: evt.tx_hash || null,
        metadata: evt.metadata || {}
      };
      var r = await fetch(url, {
        method: 'POST',
        headers: sbHeaders({ 'Prefer': 'return=minimal' }),
        body: JSON.stringify(body)
      });
      return r.ok;
    } catch(e) {
      console.warn('SB log error:', e);
      return false;
    }
  }

  /* ─── row <-> pet mapping ─── */
  function petToRow(wallet, p){
    return {
      wallet: wallet.toLowerCase(),
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
      bond_tx: p.bond_tx || null
    };
  }
  function rowToPet(r){
    return {
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
      wallet: r.wallet
    };
  }

  /* ─── public api ─── */
  async function fetchPet(wallet){
    if(!wallet) return null;
    var local = getLocal(wallet);

    if(!sbConfigured()){
      return local;
    }

    var remote = await sbFetch(wallet);

    // case A: only local exists → push to server (migration)
    if(local && !remote){
      console.info('[ChogiPetStore] migrating local pet to cloud');
      await sbUpsert(wallet, local);
      return local;
    }
    // case B: only remote exists → save locally for offline
    if(remote && !local){
      saveLocal(wallet, remote);
      return remote;
    }
    // case C: both exist → newer wins (by last_updated_at)
    if(remote && local){
      var localTs = local.last_updated_at || local.born_at || 0;
      var remoteTs = remote.last_updated_at || remote.born_at || 0;
      if(remoteTs >= localTs){
        saveLocal(wallet, remote);
        return remote;
      } else {
        await sbUpsert(wallet, local);
        return local;
      }
    }
    // case D: neither
    return null;
  }

  async function savePet(wallet, pet){
    if(!wallet || !pet) return false;
    pet.last_updated_at = Date.now();
    saveLocal(wallet, pet);
    if(sbConfigured()){
      // await the cloud upsert so callers can wait if needed
      try {
        return await sbUpsert(wallet, pet);
      } catch(e){
        console.warn('cloud save failed, kept locally:', e);
        return false;
      }
    }
    return true;
  }

  async function logEvent(wallet, evt){
    if(!sbConfigured()) return false;
    return sbLogEvent(wallet, evt);
  }

  function init(url, key){
    SB_URL = (url || '').replace(/\/+$/, '');
    SB_KEY = key || '';
    if(sbConfigured()){
      console.info('[ChogiPetStore] cloud sync enabled');
    } else {
      console.warn('[ChogiPetStore] cloud sync disabled — using localStorage only');
    }
  }

  window.ChogiPetStore = {
    init: init,
    fetch: fetchPet,
    save: savePet,
    logEvent: logEvent,
    getLocal: getLocal,
    saveLocal: saveLocal,
    isCloudEnabled: sbConfigured
  };
})();
