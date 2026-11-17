import { createTrip, speedIn, gaugeAngle, ticks, dialMax, clockAngles, SWEEP_START, SWEEP_END } from './hud.js';

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const prefs = JSON.parse(localStorage.getItem('hud-prefs') || '{}');
let unit = prefs.unit || 'mph';
let mirror = !!prefs.mirror;
const trip = createTrip();
let watchId = null, wakeLock = null, heading = null, speedMs = null, lastFixAt = 0, built = false;

const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
};
const polar = (deg, r) => [r * Math.sin((deg * Math.PI) / 180), -r * Math.cos((deg * Math.PI) / 180)];
const arcPath = (a0, a1, r) => {
  const [x0, y0] = polar(a0, r), [x1, y1] = polar(a1, r);
  return `M ${x0} ${y0} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
};
const needle = (svg, len, color, width) => {
  const g = el('g', { class: 'needle' }, svg);
  el('line', { x1: 0, y1: 8, x2: 0, y2: -len, stroke: color, 'stroke-width': width, 'stroke-linecap': 'round' }, g);
  return g;
};
const rot = (g, deg) => { g.style.transform = `rotate(${deg}deg)`; };

let speedoNeedle, speedoArc, topMark, compassCard, hourHand, minuteHand;

function buildSpeedo() {
  const svg = $('speedo'); svg.innerHTML = '';
  const max = dialMax(unit);
  el('path', { d: arcPath(SWEEP_START, SWEEP_END, 86), fill: 'none', stroke: '#1b2229', 'stroke-width': 10, 'stroke-linecap': 'round' }, svg);
  speedoArc = el('path', { d: arcPath(SWEEP_START, SWEEP_START + 0.01, 86), fill: 'none', stroke: '#7dffb0', 'stroke-width': 10, 'stroke-linecap': 'round' }, svg);
  const step = unit === 'kmh' ? 10 : 5;
  ticks(max, step, 2).forEach(t => {
    const [x0, y0] = polar(t.angle, t.major ? 66 : 72), [x1, y1] = polar(t.angle, 78);
    el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: t.major ? '#e6ebef' : '#6b7782', 'stroke-width': t.major ? 2.4 : 1.2 }, svg);
  });
  topMark = el('path', { d: 'M -4 -92 L 4 -92 L 0 -84 Z', fill: '#f0b429' }, svg);
  topMark.style.transformOrigin = '0 0'; topMark.style.transition = 'transform 0.35s';
  speedoNeedle = needle(svg, 70, '#ffffff', 3.2);
  el('circle', { r: 6, fill: '#ffffff' }, svg);
}

function buildCompass() {
  const svg = $('compass'); svg.innerHTML = '';
  el('circle', { r: 92, fill: 'none', stroke: '#1b2229', 'stroke-width': 8 }, svg);
  compassCard = el('g', { class: 'needle' }, svg);
  for (let a = 0; a < 360; a += 15) {
    const major = a % 90 === 0;
    const [x0, y0] = polar(a, major ? 70 : 78), [x1, y1] = polar(a, 86);
    el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: major ? '#e6ebef' : '#6b7782', 'stroke-width': major ? 2.6 : 1.2 }, compassCard);
  }
  el('path', { d: 'M -7 -58 L 7 -58 L 0 -84 Z', fill: '#ff5a4d' }, compassCard); // north
  // fixed pointer: the direction you are travelling
  el('path', { d: 'M -8 -96 L 8 -96 L 0 -84 Z', fill: '#7dffb0' }, svg);
  el('circle', { r: 4, fill: '#8a949e' }, svg);
}

function buildClock() {
  const svg = $('clock'); svg.innerHTML = '';
  el('circle', { r: 92, fill: 'none', stroke: '#1b2229', 'stroke-width': 8 }, svg);
  for (let h = 0; h < 12; h++) {
    const [x0, y0] = polar(h * 30, h % 3 === 0 ? 70 : 78), [x1, y1] = polar(h * 30, 86);
    el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: h % 3 === 0 ? '#e6ebef' : '#6b7782', 'stroke-width': h % 3 === 0 ? 2.6 : 1.4 }, svg);
  }
  hourHand = needle(svg, 46, '#e6ebef', 5);
  minuteHand = needle(svg, 70, '#c7ced4', 3);
  el('circle', { r: 4, fill: '#8a949e' }, svg);
}

function build() { buildSpeedo(); buildCompass(); buildClock(); built = true; }

const savePrefs = () => localStorage.setItem('hud-prefs', JSON.stringify({ unit, mirror }));
function syncOpts() {
  document.querySelectorAll('[data-unit]').forEach(b => b.classList.toggle('on', b.dataset.unit === unit));
  $('mirror').textContent = `Mirror: ${mirror ? 'on' : 'off'}`;
  $('mirror').classList.toggle('on', mirror);
  $('face').classList.toggle('mirror', mirror);
}
document.querySelectorAll('[data-unit]').forEach(b => b.addEventListener('click', () => { unit = b.dataset.unit; savePrefs(); syncOpts(); if (built) { buildSpeedo(); render(); } }));
$('mirror').addEventListener('click', () => { mirror = !mirror; savePrefs(); syncOpts(); });

let unwrapped = 0, prevHeading = 0; // keep the compass from spinning the long way round at 359 -> 0
function render() {
  if (!built) return;
  const max = dialMax(unit);
  const sp = speedIn(speedMs, unit) || 0;
  const a = gaugeAngle(sp, max);
  rot(speedoNeedle, a);
  speedoArc.setAttribute('d', arcPath(SWEEP_START, Math.max(a, SWEEP_START + 0.01), 86));
  rot(topMark, gaugeAngle(speedIn(trip.stats.top, unit) || 0, max));
  if (heading != null) {
    let diff = ((heading - prevHeading + 540) % 360) - 180;
    unwrapped += diff; prevHeading = heading;
    rot(compassCard, -unwrapped);
  }
  const c = clockAngles(new Date());
  rot(hourHand, c.hour); rot(minuteHand, c.minute);
  $('status').textContent = !lastFixAt ? 'Waiting for GPS…' : Date.now() - lastFixAt > 5000 ? 'GPS signal lost' : '';
}

async function keepAwake() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not critical */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !$('hud').hidden) keepAwake(); });

$('go').addEventListener('click', () => {
  if (!('geolocation' in navigator)) { alert('This browser has no GPS access.'); return; }
  $('start').hidden = true; $('hud').hidden = false;
  syncOpts(); build(); render(); keepAwake();
  watchId = navigator.geolocation.watchPosition(p => {
    lastFixAt = Date.now();
    speedMs = p.coords.speed;
    if (p.coords.heading != null && !Number.isNaN(p.coords.heading) && (p.coords.speed || 0) > 1) heading = p.coords.heading;
    trip.add({ lat: p.coords.latitude, lon: p.coords.longitude, time: p.timestamp, accuracy: p.coords.accuracy, speed: p.coords.speed });
    render();
  }, err => { $('status').textContent = err.code === 1 ? 'Location permission denied' : 'GPS error: ' + err.message; },
  { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  setInterval(render, 1000);
});
$('reset').addEventListener('click', () => { trip.reset(); render(); });
$('stop').addEventListener('click', () => { if (watchId != null) navigator.geolocation.clearWatch(watchId); if (wakeLock) wakeLock.release(); location.reload(); });
syncOpts();
