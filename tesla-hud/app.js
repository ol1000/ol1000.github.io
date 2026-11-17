import { createTrip, speedIn, distanceIn, compass, fmtDuration, clockAngles, bandAngle, bandScale, lerpColor, ease, twoLines } from './hud.js';
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
const CY = 470, LX = 470, RXC = 1050, RXR = 290, RYR = 215, SEG = 60;
const pt = (cx, cy, a, rx, ry) => [cx + rx * Math.sin(rad(a)), cy - ry * Math.cos(rad(a))];
const polar = (deg, r) => [r * Math.sin(rad(deg)), -r * Math.cos(rad(deg))];

let G = {}; // handles to the live parts
const disp = { speed: 0, avg: 0 }; // eased values actually drawn

function buildGauge(parent, cx, side) {
  const h = { side, cx, lit: [], glow: [] };
  const { max, label, minor } = bandScale(unit);
  const glowG = el('g', { filter: 'url(#blur)' }, parent);
  const g = el('g', {}, parent);
  for (let i = 0; i < SEG; i++) {
    const f = (i + 0.5) / SEG, a = bandAngle(f, side);
    const [x0, y0] = pt(cx, CY, a, RXR * 0.92, RYR * 0.92), [x1, y1] = pt(cx, CY, a, RXR * 1.08, RYR * 1.08);
    const c = accent(f);
    el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: '#ffffff', 'stroke-opacity': 0.08, 'stroke-width': 7.5, 'stroke-linecap': 'round' }, g);
    h.glow.push(el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: c, 'stroke-width': 15, 'stroke-linecap': 'round', opacity: 0 }, glowG));
    h.lit.push(el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: c, 'stroke-width': 7.5, 'stroke-linecap': 'round', opacity: 0 }, g));
  }
  for (let v = 0; v <= max + 1e-9; v += minor) {
    const a = bandAngle(v / max, side);
    if (v % label === 0) { const [lx, ly] = pt(cx, CY, a, RXR * 1.2, RYR * 1.2); txt(g, lx, ly + 8, 23, 'middle', v, 'num', 300).style.fill = 'rgba(255,255,255,.62)'; }
    else { const [dx, dy] = pt(cx, CY, a, RXR * 1.15, RYR * 1.15); el('circle', { cx: dx, cy: dy, r: 1.8, fill: 'rgba(255,255,255,.35)' }, g); }
  }
  h.marker = el('path', { d: 'M -6 0 L 6 0 L 0 10 Z', fill: '#ffffff' }, g); h.marker.style.display = 'none';
  return h;
}
function setGauge(h, value, max) {
  const lit = Math.min(Math.max(value / max, 0), 1) * SEG;
  for (let i = 0; i < SEG; i++) {
    const o = Math.min(Math.max(lit - i, 0), 1);
    h.lit[i].setAttribute('opacity', o); h.glow[i].setAttribute('opacity', o * 0.7);
  }
}
function setMarker(h, value, max) {
  if (!(value > 0)) { h.marker.style.display = 'none'; return; }
  const a = bandAngle(value / max, h.side), [x, y] = pt(h.cx, CY, a, RXR * 1.04 - 0, RYR * 1.04);
  h.marker.style.display = ''; h.marker.setAttribute('transform', `translate(${x} ${y}) rotate(${a + 180}) translate(0 -2)`);
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

function buildCluster() {
  const svg = $('cluster'); svg.innerHTML = '';
  svg.classList.toggle('nonum', !showNums);
  const defs = el('defs', {}, svg);
  const bg = el('radialGradient', { id: 'bg', cx: '50%', cy: '48%', r: '80%' }, defs);
  el('stop', { offset: 0, 'stop-color': '#0d1420' }, bg); el('stop', { offset: 0.6, 'stop-color': '#05080d' }, bg); el('stop', { offset: 1, 'stop-color': '#010203' }, bg);
  el('filter', { id: 'blur', x: '-30%', y: '-30%', width: '160%', height: '160%' }, defs).appendChild(el('feGaussianBlur', { stdDeviation: 7 }));
  el('filter', { id: 'soft', x: '-50%', y: '-50%', width: '200%', height: '200%' }, defs).appendChild(el('feGaussianBlur', { stdDeviation: 40 }));
  const card = el('linearGradient', { id: 'cardline', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  el('stop', { offset: 0, 'stop-color': 'rgba(255,255,255,.28)' }, card); el('stop', { offset: 1, 'stop-color': 'rgba(255,255,255,.04)' }, card);
  const carg = el('linearGradient', { id: 'carfill', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  el('stop', { offset: 0, 'stop-color': colors()[0] }, carg); el('stop', { offset: 1, 'stop-color': colors()[3] }, carg);
  el('clipPath', { id: 'mapclip' }, defs).appendChild(el('circle', { cx: 760, cy: 470, r: 104 }));
  el('rect', { width: 1520, height: 800, fill: 'url(#bg)' }, svg);

  G.ambient = el('ellipse', { cx: LX, cy: CY, rx: 380, ry: 250, fill: accent(0), opacity: 0.05, filter: 'url(#soft)' }, svg);
  G.ambient2 = el('ellipse', { cx: RXC, cy: CY, rx: 380, ry: 250, fill: accent(0), opacity: 0.04, filter: 'url(#soft)' }, svg);

  const main = el('g', { transform: 'translate(0 -45)' }, svg);
  G.left = buildGauge(main, LX, -1);
  G.right = buildGauge(main, RXC, 1);

  // readouts, sitting in the hollow of each gauge
  G.speed = txt(main, 412, 505, 168, 'middle', '0', 'num', 200);
  G.unitL = txt(main, 412, 560, 24, 'middle', unit === 'mph' ? 'MPH' : 'KM/H', 'num', 500, accent(0.2)); G.unitL.style.letterSpacing = '8px';
  G.avg = txt(main, 1108, 505, 112, 'middle', '0', 'num', 200);
  const al = txt(main, 1108, 552, 20, 'middle', 'AVERAGE', 'num', 500, accent(0.7)); al.style.letterSpacing = '7px';

  // centre glass card
  el('rect', { x: 598, y: 232, width: 324, height: 456, rx: 38, fill: 'rgba(255,255,255,.035)', stroke: 'url(#cardline)', 'stroke-width': 1.4 }, main);
  G.badge = el('g', { transform: 'translate(654 292)' }, main);
  G.t1 = txt(main, 712, 286, 21, 'start', '', '', 500); G.t2 = txt(main, 712, 313, 19, 'start', '', '', 300, 'rgba(255,255,255,.65)');
  G.status = txt(main, 760, 300, 24, 'middle', '', '', 300, 'rgba(255,255,255,.6)');
  G.car = el('g', { transform: 'translate(760 470)' }, main);
  el('ellipse', { rx: 90, ry: 130, fill: accent(0.4), opacity: 0.35, filter: 'url(#soft)' }, G.car);
  el('path', { d: 'M0 -118 C44 -118 56 -76 56 -24 L56 62 C56 104 36 120 0 120 C-36 120 -56 104 -56 62 L-56 -24 C-56 -76 -44 -118 0 -118 Z', fill: 'url(#carfill)', opacity: 0.92 }, G.car);
  el('path', { d: 'M-40 -66 C-28 -78 28 -78 40 -66 L34 -34 L-34 -34 Z', fill: '#05080d', opacity: 0.85 }, G.car);
  el('rect', { x: -38, y: -10, width: 76, height: 56, rx: 14, fill: '#05080d', opacity: 0.55 }, G.car);
  el('path', { d: 'M-36 96 C-18 104 18 104 36 96', fill: 'none', stroke: '#05080d', 'stroke-width': 4, 'stroke-linecap': 'round', opacity: 0.7 }, G.car);
  G.map = el('g', {}, main); G.map.style.display = 'none';
  el('circle', { cx: 760, cy: 470, r: 106, fill: '#070b10', stroke: 'rgba(255,255,255,.18)', 'stroke-width': 1.5 }, G.map);
  const clipped = el('g', { 'clip-path': 'url(#mapclip)' }, G.map);
  const mg = el('g', { transform: 'translate(760 520)' }, clipped);
  G.mapGlow = el('path', { d: '', fill: 'none', stroke: accent(0.1), 'stroke-width': 16, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.45, filter: 'url(#blur)' }, mg);
  G.mapPath = el('path', { d: '', fill: 'none', stroke: accent(0.1), 'stroke-width': 6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, mg);
  G.ring = el('path', { d: '', fill: 'none', stroke: accent(0.95), 'stroke-width': 5, 'stroke-linecap': 'round' }, G.map);
  el('path', { d: 'M 760 492 L 770 522 L 760 515 L 750 522 Z', fill: '#ffffff' }, G.map);
  G.dist = txt(main, 760, 628, 32, 'middle', '', '', 400, accent(0.15)); G.rem = txt(main, 760, 662, 18, 'middle', '', '', 300, 'rgba(255,255,255,.5)');

  // top: clock and GPS state
  G.clockTxt = txt(svg, 760, 84, 46, 'middle', '--:--', 'num', 300);
  G.gps = el('circle', { cx: 690, cy: 68, r: 6, fill: '#f0b429' }, svg);

  // minimal corner dials
  const cg = miniDial(svg, 100, 690, 0.62);
  G.card = el('g', { class: 'needle' }, cg);
  for (let a = 0; a < 360; a += 30) { const maj = a % 90 === 0, [x0, y0] = polar(a, maj ? 68 : 78), [x1, y1] = polar(a, 86); el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: maj ? '#fff' : 'rgba(255,255,255,.35)', 'stroke-width': maj ? 3 : 1.5 }, G.card); }
  el('path', { d: 'M -9 -50 L 9 -50 L 0 -80 Z', fill: '#ff5a6a' }, G.card);
  el('path', { d: 'M -9 -100 L 9 -100 L 0 -86 Z', fill: accent(0.1) }, cg);
  const kg = miniDial(svg, 1420, 690, 0.62);
  for (let k = 0; k < 12; k++) { const [x0, y0] = polar(k * 30, k % 3 === 0 ? 68 : 78), [x1, y1] = polar(k * 30, 86); el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: k % 3 === 0 ? '#fff' : 'rgba(255,255,255,.35)', 'stroke-width': k % 3 === 0 ? 3 : 1.5 }, kg); }
  G.hour = hand(kg, 46, '#fff', 6); G.min = hand(kg, 70, 'rgba(255,255,255,.75)', 4);
  el('circle', { r: 5, fill: accent(0.1) }, kg);

  // bottom chips
  const bchip = (x, label, key) => { const l = txt(svg, x, 726, 15, 'middle', label, 'num', 500, 'rgba(255,255,255,.45)'); l.style.letterSpacing = '4px'; G[key] = txt(svg, x, 766, 38, 'middle', '–', 'num', 300); };
  bchip(420, 'HEADING', 'dir'); bchip(630, 'ELAPSED', 'elapsed'); bchip(890, 'TRIP', 'trip'); bchip(1100, 'TOP', 'top');
  built = true;
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
  if (!on) {
    G.t1.textContent = ''; G.t2.textContent = ''; G.dist.textContent = ''; G.rem.textContent = '';
    return;
  }
  const { fix, loc, up } = navState;
  const hd = heading != null ? heading : segmentBearing(route, loc.index);
  const pts = mapPoints(route, fix, hd, loc.index, 150 + Math.min(speedMs || 0, 30) * 10, 100);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  G.mapPath.setAttribute('d', d); G.mapGlow.setAttribute('d', d);
  const frac = 1 - Math.min(up.distance, 500) / 500;
  if (frac > 0.01) {
    const a0 = -135, a1 = -135 + frac * 270, [x0, y0] = pt(760, 470, a0, 112, 112), [x1, y1] = pt(760, 470, a1, 112, 112);
    G.ring.setAttribute('d', `M ${x0} ${y0} A 112 112 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`);
  } else G.ring.setAttribute('d', '');
  G.badge.innerHTML = `<circle r="34" fill="rgba(255,255,255,.08)"/>${arrowSvg(arrowFor(up.step))}`;
  const [l1, l2] = twoLines(instructionText(up.step), 24);
  G.t1.textContent = l1; G.t2.textContent = l2;
  G.dist.textContent = fmtDist(up.distance, unit);
  G.rem.textContent = `${fmtDist(up.remaining, unit)} to go`;
}

// ---------- render ----------
let unwrapped = 0, prevHeading = 0, lastFrame = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (!built || $('hud').hidden || ts - lastFrame < 33) return;
  lastFrame = ts;
  const { max } = bandScale(unit);
  const sp = speedIn(speedMs, unit) || 0, avg = speedIn(trip.stats.avg, unit) || 0;
  disp.speed = ease(disp.speed, sp, 0.18); disp.avg = ease(disp.avg, avg, 0.18);
  setGauge(G.left, disp.speed, max); setGauge(G.right, disp.avg, max);
  G.speed.textContent = Math.round(disp.speed); G.avg.textContent = Math.round(disp.avg);
  const f = Math.min(disp.speed / max, 1), c = accent(f);
  G.speed.style.fill = '#fff';
  G.ambient.setAttribute('fill', c); G.ambient.setAttribute('opacity', 0.05 + 0.25 * f);
  G.ambient2.setAttribute('fill', accent(Math.min(disp.avg / max, 1))); G.ambient2.setAttribute('opacity', 0.04 + 0.16 * Math.min(disp.avg / max, 1));
}
requestAnimationFrame(frame);

function render() {
  if (!built) return;
  const { max } = bandScale(unit);
  const st = trip.stats, top = speedIn(st.top, unit) || 0;
  setMarker(G.left, top, max);
  G.trip.textContent = `${distanceIn(st.distance, unit).toFixed(1)}`; G.top.textContent = Math.round(top);
  G.elapsed.textContent = fmtDuration(st.elapsed);
  G.dir.textContent = compass(heading);
  const now = new Date(), c = clockAngles(now);
  G.clockTxt.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  rot(G.hour, c.hour); rot(G.min, c.minute);
  if (heading != null) { const diff = ((heading - prevHeading + 540) % 360) - 180; unwrapped += diff; prevHeading = heading; rot(G.card, -unwrapped); }
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
$('reset').addEventListener('click', () => { trip.reset(); render(); });
$('stop').addEventListener('click', () => { if (watchId != null) navigator.geolocation.clearWatch(watchId); if (wakeLock) wakeLock.release(); location.reload(); });
syncOpts();
