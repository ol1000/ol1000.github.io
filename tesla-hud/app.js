import { createTrip, speedIn, gaugeAngle, ticks, dialMax, clockAngles, SWEEP_START, SWEEP_END } from './hud.js';
import { geocode, fetchRoute, locate, upcoming, arrowFor, instructionText, fmtDist, mapPoints, segmentBearing } from './nav.js';

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const prefs = JSON.parse(localStorage.getItem('hud-prefs') || '{}');
let unit = prefs.unit || 'mph';
let voiceOn = prefs.voice !== false;
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

const savePrefs = () => localStorage.setItem('hud-prefs', JSON.stringify({ unit, mirror, voice: voiceOn }));
function syncOpts() {
  document.querySelectorAll('[data-unit]').forEach(b => b.classList.toggle('on', b.dataset.unit === unit));
  $('mirror').textContent = `Mirror: ${mirror ? 'on' : 'off'}`;
  $('mirror').classList.toggle('on', mirror);
  $('voice').textContent = `Voice: ${voiceOn ? 'on' : 'off'}`;
  $('voice').classList.toggle('on', voiceOn);
  $('face').classList.toggle('mirror', mirror);
}
document.querySelectorAll('[data-unit]').forEach(b => b.addEventListener('click', () => { unit = b.dataset.unit; savePrefs(); syncOpts(); if (built) { buildSpeedo(); render(); } }));
$('voice').addEventListener('click', () => { voiceOn = !voiceOn; savePrefs(); syncOpts(); });
$('mirror').addEventListener('click', () => { mirror = !mirror; savePrefs(); syncOpts(); });


// ---------------- satnav ----------------
let dest = null, route = null, hint = 0, offCount = 0, planning = false, lastPlan = 0, navState = null, announced = {}, navMsg = '';
let mapPath, mapRing, mapGroup;

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

function buildMap() {
  const svg = $('navmap'); svg.innerHTML = '';
  const defs = el('defs', {}, svg);
  el('circle', { r: 86, id: 'clipc' }, el('clipPath', { id: 'mapclip' }, defs));
  el('circle', { r: 86, fill: '#0b0f12' }, svg);
  const clipped = el('g', { 'clip-path': 'url(#mapclip)' }, svg);
  mapGroup = el('g', { transform: 'translate(0 30)' }, clipped);
  mapPath = el('path', { d: '', fill: 'none', stroke: '#4aa3ff', 'stroke-width': 7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, mapGroup);
  el('circle', { r: 92, fill: 'none', stroke: '#1b2229', 'stroke-width': 8 }, svg);
  mapRing = el('path', { d: '', fill: 'none', stroke: '#f0b429', 'stroke-width': 8, 'stroke-linecap': 'round' }, svg);
  el('path', { d: 'M 0 18 L 9 42 L 0 36 L -9 42 Z', fill: '#7dffb0', stroke: '#000', 'stroke-width': 1.5 }, svg); // you
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

function renderNav() {
  const on = !!(route && navState);
  $('face').classList.toggle('nav', on);
  $('navmap').hidden = !on; $('compass').hidden = on; $('navtext').hidden = !on;
  if (!on) return;
  if (!mapPath || !mapPath.isConnected) buildMap();
  const { fix, loc, up } = navState;
  const hd = heading != null ? heading : segmentBearing(route, loc.index);
  const radiusM = 150 + Math.min(speedMs || 0, 30) * 10;
  const pts = mapPoints(route, fix, hd, loc.index, radiusM, 80);
  mapPath.setAttribute('d', pts.map((p, i) => `${i ? 'L' : 'M'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' '));
  const frac = 1 - Math.min(up.distance, 500) / 500;
  mapRing.setAttribute('d', frac > 0.01 ? arcPath(-135, -135 + frac * 270, 92) : '');
  $('navarrow').innerHTML = arrowSvg(arrowFor(up.step));
  $('navinstr').textContent = instructionText(up.step);
  $('navdist').textContent = `${fmtDist(up.distance, unit)}  ·  ${fmtDist(up.remaining, unit)} to go`;
}

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
  renderNav();
  $('status').textContent = !lastFixAt ? 'Waiting for GPS…' : Date.now() - lastFixAt > 5000 ? 'GPS signal lost' : navMsg;
}

async function keepAwake() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not critical */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !$('hud').hidden) keepAwake(); });

$('go').addEventListener('click', () => {
  if (!('geolocation' in navigator)) { alert('This browser has no GPS access.'); return; }
  $('start').hidden = true; $('hud').hidden = false;
  syncOpts(); build(); render(); keepAwake();
  if (voiceOn && 'speechSynthesis' in window) { try { window.speechSynthesis.speak(new SpeechSynthesisUtterance(' ')); } catch { /* unlock audio on iOS */ } }
  watchId = navigator.geolocation.watchPosition(p => {
    lastFixAt = Date.now();
    speedMs = p.coords.speed;
    if (p.coords.heading != null && !Number.isNaN(p.coords.heading) && (p.coords.speed || 0) > 1) heading = p.coords.heading;
    navUpdate({ lat: p.coords.latitude, lon: p.coords.longitude });
    trip.add({ lat: p.coords.latitude, lon: p.coords.longitude, time: p.timestamp, accuracy: p.coords.accuracy, speed: p.coords.speed });
    render();
  }, err => { $('status').textContent = err.code === 1 ? 'Location permission denied' : 'GPS error: ' + err.message; },
  { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  setInterval(render, 1000);
});
$('reset').addEventListener('click', () => { trip.reset(); render(); });
$('stop').addEventListener('click', () => { if (watchId != null) navigator.geolocation.clearWatch(watchId); if (wakeLock) wakeLock.release(); location.reload(); });
syncOpts();
