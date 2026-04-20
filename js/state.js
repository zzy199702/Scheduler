const PAL = ['#5B8AF5','#9B72F5','#48BB78','#F56565','#ED8936',
             '#ECC94B','#38B2AC','#F687B3','#0BC5EA','#68D391','#FC8181','#76E4F7'];
const WKD  = ['日','一','二','三','四','五','六'];
const DNUMS = ['一','二','三','四','五','六','七','八','九','十'];
const DFLT  = { start:'08:00', end:'22:00', brk:10, breaks:[] };
const STORE_KEY = 'paike_v6';

let G = {
  defaultCfg: { ...DFLT, breaks:[] },  // global default
  dayCfg:     {},                       // per-day overrides: { 'YYYY-MM-DD': {start,end,brk,breaks:[{s,e,label}]} }
  bookings:   [],
  year:  new Date().getFullYear(),
  month: new Date().getMonth(),
  selDate:    null,
  editingId:  null,
  plansForModal: null,   // array of plans being shown in the chooser modal
  planTarget: null,      // the target booking associated with plansForModal (or null for pure rearrange)
  confirmCb:  null,
  scheduleStrategy: 'student',
  undoSnapshot: null,
  suppressNextUndo: false,
  breakMinConfirmed: false,
  // settings modal local state (not saved until user clicks save)
  settingsDraft: null
};
