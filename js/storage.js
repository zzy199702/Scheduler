/* ========== Persistence ========== */
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    if (d.defaultCfg) G.defaultCfg = normalizeCfg({ ...DFLT, ...d.defaultCfg });
    if (d.dayCfg) {
      G.dayCfg = {};
      for (const k of Object.keys(d.dayCfg)) G.dayCfg[k] = normalizeCfg(d.dayCfg[k]);
    }
    if (d.bookings) G.bookings = d.bookings.map(normalizeBooking);
    if (d.scheduleStrategy) G.scheduleStrategy = d.scheduleStrategy;
  } catch(e) {}

  // Migrate from older storage key
  if (!localStorage.getItem(STORE_KEY)) {
    try {
      const old = JSON.parse(localStorage.getItem('paike_v5') || '{}');
      if (old.defaultCfg) G.defaultCfg = normalizeCfg({ ...DFLT, ...old.defaultCfg });
      if (old.dayCfg) {
        G.dayCfg = {};
        for (const k of Object.keys(old.dayCfg)) G.dayCfg[k] = normalizeCfg(old.dayCfg[k]);
      }
      if (old.bookings) G.bookings = old.bookings.map(normalizeBooking);
      if (old.scheduleStrategy) G.scheduleStrategy = old.scheduleStrategy;
      save();
    } catch(e) {}
  }
}
function normalizeCfg(c) {
  return {
    start: c.start || '08:00',
    end:   c.end   || '22:00',
    brk:   Number.isFinite(+c.brk) ? +c.brk : 10,
    breaks: Array.isArray(c.breaks) ? c.breaks.map(b => ({
      s: b.s || b.start || '12:00',
      e: b.e || b.end   || '13:00',
      label: b.label || '休息'
    })) : []
  };
}
function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify({
    defaultCfg: G.defaultCfg, dayCfg: G.dayCfg, bookings: G.bookings,
    scheduleStrategy: G.scheduleStrategy
  }));
}


function normalizeBooking(b) {
  // Legacy 'locked' is migrated to 'confirmed'; anything not confirmed is pending.
  const s = b && b.status;
  const status = (s === 'confirmed' || s === 'locked') ? 'confirmed' : 'pending';
  return {
    ...b,
    status,
    lockedStart: !!b.lockedStart,
    breakMin: b.breakMin != null && Number.isFinite(+b.breakMin) ? +b.breakMin : undefined
  };
}
