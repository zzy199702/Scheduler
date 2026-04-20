/* ========== Persistence ========== */
const BACKUP_KEY = `${STORE_KEY}_backup`;

function currentDataSnapshot() {
  return {
    defaultCfg: G.defaultCfg,
    dayCfg: G.dayCfg,
    bookings: G.bookings,
    scheduleStrategy: G.scheduleStrategy,
    exportedAt: new Date().toISOString(),
    app: 'paike-scheduler',
    version: STORE_KEY
  };
}

function applyStoredData(d) {
  if (!d || typeof d !== 'object') return false;
  const hasData = !!(d.defaultCfg || d.dayCfg || Array.isArray(d.bookings) || d.scheduleStrategy);
  if (!hasData) return false;
  if (d.defaultCfg) G.defaultCfg = normalizeCfg({ ...DFLT, ...d.defaultCfg });
  if (d.dayCfg) {
    G.dayCfg = {};
    for (const k of Object.keys(d.dayCfg)) G.dayCfg[k] = normalizeCfg(d.dayCfg[k]);
  }
  if (Array.isArray(d.bookings)) G.bookings = d.bookings.map(normalizeBooking);
  if (d.scheduleStrategy) G.scheduleStrategy = d.scheduleStrategy;
  return true;
}

function load() {
  let loaded = false;
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    loaded = applyStoredData(d);
  } catch(e) {
    try {
      const backup = JSON.parse(localStorage.getItem(BACKUP_KEY) || '{}');
      loaded = applyStoredData(backup);
      if (loaded) localStorage.setItem(STORE_KEY, JSON.stringify(backup));
    } catch(_) {}
  }

  // Migrate from older storage key
  if (!loaded && !localStorage.getItem(STORE_KEY)) {
    try {
      const old = JSON.parse(localStorage.getItem('paike_v5') || '{}');
      if (applyStoredData(old)) save();
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
  const existing = localStorage.getItem(STORE_KEY);
  if (existing) localStorage.setItem(BACKUP_KEY, existing);
  localStorage.setItem(STORE_KEY, JSON.stringify(currentDataSnapshot()));
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

function importDataObject(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.bookings)) {
    throw new Error('备份文件格式不正确');
  }
  applyStoredData(d);
  save();
}
