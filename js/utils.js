/* ========== Utils ========== */
const toMin = t => { const [h,m]=t.split(':').map(Number); return h*60+m; };
const toT   = m => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
const dStr  = (y,m,d) => `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
const esc   = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const uid   = () => Date.now().toString(36)+Math.random().toString(36).slice(2,5);
function nameColor(name) {
  let h = 5381;
  for (const c of name) h = ((h<<5)+h)+c.charCodeAt(0);
  return PAL[Math.abs(h)%PAL.length];
}
function getDayCfg(date) {
  return normalizeCfg((date && G.dayCfg[date]) ? G.dayCfg[date] : G.defaultCfg);
}

/* ========== Day summary (for calendar cells & detail view) ========== */
function analyzeDayGaps(date) {
  const cfg = getDayCfg(date);
  const brk = Number(cfg.brk) || 0;
  const dayS = toMin(cfg.start), dayE = toMin(cfg.end);
  const bks = (G.bookings || []).filter(b => b.date === date && b.startTime && b.periods)
    .slice().sort((a,b) => toMin(a.startTime) - toMin(b.startTime));

  const empty = {
    hasBookings: bks.length > 0,
    earliestStart: null, latestEnd: null,
    totalPeriods: 0, teachingMinutes: 0,
    bookablePeriods: 0,
    gapTotal: 0, gapMax: 0, gaps: []
  };
  if (dayE <= dayS) return empty;

  const breakIntervals = (cfg.breaks || []).map(br => {
    if (!br || !br.s || !br.e) return null;
    const s = Math.max(dayS, toMin(br.s));
    const e = Math.min(dayE, toMin(br.e));
    return e > s ? { s, e } : null;
  }).filter(Boolean);

  const subtractBreaks = (s, e) => {
    let segs = [{ s, e }];
    for (const br of breakIntervals) {
      const next = [];
      for (const seg of segs) {
        const ovS = Math.max(seg.s, br.s), ovE = Math.min(seg.e, br.e);
        if (ovE <= ovS) {
          next.push(seg);
        } else {
          if (seg.s < ovS) next.push({ s: seg.s, e: ovS });
          if (ovE < seg.e) next.push({ s: ovE, e: seg.e });
        }
      }
      segs = next;
    }
    return segs;
  };

  // Build "blocked" intervals: bookings padded by `brk` on each side (as buffer),
  // plus explicit custom breaks. Clipped to day hours.
  const blocked = [];
  for (let i = 0; i < bks.length; i++) {
    const b = bks[i];
    const s = toMin(b.startTime), e = s + b.periods * 50;
    const pad = i < bks.length - 1 && typeof bookingBreakMin === 'function' ? bookingBreakMin(b, brk) : 0;
    const bs = Math.max(dayS, s);
    const be = Math.min(dayE, e + pad);
    if (be > bs) blocked.push({ s: bs, e: be, kind: 'booking-buffered' });
  }
  for (const br of breakIntervals) {
    blocked.push({ ...br, kind: 'break' });
  }

  blocked.sort((a,b) => a.s - b.s);
  const merged = [];
  for (const it of blocked) {
    const last = merged[merged.length - 1];
    if (!last || it.s > last.e) merged.push({ s: it.s, e: it.e });
    else last.e = Math.max(last.e, it.e);
  }

  // Gaps = day hours minus merged blocked.
  const gaps = [];
  let cur = dayS;
  for (const it of merged) {
    if (it.s > cur) gaps.push({ s: cur, e: it.s });
    cur = Math.max(cur, it.e);
  }
  if (cur < dayE) gaps.push({ s: cur, e: dayE });

  const totalPeriods = bks.reduce((s,b) => s + Number(b.periods || 0), 0);
  const teachingMin = totalPeriods * 50;
  const earliest = bks.length ? bks[0].startTime : null;
  const latestMin = bks.length ? bks.reduce((m,b) => Math.max(m, toMin(b.startTime) + b.periods*50), 0) : null;

  const bookablePeriods = gaps.reduce((sum,g) => sum + Math.floor((g.e - g.s) / 50), 0);

  let deadGapTotal = 0;
  let deadGapMax = 0;
  const deadGaps = [];
  for (let i = 0; i < bks.length - 1; i++) {
    const curB = bks[i], nextB = bks[i + 1];
    const curEnd = toMin(curB.startTime) + curB.periods * 50;
    const nextStart = toMin(nextB.startTime);
    const requiredRest = typeof bookingBreakMin === 'function' ? bookingBreakMin(curB, brk) : brk;
    const freeS = curEnd + requiredRest;
    const freeE = nextStart;
    if (freeE <= freeS) continue;
    for (const seg of subtractBreaks(freeS, freeE)) {
      const len = seg.e - seg.s;
      if (len <= 0) continue;
      deadGaps.push(seg);
      deadGapTotal += len;
      deadGapMax = Math.max(deadGapMax, len);
    }
  }

  return {
    hasBookings: bks.length > 0,
    earliestStart: earliest,
    latestEnd: latestMin != null ? toT(latestMin) : null,
    totalPeriods,
    teachingMinutes: teachingMin,
    bookablePeriods,
    gapTotal: deadGapTotal,
    gapMax: deadGapMax,
    gaps: deadGaps
  };
}

/* ========== Tiny transient toast (for auto-rearrange notifications) ========== */
function showToast(msg, ms=2200) {
  let host = document.getElementById('toastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toastHost';
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, ms);
}
