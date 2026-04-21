/* ========== Schedule logic ========== */
function bookingsOn(date) {
  return G.bookings.filter(b=>b.date===date)
    .sort((a,b)=>toMin(a.startTime)-toMin(b.startTime));
}

function pendingBookingsOn(date, excludeIds=[]) {
  return G.bookings.filter(b => b.date===date && b.status !== 'confirmed' && !excludeIds.includes(b.id));
}
function confirmedBookingsOn(date, excludeIds=[]) {
  return G.bookings.filter(b => b.date===date && b.status === 'confirmed' && !excludeIds.includes(b.id));
}

function bookingBreakMin(b, defaultBreak) {
  const n = Number(b && b.breakMin);
  return Number.isFinite(n) && n >= 0 ? n : defaultBreak;
}

// "busy intervals" for a day: all bookings, with optional extra overrides and excludes
function busyFromBookings(date, overrides=[], excludeIds=[]) {
  const byId = {};
  for (const b of G.bookings) if (b.date===date) byId[b.id] = b;
  for (const o of overrides) if (o && o.id) byId[o.id] = { ...byId[o.id], ...o };
  const res = [];
  for (const id of Object.keys(byId)) {
    if (excludeIds.includes(id)) continue;
    const b = byId[id];
    if (!b || b.date !== date || !b.startTime || !b.periods) continue;
    const s = toMin(b.startTime), e = s + b.periods*50;
    res.push({ s, e, id, name: b.name, kind:'booking' });
  }
  return res;
}

// does [aS,aE) overlap [bS,bE)?
const overlaps = (aS,aE,bS,bE) => aS < bE && bS < aE;

// Analyze one proposed slot.
function analyzeSlot(date, sM, dur, excludeIds=[], overrides=[]) {
  const cfg = getDayCfg(date);
  const brk = Number(cfg.brk);
  const dayS = toMin(cfg.start), dayE = toMin(cfg.end);
  const eM = sM + dur;
  const violations = {
    customBreakHit:null,
    brkShortWith:[],
    outOfDay:false,
    overlapsBooking:null,
    earlyStart:false,
    lateEnd:false
  };

  if (sM < dayS || eM > dayE) {
    violations.outOfDay = true;
    violations.earlyStart = sM < dayS;
    violations.lateEnd = eM > dayE;
  }

  for (const b of cfg.breaks) {
    if (!b.s||!b.e) continue;
    const bs=toMin(b.s), be=toMin(b.e);
    if (overlaps(sM,eM,bs,be)) {
      violations.customBreakHit = { s:bs, e:be, label:b.label||'休息' };
      break;
    }
  }

  const busy = busyFromBookings(date, overrides, excludeIds);
  for (const b of busy) {
    if (overlaps(sM,eM,b.s,b.e)) {
      violations.overlapsBooking = b; break;
    }
    if (sM >= b.e) {
      const gap = sM - b.e;
      const req = bookingBreakMin(b, brk);
      if (gap < req) violations.brkShortWith.push({ id:b.id, name:b.name, gap, required:req, side:'after' });
    } else if (eM <= b.s) {
      const gap = b.s - eM;
      if (gap < brk) violations.brkShortWith.push({ id:b.id, name:b.name, gap, required:brk, side:'before' });
    }
  }

  const ok = !violations.overlapsBooking && !violations.brkShortWith.length
          && !violations.customBreakHit && !violations.outOfDay;
  return { ok, violations };
}

/* ========== AUTO-REARRANGE ENGINE ==========
Given all bookings on a date, produce the best compact arrangement under the rules:
  - 已确认 (confirmed) bookings are fixed anchors (moving them is a last resort)
  - 待定 (pending) bookings should be packed as compactly as possible
  - Preference order: (1) fewest minutes over student preference, (2) earliest overall finish,
    (3) most lessons scheduled. Tie-break: tighter packing (less gap).
  - Respect custom breaks; respect day hours; if must violate, prefer breaks > out-of-day.

This is a deterministic greedy-with-ordering packer, not a full ILP.
Strategy:
  1. Confirmed bookings + custom breaks + outside-of-day form FIXED blockers.
  2. For pending, sort by (winStart asc, periods desc, winEnd-winStart asc).
  3. Place each pending at the earliest feasible slot that satisfies its preferred window.
  4. If no feasible slot in window, try expanded search (break/out-of-day) & track cost.
*/

// Builds blocker intervals from confirmed bookings + custom breaks. Returns sorted intervals with padding info.
function buildFixedBlockers(date, confirmedOverrides=[], pendingExcludeIds=[]) {
  const cfg = getDayCfg(date);
  const brk = Number(cfg.brk) || 0;
  const confirmed = confirmedBookingsOn(date, pendingExcludeIds);
  const byId = {};
  for (const b of confirmed) byId[b.id] = b;
  for (const o of confirmedOverrides) if (o && o.id) byId[o.id] = { ...byId[o.id], ...o };

  const hard = []; // [{s,e,kind,label?,id?,name?}]
  for (const id of Object.keys(byId)) {
    const b = byId[id];
    if (!b || b.date !== date) continue;
    const s = toMin(b.startTime), e = s + b.periods*50;
    hard.push({ s, e, kind:'confirmed', id, name:b.name, pad:bookingBreakMin(b, brk) });
  }
  for (const br of (cfg.breaks || [])) {
    if (!br || !br.s || !br.e) continue;
    const s = toMin(br.s), e = toMin(br.e);
    if (e > s) hard.push({ s, e, kind:'break', label: br.label || '休息', pad:0 });
  }
  hard.sort((a,b) => a.s - b.s);
  return hard;
}

function buildFreeRegions(wS, wE, placed, fallbackPad) {
  const items = placed.slice().sort((a,b) => a.s - b.s);
  let cur = wS;
  const freeRegions = [];
  for (const it of items) {
    const padAfter = it.pad != null ? it.pad : fallbackPad;
    const hardS = it.s;
    const hardE = it.e + padAfter;
    if (hardS > cur) freeRegions.push({
      s: cur,
      e: Math.min(hardS, wE),
      boundedByNext: it.s <= wE && it.kind !== 'break'
    });
    cur = Math.max(cur, hardE);
    if (cur >= wE) break;
  }
  if (cur < wE) freeRegions.push({ s: cur, e: wE, boundedByNext: false });
  return freeRegions;
}

function fitsRegion(start, dur, region, candidatePad) {
  const end = start + dur;
  if (end > region.e) return false;
  return !region.boundedByNext || end + candidatePad <= region.e;
}

// Try to place a booking inside a window [wS, wE] given already-placed intervals.
// `pad` means rest required after that booking, not before it.
function tryPlace(wS, wE, dur, placed, brk, prefStart=null, candidatePad=brk) {
  const freeRegions = buildFreeRegions(wS, wE, placed, brk);

  for (const r of freeRegions) {
    const lo = Math.max(wS, r.s);
    const hi = Math.min(wE, r.e);
    const latestStart = r.boundedByNext ? hi - dur - candidatePad : hi - dur;
    if (latestStart < lo) continue;
    // Snap start to 5-min grid for consistency
    const snap = v => Math.ceil(v/5)*5;
    let start = snap(lo);
    if (!fitsRegion(start, dur, r, candidatePad)) continue;
    // If user has a preferred start and it fits in this region, prefer it
    if (prefStart != null && prefStart >= lo && fitsRegion(prefStart, dur, r, candidatePad)) {
      start = prefStart;
    }
    return start;
  }
  return null;
}

// Like tryPlace but, when searching, picks the slot closest to [prefWS, prefWE].
// Used as the fallback when no in-window slot exists — we want to minimize how far
// we overshoot the student's preferred window, not just grab the earliest free slot.
function tryPlaceClosestTo(wS, wE, dur, placed, brk, prefWS, prefWE, candidatePad=brk) {
  const freeRegions = buildFreeRegions(wS, wE, placed, brk);

  // Scoring: how many minutes does a slot starting at `s` go outside [prefWS, prefWE]?
  const overshoot = (s) => {
    let o = 0;
    if (s < prefWS) o += (prefWS - s);
    if (s + dur > prefWE) o += (s + dur - prefWE);
    return o;
  };

  const snap = v => Math.ceil(v/5)*5;
  let best = null, bestOver = Infinity;
  for (const r of freeRegions) {
    const lo = Math.max(wS, r.s);
    const hi = Math.min(wE, r.e);
    const latestStart = r.boundedByNext ? hi - dur - candidatePad : hi - dur;
    if (latestStart < lo) continue;
    // In this region, the optimal start that minimizes overshoot is as close to prefWS as possible,
    // clamped to [lo, hi-dur].
    const ideal = Math.max(lo, Math.min(latestStart, prefWS));
    const s = snap(ideal);
    // snap may push past hi-dur; also try floor-snap as alternative
    const candidates = [s, Math.floor(ideal/5)*5].filter(x => x >= lo && fitsRegion(x, dur, r, candidatePad));
    for (const c of candidates) {
      const o = overshoot(c);
      if (o < bestOver) { best = c; bestOver = o; }
    }
  }
  return best;
}

function tryPlaceLatest(wS, wE, dur, placed, brk, candidatePad=brk) {
  const freeRegions = buildFreeRegions(wS, wE, placed, brk);
  for (let i = freeRegions.length - 1; i >= 0; i--) {
    const r = freeRegions[i];
    const lo = Math.max(wS, r.s);
    const hi = Math.min(wE, r.e);
    const latestStart = r.boundedByNext ? hi - dur - candidatePad : hi - dur;
    if (latestStart < lo) continue;
    const s = Math.floor(latestStart / 5) * 5;
    if (s >= lo && fitsRegion(s, dur, r, candidatePad)) return s;
  }
  return null;
}

// Compute per-slot cost given plan context (breaks hit, out-of-day offsets).
function computeSlotCosts(date, sM, dur, cfg, prefWS, prefWE) {
  const dayS = toMin(cfg.start), dayE = toMin(cfg.end);
  const eM = sM + dur;
  const costs = {
    inWindow: (sM >= prefWS && eM <= prefWE),
    prefOverBy: 0,        // how many minutes outside student preference
    earlyOpen: 0,         // minutes before day start
    lateClose: 0,         // minutes past day end
    breakHits: []         // [{label, minutes}] for each custom break overlapped
  };
  if (sM < prefWS) costs.prefOverBy += (prefWS - sM);
  if (eM > prefWE) costs.prefOverBy += (eM - prefWE);
  if (sM < dayS)  costs.earlyOpen = dayS - sM;
  if (eM > dayE)  costs.lateClose = eM - dayE;
  for (const br of (cfg.breaks || [])) {
    if (!br.s || !br.e) continue;
    const bs = toMin(br.s), be = toMin(br.e);
    const ov = Math.max(0, Math.min(eM, be) - Math.max(sM, bs));
    if (ov > 0) costs.breakHits.push({ label: br.label || '休息', minutes: ov });
  }
  return costs;
}

// Aggregate plan costs (for the whole arrangement: pending + optional confirmed moves).
function summarizePlan(plan) {
  // plan = { placements: [{id,isPending,isConfirmed,startTime,periods,winStart,winEnd,name,originalStart?}], date }
  const cfg = getDayCfg(plan.date);
  const dayS = toMin(cfg.start), dayE = toMin(cfg.end);
  const summary = {
    prefOverTotal: 0,
    prefOverDetails: [],   // [{name, minutes}]
    earlyOpenMin: 0,
    lateCloseMin: 0,
    breakHitsMap: {},      // label -> minutes
    movedConfirmed: [],    // [{id,name,from,to}]
    overallEnd: null,      // latest finish across plan (minutes)
    gapTotal: 0,
    placedCount: 0,
    unplaced: []           // ids that couldn't be placed
  };

  let maxEnd = -1;
  const intervals = [];
  for (const pl of plan.placements) {
    if (!pl.startTime) { summary.unplaced.push(pl); continue; }
    const s = toMin(pl.startTime), e = s + pl.periods*50;
    intervals.push({ s, e });
    maxEnd = Math.max(maxEnd, e);
    summary.placedCount++;
    const prefWS = toMin(pl.winStart), prefWE = toMin(pl.winEnd);
    const c = computeSlotCosts(plan.date, s, pl.periods*50, cfg, prefWS, prefWE);
    // 已确认预约意味着时间已和学生谈妥，不再按"期望时间"衡量。
    // 只有待定预约才算 prefOver。
    if (!pl.isConfirmed && c.prefOverBy > 0) {
      summary.prefOverTotal += c.prefOverBy;
      summary.prefOverDetails.push({ name: pl.name, minutes: c.prefOverBy });
    }
    summary.earlyOpenMin = Math.max(summary.earlyOpenMin, c.earlyOpen);
    summary.lateCloseMin = Math.max(summary.lateCloseMin, c.lateClose);
    for (const h of c.breakHits) {
      summary.breakHitsMap[h.label] = (summary.breakHitsMap[h.label] || 0) + h.minutes;
    }
    if (pl.isConfirmed && pl.originalStart && pl.originalStart !== pl.startTime) {
      summary.movedConfirmed.push({ id: pl.id, name: pl.name, from: pl.originalStart, to: pl.startTime });
    }
  }
  if (maxEnd > 0) summary.overallEnd = maxEnd;
  intervals.sort((a,b) => a.s - b.s);
  for (let i=0; i<intervals.length-1; i++) {
    summary.gapTotal += Math.max(0, intervals[i+1].s - intervals[i].e);
  }
  return summary;
}

// Compute a numeric "trouble score" from summary for ranking.
// Lower is better. Weights roughly match Zhiyan's priorities ("尽量紧凑").
// pref-over minutes weigh heaviest; moving confirmed is very expensive;
// occupying a break / extending hours add moderate cost; overall end time adds small
// pressure so among equally-fine plans the earlier-finishing one wins.
function planScore(summary) {
  const strategy = G.scheduleStrategy || 'student';
  const weights = {
    student: { pref:10, moved:500, break:4, hours:6, end:0.1, gap:0.02 },
    teacher: { pref:6, moved:500, break:8, hours:12, end:0.12, gap:0.02 },
    compact: { pref:8, moved:500, break:4, hours:6, end:0.35, gap:0.25 }
  }[strategy] || { pref:10, moved:500, break:4, hours:6, end:0.1, gap:0.02 };
  let s = 0;
  s += summary.prefOverTotal * weights.pref;
  s += summary.movedConfirmed.length * weights.moved;
  const breakMin = Object.values(summary.breakHitsMap).reduce((a,b)=>a+b, 0);
  s += breakMin * weights.break;

  // --- Asymmetric soft/hard thresholds for out-of-day minutes ---
  // Soft thresholds: late 60 min, early 30 min. Within soft threshold, late < early
  // (teacher prefers staying late over arriving early).
  // Beyond threshold: 10x multiplier — enough that 120 min over >> moving 1-2 confirmed.
  // Coefficients calibrated so (for student strategy):
  //   late 60 (360) < early 30 (432) < move 1 confirmed (500) < move 2 (1000)
  //     < late 90 (2160) < early 60 (4752) < late 120 (4320) < early 120 (7992)
  // teacher strategy (hours=12) naturally reorders: move confirmed cheapest,
  //   which matches "老师时间优先" semantics.
  const EARLY_SOFT = 30;
  const LATE_SOFT = 60;
  const HARD_MULT = 10;
  const EARLY_COEF = 2.4;   // early minutes weighed 2.4x vs late (within soft)
  const LATE_COEF = 1.0;

  const earlySoft = Math.min(summary.earlyOpenMin, EARLY_SOFT);
  const earlyHard = Math.max(0, summary.earlyOpenMin - EARLY_SOFT);
  s += earlySoft * weights.hours * EARLY_COEF;
  s += earlyHard * weights.hours * EARLY_COEF * HARD_MULT;

  const lateSoft = Math.min(summary.lateCloseMin, LATE_SOFT);
  const lateHard = Math.max(0, summary.lateCloseMin - LATE_SOFT);
  s += lateSoft * weights.hours * LATE_COEF;
  s += lateHard * weights.hours * LATE_COEF * HARD_MULT;

  if (summary.overallEnd != null) s += Math.max(0, summary.overallEnd - 600) * weights.end;
  s += summary.gapTotal * weights.gap;
  // Unplaced penalty (very high — we'd rather try alternative plan)
  s += summary.unplaced.length * 10000;
  return s;
}

function planPlacementSignature(plan) {
  return plan.placements.slice().sort((a,b)=>a.id.localeCompare(b.id))
    .map(x => `${x.id}@${x.startTime || 'X'}`).join('|');
}

// Signature for choices that are meaningfully different to the user.
// If two plans have the same unplaced bookings and the same cost summary, showing both
// usually looks like a duplicate even when two flexible students swapped valid slots.
function planOutcomeSignature(plan) {
  const s = plan.summary;
  const pref = s.prefOverDetails.slice()
    .sort((a,b) => a.name.localeCompare(b.name) || a.minutes - b.minutes)
    .map(d => `${d.name}:${d.minutes}`).join(',');
  const breaks = Object.keys(s.breakHitsMap).sort()
    .map(k => `${k}:${s.breakHitsMap[k]}`).join(',');
  const moved = s.movedConfirmed.slice()
    .sort((a,b) => a.id.localeCompare(b.id))
    .map(m => `${m.id}:${m.from}>${m.to}`).join(',');
  const unplaced = s.unplaced.slice()
    .sort((a,b) => a.id.localeCompare(b.id))
    .map(p => p.id).join(',');
  return [
    `unplaced=${unplaced}`,
    `pref=${pref}`,
    `early=${s.earlyOpenMin}`,
    `late=${s.lateCloseMin}`,
    `breaks=${breaks}`,
    `moved=${moved}`
  ].join('|');
}

function planTieBreakScore(plan) {
  return plan.placements.reduce((sum, pl) => {
    if (!pl.startTime || !pl.isPending) return sum;
    return sum + Math.abs(toMin(pl.startTime) - toMin(pl.winStart));
  }, 0);
}

function planCostVector(plan) {
  const s = plan.summary;
  return {
    unplaced: s.unplaced.length,
    prefOver: s.prefOverTotal,
    early: s.earlyOpenMin,
    late: s.lateCloseMin,
    breakMin: Object.values(s.breakHitsMap).reduce((a,b)=>a+b, 0),
    movedConfirmed: s.movedConfirmed.length,
    overallEnd: s.overallEnd == null ? 0 : s.overallEnd,
    gapTotal: s.gapTotal || 0
  };
}

function planDominates(a, b) {
  const av = planCostVector(a), bv = planCostVector(b);
  const keys = ['unplaced', 'prefOver', 'early', 'late', 'breakMin', 'movedConfirmed', 'overallEnd', 'gapTotal'];
  return keys.every(k => av[k] <= bv[k]) && keys.some(k => av[k] < bv[k]);
}

function outOfDaySearchBounds(dayS, dayE, opts) {
  const earlyS = Math.max(0, dayS - 180);
  const lateE = Math.min(24*60, dayE + 180);
  if (opts.outOfDaySide === 'early') return { s: earlyS, e: dayS };
  if (opts.outOfDaySide === 'late') return { s: dayE, e: lateE };
  return { s: earlyS, e: lateE };
}

function pushUndoSnapshot() {
  if (G.suppressNextUndo) {
    G.suppressNextUndo = false;
    return;
  }
  G.undoSnapshot = {
    bookings: JSON.parse(JSON.stringify(G.bookings)),
    dayCfg: JSON.parse(JSON.stringify(G.dayCfg)),
    defaultCfg: JSON.parse(JSON.stringify(G.defaultCfg))
  };
  renderUndoButton();
}

function renderUndoButton() {
  const btn = document.getElementById('undoBtn');
  if (btn) btn.disabled = !G.undoSnapshot;
}

function undoLastChange() {
  if (!G.undoSnapshot) return;
  G.bookings = JSON.parse(JSON.stringify(G.undoSnapshot.bookings || []));
  G.dayCfg = JSON.parse(JSON.stringify(G.undoSnapshot.dayCfg || {}));
  G.defaultCfg = normalizeCfg(G.undoSnapshot.defaultCfg || DFLT);
  G.undoSnapshot = null;
  save();
  renderUndoButton();
  renderCal();
  if (G.selDate) {
    renderCfg();
    renderBookingList();
    renderDetail(G.selDate);
  }
  showToast('已撤销上一步');
}

function openStrategySettings() {
  const modal = document.getElementById('strategyModal');
  const input = document.querySelector(`input[name="scheduleStrategy"][value="${G.scheduleStrategy || 'student'}"]`);
  if (input) input.checked = true;
  modal.classList.add('show');
}

function closeStrategySettings() {
  document.getElementById('strategyModal').classList.remove('show');
}

function saveStrategySettings() {
  const input = document.querySelector('input[name="scheduleStrategy"]:checked');
  G.scheduleStrategy = input ? input.value : 'student';
  save();
  closeStrategySettings();
  showToast('排课策略已保存');
}

/* =========================================================
   AUTO REARRANGE (the core new behavior)
   ========================================================= */
// Build several candidate plans for a date and rank them.
// `target` (optional): a pending-shaped booking that's being newly added or edited. Its
// id may or may not exist in G.bookings yet. When present, its current startTime is ignored
// (we re-pick the best slot for it too).
// Returns: [plans] ordered by score ascending. Each plan has { placements, summary, score, tags, description }.
function buildAutoRearrangePlans(date, target=null, options={}) {
  const cfg = getDayCfg(date);
  const brk = Number(cfg.brk) || 0;
  const dayS = toMin(cfg.start), dayE = toMin(cfg.end);
  const lockTargetStart = !!(target && options.lockTargetStart && target.startTime);

  // Gather pending bookings on the date (excluding the one being edited, which is in `target`).
  const excludeIds = target && target.id ? [target.id] : [];
  const allPendings = pendingBookingsOn(date, excludeIds).slice();
  const lockedPendings = allPendings.filter(b => b.lockedStart && b.startTime);
  const pendings = allPendings.filter(b => !(b.lockedStart && b.startTime));
  const fixedPlacements = [];
  for (const b of lockedPendings) {
    fixedPlacements.push({
      id: b.id,
      name: b.name,
      isPending: true,
      isConfirmed: false,
      startTime: b.startTime,
      periods: b.periods,
      breakMin: bookingBreakMin(b, brk),
      winStart: b.winStart,
      winEnd: b.winEnd,
      __isLocked: true
    });
  }
  if (target && lockTargetStart) {
    fixedPlacements.push({
      id: target.id || '__pending__',
      name: target.name,
      isPending: target.status !== 'confirmed',
      isConfirmed: target.status === 'confirmed',
      startTime: target.startTime,
      periods: target.periods,
      breakMin: bookingBreakMin(target, brk),
      winStart: target.winStart,
      winEnd: target.winEnd,
      originalStart: target.startTime,
      __isLocked: !!target.lockedStart,
      __isTarget: true
    });
  } else if (target) pendings.push({
    id: target.id || '__pending__',
    name: target.name, date, periods: target.periods,
    breakMin: bookingBreakMin(target, brk),
    winStart: target.winStart, winEnd: target.winEnd,
    startTime: target.startTime, status: 'pending', __isTarget: true
  });
  const confirmed = confirmedBookingsOn(date, excludeIds);

  // We'll try multiple strategies and collect plans.
  const plans = [];
  const maxPlans = options.maxPlans || 6;

  // ---- STRATEGY A: Don't touch confirmed. Pack pending around them. ----
  // Try several pending-ordering heuristics.
  const orderings = [
    (a,b) => toMin(a.winStart) - toMin(b.winStart) || b.periods - a.periods,
    (a,b) => toMin(a.winStart) - toMin(b.winStart) || a.periods - b.periods,
    (a,b) => b.periods - a.periods || toMin(a.winStart) - toMin(b.winStart),
    (a,b) => (toMin(a.winEnd)-toMin(a.winStart)) - (toMin(b.winEnd)-toMin(b.winStart)) || toMin(a.winStart) - toMin(b.winStart),
  ];

  for (const cmp of orderings) {
    const plan = packPending(date, pendings.slice().sort(cmp), confirmed, { allowBreak:false, allowOutOfDay:false, fixedPlacements });
    if (plan) plans.push(plan);
    // Also try allowing break/out-of-day as fallback
    const planFb = packPending(date, pendings.slice().sort(cmp), confirmed, { allowBreak:true, allowOutOfDay:true, fixedPlacements });
    if (planFb) plans.push(planFb);
    const planBreak = packPending(date, pendings.slice().sort(cmp), confirmed, { allowBreak:true, allowOutOfDay:false, preferBreak:true, fixedPlacements });
    if (planBreak) plans.push(planBreak);
    const planEarly = packPending(date, pendings.slice().sort(cmp), confirmed, { allowBreak:true, allowOutOfDay:true, outOfDaySide:'early', fixedPlacements });
    if (planEarly) plans.push(planEarly);
    const planLate = packPending(date, pendings.slice().sort(cmp), confirmed, { allowBreak:true, allowOutOfDay:true, outOfDaySide:'late', fixedPlacements });
    if (planLate) plans.push(planLate);
  }

  for (const cmp of orderings.slice(0,2)) {
    const planBack = packPendingBackward(date, pendings.slice().sort(cmp).reverse(), confirmed, { allowBreak:false, allowOutOfDay:false, fixedPlacements });
    if (planBack) plans.push(planBack);
    const planBackFb = packPendingBackward(date, pendings.slice().sort(cmp).reverse(), confirmed, { allowBreak:true, allowOutOfDay:true, fixedPlacements });
    if (planBackFb) plans.push(planBackFb);
  }
  const byCurrentTimeDesc = (a,b) => {
    const as = a.startTime ? toMin(a.startTime) : toMin(a.winStart);
    const bs = b.startTime ? toMin(b.startTime) : toMin(b.winStart);
    return bs - as;
  };
  const planBackCurrent = packPendingBackward(date, pendings.slice().sort(byCurrentTimeDesc), confirmed, { allowBreak:false, allowOutOfDay:false, fixedPlacements });
  if (planBackCurrent) plans.push(planBackCurrent);

  // ---- STRATEGY B: Allow moving confirmed bookings ----
  // Original: only fire when keep-confirmed plans ALL fail to place everyone.
  // Revised:  also fire when all keep-confirmed plans have one of these problems:
  //           - exceed soft out-of-day thresholds (>30 min early OR >60 min late), OR
  //           - violate student preferences by more than 60 minutes in total
  //           This gives the chooser a chance to compare "move 1-2 confirmed"
  //           against degraded alternatives.
  const EARLY_SOFT_GEN = 30;
  const LATE_SOFT_GEN = 60;
  const PREF_OVER_GEN = 60;
  const hasAcceptableKeepPlan = plans.some(p => {
    const unplaced = p.placements.filter(pl => !pl.startTime).length;
    if (unplaced > 0) return false;
    const sum = p.summary || summarizePlan({ placements: p.placements, date });
    p.summary = sum; // cache for later
    return sum.earlyOpenMin <= EARLY_SOFT_GEN
        && sum.lateCloseMin <= LATE_SOFT_GEN
        && sum.prefOverTotal <= PREF_OVER_GEN;
  });
  if (confirmed.length > 0 && !hasAcceptableKeepPlan && options.allowMoveConfirmed !== false) {
    for (const cmp of orderings.slice(0,2)) {
      const plan = packWithConfirmedMoves(date, pendings.slice().sort(cmp), confirmed, { allowBreak:false, allowOutOfDay:false, fixedPlacements });
      if (plan) plans.push(plan);
      const planFb = packWithConfirmedMoves(date, pendings.slice().sort(cmp), confirmed, { allowBreak:true, allowOutOfDay:true, fixedPlacements });
      if (planFb) plans.push(planFb);
      const planBreak = packWithConfirmedMoves(date, pendings.slice().sort(cmp), confirmed, { allowBreak:true, allowOutOfDay:false, preferBreak:true, fixedPlacements });
      if (planBreak) plans.push(planBreak);
      const planEarly = packWithConfirmedMoves(date, pendings.slice().sort(cmp), confirmed, { allowBreak:true, allowOutOfDay:true, outOfDaySide:'early', fixedPlacements });
      if (planEarly) plans.push(planEarly);
      const planLate = packWithConfirmedMoves(date, pendings.slice().sort(cmp), confirmed, { allowBreak:true, allowOutOfDay:true, outOfDaySide:'late', fixedPlacements });
      if (planLate) plans.push(planLate);
    }
    // Eviction plans: actively move 1-2 confirmed to let pending into its window.
    // Try both "nearest" (disrupt the one most in the way) and "widest" (disrupt the
    // one easiest to re-home) so the chooser can compare.
    for (const mode of ['nearest', 'widest']) {
      for (const cmp of orderings.slice(0,2)) {
        const planE = packEvictConfirmed(date, pendings.slice().sort(cmp), confirmed, { evictMode: mode, allowOutOfDay:false, fixedPlacements });
        if (planE) plans.push(planE);
        const planEExt = packEvictConfirmed(date, pendings.slice().sort(cmp), confirmed, { evictMode: mode, allowOutOfDay:true, fixedPlacements });
        if (planEExt) plans.push(planEExt);
      }
    }
  }

  // Deduplicate exact schedules first, then collapse equivalent user-facing choices.
  const seen = new Set();
  const exactUnique = [];
  for (const p of plans) {
    const sig = planPlacementSignature(p);
    if (seen.has(sig)) continue;
    seen.add(sig);
    p.summary = summarizePlan({ placements: p.placements, date });
    p.score = planScore(p.summary);
    exactUnique.push(p);
  }

  exactUnique.sort((a,b) =>
    a.score - b.score ||
    planTieBreakScore(a) - planTieBreakScore(b) ||
    planPlacementSignature(a).localeCompare(planPlacementSignature(b))
  );

  const outcomeSeen = new Set();
  const unique = [];
  for (const p of exactUnique) {
    if (exactUnique.some(other => other !== p && planDominates(other, p))) continue;
    const sig = planOutcomeSignature(p);
    if (outcomeSeen.has(sig)) continue;
    outcomeSeen.add(sig);
    unique.push(p);
  }
  return unique.slice(0, maxPlans);
}

// Pack `pendings` (in given order) around fixed confirmed+breaks.
function packPending(date, pendings, confirmed, opts) {
  const cfg = getDayCfg(date);
  const brk = Number(cfg.brk) || 0;
  const dayS = toMin(cfg.start), dayE = toMin(cfg.end);

  // Fixed blockers
  const fixed = [];
  for (const c of confirmed) {
    const s = toMin(c.startTime), e = s + c.periods*50;
    fixed.push({ s, e, pad: bookingBreakMin(c, brk), id:c.id, kind:'confirmed' });
  }
  for (const pl of (opts.fixedPlacements || [])) {
    if (!pl.startTime) continue;
    const s = toMin(pl.startTime), e = s + pl.periods*50;
    fixed.push({ s, e, pad: bookingBreakMin(pl, brk), id:pl.id, kind:'fixed-target' });
  }
  for (const br of (cfg.breaks || [])) {
    if (!br.s || !br.e) continue;
    const s = toMin(br.s), e = toMin(br.e);
    if (e > s) fixed.push({ s, e, pad: 0, kind:'break', label: br.label || '休息' });
  }

  // Day bounds treat as hard unless allowOutOfDay
  const placedNew = []; // placed pending intervals (with pad)
  const placements = [
    ...confirmed.map(c => ({
      id: c.id, name: c.name, isPending:false, isConfirmed:true,
      startTime: c.startTime, periods: c.periods,
      breakMin: bookingBreakMin(c, brk),
      winStart: c.winStart, winEnd: c.winEnd, originalStart: c.startTime
    })),
    ...(opts.fixedPlacements || []).map(pl => ({ ...pl }))
  ];

  for (const p of pendings) {
    const dur = p.periods*50;
    const pBreak = bookingBreakMin(p, brk);
    const prefWS = toMin(p.winStart), prefWE = toMin(p.winEnd);
    const searchWS = Math.max(prefWS, dayS);
    const searchWE = Math.min(prefWE, dayE);
    const allBlockers = [...fixed, ...placedNew];
    const blockersNoBreaks = opts.allowBreak
      ? [...fixed.filter(f => f.kind !== 'break'), ...placedNew]
      : null;

    let startM = null;
    if (opts.preferBreak && blockersNoBreaks && searchWE - searchWS >= dur) {
      startM = tryPlace(searchWS, searchWE, dur, blockersNoBreaks, brk, null, pBreak);
    }
    if (startM == null && searchWE - searchWS >= dur) {
      startM = tryPlace(searchWS, searchWE, dur, allBlockers, brk, null, pBreak);
    }
    // If no in-window slot, search the whole day but pick the one closest to the preferred window
    if (startM == null) {
      startM = tryPlaceClosestTo(dayS, dayE, dur, allBlockers, brk, prefWS, prefWE, pBreak);
    }
    // Fallback: occupy breaks
    if (startM == null && opts.allowBreak) {
      startM = tryPlaceClosestTo(dayS, dayE, dur, blockersNoBreaks, brk, prefWS, prefWE, pBreak);
    }
    // Fallback: extend day
    if (startM == null && opts.allowOutOfDay) {
      const blockersExt = opts.allowBreak
        ? [...fixed.filter(f => f.kind !== 'break'), ...placedNew]
        : [...fixed, ...placedNew];
      const ext = outOfDaySearchBounds(dayS, dayE, opts);
      startM = tryPlaceClosestTo(ext.s, ext.e, dur, blockersExt, brk, prefWS, prefWE, pBreak);
    }

    if (startM == null) {
      placements.push({
        id: p.id, name: p.name, isPending:true, isConfirmed:false,
        startTime: null, periods: p.periods,
        breakMin: pBreak,
        winStart: p.winStart, winEnd: p.winEnd,
        __isTarget: !!p.__isTarget
      });
      continue;
    }

    placedNew.push({ s: startM, e: startM + dur, pad: pBreak });
    placements.push({
      id: p.id, name: p.name, isPending:true, isConfirmed:false,
      startTime: toT(startM), periods: p.periods,
      breakMin: pBreak,
      winStart: p.winStart, winEnd: p.winEnd,
      __isTarget: !!p.__isTarget
    });
  }

  return { placements, date, strategy:'pack' };
}

// Pack from late to early. This catches the teacher-friendly move of ending a class
// right before a custom break (for example dinner) instead of pushing it far after.
function packPendingBackward(date, pendings, confirmed, opts) {
  const cfg = getDayCfg(date);
  const brk = Number(cfg.brk) || 0;
  const dayS = toMin(cfg.start), dayE = toMin(cfg.end);

  const fixed = [];
  for (const c of confirmed) {
    const s = toMin(c.startTime), e = s + c.periods*50;
    fixed.push({ s, e, pad: bookingBreakMin(c, brk), id:c.id, kind:'confirmed' });
  }
  for (const pl of (opts.fixedPlacements || [])) {
    if (!pl.startTime) continue;
    const s = toMin(pl.startTime), e = s + pl.periods*50;
    fixed.push({ s, e, pad: bookingBreakMin(pl, brk), id:pl.id, kind:'fixed-target' });
  }
  for (const br of (cfg.breaks || [])) {
    if (!br.s || !br.e) continue;
    const s = toMin(br.s), e = toMin(br.e);
    if (e > s) fixed.push({ s, e, pad: 0, kind:'break', label: br.label || '休息' });
  }

  const placedNew = [];
  const placements = [
    ...confirmed.map(c => ({
      id: c.id, name: c.name, isPending:false, isConfirmed:true,
      startTime: c.startTime, periods: c.periods,
      breakMin: bookingBreakMin(c, brk),
      winStart: c.winStart, winEnd: c.winEnd, originalStart: c.startTime
    })),
    ...(opts.fixedPlacements || []).map(pl => ({ ...pl }))
  ];

  for (const p of pendings) {
    const dur = p.periods*50;
    const pBreak = bookingBreakMin(p, brk);
    const prefWS = toMin(p.winStart), prefWE = toMin(p.winEnd);
    const searchWS = Math.max(prefWS, dayS);
    const searchWE = Math.min(prefWE, dayE);
    const allBlockers = [...fixed, ...placedNew];
    let startM = null;

    if (searchWE - searchWS >= dur) {
      startM = tryPlaceLatest(searchWS, searchWE, dur, allBlockers, brk, pBreak);
    }
    if (startM == null) {
      startM = tryPlaceLatest(dayS, dayE, dur, allBlockers, brk, pBreak);
    }
    if (startM == null && opts.allowBreak) {
      const blockersNoBreaks = [...fixed.filter(f => f.kind !== 'break'), ...placedNew];
      startM = tryPlaceLatest(dayS, dayE, dur, blockersNoBreaks, brk, pBreak);
    }
    if (startM == null && opts.allowOutOfDay) {
      const blockersExt = opts.allowBreak
        ? [...fixed.filter(f => f.kind !== 'break'), ...placedNew]
        : allBlockers;
      const ext = outOfDaySearchBounds(dayS, dayE, opts);
      startM = tryPlaceLatest(ext.s, ext.e, dur, blockersExt, brk, pBreak);
    }

    if (startM == null) {
      placements.push({
        id: p.id, name: p.name, isPending:true, isConfirmed:false,
        startTime: null, periods: p.periods,
        breakMin: pBreak,
        winStart: p.winStart, winEnd: p.winEnd,
        __isTarget: !!p.__isTarget
      });
      continue;
    }

    placedNew.push({ s: startM, e: startM + dur, pad: pBreak });
    placements.push({
      id: p.id, name: p.name, isPending:true, isConfirmed:false,
      startTime: toT(startM), periods: p.periods,
      breakMin: pBreak,
      winStart: p.winStart, winEnd: p.winEnd,
      __isTarget: !!p.__isTarget
    });
  }

  return { placements, date, strategy:'pack-backward' };
}

// Pack allowing confirmed bookings to move within their own windows (expensive).
function packWithConfirmedMoves(date, pendings, confirmed, opts) {
  const cfg = getDayCfg(date);
  const brk = Number(cfg.brk) || 0;
  const dayS = toMin(cfg.start), dayE = toMin(cfg.end);

  // Treat ALL bookings as movable (confirmed ones carry a flag).
  const all = [
    ...confirmed.map(c => ({ ...c, isPending:false, isConfirmed:true })),
    ...pendings.map(p => ({ ...p, isPending:true, isConfirmed:false }))
  ];
  // Order: confirmed first, sorted by ORIGINAL startTime (so they re-claim their real positions
  // in time order, not some made-up order based on winStart). Pendings come last.
  all.sort((a,b) => {
    if (a.isConfirmed !== b.isConfirmed) return a.isConfirmed ? -1 : 1;
    if (a.isConfirmed) {
      // both confirmed: order by original startTime ascending
      return toMin(a.startTime) - toMin(b.startTime);
    }
    return toMin(a.winStart) - toMin(b.winStart);
  });

  // Fixed = breaks only.
  const fixed = [];
  for (const pl of (opts.fixedPlacements || [])) {
    if (!pl.startTime) continue;
    const s = toMin(pl.startTime), e = s + pl.periods*50;
    fixed.push({ s, e, pad:bookingBreakMin(pl, brk), kind:'fixed-target', id:pl.id });
  }
  for (const br of (cfg.breaks || [])) {
    if (!br.s || !br.e) continue;
    const s = toMin(br.s), e = toMin(br.e);
    if (e > s) fixed.push({ s, e, pad:0, kind:'break', label: br.label || '休息' });
  }

  const placedNew = [];
  const placements = (opts.fixedPlacements || []).map(pl => ({ ...pl }));

  for (const p of all) {
    const dur = p.periods*50;
    const pBreak = bookingBreakMin(p, brk);
    const allBlockers = [...fixed, ...placedNew];
    const blockersNoBreaks = opts.allowBreak
      ? [...fixed.filter(f => f.kind !== 'break'), ...placedNew]
      : null;
    const origStart = p.startTime ? toMin(p.startTime) : null;

    let startM = null;
    if (p.isConfirmed) {
      if (opts.preferBreak && blockersNoBreaks) {
        startM = tryPlace(dayS, dayE, dur, blockersNoBreaks, brk, origStart, pBreak);
      }
      // 已确认预约：时间已与学生谈妥，不再按期望窗口衡量；尽量就地不动。
      // 如果原位不被新的约束挡住，保持原位；否则在整个工作日内找最近原位的位置。
      if (startM == null) startM = tryPlace(dayS, dayE, dur, allBlockers, brk, origStart, pBreak);
      if (startM == null && opts.allowBreak) {
        startM = tryPlace(dayS, dayE, dur, blockersNoBreaks, brk, origStart, pBreak);
      }
      if (startM == null && opts.allowOutOfDay) {
        const ext = outOfDaySearchBounds(dayS, dayE, opts);
        startM = tryPlace(ext.s, ext.e, dur, allBlockers, brk, origStart, pBreak);
      }
    } else {
      // 待定预约：按期望窗口搜索，搜不到再回退。
      const prefWS = toMin(p.winStart), prefWE = toMin(p.winEnd);
      const searchWS = Math.max(prefWS, dayS);
      const searchWE = Math.min(prefWE, dayE);
      if (opts.preferBreak && blockersNoBreaks && searchWE - searchWS >= dur) {
        startM = tryPlace(searchWS, searchWE, dur, blockersNoBreaks, brk, origStart, pBreak);
      }
      if (startM == null && searchWE - searchWS >= dur) {
        startM = tryPlace(searchWS, searchWE, dur, allBlockers, brk, origStart, pBreak);
      }
      if (startM == null) startM = tryPlaceClosestTo(dayS, dayE, dur, allBlockers, brk, prefWS, prefWE, pBreak);
      if (startM == null && opts.allowBreak) {
        startM = tryPlaceClosestTo(dayS, dayE, dur, blockersNoBreaks, brk, prefWS, prefWE, pBreak);
      }
      if (startM == null && opts.allowOutOfDay) {
        const ext = outOfDaySearchBounds(dayS, dayE, opts);
        startM = tryPlaceClosestTo(ext.s, ext.e, dur, [...fixed, ...placedNew], brk, prefWS, prefWE, pBreak);
      }
    }

    if (startM == null) {
      placements.push({
        id: p.id, name: p.name, isPending:p.isPending, isConfirmed:p.isConfirmed,
        startTime: null, periods: p.periods,
        breakMin: pBreak,
        winStart: p.winStart, winEnd: p.winEnd,
        originalStart: p.isConfirmed ? p.startTime : null,
        __isTarget: !!p.__isTarget
      });
      continue;
    }
    placedNew.push({ s: startM, e: startM + dur, pad: pBreak });
    placements.push({
      id: p.id, name: p.name, isPending:p.isPending, isConfirmed:p.isConfirmed,
      startTime: toT(startM), periods: p.periods,
      breakMin: pBreak,
      winStart: p.winStart, winEnd: p.winEnd,
      originalStart: p.isConfirmed ? p.startTime : null,
      __isTarget: !!p.__isTarget
    });
  }

  return { placements, date, strategy:'with-confirmed-moves' };
}

/* ========== Actively evict 1-2 confirmed bookings to make room for pending ==========
  Unlike packWithConfirmedMoves (which keeps confirmed at original positions and packs
  pending into leftover gaps), this function ACTIVELY picks 1-2 confirmed bookings
  that overlap a pending's preferred window, removes them, places the pending first,
  then re-homes the evicted confirmed within THEIR OWN preferred windows.

  If an evicted confirmed cannot fit back within its own [winStart, winEnd], the whole
  plan is abandoned (we never push a confirmed outside its agreed-upon window).

  `mode` controls which confirmed to evict:
    'nearest'  → evict the confirmed(s) whose original slot overlaps the pending's
                 preferred window most directly (minimum disruption to other students)
    'widest'   → evict the confirmed(s) with the widest [winStart, winEnd] (easiest
                 to re-home elsewhere)
*/
function packEvictConfirmed(date, pendings, confirmed, opts) {
  const cfg = getDayCfg(date);
  const brk = Number(cfg.brk) || 0;
  const dayS = toMin(cfg.start), dayE = toMin(cfg.end);
  const mode = opts.evictMode || 'nearest';

  // We only invoke eviction for a single "target" pending (the one that can't
  // fit otherwise). Pick: the pending whose preferred window has the least
  // free space given current confirmed layout.
  if (!pendings.length) return null;

  // Pick target pending: the one whose preferred window is most blocked
  // by confirmed bookings.
  let target = pendings[0];
  let maxBlock = -1;
  for (const p of pendings) {
    const pWS = toMin(p.winStart), pWE = toMin(p.winEnd);
    let blocked = 0;
    for (const c of confirmed) {
      const cS = toMin(c.startTime), cE = cS + c.periods * 50;
      const ov = Math.max(0, Math.min(pWE, cE) - Math.max(pWS, cS));
      blocked += ov;
    }
    if (blocked > maxBlock) { maxBlock = blocked; target = p; }
  }
  if (maxBlock <= 0) return null; // no confirmed blocks any pending — eviction pointless

  const targetWS = toMin(target.winStart), targetWE = toMin(target.winEnd);
  const targetDur = target.periods * 50;

  // Rank confirmed by eviction priority.
  const rank = (c) => {
    const cS = toMin(c.startTime), cE = cS + c.periods * 50;
    const overlap = Math.max(0, Math.min(targetWE, cE) - Math.max(targetWS, cS));
    if (mode === 'widest') {
      // Widest own window → easiest to re-home. Only consider overlapping ones.
      if (overlap === 0) return Infinity;
      const cWidth = toMin(c.winEnd) - toMin(c.winStart);
      return -cWidth; // negative so larger width = "smaller rank" = preferred
    }
    // 'nearest': prefer confirmed whose current slot overlaps target's window most.
    if (overlap === 0) return Infinity;
    return -overlap; // larger overlap = preferred for eviction
  };

  const evictCandidates = confirmed
    .slice()
    .map(c => ({ c, r: rank(c) }))
    .filter(x => x.r !== Infinity)
    .sort((a,b) => a.r - b.r)
    .map(x => x.c);

  if (!evictCandidates.length) return null;

  // Try evicting 1 first, then 2 if needed.
  for (const evictCount of [1, 2]) {
    if (evictCandidates.length < evictCount) continue;
    const toEvict = evictCandidates.slice(0, evictCount);
    const evictIds = new Set(toEvict.map(c => c.id));
    const keepConfirmed = confirmed.filter(c => !evictIds.has(c.id));

    // Build fixed blockers from kept confirmed + breaks.
    const fixed = [];
    for (const c of keepConfirmed) {
      const s = toMin(c.startTime), e = s + c.periods * 50;
      fixed.push({ s, e, pad: bookingBreakMin(c, brk), id: c.id, kind: 'confirmed' });
    }
    for (const br of (cfg.breaks || [])) {
      if (!br.s || !br.e) continue;
      const s = toMin(br.s), e = toMin(br.e);
      if (e > s) fixed.push({ s, e, pad: 0, kind: 'break', label: br.label || '休息' });
    }
    for (const pl of (opts.fixedPlacements || [])) {
      if (!pl.startTime) continue;
      const s = toMin(pl.startTime), e = s + pl.periods*50;
      fixed.push({ s, e, pad: bookingBreakMin(pl, brk), id: pl.id, kind: 'fixed-target' });
    }

    // Step 1: place target pending inside its preferred window (no compromise on day hours).
    const searchWS = Math.max(targetWS, dayS);
    const searchWE = Math.min(targetWE, dayE);
    if (searchWE - searchWS < targetDur) continue; // target itself doesn't fit in day∩pref

    const placedNew = [];
    const allBlockers = [...fixed];
    let targetStart = tryPlace(searchWS, searchWE, targetDur, allBlockers, brk, toMin(target.startTime), bookingBreakMin(target, brk));
    if (targetStart == null) continue; // couldn't place target even after eviction

    placedNew.push({ s: targetStart, e: targetStart + targetDur, pad: bookingBreakMin(target, brk) });

    // Step 2: re-home each evicted confirmed within ITS OWN preferred window.
    const evictedPlacements = [];
    let allEvictedFit = true;
    for (const c of toEvict) {
      const cDur = c.periods * 50;
      const cPad = bookingBreakMin(c, brk);
      const cWS = Math.max(toMin(c.winStart), dayS);
      const cWE = Math.min(toMin(c.winEnd), dayE);
      if (cWE - cWS < cDur) { allEvictedFit = false; break; }
      const blockersNow = [...fixed, ...placedNew];
      // Prefer staying close to original slot.
      const origStart = toMin(c.startTime);
      const cStart = tryPlace(cWS, cWE, cDur, blockersNow, brk, origStart, cPad);
      if (cStart == null) { allEvictedFit = false; break; }
      placedNew.push({ s: cStart, e: cStart + cDur, pad: cPad });
      evictedPlacements.push({ c, start: cStart });
    }
    if (!allEvictedFit) continue;

    // Step 3: place remaining pendings (other than target) in their preferred windows.
    const otherPendings = pendings.filter(p => p.id !== target.id);
    const otherPlacements = [];
    let allPendingsFit = true;
    for (const p of otherPendings) {
      const pDur = p.periods * 50;
      const pPad = bookingBreakMin(p, brk);
      const pWS = Math.max(toMin(p.winStart), dayS);
      const pWE = Math.min(toMin(p.winEnd), dayE);
      const blockersNow = [...fixed, ...placedNew];
      let startM = null;
      if (pWE - pWS >= pDur) {
        startM = tryPlace(pWS, pWE, pDur, blockersNow, brk, null, pPad);
      }
      if (startM == null) {
        startM = tryPlaceClosestTo(dayS, dayE, pDur, blockersNow, brk, toMin(p.winStart), toMin(p.winEnd), pPad);
      }
      if (startM == null && opts.allowOutOfDay) {
        const ext = outOfDaySearchBounds(dayS, dayE, opts);
        startM = tryPlaceClosestTo(ext.s, ext.e, pDur, blockersNow, brk, toMin(p.winStart), toMin(p.winEnd), pPad);
      }
      if (startM == null) { allPendingsFit = false; break; }
      placedNew.push({ s: startM, e: startM + pDur, pad: pPad });
      otherPlacements.push({ p, start: startM });
    }
    if (!allPendingsFit) continue;

    // Build placements list.
    const placements = [...(opts.fixedPlacements || []).map(pl => ({...pl}))];
    // Kept confirmed at original positions
    for (const c of keepConfirmed) {
      placements.push({
        id: c.id, name: c.name, isPending: false, isConfirmed: true,
        startTime: c.startTime, periods: c.periods,
        breakMin: bookingBreakMin(c, brk),
        winStart: c.winStart, winEnd: c.winEnd,
        originalStart: c.startTime
      });
    }
    // Evicted confirmed at new positions (this is what triggers movedConfirmed in summary)
    for (const ep of evictedPlacements) {
      placements.push({
        id: ep.c.id, name: ep.c.name, isPending: false, isConfirmed: true,
        startTime: toT(ep.start), periods: ep.c.periods,
        breakMin: bookingBreakMin(ep.c, brk),
        winStart: ep.c.winStart, winEnd: ep.c.winEnd,
        originalStart: ep.c.startTime  // <-- different from startTime ⇒ counted as moved
      });
    }
    // Target pending
    placements.push({
      id: target.id, name: target.name, isPending: true, isConfirmed: false,
      startTime: toT(targetStart), periods: target.periods,
      breakMin: bookingBreakMin(target, brk),
      winStart: target.winStart, winEnd: target.winEnd,
      originalStart: null,
      __isTarget: !!target.__isTarget
    });
    // Other pendings
    for (const op of otherPlacements) {
      placements.push({
        id: op.p.id, name: op.p.name, isPending: true, isConfirmed: false,
        startTime: toT(op.start), periods: op.p.periods,
        breakMin: bookingBreakMin(op.p, brk),
        winStart: op.p.winStart, winEnd: op.p.winEnd,
        originalStart: null,
        __isTarget: !!op.p.__isTarget
      });
    }

    return { placements, date, strategy: `evict-${mode}-${evictCount}` };
  }
  return null;
}

/* ========== Describe plan costs for UI (the "代价说明" card) ========== */
function describePlanCosts(plan, targetId=null) {
  // Plan MUST have summary already computed.
  const s = plan.summary;
  const lines = [];

  // 1. 期望内?
  if (s.prefOverTotal === 0 && s.movedConfirmed.length === 0 && s.earlyOpenMin === 0 && s.lateCloseMin === 0 && Object.keys(s.breakHitsMap).length === 0) {
    lines.push({ kind:'good', text:'所有预约都在学生期望时间内' });
  } else if (s.prefOverTotal === 0) {
    lines.push({ kind:'good', text:'所有预约都在学生期望时间内' });
  }

  // 2. 占用自定义休息
  for (const label of Object.keys(s.breakHitsMap)) {
    const mins = s.breakHitsMap[label];
    if (mins > 0) lines.push({ kind:'break', text:`占用${label} ${mins} 分钟` });
  }

  // 3. 提早开课
  if (s.earlyOpenMin > 0) lines.push({ kind:'early', text:`提前 ${s.earlyOpenMin} 分钟开课` });
  // 4. 延后下班
  if (s.lateCloseMin > 0) lines.push({ kind:'late', text:`延后 ${s.lateCloseMin} 分钟下班` });

  // 5. 超出学生期望
  for (const d of s.prefOverDetails) {
    lines.push({ kind:'over-pref', text:`超出【${d.name}】期望 ${d.minutes} 分钟` });
  }

  // 6. 移动已确认
  for (const m of s.movedConfirmed) {
    lines.push({ kind:'moved-confirmed', text:`移动【${m.name}】已确认时间（${m.from} → ${m.to}），需和【${m.name}】沟通` });
  }

  return lines;
}

/* ========== Apply a plan to G.bookings ========== */
// Pass-through write: replace startTime of every existing booking in plan.placements;
// if target is a new booking (id='__pending__' or not in G.bookings), insert it.
function applyPlan(plan, targetBooking=null) {
  pushUndoSnapshot();
  for (const pl of plan.placements) {
    if (!pl.startTime) continue;
    if (pl.id === '__pending__' || (targetBooking && pl.id === targetBooking.id && !G.bookings.find(b => b.id === pl.id))) {
      // Will insert target below
      continue;
    }
    const bk = G.bookings.find(b => b.id === pl.id);
    if (bk) bk.startTime = pl.startTime;
  }
  if (targetBooking) {
    const existing = G.bookings.find(b => b.id === targetBooking.id);
    const targetPlacement = plan.placements.find(pl =>
      pl.id === targetBooking.id || (pl.__isTarget) || pl.id === '__pending__'
    );
    const finalStart = targetPlacement && targetPlacement.startTime ? targetPlacement.startTime : targetBooking.startTime;
    if (existing) {
      Object.assign(existing, targetBooking, { startTime: finalStart });
    } else {
      G.bookings.push({ ...targetBooking, startTime: finalStart });
    }
  }
  save();
}

/* ========== The main entry points (called from UI) ========== */
// Called after adding / editing / deleting a booking. Auto-rearranges pending bookings
// on that date. If target is provided (new/edited), include it in the rearrangement.
// Options: { isNew, isEdit, isDelete, silent }
function autoRearrangeDay(date, target=null, options={}) {
  const plans = buildAutoRearrangePlans(date, target, options);

  if (!plans.length) {
    // Fall back: just insert target verbatim
    if (target) applyPlan({ placements: [], date }, target);
    return { outcome:'no-plan' };
  }

  const best = plans[0];

  // Check if best plan is "clean" (no moves of confirmed, no break/out/over-pref).
  const isClean = (p) => {
    const s = p.summary;
    return s.movedConfirmed.length === 0
        && s.prefOverTotal === 0
        && s.earlyOpenMin === 0
        && s.lateCloseMin === 0
        && Object.keys(s.breakHitsMap).length === 0
        && s.unplaced.length === 0;
  };

  if (isClean(best)) {
    // Auto-apply clean plan.
    const countRearranged = countActualMoves(best, target);
    applyPlan(best, target);
    if (!options.silent && countRearranged > 0) {
      showToast(`已自动重排 ${countRearranged} 个预约`);
    }
    return { outcome:'auto', plan: best };
  }

  // Not clean — surface the plans for user choice.
  return { outcome:'choose', plans, target };
}

function countActualMoves(plan, target) {
  let n = 0;
  const targetId = target && target.id;
  const targetAlreadyInG = target && G.bookings.find(b => b.id === targetId);
  for (const pl of plan.placements) {
    if (!pl.startTime) continue;
    if (pl.__isTarget || pl.id === '__pending__' || (targetId && pl.id === targetId)) {
      // Count the target iff it's being inserted anew, OR if editing moved its startTime.
      if (!targetAlreadyInG) { n++; continue; }
      if (target && pl.startTime !== target.startTime) { n++; continue; }
      continue;
    }
    const bk = G.bookings.find(b => b.id === pl.id);
    if (bk && bk.startTime !== pl.startTime) n++;
  }
  return n;
}

/* ========== Commit after user picks a plan from the modal ========== */
function applyChosenPlan(planIndex) {
  const plan = G.plansForModal && G.plansForModal[planIndex];
  if (!plan) return;
  applyPlan(plan, G.planTarget);
  G.plansForModal = null;
  G.planTarget = null;
  document.getElementById('conflictModal').classList.remove('show');

  // Refresh view
  renderCal();
  if (G.selDate) { renderBookingList(); renderDetail(G.selDate); }
  if (G.editingId) cancelEdit();
}

/* ========== Show the plan-chooser modal ========== */
function showPlanChooser(plans, target, title='选择排课方案', subtitle='当前安排需要做出取舍，请选择：') {
  G.plansForModal = plans;
  G.planTarget = target;

  document.getElementById('cmTitle').textContent = title;
  document.getElementById('cmSubtitle').textContent = subtitle;
  document.getElementById('cmNewLabel').textContent = target ? '本次操作' : '当前日安排';

  if (target) {
    const dur = target.periods * 50;
    const reqS = target.startTime ? toMin(target.startTime) : toMin(target.winStart);
    document.getElementById('cmNew').innerHTML = `
      <div class="cm-info-row">
        <div class="cm-dot" style="background:${nameColor(target.name)}"></div>
        <div>
          <strong>${esc(target.name)}</strong>
          &nbsp;${target.periods}课时 · ${dur}分钟
          <div style="font-size:11px;color:var(--muted);margin-top:2px">
            期望时间段：${target.winStart} – ${target.winEnd}
          </div>
        </div>
      </div>`;
  } else {
    document.getElementById('cmNew').innerHTML = `<div style="font-size:13px;color:var(--muted)">重新整理当天待定预约</div>`;
  }
  document.getElementById('cmConflictsSection').style.display = 'none';

  const html = plans.map((p, i) => {
    const costs = describePlanCosts(p, target ? target.id : null);
    const costHtml = costs.length
      ? `<ul class="cost-list">${costs.map(c => `<li class="cost-${c.kind}">${esc(c.text)}</li>`).join('')}</ul>`
      : `<div class="cost-list-empty">无额外代价</div>`;

    // placements: list each scheduled slot so user sees "who at when"
    const placeLines = p.placements
      .filter(pl => pl.startTime)
      .sort((a,b) => toMin(a.startTime) - toMin(b.startTime))
      .map(pl => {
        const eT = toT(toMin(pl.startTime) + pl.periods*50);
        const movedMark = pl.isConfirmed && pl.originalStart && pl.originalStart !== pl.startTime
          ? `<span class="cm-warn-mark">⚠ 已确认</span>` : '';
        const label = pl.isConfirmed ? '已确认' : (pl.__isTarget ? '本次' : '待定');
        return `<div class="cm-sugg-line"><span class="cm-sugg-role">${label}</span>【${esc(pl.name)}】${pl.isConfirmed && pl.originalStart && pl.originalStart!==pl.startTime ? `${pl.originalStart} → ` : ''}${pl.startTime}–${eT} ${movedMark}</div>`;
      }).join('');

    const unplaced = p.placements.filter(pl => !pl.startTime);
    const unplacedHtml = unplaced.length
      ? `<div class="cm-unplaced">⚠ 无法安排：${unplaced.map(u => esc(u.name)).join('、')}</div>`
      : '';

    const needsComm = p.summary.movedConfirmed.length > 0;
    const cardCls = `cm-sugg${needsComm ? ' cm-sugg-warn' : ''}`;

    return `
      <div class="${cardCls}" onclick="applyChosenPlan(${i})">
        <div class="cm-sugg-hdr">
          <span class="cm-num">方案${DNUMS[i] || (i+1)}</span>
          ${needsComm ? '<span class="tag-move-out">需沟通已确认预约</span>' : ''}
        </div>
        <div class="cm-sugg-body">
          ${costHtml}
        </div>
        <div class="cm-sugg-placements">${placeLines}</div>
        ${unplacedHtml}
      </div>`;
  }).join('');
  document.getElementById('cmSuggs').innerHTML = html || '<div class="cm-nosugg">没有可行方案</div>';
  document.getElementById('conflictModal').classList.add('show');
}

/* ========== Edit mode ========== */
function startEdit(id) {
  const b = G.bookings.find(b=>b.id===id);
  if (!b) return;
  G.editingId = id;

  document.getElementById('iName').value     = b.name;
  document.getElementById('iDate').value     = b.date;
  document.getElementById('iWinStart').value = b.winStart;
  document.getElementById('iWinEnd').value   = b.winEnd;
  document.getElementById('iPeriods').value  = b.periods;
  document.getElementById('iBreakMin').value = bookingBreakMin(b, Number(getDayCfg(b.date).brk) || 0);
  document.getElementById('iStartTime').value= b.startTime;
  document.getElementById('iLockedStart').checked = !!b.lockedStart;

  document.getElementById('breakMinField').style.display = 'block';
  document.getElementById('startTimeField').style.display = 'block';
  document.getElementById('addBtns').style.display  = 'none';
  document.getElementById('editBtns').style.display = 'block';
  document.getElementById('formLabel').textContent  = '编辑预约';
  document.getElementById('editBanner').classList.add('show');
  document.getElementById('editBannerName').textContent = b.name;
  document.getElementById('addErr').style.display = 'none';
  document.getElementById('editPrecheck').style.display = 'block';

  document.getElementById('sbScroll').scrollTop = 0;
  renderEditPrecheck();
  renderBookingList();
}
function cancelEdit() {
  G.editingId = null;
  document.getElementById('iName').value      = '';
  document.getElementById('iBreakMin').value  = '';
  document.getElementById('iStartTime').value = '';
  document.getElementById('iLockedStart').checked = false;
  document.getElementById('breakMinField').style.display = 'none';
  document.getElementById('startTimeField').style.display = 'none';
  document.getElementById('addBtns').style.display  = 'block';
  document.getElementById('editBtns').style.display = 'none';
  document.getElementById('formLabel').textContent  = '新建预约';
  document.getElementById('editBanner').classList.remove('show');
  document.getElementById('addErr').style.display = 'none';
  document.getElementById('editPrecheck').style.display = 'none';

  if (G.selDate) {
    const cfg = getDayCfg(G.selDate);
    document.getElementById('iDate').value     = G.selDate;
    document.getElementById('iWinStart').value = cfg.start;
    document.getElementById('iWinEnd').value   = cfg.end;
  }
  renderBookingList();
}

/* ========== Confirm modal (generic) ========== */
function askConfirm(title, bodyHtml, onOk, okText='继续添加') {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmBody').innerHTML   = bodyHtml;
  document.getElementById('confirmOk').textContent   = okText;
  G.confirmCb = onOk;
  document.getElementById('confirmModal').classList.add('show');
}
function confirmOk() {
  const cb = G.confirmCb; G.confirmCb = null;
  document.getElementById('confirmModal').classList.remove('show');
  if (cb) cb();
}
function confirmCancel() {
  G.confirmCb = null;
  document.getElementById('confirmModal').classList.remove('show');
}
document.getElementById('confirmModal').addEventListener('click', e => {
  if (e.target === document.getElementById('confirmModal')) confirmCancel();
});

/* ========== Cancel plan-chooser ========== */
function cancelPending() {
  G.plansForModal = null;
  G.planTarget = null;
  G.suppressNextUndo = false;
  document.getElementById('conflictModal').classList.remove('show');
}
document.getElementById('conflictModal').addEventListener('click', e => {
  if (e.target === document.getElementById('conflictModal')) cancelPending();
});
document.getElementById('settingsModal').addEventListener('click', e => {
  if (e.target === document.getElementById('settingsModal')) closeSettings();
});
document.getElementById('strategyModal').addEventListener('click', e => {
  if (e.target === document.getElementById('strategyModal')) closeStrategySettings();
});

function readEditDraft() {
  if (!G.editingId) return null;
  const name = document.getElementById('iName').value.trim();
  const date = document.getElementById('iDate').value;
  const winStart = document.getElementById('iWinStart').value;
  const winEnd = document.getElementById('iWinEnd').value;
  const periods = parseInt(document.getElementById('iPeriods').value) || 1;
  const startTime = document.getElementById('iStartTime').value;
  const cfg = date ? getDayCfg(date) : G.defaultCfg;
  const breakRaw = document.getElementById('iBreakMin').value;
  const breakMin = breakRaw === '' ? Number(cfg.brk) || 0 : Number(breakRaw);
  if (!name || !date || !winStart || !winEnd || !startTime || !Number.isFinite(breakMin)) return null;
  return { id:G.editingId, name, date, winStart, winEnd, periods, startTime, breakMin };
}

function renderEditPrecheck() {
  const el = document.getElementById('editPrecheck');
  if (!el || !G.editingId) return;
  const draft = readEditDraft();
  if (!draft) {
    el.className = 'precheck warn';
    el.style.display = 'block';
    el.textContent = '填写实际开始时间后，会预检冲突和课间。';
    return;
  }

  const cfg = getDayCfg(draft.date);
  const dayS = toMin(cfg.start), dayE = toMin(cfg.end);
  const s = toMin(draft.startTime), e = s + draft.periods * 50;
  const issues = [];
  if (s < dayS) issues.push(`早于当天开始时间 ${cfg.start}`);
  if (e > dayE) issues.push(`晚于当天结束时间 ${cfg.end}`);
  for (const br of (cfg.breaks || [])) {
    if (!br.s || !br.e) continue;
    const bs = toMin(br.s), be = toMin(br.e);
    if (overlaps(s, e, bs, be)) issues.push(`占用${br.label || '休息'} ${Math.max(0, Math.min(e, be) - Math.max(s, bs))} 分钟`);
  }
  for (const b of G.bookings.filter(b => b.date === draft.date && b.id !== draft.id && b.startTime)) {
    const bs = toMin(b.startTime), be = bs + b.periods * 50;
    if (overlaps(s, e, bs, be)) {
      issues.push(`和【${b.name}】时间重叠`);
      continue;
    }
    const gap = s >= be ? s - be : bs - e;
    const req = s >= be
      ? bookingBreakMin(b, Number(cfg.brk) || 0)
      : bookingBreakMin(draft, Number(cfg.brk) || 0);
    if (gap >= 0 && gap < req) issues.push(`和【${b.name}】间隔 ${gap} 分钟，不足课间 ${req} 分钟`);
  }

  el.style.display = 'block';
  if (!issues.length) {
    el.className = 'precheck good';
    el.textContent = '预检通过：当前时间没有冲突，课间也足够。';
  } else {
    el.className = issues.some(x => x.includes('重叠')) ? 'precheck bad' : 'precheck warn';
    el.innerHTML = `预检提醒：<br>${issues.map(esc).join('<br>')}`;
  }
}

/* ========== Form submit ========== */
function submitForm() {
  const name    = document.getElementById('iName').value.trim();
  const date    = document.getElementById('iDate').value;
  const winStart= document.getElementById('iWinStart').value;
  const winEnd  = document.getElementById('iWinEnd').value;
  const periods = parseInt(document.getElementById('iPeriods').value) || 1;
  const isEdit  = !!G.editingId;
  const breakMinAlreadyConfirmed = !!G.breakMinConfirmed;
  G.breakMinConfirmed = false;
  const cfg     = getDayCfg(date);
  const dayS    = toMin(cfg.start), dayE = toMin(cfg.end);
  const wS      = toMin(winStart), wE = toMin(winEnd);
  const effectiveStartMin = Math.max(wS, dayS);
  const effectiveStart = toT(effectiveStartMin);
  const effectiveEndMin = Math.min(wE, dayE);
  const defaultBreakMin = Number(cfg.brk) || 0;
  renderEditPrecheck();

  const errEl = document.getElementById('addErr');
  errEl.style.display = 'none';
  const err = msg => { errEl.textContent=msg; errEl.style.display='block';
    clearTimeout(errEl._t); errEl._t=setTimeout(()=>errEl.style.display='none',4000); };

  if (!name)              return err('请填写学生姓名');
  if (!date)              return err('请选择日期');
  if (!winStart||!winEnd) return err('请填写期望时间段');
  if (toMin(winEnd)<=toMin(winStart)) return err('结束时间必须晚于开始时间');
  const dur = periods*50;
  if (toMin(winStart)+dur > toMin(winEnd))
    return err(`${periods}节课需要${dur}分钟，超出期望时间段（${toMin(winEnd)-toMin(winStart)}分钟）`);

  // Same student cannot appear twice same day
  const sameDay = G.bookings.filter(b =>
    b.date===date && b.name===name && (!isEdit || b.id!==G.editingId)
  );
  if (sameDay.length) {
    return err(`${date} 已有学生【${name}】的预约，同一天不可重复`);
  }

  // Edit mode may have user-specified startTime; otherwise we let autoRearrange pick.
  let userStartTime = null;
  let userLockedStart = false;
  let userBreakMin = defaultBreakMin;
  if (isEdit) {
    const s = document.getElementById('iStartTime').value;
    const breakRaw = document.getElementById('iBreakMin').value;
    userLockedStart = document.getElementById('iLockedStart').checked;
    userBreakMin = breakRaw === '' ? defaultBreakMin : Number(breakRaw);
    if (!Number.isFinite(userBreakMin) || userBreakMin < 0 || userBreakMin > 120)
      return err('课间休息需填写 0-120 分钟');
    if (s) {
      userStartTime = s;
      if (toMin(s) < toMin(winStart) || toMin(s) + dur > toMin(winEnd))
        return err('实际开始时间超出期望时间段');
    } else if (userLockedStart) {
      return err('锁定时间前请先填写实际开始时间');
    }
  }

  if (isEdit && userBreakMin < defaultBreakMin && !breakMinAlreadyConfirmed) {
    askConfirm(
      '课间休息短于当天设置',
      `当天设置的课间休息是 ${defaultBreakMin} 分钟，本次将改为 ${userBreakMin} 分钟。<br><br>确定要按新的课间时间重新排课吗？`,
      () => {
        G.breakMinConfirmed = true;
        submitForm();
      },
      '确认修改'
    );
    return;
  }

  const hasEffectiveOverlap = effectiveEndMin > effectiveStartMin;
  if (!hasEffectiveOverlap) {
    const earlyMsg = wS < dayS ? `期望开始时间 ${winStart} 早于本日开始时间 ${cfg.start}` : null;
    const lateMsg  = wE > dayE ? `期望结束时间 ${winEnd} 晚于本日结束时间 ${cfg.end}`  : null;
    const msgs = [earlyMsg, lateMsg].filter(Boolean);
    askConfirm('期望时间超出当日时段', msgs.join('<br>') + '<br><br>是否仍然添加？', () => {
      afterWindowConfirmed();
    });
    return;
  }
  afterWindowConfirmed();

  function afterWindowConfirmed() {
    const existing = isEdit ? G.bookings.find(b => b.id===G.editingId) : null;
    const booking = {
      id: isEdit ? G.editingId : uid(),
      name, color: nameColor(name),
      date, winStart, winEnd, periods,
      startTime: userStartTime || effectiveStart,
      status: existing ? existing.status : 'pending',
      lockedStart: isEdit ? userLockedStart : false,
      breakMin: isEdit ? userBreakMin : defaultBreakMin
    };

    // Kick off auto-rearrange including this new/edited booking.
    // Edit mode: if user specified startTime explicitly, respect it (don't re-pick for this one).
    const result = autoRearrangeDay(date, booking, { isNew: !isEdit, isEdit, lockTargetStart: isEdit && userLockedStart && !!userStartTime });

    if (result.outcome === 'choose') {
      showPlanChooser(result.plans, booking,
        isEdit ? '编辑预约需要取舍' : '添加预约需要取舍',
        '当前安排无法完全满足所有约束，请选择方案：');
      return;
    }

    // Clean or no-plan path: refresh UI
    if (!isEdit) document.getElementById('iName').value = '';
    const d = new Date(booking.date + 'T00:00:00');
    G.year = d.getFullYear(); G.month = d.getMonth();
    renderCal();
    selDay(booking.date);
    if (isEdit) cancelEdit();
  }
}

/* ========== Manual rearrange (triggered by user for settings changes) ========== */
function manualRearrangeDay(date) {
  if (!date) return;
  pushUndoSnapshot();
  const cfg = getDayCfg(date);
  const brk = Number(cfg.brk) || 0;
  for (const b of G.bookings) {
    if (b.date === date) b.breakMin = brk;
  }
  save();
  G.suppressNextUndo = true;
  const pendings = pendingBookingsOn(date);
  if (!pendings.length) {
    G.suppressNextUndo = false;
    showToast('已应用当天课间；当天没有待定预约，无需重排');
    renderBookingList();
    renderCal();
    renderDetail(date);
    return;
  }
  const result = autoRearrangeDay(date, null, { silent: false });
  if (result.outcome === 'choose') {
    showPlanChooser(result.plans, null,
      '重新排课需要取舍',
      '当前约束下无法完全满足，请选择方案：');
  } else if (result.outcome === 'auto') {
    renderCal();
    if (G.selDate) { renderBookingList(); renderDetail(G.selDate); }
  } else {
    G.suppressNextUndo = false;
    showToast('暂无可执行方案');
  }
}
