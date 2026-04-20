/* ========== Init ========== */
load();
renderCal();

const n = new Date(), pad = x => String(x).padStart(2,'0');
const todayStr = `${n.getFullYear()}-${pad(n.getMonth()+1)}-${pad(n.getDate())}`;
document.getElementById('iDate').value     = todayStr;
document.getElementById('iWinStart').value = G.defaultCfg.start;
document.getElementById('iWinEnd').value   = G.defaultCfg.end;

// Auto-select today so the user immediately sees today's schedule + config
selDay(todayStr);
renderUndoButton();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}


(function initDetailResizer(){
  const right = document.querySelector('.right');
  const calWrap = document.querySelector('.cal-wrap');
  const detail = document.getElementById('dayDetail');
  const resizer = document.getElementById('detailResizer');
  if (!right || !calWrap || !detail || !resizer) return;

  let dragging = false;
  function syncHandle() {
    const open = detail.classList.contains('open');
    resizer.classList.toggle('show', open);
  }

  window.syncDetailResizer = syncHandle;
  syncHandle();

  resizer.addEventListener('mousedown', e => {
    if (!detail.classList.contains('open')) return;
    dragging = true;
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const rightRect = right.getBoundingClientRect();
    const resizerRect = resizer.getBoundingClientRect();
    const newHeight = rightRect.bottom - e.clientY;
    const maxHeight = Math.max(180, rightRect.height - 180 - resizerRect.height);
    const clamped = Math.max(120, Math.min(maxHeight, newHeight));
    detail.style.height = clamped + 'px';
    calWrap.style.flexBasis = 'auto';
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
  });
})();
