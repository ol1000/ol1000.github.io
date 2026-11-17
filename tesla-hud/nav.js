// Navigation logic: routing, progress along a route, turn instructions and the round map. No DOM.
import { haversine } from './hud.js';

const R = 6371000;
const rad = d => (d * Math.PI) / 180;
const GEOCODE = 'https://nominatim.openstreetmap.org/search';
const ROUTE = 'https://router.project-osrm.org/route/v1/driving';

export async function geocode(query) {
  const res = await fetch(`${GEOCODE}?${new URLSearchParams({ q: query, format: 'jsonv2', limit: '5' })}`);
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  return (await res.json()).map(r => ({ name: r.display_name, lat: Number(r.lat), lon: Number(r.lon) }));
}

export async function fetchRoute(from, to) {
  const url = `${ROUTE}/${from.lon},${from.lat};${to.lon},${to.lat}?steps=true&geometries=geojson&overview=full`;
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.code !== 'Ok' || !json.routes || !json.routes.length) throw new Error(json.message || json.code || `Routing failed (${res.status})`);
  return buildRoute(json.routes[0]);
}

/** Turn an OSRM route into coords with cumulative distance and a flat step list with start offsets. */
export function buildRoute(r) {
  const coords = r.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
  const steps = [];
  let start = 0;
  for (const leg of r.legs) for (const s of leg.steps) {
    steps.push({ startAlong: start, distance: s.distance, type: s.maneuver.type, modifier: s.maneuver.modifier || null, exit: s.maneuver.exit || null, name: s.name || '' });
    start += s.distance;
  }
  return { coords, cum, total: cum[cum.length - 1], steps };
}

/** Metres east/north of origin (good for a few km). */
export function project(origin, p) {
  return { x: rad(p.lon - origin.lon) * Math.cos(rad(origin.lat)) * R, y: rad(p.lat - origin.lat) * R };
}

/**
 * Where is `pos` on the route? Searches a window from `hint` so a route that doubles back
 * can't snap you to the wrong stretch. Returns progress along the route and distance off it.
 */
export function locate(route, pos, hint = 0) {
  const n = route.coords.length;
  const scan = (from, to) => {
    let best = { dist: Infinity, index: from, along: 0 };
    for (let i = from; i < to; i++) {
      const a = project(pos, route.coords[i]), b = project(pos, route.coords[i + 1]);
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.min(1, Math.max(0, (-a.x * dx + -a.y * dy) / len2)) : 0;
      const dist = Math.hypot(a.x + t * dx, a.y + t * dy);
      if (dist < best.dist) best = { dist, index: i, along: route.cum[i] + t * (route.cum[i + 1] - route.cum[i]) };
    }
    return best;
  };
  const from = Math.max(0, hint - 3), to = Math.min(n - 1, hint + 400);
  let best = scan(from, to);
  // Far from the windowed match (GPS gap, tunnel): rescan everything before calling it off route.
  if (best.dist > 150 && (from > 0 || to < n - 1)) { const all = scan(0, n - 1); if (all.dist < best.dist) best = all; }
  return { index: best.index, along: best.along, offRoute: best.dist };
}

/** The next manoeuvre ahead of `along` and how far away it is. */
export function upcoming(route, along) {
  const k = route.steps.findIndex(s => s.startAlong > along + 1);
  const step = k === -1 ? route.steps[route.steps.length - 1] : route.steps[k];
  return { step, distance: Math.max(0, (k === -1 ? route.total : step.startAlong) - along), remaining: Math.max(0, route.total - along) };
}

const ANGLE = { uturn: 180, 'sharp right': 135, right: 90, 'slight right': 35, straight: 0, 'slight left': -35, left: -90, 'sharp left': -135 };
const ROUNDABOUT = ['roundabout', 'rotary', 'roundabout turn', 'exit roundabout', 'exit rotary'];

/** What to draw for a manoeuvre. */
export function arrowFor(step) {
  if (step.type === 'arrive') return { icon: 'arrive', rotation: 0 };
  if (ROUNDABOUT.includes(step.type)) return { icon: 'roundabout', rotation: ANGLE[step.modifier] ?? 0, exit: step.exit };
  return { icon: 'arrow', rotation: ANGLE[step.modifier] ?? 0 };
}

const ordinal = n => ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'][n] || `${n}th`;

export function instructionText(step) {
  const onto = step.name ? ` onto ${step.name}` : '';
  const dir = step.modifier || 'straight';
  if (step.type === 'arrive') return 'You have arrived';
  if (step.type === 'depart') return `Head ${step.name ? 'along ' + step.name : 'off'}`;
  if (ROUNDABOUT.includes(step.type)) return `At the roundabout take the ${ordinal(step.exit || 1)} exit${onto}`;
  if (step.type === 'fork') return `Keep ${dir.includes('left') ? 'left' : 'right'} at the fork${onto}`;
  if (step.type === 'merge') return `Merge${onto}`;
  if (step.type === 'off ramp') return `Take the exit${onto}`;
  if (dir === 'straight') return `Continue straight${onto}`;
  if (dir === 'uturn') return 'Make a U-turn';
  return `Turn ${dir}${onto}`;
}

export function fmtDist(m, unit) {
  if (unit === 'kmh') return m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`;
  return m < 160 ? `${Math.max(10, Math.round((m * 1.09361) / 10) * 10)} yd` : `${(m / 1609.344).toFixed(1)} mi`;
}

/**
 * Route points for the round map, heading-up, in SVG units (centre 0,0; radius `r`).
 * `radiusM` is how many metres the dial edge represents.
 */
export function mapPoints(route, pos, headingDeg, index, radiusM, r = 80) {
  const th = rad(headingDeg || 0), c = Math.cos(th), s = Math.sin(th), k = r / radiusM;
  const pts = [];
  const from = Math.max(0, index - 10);
  for (let i = from; i < route.coords.length; i++) {
    const p = project(pos, route.coords[i]);
    const x = p.x * c - p.y * s, y = p.x * s + p.y * c;
    pts.push([x * k, -y * k]);
    if (i > index + 1 && Math.hypot(p.x, p.y) > radiusM * 3) break;
  }
  return pts;
}

/** Bearing in degrees (clockwise from north) of route segment `i`. */
export function segmentBearing(route, i) {
  const a = route.coords[Math.min(i, route.coords.length - 2)], b = route.coords[Math.min(i + 1, route.coords.length - 1)];
  const p = project(a, b);
  return ((Math.atan2(p.x, p.y) * 180) / Math.PI + 360) % 360;
}
