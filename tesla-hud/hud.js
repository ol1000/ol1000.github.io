// Pure helpers for the HUD. No DOM.
export const MS_TO_MPH = 2.236936;
export const MS_TO_KMH = 3.6;
const R = 6371000; // earth radius, metres

export function haversine(a, b) {
  const rad = d => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const speedIn = (ms, unit) => (ms == null || ms < 0 ? null : ms * (unit === 'kmh' ? MS_TO_KMH : MS_TO_MPH));
export const distanceIn = (m, unit) => m / (unit === 'kmh' ? 1000 : 1609.344);

export function compass(deg) {
  if (deg == null || Number.isNaN(deg)) return '–';
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

export function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Trip tracker fed with GPS fixes. Ignores poor-accuracy fixes and jitter while stopped,
 * so distance doesn't creep up at traffic lights.
 */
export function createTrip({ maxAccuracy = 30, minMove = 5 } = {}) {
  let last = null, distance = 0, moving = 0, top = 0, startedAt = null, elapsed = 0;
  return {
    add(fix) {
      if (fix.accuracy != null && fix.accuracy > maxAccuracy) return;
      if (startedAt == null) startedAt = fix.time;
      elapsed = (fix.time - startedAt) / 1000;
      if (last) {
        const d = haversine(last, fix);
        const dt = (fix.time - last.time) / 1000;
        if (d >= minMove) {
          distance += d;
          moving += dt;
        } else return; // keep `last` so slow drift can't be missed, but don't count jitter
      }
      last = fix;
      if (fix.speed != null && fix.speed > top) top = fix.speed;
    },
    reset() { last = null; distance = 0; moving = 0; top = 0; startedAt = null; elapsed = 0; },
    get stats() { return { distance, elapsed, moving, top, avg: moving > 0 ? distance / moving : 0 }; }
  };
}
