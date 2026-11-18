import { createTrip, speedIn, distanceIn, compass, clockAngles, bandScale, lerpColor, ease, twoLines } from './hud.js';
import { validateBase, liveEfficiency, arrivalPct, carStatus, ageSeconds, createTesla } from './tesla.js';
import { etaMs, geocode, fetchRoute, locate, upcoming, arrowFor, instructionText, fmtDist, mapPoints, segmentBearing } from './nav.js';

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const prefs = JSON.parse(localStorage.getItem('hud-prefs') || '{}');
let unit = prefs.unit || 'mph';
let mirror = !!prefs.mirror;
let voiceOn = prefs.voice !== false;
let showNums = prefs.numbers !== false;
let theme = prefs.theme === 'ember' ? 'ember' : 'aurora';
const LAYOUTS = ['cluster', 'hud'];
const LAYOUT_NAMES = { cluster: 'Cluster', hud: 'Windshield' };
let layout = LAYOUTS.includes(prefs.layout) ? prefs.layout : 'cluster';
const THEMES = { aurora: ['#2ee6ff', '#5b8cff', '#a35bff', '#ff4fd8'], ember: ['#ffd24a', '#ff8a2a', '#ff4a2a', '#ff2d55'] };
const trip = createTrip();
const BATTERY_KWH = 75; // usable kWh, used only to turn a battery drop into an efficiency
let tesla = null, tState = null, tError = '', tStartPct = null, tTimer = null;
const tPrefs = JSON.parse(localStorage.getItem('hud-tesla') || '{}');
let watchId = null, wakeLock = null, heading = null, speedMs = null, lastFixAt = 0, built = false;

const rad = d => (d * Math.PI) / 180;
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
};
const txt = (parent, x, y, size, anchor, content = '', cls = '', weight = 300, fill) => {
  const t = el('text', { x, y, 'font-size': size, 'text-anchor': anchor, 'font-weight': weight, class: cls }, parent);
  t.textContent = content; if (fill) t.style.fill = fill; return t;
};
const rot = (g, deg) => { g.style.transform = `rotate(${deg}deg)`; };
const colors = () => THEMES[theme];
const accent = t => lerpColor(colors(), t);

// ---------- geometry ----------
const DX = 760, DY = 425, R = 292, SEG = 90, A0 = -135, SWEEP = 270;
const dialAngle = f => A0 + Math.min(Math.max(Number(f) || 0, 0), 1) * SWEEP;
const pt = (cx, cy, a, rx, ry) => [cx + rx * Math.sin(rad(a)), cy - ry * Math.cos(rad(a))];
const polar = (deg, r) => [r * Math.sin(rad(deg)), -r * Math.cos(rad(deg))];
const arcD = (cx, cy, a0, a1, r) => {
  const [x0, y0] = pt(cx, cy, a0, r, r), [x1, y1] = pt(cx, cy, a1, r, r);
  return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
};

let G = {}; // handles to the live parts
const disp = { speed: 0, bat: 0, rng: 0 }; // eased values actually drawn

function buildDial(parent) {
  const h = { lit: [], glow: [] };
  const { max, label, minor } = bandScale(unit);
  // outer hairline
  el('circle', { cx: DX, cy: DY, r: R + 52, fill: 'none', stroke: 'rgba(255,255,255,.08)', 'stroke-width': 1.5 }, parent);
  const glowG = el('g', { filter: 'url(#blur)' }, parent);
  const g = el('g', {}, parent);
  for (let i = 0; i < SEG; i++) {
    const f = (i + 0.5) / SEG, a = dialAngle(f);
    const [x0, y0] = pt(DX, DY, a, R - 17, R - 17), [x1, y1] = pt(DX, DY, a, R + 17, R + 17);
    const c = accent(f);
    el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: '#fff', 'stroke-opacity': 0.08, 'stroke-width': 6, 'stroke-linecap': 'round' }, g);
    h.glow.push(el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: c, 'stroke-width': 14, 'stroke-linecap': 'round', opacity: 0 }, glowG));
    h.lit.push(el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: c, 'stroke-width': 6, 'stroke-linecap': 'round', opacity: 0 }, g));
  }
  for (let v = 0; v <= max + 1e-9; v += minor) {
    const a = dialAngle(v / max);
    if (v % label === 0) { const [lx, ly] = pt(DX, DY, a, R + 46, R + 46); txt(g, lx, ly + 8, 24, 'middle', v, 'num', 300, 'rgba(255,255,255,.62)'); }
    else { const [dx, dy] = pt(DX, DY, a, R + 40, R + 40); el('circle', { cx: dx, cy: dy, r: 1.8, fill: 'rgba(255,255,255,.35)' }, g); }
  }
  h.marker = el('path', { d: 'M -6 0 L 6 0 L 0 10 Z', fill: '#ffffff' }, g); h.marker.style.display = 'none';
  return h;
}
function setDial(h, value, max) {
  const lit = Math.min(Math.max(value / max, 0), 1) * SEG;
  for (let i = 0; i < SEG; i++) {
    const o = Math.min(Math.max(lit - i, 0), 1);
    h.lit[i].setAttribute('opacity', o); h.glow[i].setAttribute('opacity', o * 0.7);
  }
}
function setMarker(h, value, max) {
  if (!(value > 0)) { h.marker.style.display = 'none'; return; }
  const a = dialAngle(value / max), [x, y] = pt(DX, DY, a, R - 24, R - 24);
  h.marker.style.display = ''; h.marker.setAttribute('transform', `translate(${x} ${y}) rotate(${a})`);
}

function miniDial(svg, x, y, scale) {
  const g = el('g', { transform: `translate(${x} ${y}) scale(${scale})` }, svg);
  el('circle', { r: 92, fill: 'rgba(255,255,255,.04)', stroke: 'rgba(255,255,255,.25)', 'stroke-width': 2 }, g);
  return g;
}
function hand(parent, len, color, width) {
  const g = el('g', { class: 'needle' }, parent);
  el('line', { x1: 0, y1: 10, x2: 0, y2: -len, stroke: color, 'stroke-width': width, 'stroke-linecap': 'round' }, g);
  return g;
}
const glass = (parent, x, y, w, h, r = 30) => el('rect', { x, y, width: w, height: h, rx: r, fill: 'rgba(255,255,255,.035)', stroke: 'url(#cardline)', 'stroke-width': 1.4 }, parent);

function buildCluster() {
  const svg = $('cluster'); svg.innerHTML = ''; svg.setAttribute('viewBox', '0 0 1520 800');
  svg.classList.toggle('nonum', !showNums);
  const defs = el('defs', {}, svg);
  const bg = el('radialGradient', { id: 'bg', cx: '50%', cy: '50%', r: '78%' }, defs);
  el('stop', { offset: 0, 'stop-color': '#0d1420' }, bg); el('stop', { offset: 0.6, 'stop-color': '#05080d' }, bg); el('stop', { offset: 1, 'stop-color': '#010203' }, bg);
  el('filter', { id: 'blur', x: '-30%', y: '-30%', width: '160%', height: '160%' }, defs).appendChild(el('feGaussianBlur', { stdDeviation: 7 }));
  el('filter', { id: 'soft', x: '-50%', y: '-50%', width: '200%', height: '200%' }, defs).appendChild(el('feGaussianBlur', { stdDeviation: 46 }));
  const card = el('linearGradient', { id: 'cardline', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  el('stop', { offset: 0, 'stop-color': 'rgba(255,255,255,.28)' }, card); el('stop', { offset: 1, 'stop-color': 'rgba(255,255,255,.04)' }, card);
  const carg = el('linearGradient', { id: 'carfill', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  el('stop', { offset: 0, 'stop-color': colors()[0] }, carg); el('stop', { offset: 1, 'stop-color': colors()[3] }, carg);
  el('clipPath', { id: 'mapclip' }, defs).appendChild(el('circle', { cx: 1335, cy: 470, r: 92 }));
  el('rect', { width: 1520, height: 800, fill: 'url(#bg)' }, svg);

  G.ambient = el('ellipse', { cx: DX, cy: DY, rx: 430, ry: 330, fill: accent(0), opacity: 0.06, filter: 'url(#soft)' }, svg);

  // the big dial
  G.dial = buildDial(svg);
  G.speed = txt(svg, DX, DY + 72, 236, 'middle', '0', 'num', 200);
  G.unitL = txt(svg, DX, DY + 128, 26, 'middle', unit === 'mph' ? 'MPH' : 'KM/H', 'num', 500, accent(0.25)); G.unitL.style.letterSpacing = '10px';

  // top: clock and GPS state
  G.clockTxt = txt(svg, DX, 64, 40, 'middle', '--:--', 'num', 300);
  G.gps = el('circle', { cx: DX - 66, cy: 51, r: 6, fill: '#f0b429' }, svg);

  // left edge: battery, trip, top speed / efficiency
  glass(svg, 40, 150, 270, 160);
  const bl = txt(svg, 66, 188, 16, 'start', 'BATTERY', 'num', 500, 'rgba(255,255,255,.45)'); bl.style.letterSpacing = '5px';
  G.batPct = txt(svg, 66, 250, 62, 'start', '–', 'num', 300);
  G.batRange = txt(svg, 288, 250, 22, 'end', '', 'num', 300, 'rgba(255,255,255,.6)');
  el('rect', { x: 66, y: 272, width: 218, height: 10, rx: 5, fill: 'rgba(255,255,255,.1)' }, svg);
  G.batBar = el('rect', { x: 66, y: 272, width: 0, height: 10, rx: 5, fill: accent(0.3) }, svg);
  G.batLimit = el('rect', { x: 66, y: 266, width: 2, height: 22, rx: 1, fill: 'rgba(255,255,255,.7)' }, svg); G.batLimit.style.display = 'none';
  const tile = (y, label, key, h = 112, size = 44) => {
    glass(svg, 40, y, 270, h);
    const l = txt(svg, 66, y + 36, 16, 'start', label, 'num', 500, 'rgba(255,255,255,.45)'); l.style.letterSpacing = '5px';
    G[key] = txt(svg, 66, y + h - 24, size, 'start', '–', 'num', 300);
    return l;
  };
  tile(326, 'TRIP', 'trip'); G.t3label = tile(450, 'TOP SPEED', 'top');

  // top: car status chips
  G.lock = el('g', { transform: 'translate(46 38)' }, svg);
  el('rect', { x: 0, y: 11, width: 22, height: 16, rx: 4, fill: 'currentColor' }, G.lock);
  G.shackle = el('path', { d: 'M 5 11 V 7 a 6 6 0 0 1 12 0 V 11', fill: 'none', stroke: 'currentColor', 'stroke-width': 3 }, G.lock);
  G.lock.style.color = 'rgba(255,255,255,.3)';
  G.outTemp = txt(svg, 82, 64, 28, 'start', '', 'num', 300);
  G.carStat = txt(svg, 1470, 64, 24, 'end', '', '', 400, accent(0.15));

  // left bottom: compass
  const cg = miniDial(svg, 100, 700, 0.66);
  G.card = el('g', { class: 'needle' }, cg);
  for (let a = 0; a < 360; a += 30) { const maj = a % 90 === 0, [x0, y0] = polar(a, maj ? 68 : 78), [x1, y1] = polar(a, 86); el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: maj ? '#fff' : 'rgba(255,255,255,.35)', 'stroke-width': maj ? 3 : 1.5 }, G.card); }
  el('path', { d: 'M -9 -50 L 9 -50 L 0 -80 Z', fill: '#ff5a6a' }, G.card);
  el('path', { d: 'M -9 -100 L 9 -100 L 0 -86 Z', fill: accent(0.1) }, cg);
  G.dir = txt(svg, 210, 712, 40, 'middle', '–', 'num', 300);

  // right edge: navigation card
  glass(svg, 1190, 170, 290, 470);
  G.badge = el('g', { transform: 'translate(1244 232)' }, svg);
  G.dist = txt(svg, 1292, 246, 34, 'start', '', '', 400, accent(0.15));
  G.t1 = txt(svg, 1216, 312, 21, 'start', '', '', 500); G.t2 = txt(svg, 1216, 340, 19, 'start', '', '', 300, 'rgba(255,255,255,.65)');
  G.status = txt(svg, 1335, 262, 20, 'middle', '', '', 300, 'rgba(255,255,255,.55)');
  G.car = el('g', { transform: 'translate(1335 470) scale(.8)' }, svg);
  el('ellipse', { rx: 90, ry: 130, fill: accent(0.4), opacity: 0.35, filter: 'url(#soft)' }, G.car);
  el('path', { d: 'M0 -118 C44 -118 56 -76 56 -24 L56 62 C56 104 36 120 0 120 C-36 120 -56 104 -56 62 L-56 -24 C-56 -76 -44 -118 0 -118 Z', fill: 'url(#carfill)', opacity: 0.92 }, G.car);
  el('path', { d: 'M-40 -66 C-28 -78 28 -78 40 -66 L34 -34 L-34 -34 Z', fill: '#05080d', opacity: 0.85 }, G.car);
  el('rect', { x: -38, y: -10, width: 76, height: 56, rx: 14, fill: '#05080d', opacity: 0.55 }, G.car);
  G.map = el('g', {}, svg); G.map.style.display = 'none';
  el('circle', { cx: 1335, cy: 470, r: 94, fill: '#070b10', stroke: 'rgba(255,255,255,.18)', 'stroke-width': 1.5 }, G.map);
  const clipped = el('g', { 'clip-path': 'url(#mapclip)' }, G.map);
  const mg = el('g', { transform: 'translate(1335 515)' }, clipped);
  G.mapGlow = el('path', { d: '', fill: 'none', stroke: accent(0.1), 'stroke-width': 14, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.45, filter: 'url(#blur)' }, mg);
  G.mapPath = el('path', { d: '', fill: 'none', stroke: accent(0.1), 'stroke-width': 5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, mg);
  G.ring = el('path', { d: '', fill: 'none', stroke: accent(0.95), 'stroke-width': 5, 'stroke-linecap': 'round' }, G.map);
  el('path', { d: 'M 1335 488 L 1344 514 L 1335 508 L 1326 514 Z', fill: '#ffffff' }, G.map);
  G.rem = txt(svg, 1335, 600, 20, 'middle', '', '', 300, 'rgba(255,255,255,.55)');
  G.arrive = txt(svg, 1335, 630, 24, 'middle', '', '', 500, accent(0.1));

  // right bottom: analog clock
  const kg = miniDial(svg, 1420, 700, 0.66);
  for (let k = 0; k < 12; k++) { const [x0, y0] = polar(k * 30, k % 3 === 0 ? 68 : 78), [x1, y1] = polar(k * 30, 86); el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: k % 3 === 0 ? '#fff' : 'rgba(255,255,255,.35)', 'stroke-width': k % 3 === 0 ? 3 : 1.5 }, kg); }
  G.hour = hand(kg, 46, '#fff', 6); G.min = hand(kg, 70, 'rgba(255,255,255,.75)', 4);
  el('circle', { r: 5, fill: accent(0.1) }, kg);
  built = true;
}


// ---------- tesla ----------
function teslaClient() {
  const base = $('tbase').value.trim(), token = $('ttoken').value;
  if (!base || !token) return null;
  const bad = validateBase(base, location.protocol);
  if (bad) { $('tstatus').textContent = bad; return null; }
  localStorage.setItem('hud-tesla', JSON.stringify({ base, token }));
  return createTesla({ base, token });
}
$('tbase').value = tPrefs.base || ''; $('ttoken').value = tPrefs.token || '';
$('ttest').addEventListener('click', async () => {
  const c = teslaClient(); if (!c) { if (!$('tstatus').textContent) $('tstatus').textContent = 'Enter the address and token first.'; return; }
  $('tstatus').textContent = 'Connecting…';
  try { const st = await c.state(); $('tstatus').textContent = st.asleep ? 'Connected. The car is asleep, so values appear once it wakes.' : `Connected: ${st.name}, battery ${st.battery}%`; }
  catch (e) { $('tstatus').textContent = 'Failed: ' + e.message }
});
$('tlogin').addEventListener('click', async () => {
  const c = teslaClient(); if (!c) return;
  $('tstatus').textContent = 'Opening Tesla sign-in…';
  try { location.href = await c.startAuth(); } catch (e) { $('tstatus').textContent = 'Failed: ' + e.message; }
});
async function pollTesla() {
  if (!tesla) return;
  try {
    const st = await tesla.state();
    tState = st; tError = '';
    if (tStartPct == null && !st.stale && Number.isFinite(st.battery)) tStartPct = st.battery;
  } catch (e) { tError = e.message; }
  render();
}

// ---------- settings ----------
const savePrefs = () => localStorage.setItem('hud-prefs', JSON.stringify({ unit, mirror, voice: voiceOn, numbers: showNums, theme, layout }));
function syncOpts() {
  document.querySelectorAll('[data-unit]').forEach(b => b.classList.toggle('on', b.dataset.unit === unit));
  for (const [id, on, label] of [['mirror', mirror, 'Mirror'], ['voice', voiceOn, 'Voice'], ['numbers', showNums, 'Numbers']]) {
    $(id).textContent = `${label}: ${on ? 'on' : 'off'}`; $(id).classList.toggle('on', on);
  }
  $('theme').textContent = `Theme: ${theme === 'aurora' ? 'Aurora' : 'Ember'}`;
  $('layout').textContent = `Starts on: ${LAYOUT_NAMES[layout]}`;
  $('face').classList.toggle('mirror', mirror);
  if (built) $('cluster').classList.toggle('nonum', !showNums);
}
const rebuild = () => { if (built) { buildFace(); render(); } };
document.querySelectorAll('[data-unit]').forEach(b => b.addEventListener('click', () => { unit = b.dataset.unit; savePrefs(); syncOpts(); rebuild(); }));
$('layout').addEventListener('click', () => { layout = LAYOUTS[(LAYOUTS.indexOf(layout) + 1) % LAYOUTS.length]; savePrefs(); syncOpts(); });
$('theme').addEventListener('click', () => { theme = theme === 'aurora' ? 'ember' : 'aurora'; savePrefs(); syncOpts(); rebuild(); });
$('mirror').addEventListener('click', () => { mirror = !mirror; savePrefs(); syncOpts(); });
$('voice').addEventListener('click', () => { voiceOn = !voiceOn; savePrefs(); syncOpts(); });
$('numbers').addEventListener('click', () => { showNums = !showNums; savePrefs(); syncOpts(); });

// ---------- satnav ----------
let dest = null, route = null, hint = 0, offCount = 0, planning = false, lastPlan = 0, navState = null, announced = {}, navMsg = '';

$('search').addEventListener('click', async () => {
  const q = $('q').value.trim(); if (!q) return;
  $('results').textContent = 'Searching…';
  try {
    const found = await geocode(q);
    $('results').textContent = found.length ? '' : 'No results';
    found.forEach(r => {
      const b = document.createElement('button'); b.textContent = r.name;
      b.addEventListener('click', () => { dest = r; $('results').textContent = ''; $('chosen').textContent = 'Destination: ' + r.name; });
      $('results').appendChild(b);
    });
  } catch (e) { $('results').textContent = e.message; }
});

function say(text) {
  if (!voiceOn || !('speechSynthesis' in window)) return;
  try { window.speechSynthesis.cancel(); window.speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } catch { /* ignore */ }
}

function arrowSvg(a) {
  if (a.icon === 'arrive') return '<circle r="22" fill="none" stroke="#7dffb0" stroke-width="6"/><circle r="8" fill="#7dffb0"/>';
  const head = `<g transform="rotate(${a.rotation}) scale(.62)"><path d="M 0 -42 L 26 -8 L 10 -8 L 10 40 L -10 40 L -10 -8 L -26 -8 Z" fill="#ffffff"/></g>`;
  return a.icon === 'roundabout' ? `<circle r="34" fill="none" stroke="rgba(255,255,255,.3)" stroke-width="4"/>${head}` : head;
}

async function plan(fix, rerouting) {
  planning = true; navMsg = rerouting ? 'Rerouting…' : 'Planning route…';
  try {
    route = await fetchRoute(fix, dest); hint = 0; offCount = 0; announced = {}; navMsg = '';
    say(rerouting ? 'Route updated' : 'Route ready. ' + instructionText(route.steps[1] || route.steps[0]));
  } catch (e) { navMsg = 'Route failed: ' + e.message; }
  planning = false; lastPlan = Date.now();
}

function navUpdate(fix) {
  if (!dest) return;
  if (!route) { if (!planning && Date.now() - lastPlan > 10000) plan(fix, false); return; }
  const loc = locate(route, fix, hint);
  hint = loc.index;
  if (loc.offRoute > 60) { offCount++; if (offCount >= 3 && !planning && Date.now() - lastPlan > 15000) plan(fix, true); } else offCount = 0;
  const up = upcoming(route, loc.along);
  navState = { fix, loc, up };
  if (up.step.type === 'arrive' && up.distance < 25) { say('You have arrived'); navMsg = 'Arrived'; route = null; dest = null; navState = null; return; }
  const key = route.steps.indexOf(up.step);
  const a = announced[key] || (announced[key] = {});
  if (up.distance < 600 && !a.far && up.distance >= 150) { a.far = true; say(`In ${fmtDist(up.distance, unit)}, ${instructionText(up.step)}`); }
  if (up.distance < 120 && !a.near) { a.near = true; say(instructionText(up.step)); }
}

function renderNav() {
  const on = !!(route && navState);
  G.car.style.display = on ? 'none' : ''; G.map.style.display = on ? '' : 'none';
  G.badge.style.display = on ? '' : 'none';
  if (!on) { G.t1.textContent = ''; G.t2.textContent = ''; G.dist.textContent = ''; G.rem.textContent = ''; return; }
  const { fix, loc, up } = navState;
  const hd = heading != null ? heading : segmentBearing(route, loc.index);
  const pts = mapPoints(route, fix, hd, loc.index, 150 + Math.min(speedMs || 0, 30) * 10, 92);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  G.mapPath.setAttribute('d', d); G.mapGlow.setAttribute('d', d);
  const frac = 1 - Math.min(up.distance, 500) / 500;
  G.ring.setAttribute('d', frac > 0.01 ? arcD(1335, 470, -135, -135 + frac * 270, 104) : '');
  G.badge.innerHTML = `<circle r="34" fill="rgba(255,255,255,.08)"/>${arrowSvg(arrowFor(up.step))}`;
  const [l1, l2] = twoLines(instructionText(up.step), 24);
  G.t1.textContent = l1; G.t2.textContent = l2;
  G.dist.textContent = fmtDist(up.distance, unit);
  G.rem.textContent = `${fmtDist(up.remaining, unit)} to go`;
}


// ---------- windshield layout: bold, bright, on pure black, meant to be mirrored and reflected ----------
// Drawn to fit the real screen shape: the width follows the phone's aspect ratio, so nothing is left as side bars.
const HG = {};
const HC = { yellow: '#ffe94a', green: '#7dff4a', white: '#ffffff', amber: '#ffb020', red: '#ff4a3d', cyan: '#4ad8ff', off: 'rgba(255,255,255,.13)', label: 'rgba(255,255,255,.62)' };
let HW = 1520, HM = 44;
const stroke = { fill: 'none', stroke: 'currentColor', 'stroke-width': 4.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
const polarX = (deg, r) => (r * Math.sin(rad(deg))).toFixed(1), polarY = (deg, r) => (-r * Math.cos(rad(deg))).toFixed(1);

function hudIcon(parent, x, key, draw) {
  const g = el('g', { transform: `translate(${x.toFixed(1)} 764) scale(1.15)` }, parent);
  g.style.color = HC.off; draw(g); HG[key] = g;
}

function buildHud() {
  const svg = $('cluster'); svg.innerHTML = ''; svg.classList.remove('nonum');
  const box = svg.getBoundingClientRect();
  HW = box.width && box.height ? Math.round(Math.min(Math.max((800 * box.width) / box.height, 1100), 2300)) : 1520;
  svg.setAttribute('viewBox', `0 0 ${HW} 800`);
  const W = HW, M = HM, cx = W / 2, inner = W - 2 * M;
  const defs = el('defs', {}, svg);
  const bar = el('linearGradient', { id: 'hudbar', gradientUnits: 'userSpaceOnUse', x1: M, y1: 0, x2: W - M, y2: 0 }, defs);
  colors().forEach((c, i, a) => el('stop', { offset: i / (a.length - 1), 'stop-color': c }, bar));
  el('rect', { width: W, height: 800, fill: '#000' }, svg);

  // top row: clock, trip
  HG.clock = txt(svg, cx, 126, 116, 'middle', '--:--', '', 700, HC.yellow);
  txt(svg, W - M - 190, 112, 40, 'end', 'TRIP', '', 600, HC.label); HG.trip = txt(svg, W - M, 112, 58, 'end', '0.0', '', 700, HC.green);
  HG.instr = txt(svg, cx, 204, 46, 'middle', '', '', 600, HC.white);

  // left slot: next-turn arrow and distance ; right slot: arrival (or heading)
  const xl = M + 150, xr = W - M - 150;
  HG.arrow = el('g', { transform: `translate(${xl} 345) scale(2.1)` }, svg);
  HG.lVal = txt(svg, xl, 462, 68, 'middle', '', '', 700, HC.green);
  HG.lLab = txt(svg, xl, 498, 28, 'middle', '', '', 600, HC.label);
  HG.rVal = txt(svg, xr, 360, 96, 'middle', '', '', 700, HC.white);
  HG.rLab = txt(svg, xr, 406, 30, 'middle', '', '', 600, HC.label);
  HG.rSub = txt(svg, xr, 478, 56, 'middle', '', '', 700, HC.green);

  // the speed
  HG.speed = txt(svg, cx - 20, 622, 380, 'middle', '0', '', 700, HC.white);
  HG.unit = txt(svg, cx + 300, 622, 50, 'start', unit === 'mph' ? 'MPH' : 'KM/H', '', 600, HC.label);
  hudLen = 0;

  // battery and range dials flank the speed; status sits under it
  el('filter', { id: 'gblur', x: '-30%', y: '-30%', width: '160%', height: '160%' }, defs).appendChild(el('feGaussianBlur', { stdDeviation: 7 }));
  const DR = 94, dcy = 606, dxl = M + DR + 26, dxr = W - M - DR - 26;
  HG.batRing = buildRing(svg, dxl, dcy, DR); HG.rngRing = buildRing(svg, dxr, dcy, DR);
  HG.pct = txt(svg, dxl, dcy + 14, 50, 'middle', '–', '', 700, HC.green);
  txt(svg, dxl, dcy + 46, 19, 'middle', 'BATTERY', '', 600, HC.label).style.letterSpacing = '3px';
  HG.range = txt(svg, dxr, dcy + 14, 50, 'middle', '–', '', 700, HC.green);
  HG.rangeLab = txt(svg, dxr, dcy + 46, 19, 'middle', 'RANGE', '', 600, HC.label); HG.rangeLab.style.letterSpacing = '3px';
  HG.status = txt(svg, cx, 700, 44, 'middle', '', '', 700, HC.green);
  el('rect', { x: M, y: 714, width: inner, height: 12, rx: 6, fill: HC.off }, svg);
  HG.bar = el('rect', { x: M, y: 714, width: 0, height: 12, rx: 6, fill: 'url(#hudbar)' }, svg);
  HG.barW = inner;
  disp.bat = 0; disp.rng = 0;

  // indicators: dim until they matter, spread across the full width
  const n = 8, x0 = M + 40, step = (inner - 80) / (n - 1); let i = 0;
  const X = () => x0 + step * i++;
  hudIcon(svg, X(), 'iLock', g => { el('rect', { x: -15, y: -2, width: 30, height: 24, rx: 5, fill: 'currentColor' }, g); el('path', { d: 'M -9 -2 V -9 a 9 9 0 0 1 18 0 V -2', ...stroke }, g); });
  hudIcon(svg, X(), 'iDoor', g => { el('path', { d: 'M -18 20 V -8 Q -18 -20 -6 -20 H 18 V 20 Z', ...stroke }, g); el('rect', { x: 5, y: 0, width: 9, height: 5, rx: 2, fill: 'currentColor' }, g); });
  hudIcon(svg, X(), 'iSentry', g => { el('ellipse', { rx: 24, ry: 14, ...stroke }, g); el('circle', { r: 7, fill: 'currentColor' }, g); });
  hudIcon(svg, X(), 'iTyre', g => { el('circle', { r: 21, ...stroke }, g); el('path', { d: 'M 0 -11 V 3', ...stroke }, g); el('circle', { cy: 11, r: 3, fill: 'currentColor' }, g); });
  hudIcon(svg, X(), 'iPlug', g => el('polygon', { points: '4,-24 -14,4 -2,4 -6,24 14,-6 2,-6', fill: 'currentColor' }, g));
  hudIcon(svg, X(), 'iClimate', g => { for (const a of [0, 60, 120]) el('path', { d: `M ${polarX(a, 21)} ${polarY(a, 21)} L ${polarX(a + 180, 21)} ${polarY(a + 180, 21)}`, ...stroke }, g); });
  hudIcon(svg, X(), 'iUpdate', g => { el('path', { d: 'M 0 -20 V 6 M -12 -6 L 0 8 L 12 -6 M -16 20 H 16', ...stroke }, g); });
  hudIcon(svg, X(), 'iGps', g => { el('circle', { r: 15, ...stroke }, g); el('circle', { r: 5, fill: 'currentColor' }, g); el('path', { d: 'M 0 -25 V -19 M 0 19 V 25 M -25 0 H -19 M 19 0 H 25', ...stroke }, g); });
  built = true;
}
const lit = (key, color, on) => { HG[key].style.color = on ? color : HC.off; };

let hudLen = 0;
function frameHud() {
  const { max } = bandScale(unit);
  disp.speed = ease(disp.speed, speedIn(speedMs, unit) || 0, 0.2);
  const txtv = String(Math.round(disp.speed));
  HG.speed.textContent = txtv;
  if (txtv.length !== hudLen) { hudLen = txtv.length; const b = HG.speed.getBBox(); HG.unit.setAttribute('x', b.x + b.width + 26); }
  HG.bar.setAttribute('width', HG.barW * Math.min(Math.max(disp.speed / max, 0), 1));
  const { bat, rng, full } = gaugeValues(), c = levelColor(bat);
  disp.bat = ease(disp.bat, bat == null ? 0 : bat / 100, 0.15); disp.rng = ease(disp.rng, rng == null ? 0 : rng / full, 0.15);
  setRing(HG.batRing, disp.bat, c); setRing(HG.rngRing, disp.rng, c);
}

function renderHud() {
  const mi = unit === 'mph', k = mi ? 1 : 1.609344, st = trip.stats, ts = tState;
  const now = new Date();
  HG.clock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  HG.trip.textContent = distanceIn(st.distance, unit).toFixed(1);

  // battery, range, status
  const bat = ts && Number.isFinite(ts.battery) ? ts.battery : null;
  const { rng } = gaugeValues(), bc = levelColor(bat);
  HG.pct.textContent = bat == null ? '–' : bat + '%'; HG.pct.style.fill = bc;
  HG.range.textContent = rng == null ? '–' : String(Math.round(rng)); HG.range.style.fill = bc;
  HG.rangeLab.textContent = unit === 'mph' ? 'MILES' : 'KM';
  let label = '', lc = HC.green;
  if (tError) { label = /sign-in/.test(tError) ? 'SIGN IN NEEDED' : 'TESLA OFFLINE'; lc = HC.amber; }
  else if (ts) {
    if (ts.asleep) { label = 'ASLEEP'; lc = HC.label; }
    else if (ts.charging) label = 'CHARGING';
    else if (ts.user_present) label = 'READY';
    else if (typeof ts.locked === 'boolean') { label = ts.locked ? 'LOCKED' : 'UNLOCKED'; lc = ts.locked ? HC.green : HC.amber; }
  }
  HG.status.textContent = label; HG.status.style.fill = lc;

  // indicators
  const fresh = lastFixAt && Date.now() - lastFixAt <= 5000;
  lit('iLock', ts && ts.locked === false ? HC.amber : HC.green, !!ts && typeof ts.locked === 'boolean');
  lit('iDoor', HC.red, !!(ts && ts.doors_open));
  lit('iSentry', HC.red, !!(ts && ts.sentry));
  lit('iTyre', HC.amber, !!(ts && ts.tpms_low));
  lit('iPlug', HC.green, !!(ts && (ts.charging || ts.plugged)));
  lit('iClimate', HC.cyan, !!(ts && ts.climate));
  lit('iUpdate', HC.cyan, !!(ts && ts.update_available));
  lit('iGps', fresh ? HC.green : HC.amber, !!lastFixAt);

  // navigation or fallbacks
  if (route && navState) {
    const { up } = navState;
    HG.arrow.innerHTML = arrowSvg(arrowFor(up.step)).replace(/#ffffff/g, HC.green).replace(/rgba\(255,255,255,\.3\)/g, 'rgba(125,255,74,.35)');
    HG.lVal.textContent = fmtDist(up.distance, unit); HG.lLab.textContent = 'NEXT TURN';
    HG.instr.textContent = clipText(instructionText(up.step), Math.round(HW / 27));
    const eta = etaMs(route, up.remaining);
    HG.rVal.textContent = eta ? new Date(eta).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    HG.rLab.textContent = 'ARRIVE';
    const pct = ts && Number.isFinite(ts.battery) ? arrivalPct({ batteryPct: ts.battery, rangeMi: ts.range_mi, remainingMi: up.remaining / 1609.344 }) : null;
    HG.rSub.textContent = pct == null ? fmtDist(up.remaining, unit) : `${pct}%`;
    HG.rSub.style.fill = pct != null && pct < 10 ? HC.red : HC.green;
  } else {
    HG.arrow.innerHTML = '';
    HG.lVal.textContent = ''; HG.lLab.textContent = '';
    HG.rVal.textContent = compass(heading); HG.rLab.textContent = 'HEADING'; HG.rSub.textContent = '';
    HG.instr.textContent = !lastFixAt ? 'Waiting for GPS…' : !fresh ? 'GPS signal lost' : navMsg || (dest ? 'Planning route…' : '');
  }
}
const clipText = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);


// ---------- battery and range dials (used by the windshield layout) ----------
const levelColor = pct => (pct != null && pct <= 15 ? HC.red : pct != null && pct <= 30 ? HC.amber : HC.green);
const dialSegs = 40;
function buildRing(parent, cx, cy, r) {
  const lit = [], glow = [], glowG = el('g', { filter: 'url(#gblur)' }, parent), g = el('g', {}, parent);
  for (let i = 0; i < dialSegs; i++) {
    const a = dialAngle((i + 0.5) / dialSegs), [x0, y0] = pt(cx, cy, a, r - 14, r - 14), [x1, y1] = pt(cx, cy, a, r + 14, r + 14);
    el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: '#fff', 'stroke-opacity': 0.14, 'stroke-width': 8, 'stroke-linecap': 'round' }, g);
    glow.push(el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: HC.green, 'stroke-width': 15, 'stroke-linecap': 'round', opacity: 0 }, glowG));
    lit.push(el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: HC.green, 'stroke-width': 8, 'stroke-linecap': 'round', opacity: 0 }, g));
  }
  return { lit, glow };
}
function setRing(r, frac, color) {
  const n = Math.min(Math.max(frac, 0), 1) * dialSegs;
  r.lit.forEach((l, i) => { const o = Math.min(Math.max(n - i, 0), 1); l.setAttribute('opacity', o); l.setAttribute('stroke', color); r.glow[i].setAttribute('opacity', o * 0.55); r.glow[i].setAttribute('stroke', color); });
}
function gaugeValues() {
  const ts = tState, k = unit === 'mph' ? 1 : 1.609344;
  const bat = ts && Number.isFinite(ts.battery) ? ts.battery : null;
  const rng = ts && Number.isFinite(ts.range_mi) ? ts.range_mi * k : null;
  // full-charge range, worked out from the current reading so the range dial sweeps in step with the battery
  const full = rng != null && bat >= 5 ? Math.ceil((rng / (bat / 100)) / 10) * 10 : 350 * k;
  return { bat, rng, full };
}

const buildFace = () => (layout === 'hud' ? buildHud() : buildCluster());

// follow the screen: rebuild when the phone is turned or resized
let resizeTimer = null;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (built && !$('hud').hidden) { buildFace(); render(); } }, 200);
});
// swipe sideways to flip between the Cluster and Windshield layouts
let pagerTimer = null;
function showPager() {
  const pg = $('pager'); pg.classList.remove('idle');
  [...pg.children].forEach((d, i) => d.classList.toggle('on', LAYOUTS[i] === layout));
  clearTimeout(pagerTimer); pagerTimer = setTimeout(() => pg.classList.add('idle'), 2500);
}
function switchLayout(dir) { // dir: +1 = next (swipe left), -1 = previous
  const i = LAYOUTS.indexOf(layout), n = LAYOUTS[(i + dir + LAYOUTS.length) % LAYOUTS.length];
  if (n === layout) return;
  layout = n; savePrefs(); buildFace(); render(); showPager();
  const svg = $('cluster'); svg.classList.remove('in-l', 'in-r'); void svg.getBoundingClientRect();
  svg.classList.add(dir > 0 ? 'in-r' : 'in-l');
}
let sw = null;
$('hud').addEventListener('touchstart', e => { const t = e.touches[0]; sw = e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null; }, { passive: true });
$('hud').addEventListener('touchend', e => {
  if (!sw) return; const t = e.changedTouches[0], dx = t.clientX - sw.x, dy = t.clientY - sw.y; sw = null;
  if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
  switchLayout((dx < 0 ? 1 : -1) * (mirror ? -1 : 1)); // when mirrored, the picture is flipped, so swipe direction flips too
}, { passive: true });
// the Reset/Exit buttons stay out of the way until you tap the display
let ctlTimer = null;
$('hud').addEventListener('click', () => {
  $('controls').classList.add('show'); clearTimeout(ctlTimer);
  ctlTimer = setTimeout(() => $('controls').classList.remove('show'), 4000);
});

// ---------- render ----------
// ---------- render ----------
let unwrapped = 0, prevHeading = 0, lastFrame = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (!built || $('hud').hidden || ts - lastFrame < 33) return;
  lastFrame = ts;
  if (layout === 'hud') return frameHud();
  const { max } = bandScale(unit);
  disp.speed = ease(disp.speed, speedIn(speedMs, unit) || 0, 0.18);
  setDial(G.dial, disp.speed, max);
  G.speed.textContent = Math.round(disp.speed);
  const f = Math.min(disp.speed / max, 1);
  G.ambient.setAttribute('fill', accent(f)); G.ambient.setAttribute('opacity', 0.06 + 0.3 * f);
}
requestAnimationFrame(frame);


function renderTesla(topSpeed) {
  const mi = unit === 'mph', st = tState;
  const k = mi ? 1 : 1.609344;
  if (!st || !Number.isFinite(st.battery)) {
    G.batPct.textContent = '–'; G.batRange.textContent = ''; G.batBar.setAttribute('width', 0);
  } else {
    G.batPct.textContent = st.battery + '%';
    G.batRange.textContent = Number.isFinite(st.range_mi) ? `${Math.round(st.range_mi * k)} ${mi ? 'mi' : 'km'}` : '';
    G.batBar.setAttribute('width', (218 * Math.min(Math.max(st.battery, 0), 100)) / 100);
    G.batBar.setAttribute('fill', st.battery <= 15 ? '#ff5a4d' : accent(0.3));
    if (Number.isFinite(st.limit)) { G.batLimit.style.display = ''; G.batLimit.setAttribute('x', 66 + (218 * st.limit) / 100 - 1); } else G.batLimit.style.display = 'none';
  }
  // efficiency replaces top speed once the battery has dropped enough to measure
  const miles = distanceIn(trip.stats.distance, 'mph');
  const eff = st && !st.stale ? liveEfficiency(tStartPct, st.battery, miles, BATTERY_KWH) : null;
  if (eff != null) { G.t3label.textContent = 'EFFICIENCY'; G.top.textContent = `${(eff * k).toFixed(1)} ${mi ? 'mi' : 'km'}/kWh`; }
  else { G.t3label.textContent = 'TOP SPEED'; G.top.textContent = `${Math.round(topSpeed)} ${mi ? 'mph' : 'km/h'}`; }
  // chips
  if (st && typeof st.locked === 'boolean') { G.lock.style.color = st.locked ? '#3ddc84' : '#f0b429'; G.shackle.setAttribute('d', st.locked ? 'M 5 11 V 7 a 6 6 0 0 1 12 0 V 11' : 'M 5 11 V 7 a 6 6 0 0 1 12 0 V 5'); }
  G.outTemp.textContent = st && Number.isFinite(st.outside_c) ? `${Math.round(st.outside_c)}°C` : '';
  const age = ageSeconds(st);
  G.carStat.textContent = tError ? (/sign-in/.test(tError) ? 'Tesla: sign in' : 'Tesla offline') : (carStatus(st) || (st && st.stale ? 'Last known' : ''));
  G.carStat.style.fill = tError ? '#f0b429' : accent(0.15);
  // arrival battery on the nav card
  if (route && navState && st && Number.isFinite(st.battery)) {
    const pct = arrivalPct({ batteryPct: st.battery, rangeMi: st.range_mi, remainingMi: navState.up.remaining / 1609.344 });
    G.arrive.textContent = pct == null ? '' : `Arrive with ~${pct}%`;
    G.arrive.style.fill = pct != null && pct < 10 ? '#ff5a4d' : accent(0.1);
  } else G.arrive.textContent = '';
  void age;
}

function render() {
  if (!built) return;
  if (layout === 'hud') return renderHud();
  const { max } = bandScale(unit);
  const st = trip.stats, top = speedIn(st.top, unit) || 0;
  setMarker(G.dial, top, max);
  G.trip.textContent = `${distanceIn(st.distance, unit).toFixed(1)} ${unit === 'mph' ? 'mi' : 'km'}`;
  G.top.textContent = `${Math.round(top)} ${unit === 'mph' ? 'mph' : 'km/h'}`;
  G.dir.textContent = compass(heading);
  const now = new Date(), c = clockAngles(now);
  G.clockTxt.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  rot(G.hour, c.hour); rot(G.min, c.minute);
  if (heading != null) { const diff = ((heading - prevHeading + 540) % 360) - 180; unwrapped += diff; prevHeading = heading; rot(G.card, -unwrapped); }
  renderTesla(top);
  renderNav();
  const stale = !lastFixAt || Date.now() - lastFixAt > 5000;
  G.gps.setAttribute('fill', stale ? '#f0b429' : '#3ddc84');
  const msg = !lastFixAt ? 'Waiting for GPS…' : stale ? 'GPS signal lost' : navMsg;
  G.status.textContent = (route && navState) ? '' : (msg || (dest ? 'Planning route…' : ''));
  if (route && navState && msg) G.rem.textContent = msg;
}

async function keepAwake() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not critical */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !$('hud').hidden) keepAwake(); });

$('go').addEventListener('click', () => {
  if (!('geolocation' in navigator)) { alert('This browser has no GPS access.'); return; }
  $('start').hidden = true; $('hud').hidden = false;
  buildFace(); syncOpts(); render(); keepAwake(); showPager();
  tesla = teslaClient(); if (tesla) { pollTesla(); tTimer = setInterval(pollTesla, 60000); }
  if (voiceOn && 'speechSynthesis' in window) { try { window.speechSynthesis.speak(new SpeechSynthesisUtterance(' ')); } catch { /* unlock audio on iOS */ } }
  watchId = navigator.geolocation.watchPosition(p => {
    lastFixAt = Date.now();
    speedMs = p.coords.speed;
    if (p.coords.heading != null && !Number.isNaN(p.coords.heading) && (p.coords.speed || 0) > 1) heading = p.coords.heading;
    navUpdate({ lat: p.coords.latitude, lon: p.coords.longitude });
    trip.add({ lat: p.coords.latitude, lon: p.coords.longitude, time: p.timestamp, accuracy: p.coords.accuracy, speed: p.coords.speed });
    render();
  }, err => { navMsg = err.code === 1 ? 'Location permission denied' : 'GPS error: ' + err.message; render(); },
  { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  setInterval(render, 1000);
});
$('reset').addEventListener('click', () => { trip.reset(); tStartPct = tState && !tState.stale ? tState.battery : null; render(); });
$('stop').addEventListener('click', () => { if (watchId != null) navigator.geolocation.clearWatch(watchId); if (wakeLock) wakeLock.release(); location.reload(); });
syncOpts();
