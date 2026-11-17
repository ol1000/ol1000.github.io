import { createTrip, speedIn, distanceIn, compass, fmtDuration, clockAngles, bandAngle, bandScale } from './hud.js';
import { geocode, fetchRoute, locate, upcoming, arrowFor, instructionText, fmtDist, mapPoints, segmentBearing } from './nav.js';

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const prefs = JSON.parse(localStorage.getItem('hud-prefs') || '{}');
let unit = prefs.unit || 'mph';
let mirror = !!prefs.mirror;
let voiceOn = prefs.voice !== false;
let showNums = prefs.numbers !== false;
const trip = createTrip();
let watchId = null, wakeLock = null, heading = null, speedMs = null, lastFixAt = 0, built = false;

const rad = d => (d * Math.PI) / 180;
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
};
const txt = (parent, x, y, size, anchor, content = '', cls = '', weight = 400) =>
  Object.assign(el('text', { x, y, 'font-size': size, 'text-anchor': anchor, 'font-weight': weight, class: cls }, parent), { textContent: content });
const rot = (g, deg) => { g.style.transform = `rotate(${deg}deg)`; };

// ---------- cluster geometry ----------
const CY = 470, LX = 470, RX_ = 1050, RXR = 300, RYR = 225;
const pt = (cx, cy, a, rx, ry) => [cx + rx * Math.sin(rad(a)), cy - ry * Math.cos(rad(a))];
const ell = (cx, cy, a0, a1, rx, ry) => {
  const [x0, y0] = pt(cx, cy, a0, rx, ry), [x1, y1] = pt(cx, cy, a1, rx, ry);
  return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${rx} ${ry} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} ${a1 > a0 ? 1 : 0} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
};

let G = {}; // handles to the dynamic parts

function buildBand(svg, cx, side) {
  const h = {};
  const g = el('g', {}, svg);
  // frame: two fine outlines
  [[20, 2.2], [29, 1]].forEach(([d, w]) => el('path', { d: ell(cx, CY, bandAngle(0, side) + side * -10, bandAngle(1, side) - side * 4, RXR + d, RYR + d * 0.8), fill: 'none', stroke: '#e9eef2', 'stroke-width': w, 'stroke-linecap': 'round' }, g));
  // dark track and glowing fill band
  const [a0, a1] = [bandAngle(0, side), bandAngle(1, side)];
  el('path', { d: ell(cx, CY, a0, a1, RXR - 24, RYR - 19), fill: 'none', stroke: '#1d1013', 'stroke-width': 38, 'stroke-linecap': 'butt' }, g);
  h.glow = el('path', { d: '', fill: 'none', stroke: '#ff3b1f', 'stroke-width': 44, filter: 'url(#blur)', opacity: 0.55 }, g);
  h.fill = el('path', { d: '', fill: 'none', stroke: 'url(#band)', 'stroke-width': 34 }, g);
  h.tip = el('circle', { r: 7, fill: '#fff', cx: -50, cy: -50 }, g);
  h.side = side; h.cx = cx;
  // scale
  const { max, label, minor } = bandScale(unit);
  for (let v = 0; v <= max + 1e-9; v += minor) {
    const a = bandAngle(v / max, side), major = v % label === 0;
    const [x0, y0] = pt(cx, CY, a, RXR + 4, RYR + 3), [x1, y1] = pt(cx, CY, a, RXR + (major ? 22 : 15), RYR + (major ? 18 : 12));
    el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: '#fff', 'stroke-width': major ? 2.6 : 1.3 }, g);
    if (major) { const [lx, ly] = pt(cx, CY, a, RXR + 50, RYR + 42); txt(g, lx, ly + 10, 28, 'middle', v, 'num', 500); }
  }
  h.marker = el('path', { d: 'M -7 0 L 7 0 L 0 12 Z', fill: '#f0b429' }, g); // top-speed marker
  h.marker.style.display = 'none';
  return h;
}

function setBand(h, value, max) {
  const f = Math.min(Math.max(value / max, 0), 1);
  if (f < 0.005) { h.fill.setAttribute('d', ''); h.glow.setAttribute('d', ''); h.tip.setAttribute('cx', -50); return; }
  const a0 = bandAngle(0, h.side), a1 = bandAngle(f, h.side);
  const d = ell(h.cx, CY, a0, a1, RXR - 24, RYR - 19);
  h.fill.setAttribute('d', d); h.glow.setAttribute('d', d);
  const [x, y] = pt(h.cx, CY, a1, RXR - 24, RYR - 19);
  h.tip.setAttribute('cx', x); h.tip.setAttribute('cy', y);
}
function setMarker(h, value, max) {
  if (!(value > 0)) { h.marker.style.display = 'none'; return; }
  const a = bandAngle(value / max, h.side), [x, y] = pt(h.cx, CY, a, RXR + 34, RYR + 28);
  h.marker.style.display = ''; h.marker.setAttribute('transform', `translate(${x} ${y}) rotate(${a})`);
}

function smallDial(svg, x, y, scale) {
  const g = el('g', { transform: `translate(${x} ${y}) scale(${scale})` }, svg);
  el('circle', { r: 92, fill: '#070b10', stroke: '#e9eef2', 'stroke-width': 3 }, g);
  return g;
}
function needle(parent, len, color, width) {
  const g = el('g', { class: 'needle' }, parent);
  el('line', { x1: 0, y1: 8, x2: 0, y2: -len, stroke: color, 'stroke-width': width, 'stroke-linecap': 'round' }, g);
  return g;
}
const polar = (deg, r) => [r * Math.sin(rad(deg)), -r * Math.cos(rad(deg))];

function buildCluster() {
  const svg = $('cluster'); svg.innerHTML = '';
  svg.classList.toggle('nonum', !showNums);
  const defs = el('defs', {}, svg);
  const bg = el('radialGradient', { id: 'bg', cx: '50%', cy: '55%', r: '75%' }, defs);
  el('stop', { offset: 0, 'stop-color': '#0f1a26' }, bg); el('stop', { offset: 1, 'stop-color': '#03060a' }, bg);
  const band = el('linearGradient', { id: 'band', x1: 0, y1: 1, x2: 0, y2: 0 }, defs);
  el('stop', { offset: 0, 'stop-color': '#ff2d1f' }, band); el('stop', { offset: 1, 'stop-color': '#ff9a3a' }, band);
  el('filter', { id: 'blur', x: '-20%', y: '-20%', width: '140%', height: '140%' }, defs).appendChild(el('feGaussianBlur', { stdDeviation: 9 }));
  el('clipPath', { id: 'mapclip' }, defs).appendChild(el('circle', { cx: 760, cy: 445, r: 128 }));
  el('rect', { width: 1520, height: 800, fill: 'url(#bg)' }, svg);

  const main = el('g', { transform: 'translate(0 -55)' }, svg);
  G.left = buildBand(main, LX, -1);
  G.right = buildBand(main, RX_, 1);

  // digital readouts (hidden when numbers are off)
  G.speed = txt(main, 400, 462, 96, 'middle', '0', 'num', 600);
  txt(main, 505, 472, 26, 'start', '', 'num').textContent = '';
  G.unit = txt(main, 520, 466, 26, 'start', unit === 'mph' ? 'mph' : 'km/h', 'num', 400);
  el('line', { x1: 300, y1: 484, x2: 570, y2: 484, stroke: '#fff', 'stroke-width': 2, class: 'num' }, main);
  G.avg = txt(main, 1120, 462, 96, 'middle', '0', 'num', 600);
  txt(main, 1010, 466, 26, 'end', 'avg', 'num');
  el('line', { x1: 950, y1: 484, x2: 1220, y2: 484, stroke: '#fff', 'stroke-width': 2, class: 'num' }, main);
  txt(main, 1010, 530, 26, 'start', 'TRIP', 'num'); G.trip = txt(main, 1220, 530, 26, 'end', '0.0', 'num');
  txt(main, 1010, 568, 26, 'start', 'TOP', 'num'); G.top = txt(main, 1220, 568, 26, 'end', '0', 'num');

  // centre: status line, then car or map
  G.title = txt(main, 760, 285, 27, 'middle', '', '', 600);
  G.sub = txt(main, 760, 322, 22, 'middle', '', '');
  G.sub.style.fill = '#9aa6b0';
  G.car = el('g', { transform: 'translate(760 450)' }, main);
  el('rect', { x: -48, y: -105, width: 96, height: 210, rx: 40, fill: '#ff4a2a', opacity: 0.9 }, G.car);
  el('rect', { x: -36, y: -58, width: 72, height: 32, rx: 10, fill: '#0b1218' }, G.car);
  el('rect', { x: -36, y: 24, width: 72, height: 24, rx: 8, fill: '#0b1218' }, G.car);
  G.map = el('g', {}, main); G.map.style.display = 'none';
  el('circle', { cx: 760, cy: 445, r: 128, fill: '#0b0f12' }, G.map);
  const clipped = el('g', { 'clip-path': 'url(#mapclip)' }, G.map);
  G.mapPath = el('path', { d: '', fill: 'none', stroke: '#4aa3ff', 'stroke-width': 9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, el('g', { transform: 'translate(760 505)' }, clipped));
  el('circle', { cx: 760, cy: 445, r: 130, fill: 'none', stroke: '#e9eef2', 'stroke-width': 2.5 }, G.map);
  G.ring = el('path', { d: '', fill: 'none', stroke: '#f0b429', 'stroke-width': 9, 'stroke-linecap': 'round' }, G.map);
  el('path', { d: 'M 760 470 L 771 502 L 760 495 L 749 502 Z', fill: '#7dffb0', stroke: '#000', 'stroke-width': 1.5 }, G.map);
  G.arrow = el('g', { transform: 'translate(588 440) scale(0.95)' }, G.map);
  G.dist = txt(main, 760, 625, 30, 'middle', '', '', 600); G.dist.style.fill = '#7dffb0';

  // corner dials: compass (left) and clock (right)
  const cg = smallDial(svg, 92, 690, 0.62);
  G.card = el('g', { class: 'needle' }, cg);
  for (let a = 0; a < 360; a += 30) { const maj = a % 90 === 0, [x0, y0] = polar(a, maj ? 66 : 76), [x1, y1] = polar(a, 86); el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: maj ? '#fff' : '#6b7782', 'stroke-width': maj ? 3 : 1.5 }, G.card); }
  el('path', { d: 'M -9 -50 L 9 -50 L 0 -80 Z', fill: '#ff5a4d' }, G.card);
  el('path', { d: 'M -10 -98 L 10 -98 L 0 -84 Z', fill: '#7dffb0' }, cg);
  const kg = smallDial(svg, 1428, 690, 0.62);
  for (let h = 0; h < 12; h++) { const [x0, y0] = polar(h * 30, h % 3 === 0 ? 66 : 76), [x1, y1] = polar(h * 30, 86); el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: h % 3 === 0 ? '#fff' : '#6b7782', 'stroke-width': h % 3 === 0 ? 3 : 1.5 }, kg); }
  G.hour = needle(kg, 46, '#fff', 6); G.min = needle(kg, 70, '#c7ced4', 4);
  el('circle', { r: 5, fill: '#8a949e' }, kg);

  // bottom row
  G.dir = txt(svg, 250, 762, 44, 'middle', '–', 'num', 600);
  G.clockTxt = txt(svg, 405, 762, 44, 'middle', '--:--', 'num', 500);
  G.elapsed = txt(svg, 1115, 762, 44, 'middle', '0:00', 'num', 500);
  G.rem = txt(svg, 1275, 762, 30, 'middle', '', 'num');
  built = true;
}

// ---------- settings ----------
const savePrefs = () => localStorage.setItem('hud-prefs', JSON.stringify({ unit, mirror, voice: voiceOn, numbers: showNums }));
function syncOpts() {
  document.querySelectorAll('[data-unit]').forEach(b => b.classList.toggle('on', b.dataset.unit === unit));
  for (const [id, on, label] of [['mirror', mirror, 'Mirror'], ['voice', voiceOn, 'Voice'], ['numbers', showNums, 'Numbers']]) {
    $(id).textContent = `${label}: ${on ? 'on' : 'off'}`; $(id).classList.toggle('on', on);
  }
  $('face').classList.toggle('mirror', mirror);
  if (built) $('cluster').classList.toggle('nonum', !showNums);
}
document.querySelectorAll('[data-unit]').forEach(b => b.addEventListener('click', () => { unit = b.dataset.unit; savePrefs(); syncOpts(); if (built) { buildCluster(); render(); } }));
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
  if (a.icon === 'arrive') return '<circle r="30" fill="none" stroke="#7dffb0" stroke-width="8"/><circle r="12" fill="#7dffb0"/>';
  const head = `<g transform="rotate(${a.rotation})"><path d="M 0 -42 L 26 -8 L 10 -8 L 10 40 L -10 40 L -10 -8 L -26 -8 Z" fill="#ffffff"/></g>`;
  return a.icon === 'roundabout' ? `<circle r="46" fill="none" stroke="#3a444d" stroke-width="5"/>${head}` : head;
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

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function renderNav() {
  const on = !!(route && navState);
  G.car.style.display = on ? 'none' : ''; G.map.style.display = on ? '' : 'none';
  if (!on) { G.dist.textContent = ''; return; }
  const { fix, loc, up } = navState;
  const hd = heading != null ? heading : segmentBearing(route, loc.index);
  const pts = mapPoints(route, fix, hd, loc.index, 150 + Math.min(speedMs || 0, 30) * 10, 118);
  G.mapPath.setAttribute('d', pts.map((p, i) => `${i ? 'L' : 'M'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' '));
  const frac = 1 - Math.min(up.distance, 500) / 500;
  G.ring.setAttribute('d', frac > 0.01 ? ell(760, 445, -135, -135 + frac * 270, 138, 138) : '');
  G.arrow.innerHTML = arrowSvg(arrowFor(up.step));
  G.title.textContent = clip(instructionText(up.step), 40);
  G.sub.textContent = '';
  G.dist.textContent = `${fmtDist(up.distance, unit)}  ·  ${fmtDist(up.remaining, unit)} to go`;
}

// ---------- render ----------
let unwrapped = 0, prevHeading = 0;
function render() {
  if (!built) return;
  const { max } = bandScale(unit);
  const st = trip.stats;
  const sp = speedIn(speedMs, unit) || 0, avg = speedIn(st.avg, unit) || 0, top = speedIn(st.top, unit) || 0;
  setBand(G.left, sp, max); setBand(G.right, avg, max); setMarker(G.left, top, max);
  G.speed.textContent = Math.round(sp); G.avg.textContent = Math.round(avg);
  G.trip.textContent = `${distanceIn(st.distance, unit).toFixed(1)} ${unit === 'mph' ? 'mi' : 'km'}`; G.top.textContent = Math.round(top);
  G.elapsed.textContent = fmtDuration(st.elapsed);
  G.dir.textContent = compass(heading);
  const now = new Date(), c = clockAngles(now);
  G.clockTxt.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  rot(G.hour, c.hour); rot(G.min, c.minute);
  if (heading != null) { const diff = ((heading - prevHeading + 540) % 360) - 180; unwrapped += diff; prevHeading = heading; rot(G.card, -unwrapped); }
  renderNav();
  const gps = !lastFixAt ? 'Waiting for GPS…' : Date.now() - lastFixAt > 5000 ? 'GPS signal lost' : '';
  if (!(route && navState)) { G.title.textContent = gps || navMsg || (dest ? 'Planning route…' : ''); G.sub.textContent = ''; }
  else if (gps || navMsg) G.sub.textContent = gps || navMsg;
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
