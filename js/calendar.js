/* ========== Booking list (per-day only) ========== */
function renderBookingList() {
  const el = document.getElementById('bookingList');
  const lbl = document.getElementById('blLabel');

  if (!G.selDate) {
    lbl.textContent = '预约记录';
    el.innerHTML = '<div class="empty-note">请先在日历上选择日期</div>';
    return;
  }

  const date = new Date(G.selDate+'T00:00:00');
  lbl.textContent = `${date.getMonth()+1}月${date.getDate()}日 预约记录`;

  const items = bookingsOn(G.selDate);
  if (!items.length) {
    el.innerHTML = '<div class="empty-note">当日暂无预约</div>';
    return;
  }
  let html = '';
  for (const b of items) {
    const dur = b.periods*50;
    const isEditing = G.editingId === b.id;
    const isConfirmed = b.status === 'confirmed';
    const lockedHtml = b.lockedStart ? '<span class="status-pill status-locked">锁定</span>' : '';
    const breakHtml = b.breakMin != null && Number(b.breakMin) !== Number(getDayCfg(b.date).brk)
      ? `<span class="status-pill status-locked">课间${Number(b.breakMin)}分钟</span>` : '';
    html += `
      <div class="bl-item${isEditing?' editing':''}">
        <div class="bl-bar" style="background:${nameColor(b.name)}"></div>
        <div class="bl-info">
          <div class="bl-name">${esc(b.name)} <span class="status-pill ${isConfirmed?'status-confirmed':'status-pending'}">${isConfirmed?'已确认':'待定'}</span>${lockedHtml}${breakHtml}</div>
          <div class="bl-time">${b.startTime}–${toT(toMin(b.startTime)+dur)} · ${b.periods}课时 · ${dur}分钟</div>
        </div>
        <div class="bl-actions">
          <button class="bl-toggle ${isConfirmed?'is-confirmed':''}" onclick="toggleBookingStatus('${b.id}')">${isConfirmed?'改为待定':'确认'}</button>
          <button class="bl-edit" onclick="startEdit('${b.id}')">编辑</button>
          <button class="rm-btn" onclick="removeBooking('${b.id}')">×</button>
        </div>
      </div>`;
  }
  el.innerHTML = html;
}

function removeBooking(id) {
  const bk = G.bookings.find(b=>b.id===id);
  if (!bk) return;
  const date = bk.date;
  if (G.editingId === id) cancelEdit();
  pushUndoSnapshot();
  G.suppressNextUndo = true;
  G.bookings = G.bookings.filter(b=>b.id!==id);
  save();

  // Auto-rearrange remaining pending bookings on that date.
  const result = autoRearrangeDay(date, null);
  if (result.outcome === 'choose') {
    // Remaining bookings still have conflicts — offer plans. Note: removal already happened.
    showPlanChooser(result.plans, null,
      '删除预约后重新排课',
      '移除后当前约束仍存在取舍，请选择方案：');
  }

  if (result.outcome !== 'choose') G.suppressNextUndo = false;

  renderBookingList(); renderCal();
  if (G.selDate) renderDetail(G.selDate);
}


function toggleBookingStatus(id) {
  const b = G.bookings.find(b=>b.id===id);
  if (!b) return;
  pushUndoSnapshot();
  b.status = b.status === 'confirmed' ? 'pending' : 'confirmed';
  save();
  renderBookingList();
  renderCal();
  if (G.selDate) renderDetail(G.selDate);
}

/* ========== Calendar ========== */
function renderCal() {
  const { year:y, month:m } = G;
  document.getElementById('calTitle').textContent = `${y}年${m+1}月`;
  const fw = new Date(y,m,1).getDay(), days = new Date(y,m+1,0).getDate();
  const now = new Date();
  const todayS = dStr(now.getFullYear(), now.getMonth(), now.getDate());
  const cells = Math.ceil((fw+days)/7)*7;
  let html = '', day = 1;
  for (let i=0; i<cells; i++) {
    if (i<fw || day>days) { html += '<div class="dc empty"></div>'; }
    else {
      const ds = dStr(y, m, day);
      const dow = new Date(ds+'T00:00:00').getDay();
      const wk = dow===0||dow===6;
      const hasCfg = !!G.dayCfg[ds];
      const info = analyzeDayGaps(ds);

      let summaryHtml = '';
      if (info.hasBookings) {
        summaryHtml = `
          <div class="day-sum">
            <div class="ds-row ds-time"><span class="ds-k">上班</span><span class="ds-v">${info.earliestStart}</span></div>
            <div class="ds-row ds-time"><span class="ds-k">下班</span><span class="ds-v">${info.latestEnd}</span></div>
            <div class="ds-row"><span class="ds-k">总计</span><span class="ds-v">${info.totalPeriods}课时</span></div>
            <div class="ds-row ds-gap"><span class="ds-k">还可</span><span class="ds-v">${info.bookablePeriods}课时</span></div>
          </div>`;
      }
      html += `<div class="dc${ds===todayS?' today':''}${ds===G.selDate?' sel':''}${wk?' wknd-day':''}"
                  onclick="selDay('${ds}')">
        <div class="dn">${day}${hasCfg?'<span style="width:4px;height:4px;background:var(--primary);border-radius:50%;display:inline-block;margin-left:3px;vertical-align:middle"></span>':''}</div>
        ${summaryHtml}
      </div>`;
      day++;
    }
  }
  document.getElementById('calDays').innerHTML = html;
}

function selDay(ds) {
  G.selDate = ds;
  renderCal();
  loadCfgPanel(ds);

  if (!G.editingId) {
    document.getElementById('iDate').value = ds;
    const cfg = getDayCfg(ds);
    document.getElementById('iWinStart').value = cfg.start;
    document.getElementById('iWinEnd').value   = cfg.end;
  }

  renderBookingList();
  renderDetail(ds);
}

function renderDetail(ds) {
  const date = new Date(ds+'T00:00:00');
  const bks = bookingsOn(ds);
  const cfg = getDayCfg(ds);
  const brk = Number(cfg.brk);
  const info = analyzeDayGaps(ds);

  document.getElementById('dtTitle').textContent =
    `${date.getFullYear()}年${date.getMonth()+1}月${date.getDate()}日 周${WKD[date.getDay()]}`;
  document.getElementById('dtTag').textContent = bks.length ? `${bks.length}个预约` : '';

  // Day summary block (prominent)
  let summaryBlock = '';
  if (info.hasBookings) {
    summaryBlock = `
      <div class="day-summary-block">
        <div class="dsb-title">本日概览</div>
        <div class="dsb-grid">
          <div class="dsb-cell"><div class="dsb-k">上班时间</div><div class="dsb-v">${info.earliestStart}</div></div>
          <div class="dsb-cell"><div class="dsb-k">下班时间</div><div class="dsb-v">${info.latestEnd}</div></div>
          <div class="dsb-cell"><div class="dsb-k">总授课</div><div class="dsb-v">${info.totalPeriods}课时</div></div>
          <div class="dsb-cell"><div class="dsb-k">还可预约</div><div class="dsb-v">${info.bookablePeriods}课时</div></div>
          <div class="dsb-cell"><div class="dsb-k">空档总计</div><div class="dsb-v">${info.gapTotal}分钟</div></div>
          <div class="dsb-cell"><div class="dsb-k">最长空档</div><div class="dsb-v">${info.gapMax}分钟</div></div>
        </div>
      </div>`;
  } else {
    summaryBlock = `
      <div class="day-summary-block day-summary-empty">
        <div class="dsb-title">本日概览</div>
        <div class="dsb-empty">当日暂无预约</div>
      </div>`;
  }

  // Build a combined timeline: bookings + explicit breaks (within the day window), sorted
  const dayS = toMin(cfg.start), dayE = toMin(cfg.end);
  const timeline = [];
  for (const b of bks) {
    timeline.push({ kind:'booking', s:toMin(b.startTime), e:toMin(b.startTime)+b.periods*50, booking:b });
  }
  for (const br of cfg.breaks) {
    if (!br.s||!br.e) continue;
    const s = toMin(br.s), e = toMin(br.e);
    if (e<=s) continue;
    const cs = Math.max(s, dayS), ce = Math.min(e, dayE);
    if (ce<=cs) continue;
    timeline.push({ kind:'break', s:cs, e:ce, label: br.label || '休息' });
  }
  timeline.sort((a,b)=>a.s-b.s);

  let html = summaryBlock;
  if (!timeline.length) {
    html += '';
  } else {
    html += '<div class="p-rows-header">当天时间线</div>';
    for (let i=0; i<timeline.length; i++) {
      const it = timeline[i];
      if (it.kind==='booking') {
        const b = it.booking, col = nameColor(b.name);
        const isConfirmed = b.status === 'confirmed';
        const lockedHtml = b.lockedStart ? '<span class="status-pill status-locked">锁定</span>' : '';
        const breakHtml = b.breakMin != null && Number(b.breakMin) !== brk
          ? `<span class="status-pill status-locked">课间${Number(b.breakMin)}分钟</span>` : '';
        html += `
          <div class="p-row" style="border-color:${col}" onclick="startEdit('${b.id}')">
            <div class="p-dot" style="background:${col}"></div>
            <div class="p-name">${esc(b.name)} <span class="status-pill ${isConfirmed?'status-confirmed':'status-pending'}">${isConfirmed?'已确认':'待定'}</span>${lockedHtml}${breakHtml}</div>
            <div class="p-right">${toT(it.s)}–${toT(it.e)}（${b.periods}课时）</div>
          </div>`;
      } else {
        html += `
          <div class="p-row break-row" style="border-color:#CBD5E0">
            <div class="p-dot" style="background:#CBD5E0"></div>
            <div class="p-name">${esc(it.label)}</div>
            <div class="p-right">${toT(it.s)}–${toT(it.e)}</div>
          </div>`;
      }
      if (i < timeline.length-1) {
        const next = timeline[i+1];
        const gap = next.s - it.e;
        if (it.kind==='booking' && next.kind==='booking') {
          let cls='gap-ok', label='';
          const requiredGap = bookingBreakMin(it.booking, brk);
          if (gap<0)          { cls='gap-bad';  label='时间重叠'; }
          else if (gap<requiredGap)   { cls='gap-warn'; label=`间隔${gap}分钟，不足课间${requiredGap}分钟`; }
          else if (gap===requiredGap) { cls='gap-ok';   label=`课间休息 ${gap} 分钟`; }
          else                { cls='gap-ok';   label=`间隔 ${gap} 分钟`; }
          html += `<div class="gap-row ${cls}"><div class="gap-line"></div>${label}<div class="gap-line"></div></div>`;
        } else if (gap>=0) {
          html += `<div class="gap-row gap-ok"><div class="gap-line"></div>间隔 ${gap} 分钟<div class="gap-line"></div></div>`;
        }
      }
    }
  }
  document.getElementById('pRows').innerHTML = html;
  document.getElementById('dayDetail').classList.add('open');
  if (window.syncDetailResizer) window.syncDetailResizer();
}

function closeDetail() {
  G.selDate = null;
  document.getElementById('dayDetail').classList.remove('open');
  if (window.syncDetailResizer) window.syncDetailResizer();
  loadCfgPanel(null);
  renderBookingList();
  renderCal();
}

function navM(d) {
  G.month += d;
  if (G.month<0)  { G.month=11; G.year--; }
  if (G.month>11) { G.month=0;  G.year++; }
  renderCal();
}
function navToday() {
  const n = new Date(); G.year = n.getFullYear(); G.month = n.getMonth(); renderCal();
}
