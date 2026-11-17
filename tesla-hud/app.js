import { createTrip, speedIn, distanceIn, compass, fmtDuration } from './hud.js';

const $ = id => document.getElementById(id);
const prefs = JSON.parse(localStorage.getItem('hud-prefs') || '{}');
let unit = prefs.unit || 'mph';
let mirror = !!prefs.mirror;
const trip = createTrip();
let watchId = null, wakeLock = null, heading = null, speedMs = null, lastFixAt = 0;

const savePrefs = () => localStorage.setItem('hud-prefs', JSON.stringify({ unit, mirror }));
function syncOpts() {
  document.querySelectorAll('[data-unit]').forEach(b => b.classList.toggle('on', b.dataset.unit === unit));
  $('mirror').textContent = `Mirror: ${mirror ? 'on' : 'off'}`;
  $('mirror').classList.toggle('on', mirror);
  $('face').classList.toggle('mirror', mirror);
  $('unit').textContent = unit === 'mph' ? 'mph' : 'km/h';
  $('dunit').textContent = unit === 'mph' ? 'mi' : 'km';
}
document.querySelectorAll('[data-unit]').forEach(b => b.addEventListener('click', () => { unit = b.dataset.unit; savePrefs(); syncOpts(); }));
$('mirror').addEventListener('click', () => { mirror = !mirror; savePrefs(); syncOpts(); });

function render() {
  const st = trip.stats;
  const sp = speedIn(speedMs, unit);
  $('speed').textContent = sp == null ? '–' : Math.round(sp);
  $('dist').textContent = distanceIn(st.distance, unit).toFixed(1);
  $('avg').textContent = Math.round(speedIn(st.avg, unit) || 0);
  $('top').textContent = Math.round(speedIn(st.top, unit) || 0);
  $('elapsed').textContent = fmtDuration(st.elapsed);
  $('dir').textContent = compass(heading);
  $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const stale = Date.now() - lastFixAt > 5000;
  if (!lastFixAt) $('status').textContent = 'Waiting for GPS…';
  else $('status').textContent = stale ? 'GPS signal lost' : '';
}

async function keepAwake() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not critical */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !$('hud').hidden) keepAwake(); });

$('go').addEventListener('click', () => {
  if (!('geolocation' in navigator)) { alert('This browser has no GPS access.'); return; }
  $('start').hidden = true; $('hud').hidden = false;
  syncOpts(); keepAwake();
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
