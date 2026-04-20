/* ========== Settings modal ========== */
function openSettings() {
  G.settingsDraft = {
    start: G.defaultCfg.start,
    end:   G.defaultCfg.end,
    brk:   G.defaultCfg.brk,
    breaks: G.defaultCfg.breaks.map(b => ({...b}))
  };
  document.getElementById('setStart').value = G.settingsDraft.start;
  document.getElementById('setEnd').value   = G.settingsDraft.end;
  document.getElementById('setBrk').value   = G.settingsDraft.brk;
  renderSettingsBreaks();
  renderSettingsHint();
  document.getElementById('settingsModal').classList.add('show');
}
function closeSettings() {
  document.getElementById('settingsModal').classList.remove('show');
  G.settingsDraft = null;
}

function backupFileName() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `paike-backup-${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}.json`;
}

function exportBackup() {
  const data = JSON.stringify(currentDataSnapshot(), null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = backupFileName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('已导出备份');
}

function importBackupFile(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result || '{}'));
      if (!Array.isArray(data.bookings)) throw new Error('备份文件格式不正确');
      askConfirm(
        '导入备份',
        `将导入 ${data.bookings.length} 个预约，并覆盖当前设备上的所有数据。<br><br>导入前建议先导出一份当前备份。`,
        () => {
          pushUndoSnapshot();
          importDataObject(data);
          closeSettings();
          loadCfgPanel(G.selDate);
          renderCal();
          if (G.selDate) {
            renderBookingList();
            renderDetail(G.selDate);
          }
          showToast('导入完成');
        },
        '确认导入'
      );
    } catch (e) {
      alert(e.message || '备份文件无法读取');
    }
  };
  reader.onerror = () => alert('备份文件无法读取');
  reader.readAsText(file);
}

function renderSettingsBreaks() {
  const d = G.settingsDraft; if (!d) return;
  const host = document.getElementById('setBreaks');
  if (!d.breaks.length) {
    host.innerHTML = '<div class="break-empty">暂无，点击上方「+ 添加」新增</div>';
    return;
  }
  host.innerHTML = d.breaks.map((b,i) => `
    <div class="break-item">
      <input type="time" value="${b.s}" oninput="updGlobalBreak(${i},'s',this.value)">
      <input type="time" value="${b.e}" oninput="updGlobalBreak(${i},'e',this.value)">
      <input type="text" value="${esc(b.label)}" placeholder="标签" style="grid-column:1 / span 2" oninput="updGlobalBreak(${i},'label',this.value)">
      <button class="brk-x" onclick="delGlobalBreak(${i})" title="删除">×</button>
    </div>`).join('');
}
function addGlobalBreak() {
  if (!G.settingsDraft) return;
  G.settingsDraft.breaks.push({ s:'12:00', e:'13:00', label:'午餐' });
  renderSettingsBreaks(); renderSettingsHint();
}
function updGlobalBreak(i,k,v) {
  if (!G.settingsDraft || !G.settingsDraft.breaks[i]) return;
  G.settingsDraft.breaks[i][k] = v;
  renderSettingsHint();
}
function delGlobalBreak(i) {
  if (!G.settingsDraft) return;
  G.settingsDraft.breaks.splice(i,1);
  renderSettingsBreaks(); renderSettingsHint();
}
function renderSettingsHint() {
  const d = G.settingsDraft; if (!d) return;
  const start = document.getElementById('setStart').value;
  const end   = document.getElementById('setEnd').value;
  const brk   = Math.max(0, parseInt(document.getElementById('setBrk').value) || 0);
  d.start = start; d.end = end; d.brk = brk;
  const hint = document.getElementById('setHint');
  if (!start || !end || toMin(end) <= toMin(start)) {
    hint.textContent = '请选择有效的开始和结束时间';
    return;
  }
  const avail = toMin(end) - toMin(start);
  const breakMin = d.breaks.reduce((sum,b) => {
    if (!b.s||!b.e) return sum;
    const s=Math.max(toMin(b.s),toMin(start)), e=Math.min(toMin(b.e),toMin(end));
    return sum + Math.max(0, e-s);
  }, 0);
  const net = avail - breakMin;
  const maxS = brk === 0 ? Math.floor(net/50) : Math.floor((net+brk)/(50+brk));
  hint.innerHTML =
    `${start} – ${end}，共 <strong>${avail}</strong> 分钟` +
    (breakMin ? `（扣除休息 ${breakMin} 分钟）` : '') + `<br>` +
    `课间 ${brk} 分钟时，每天最多 <strong>${Math.max(0,maxS)}</strong> 课时`;
}
function saveGlobalSettings() {
  const d = G.settingsDraft; if (!d) return closeSettings();
  if (!d.start || !d.end || toMin(d.end) <= toMin(d.start)) {
    alert('结束时间必须晚于开始时间');
    return;
  }
  for (const b of d.breaks) {
    if (!b.s || !b.e || toMin(b.e) <= toMin(b.s)) {
      alert('休息/用餐时间段无效，请检查');
      return;
    }
  }
  pushUndoSnapshot();
  G.defaultCfg = {
    start: d.start, end: d.end, brk: d.brk,
    breaks: d.breaks.map(b => ({...b}))
  };

  if (!G.editingId && !G.selDate) {
    document.getElementById('iWinStart').value = d.start;
    document.getElementById('iWinEnd').value   = d.end;
  }

  save();
  loadCfgPanel(G.selDate);
  renderCal();
  if (G.selDate) renderDetail(G.selDate);
  closeSettings();
}

/* ========== Per-day config ==========
   NOTE: Changing day hours / custom breaks / gap-minutes does NOT auto-rearrange
   pending bookings. The user must press the "重新排课" button in this panel.
*/
function saveCfg() {
  const start = document.getElementById('cfgStart').value;
  const end   = document.getElementById('cfgEnd').value;
  const brk   = Math.max(0, parseInt(document.getElementById('cfgBrk').value) || 0);
  if (!G.selDate || !start || !end) return;
  document.getElementById('cfgBrk').value = brk;
  pushUndoSnapshot();
  const existing = G.dayCfg[G.selDate] || {};
  G.dayCfg[G.selDate] = normalizeCfg({
    start, end, brk,
    breaks: existing.breaks || G.defaultCfg.breaks.map(b=>({...b}))
  });
  save();
  renderCfgHint();
  renderCfgBreaks();
  renderCal();
  if (G.selDate) renderDetail(G.selDate);
}
function renderCfgBreaks() {
  if (!G.selDate) return;
  const cfg = getDayCfg(G.selDate);
  const host = document.getElementById('cfgBreaks');
  if (!cfg.breaks.length) {
    host.innerHTML = '<div class="break-empty">暂无，点击上方「+ 添加」新增</div>';
    return;
  }
  host.innerHTML = cfg.breaks.map((b,i) => `
    <div class="break-item">
      <input type="time" value="${b.s}" oninput="updDayBreak(${i},'s',this.value)">
      <input type="time" value="${b.e}" oninput="updDayBreak(${i},'e',this.value)">
      <input type="text" value="${esc(b.label)}" placeholder="标签" style="grid-column:1 / span 2" oninput="updDayBreak(${i},'label',this.value)">
      <button class="brk-x" onclick="delDayBreak(${i})" title="删除">×</button>
    </div>`).join('');
}
function addDayBreak() {
  if (!G.selDate) return;
  pushUndoSnapshot();
  const existing = G.dayCfg[G.selDate] ? G.dayCfg[G.selDate] : {
    ...G.defaultCfg,
    breaks: G.defaultCfg.breaks.map(b=>({...b}))
  };
  const cfg = normalizeCfg(existing);
  cfg.breaks.push({ s:'12:00', e:'13:00', label:'午餐' });
  G.dayCfg[G.selDate] = cfg;
  save();
  renderCfgBreaks(); renderCfgHint();
  renderCal(); renderDetail(G.selDate);
}
function updDayBreak(i,k,v) {
  if (!G.selDate) return;
  pushUndoSnapshot();
  const existing = G.dayCfg[G.selDate] ? G.dayCfg[G.selDate] : {
    ...G.defaultCfg,
    breaks: G.defaultCfg.breaks.map(b=>({...b}))
  };
  const cfg = normalizeCfg(existing);
  if (!cfg.breaks[i]) return;
  cfg.breaks[i][k] = v;
  G.dayCfg[G.selDate] = cfg;
  save();
  renderCfgHint();
  renderCal();
  renderDetail(G.selDate);
}
function delDayBreak(i) {
  if (!G.selDate) return;
  pushUndoSnapshot();
  const cfg = getDayCfg(G.selDate);
  cfg.breaks.splice(i,1);
  G.dayCfg[G.selDate] = cfg;
  save();
  renderCfgBreaks(); renderCfgHint();
  renderCal(); renderDetail(G.selDate);
}
function renderCfgHint() {
  const cfg = G.selDate ? getDayCfg(G.selDate) : G.defaultCfg;
  if (toMin(cfg.end) <= toMin(cfg.start)) { document.getElementById('cfgHint').textContent = ''; return; }
  const avail = toMin(cfg.end) - toMin(cfg.start);
  const breakMin = cfg.breaks.reduce((sum,b)=>{
    if (!b.s||!b.e) return sum;
    const s=Math.max(toMin(b.s),toMin(cfg.start)), e=Math.min(toMin(b.e),toMin(cfg.end));
    return sum + Math.max(0,e-s);
  },0);
  const net = avail - breakMin;
  const brk = Number(cfg.brk);
  const maxS = brk === 0 ? Math.floor(net/50) : Math.floor((net+brk)/(50+brk));
  document.getElementById('cfgHint').innerHTML =
    `${cfg.start} – ${cfg.end}，共 <strong>${avail}</strong> 分钟` +
    (breakMin ? `（扣除休息 ${breakMin} 分钟）` : '') + `<br>` +
    `课间 ${brk} 分钟时，每天最多 <strong>${Math.max(0,maxS)}</strong> 课时`;
}
function loadCfgPanel(date) {
  const label = document.getElementById('cfgLabel');
  const panel = label.nextElementSibling;
  const divider = panel.nextElementSibling;
  const showDayCfg = !!date;
  label.style.display = showDayCfg ? 'flex' : 'none';
  panel.style.display = showDayCfg ? 'block' : 'none';
  divider.style.display = showDayCfg ? 'block' : 'none';
  if (!showDayCfg) return;

  const cfg = getDayCfg(date);
  document.getElementById('cfgStart').value = cfg.start;
  document.getElementById('cfgEnd').value   = cfg.end;
  document.getElementById('cfgBrk').value   = cfg.brk;
  const d = new Date(date+'T00:00:00');
  document.getElementById('cfgLabel').innerHTML =
    `<span>${d.getMonth()+1}月${d.getDate()}日设置</span>`;
  renderCfgBreaks();
  renderCfgHint();
}

/* ========== Manual rearrange button handler ========== */
function onRearrangeClick() {
  if (!G.selDate) {
    showToast('请先选择日期');
    return;
  }
  manualRearrangeDay(G.selDate);
}
