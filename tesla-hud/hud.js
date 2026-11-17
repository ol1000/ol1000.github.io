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

// ---- dial geometry (angles in degrees, 0 = straight up, clockwise) ----
export const SWEEP_START = -135, SWEEP_END = 135;
export const dialMax = unit => (unit === 'kmh' ? 160 : 100);

/** Needle angle for a value on a 270-degree gauge, clamped to the scale. */
export function gaugeAngle(value, max) {
  const v = Math.min(Math.max(Number(value) || 0, 0), max);
  return SWEEP_START + (v / max) * (SWEEP_END - SWEEP_START);
}

/** Tick marks every `step` units; every `major` steps is a long one. */
export function ticks(max, step, major) {
  const out = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push({ value: v, angle: gaugeAngle(v, max), major: Math.round(v / step) % major === 0 });
  return out;
}

export function clockAngles(date) {
  const m = date.getMinutes(), s = date.getSeconds(), h = date.getHours() % 12;
  return { hour: (h + m / 60) * 30, minute: (m + s / 60) * 6 };
}

// ---- cluster gauges: a swept band on the left (side -1) or right (side +1), 0 at the bottom, max at the top ----
export const BAND_START = 160, BAND_SPAN = 148;
export function bandAngle(frac, side) {
  const f = Math.min(Math.max(Number(frac) || 0, 0), 1);
  return side < 0 ? -BAND_START + f * BAND_SPAN : BAND_START - f * BAND_SPAN;
}
/** Scale max and label step for a unit. */
export const bandScale = unit => (unit === 'kmh' ? { max: 160, label: 20, minor: 10 } : { max: 100, label: 20, minor: 10 });

// ---- colour ----
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
/** Colour at position t (0..1) along a list of hex stops. */
export function lerpColor(stops, t) {
  const f = Math.min(Math.max(Number(t) || 0, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(f), stops.length - 2), u = f - i;
  const a = hex(stops[i]), b = hex(stops[i + 1]);
  return '#' + a.map((v, k) => Math.round(v + (b[k] - v) * u).toString(16).padStart(2, '0')).join('');
}

/** Move `current` toward `target` by exponential smoothing; snaps when close. */
export function ease(current, target, k = 0.2) {
  const d = target - current;
  return Math.abs(d) < 0.02 ? target : current + d * k;
}

/** Split text into at most two lines of `n` characters, breaking at spaces. */
export function twoLines(text, n) {
  const words = String(text).split(' ');
  const lines = ['', ''];
  let l = 0;
  for (const w of words) {
    if ((lines[l] + ' ' + w).trim().length > n && l === 0) l = 1;
    lines[l] = (lines[l] + ' ' + w).trim();
  }
  if (lines[1].length > n) lines[1] = lines[1].slice(0, n - 1) + '…';
  return lines;
}
