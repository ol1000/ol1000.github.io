import { createTrip, speedIn, distanceIn, compass, fmtDuration, clockAngles, bandScale, lerpColor, ease, twoLines } from './hud.js';
import { validateBase, liveEfficiency, arrivalPct, carStatus, ageSeconds, createTesla } from './tesla.js';
import { geocode, fetchRoute, locate, upcoming, arrowFor, instructionText, fmtDist, mapPoints, segmentBearing } from './nav.js';

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const prefs = JSON.parse(localStorage.getItem('hud-prefs') || '{}');
let unit = prefs.unit || 'mph';
let mirror = !!prefs.mirror;
let voiceOn = prefs.voice !== false;
let showNums = prefs.numbers !== false;
let theme = prefs.theme === 'ember' ? 'ember' : 'aurora';
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
const disp = { speed: 0, avg: 0 }; // eased values actually drawn

function buildDial(parent) {
  const h = { lit: [], glow: [] };
  const { max, label, minor } = bandScale(unit);
  // outer hairline and an inner track for the average
  el('circle', { cx: DX, cy: DY, r: R + 52, fill: 'none', stroke: 'rgba(255,255,255,.08)', 'stroke-width': 1.5 }, parent);
  el('path', { d: arcD(DX, DY, A0, A0 + SWEEP, R - 52), fill: 'none', stroke: 'rgba(255,255,255,.08)', 'stroke-width': 7, 'stroke-linecap': 'round' }, parent);
  h.avgGlow = el('path', { d: '', fill: 'none', stroke: accent(0.75), 'stroke-width': 13, 'stroke-linecap': 'round', opacity: 0.6, filter: 'url(#blur)' }, parent);
  h.avg = el('path', { d: '', fill: 'none', stroke: accent(0.75), 'stroke-width': 7, 'stroke-linecap': 'round' }, parent);
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
function setDial(h, value, avg, max) {
  const lit = Math.min(Math.max(value / max, 0), 1) * SEG;
  for (let i = 0; i < SEG; i++) {
    const o = Math.min(Math.max(lit - i, 0), 1);
    h.lit[i].setAttribute('opacity', o); h.glow[i].setAttribute('opacity', o * 0.7);
  }
  const fa = Math.min(Math.max(avg / max, 0), 1);
  const d = fa > 0.004 ? arcD(DX, DY, A0, dialAngle(fa), R - 52) : '';
  h.avg.setAttribute('d', d); h.avgGlow.setAttribute('d', d);
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
  const svg = $('cluster'); svg.innerHTML = '';
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
  const al = txt(svg, DX - 38, DY + 196, 17, 'end', 'AVG', 'num', 500, accent(0.75)); al.style.letterSpacing = '5px';
  G.avgTxt = txt(svg, DX - 26, DY + 200, 34, 'start', '0', 'num', 300);

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
  G.elapsed = txt(svg, DX, 774, 22, 'middle', '', 'num', 300, 'rgba(255,255,255,.5)');

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
  catch (e) { $('tstatus').textContent = 'Failed: ' + e.message; }
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
const savePrefs = () => localStorage.setItem('hud-prefs', JSON.stringify({ unit, mirror, voice: voiceOn, numbers: showNums, theme }));
function syncOpts() {
  document.querySelectorAll('[data-unit]').forEach(b => b.classList.toggle('on', b.dataset.unit === unit));
  for (const [id, on, label] of [['mirror', mirror, 'Mirror'], ['voice', voiceOn, 'Voice'], ['numbers', showNums, 'Numbers']]) {
    $(id).textContent = `${label}: ${on ? 'on' : 'off'}`; $(id).classList.toggle('on', on);
  }
  $('theme').textContent = `Theme: ${theme === 'aurora' ? 'Aurora' : 'Ember'}`;
  $('face').classList.toggle('mirror', mirror);
  if (built) $('cluster').classList.toggle('nonum', !showNums);
}
const rebuild = () => { if (built) { buildCluster(); render(); } };
document.querySelectorAll('[data-unit]').forEach(b => b.addEventListener('click', () => { unit = b.dataset.unit; savePrefs(); syncOpts(); rebuild(); }));
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

// ---------- render ----------
// ---------- render ----------
let unwrapped = 0, prevHeading = 0, lastFrame = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (!built || $('hud').hidden || ts - lastFrame < 33) return;
  lastFrame = ts;
  const { max } = bandScale(unit);
  const sp = speedIn(speedMs, unit) || 0, avg = speedIn(trip.stats.avg, unit) || 0;
  disp.speed = ease(disp.speed, sp, 0.18); disp.avg = ease(disp.avg, avg, 0.18);
  setDial(G.dial, disp.speed, disp.avg, max);
  G.speed.textContent = Math.round(disp.speed); G.avgTxt.textContent = Math.round(disp.avg);
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
  G.carStat.textContent = tError ? 'Tesla offline' : (carStatus(st) || (st && st.stale ? 'Last known' : ''));
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
  const { max } = bandScale(unit);
  const st = trip.stats, top = speedIn(st.top, unit) || 0;
  setMarker(G.dial, top, max);
  G.trip.textContent = `${distanceIn(st.distance, unit).toFixed(1)} ${unit === 'mph' ? 'mi' : 'km'}`;
  G.top.textContent = `${Math.round(top)} ${unit === 'mph' ? 'mph' : 'km/h'}`;
  G.elapsed.textContent = st.elapsed > 0 ? `ELAPSED ${fmtDuration(st.elapsed)}` : '';
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
  buildCluster(); syncOpts(); render(); keepAwake();
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
