import { DEFAULTS, analyseEntry, summarise } from './calc.js';

const KEY = 'ev-efficiency-v1';
const $ = id => document.getElementById(id);
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
let state = { settings: { ...DEFAULTS }, drives: [], ...load() };
state.settings = { ...DEFAULTS, ...state.settings };
const save = () => localStorage.setItem(KEY, JSON.stringify(state));

const fmt = (v, d = 2) => Number(v).toFixed(d);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderSummary() {
  const s = summarise(state.drives, state.settings);
  const el = $('summary');
  if (!s) { el.innerHTML = '<h2>Your efficiency</h2><p class="muted">Add a drive to see your efficiency and cost per mile.</p>'; return; }
  const pct = Math.abs(s.vsRated * 100).toFixed(0);
  el.innerHTML = `
    <div class="muted">Average efficiency over ${s.drives} drive${s.drives > 1 ? 's' : ''}, ${fmt(s.miles, 0)} miles</div>
    <div class="big">${fmt(s.milesPerKwh)} <span class="muted" style="font-size:16px">miles/kWh</span></div>
    <div class="${s.vsRated >= 0 ? 'good' : 'bad'}">${pct}% ${s.vsRated >= 0 ? 'better' : 'worse'} than rated</div>
    <div class="stats">
      <div class="stat"><b>${fmt(s.whPerMile, 0)} Wh</b><span>per mile</span></div>
      <div class="stat"><b>${fmt(s.pencePerMile, 1)}p</b><span>per mile</span></div>
      <div class="stat"><b>£${fmt(s.per100)}</b><span>per 100 miles</span></div>
      <div class="stat"><b>${fmt(s.equivalentMpg, 0)} mpg</b><span>petrol equivalent cost</span></div>
      <div class="stat"><b>£${fmt(s.cost)}</b><span>total spent</span></div>
      <div class="stat"><b class="${s.saving >= 0 ? 'good' : 'bad'}">£${fmt(Math.abs(s.saving))} ${s.saving >= 0 ? 'saved' : 'extra'}</b><span>vs petrol (${fmt(s.petrolPencePerMile, 1)}p/mile)</span></div>
    </div>`;
}

function renderDrives() {
  const el = $('drives');
  if (!state.drives.length) { el.innerHTML = '<p class="muted">No drives yet.</p>'; return; }
  el.innerHTML = state.drives.map((d, i) => {
    const a = analyseEntry(d, state.settings);
    return `<div class="drive"><div><b>${fmt(d.miles, 1)} mi</b> ${a ? `· ${fmt(a.milesPerKwh)} mi/kWh · ${fmt(a.pencePerMile, 1)}p/mi` : '· incomplete'}
      <small>${esc(d.date)}${d.note ? ' · ' + esc(d.note) : ''}</small></div><button data-del="${i}" aria-label="Delete drive">Delete</button></div>`;
  }).reverse().join('');
}

const render = () => { renderSummary(); renderDrives(); };

// settings
document.querySelectorAll('[data-s]').forEach(inp => {
  inp.value = state.settings[inp.dataset.s];
  inp.addEventListener('input', () => { state.settings[inp.dataset.s] = inp.value === '' ? DEFAULTS[inp.dataset.s] : Number(inp.value); save(); render(); });
});

$('add').addEventListener('click', () => {
  const d = { miles: Number($('miles').value), kwh: Number($('kwh').value), startPct: Number($('startPct').value), endPct: Number($('endPct').value),
    note: $('note').value.trim(), date: new Date().toISOString().slice(0, 10) };
  if ($('dprice').value !== '') d.price = Number($('dprice').value);
  const err = $('err');
  if (!analyseEntry(d, state.settings)) {
    err.textContent = 'Need miles driven plus either kWh used, or a start % higher than the end %.';
    err.hidden = false; return;
  }
  err.hidden = true;
  state.drives.push(d); save();
  ['miles', 'kwh', 'startPct', 'endPct', 'note', 'dprice'].forEach(id => ($(id).value = ''));
  render();
});

$('drives').addEventListener('click', e => {
  const i = e.target.dataset.del;
  if (i !== undefined) { state.drives.splice(Number(i), 1); save(); render(); }
});
$('clear').addEventListener('click', () => { if (confirm('Delete all drives?')) { state.drives = []; save(); render(); } });
$('export').addEventListener('click', async () => {
  const rows = ['date,miles,kwh,start_pct,end_pct,price_p,note', ...state.drives.map(d => [d.date, d.miles, d.kwh || '', d.startPct || '', d.endPct || '', d.price ?? '', JSON.stringify(d.note || '')].join(','))];
  try { await navigator.clipboard.writeText(rows.join('\n')); alert('CSV copied'); } catch { prompt('Copy this CSV:', rows.join('\n')); }
});

render();
