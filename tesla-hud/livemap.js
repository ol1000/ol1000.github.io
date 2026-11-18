// Live map behind the HUD: OpenStreetMap tiles (darkened in CSS), heading-up, no library.
// Pure maths first (testable), then a small DOM controller.
export const TILE = 256;

/** Web Mercator pixel position of a lat/lon at zoom z. */
export function worldPx(lat, lon, z) {
  const s = TILE * 2 ** z, r = (lat * Math.PI) / 180;
  return { x: ((lon + 180) / 360) * s, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * s };
}

/** Closer in when slow, wider when fast. Speed in m/s. */
export function zoomFor(speedMs) {
  const s = Number.isFinite(speedMs) ? speedMs : 0;
  return s < 6 ? 17 : s < 16 ? 16 : s < 28 ? 15 : 14;
}

/** Tile indices covering a square of half-size `radius` px around (px, py), with y clipped to the map. */
export function tilesNeeded(px, py, radius, z, margin = 0) {
  const n = 2 ** z, out = [];
  const x0 = Math.floor((px - radius) / TILE) - margin, x1 = Math.floor((px + radius) / TILE) + margin;
  const y0 = Math.max(0, Math.floor((py - radius) / TILE) - margin), y1 = Math.min(n - 1, Math.floor((py + radius) / TILE) + margin);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ x, y, wx: ((x % n) + n) % n });
  return out;
}

const SVGNS = 'http://www.w3.org/2000/svg';
const tileUrl = (z, wx, y) => `https://tile.openstreetmap.org/${z}/${wx}/${y}.png`;

export function createLiveMap({ root, routeColor = '#2ee6ff' }) {
  const pivot = document.createElement('div'); pivot.className = 'map-pivot';
  const world = document.createElement('div'); world.className = 'map-world';
  const svg = document.createElementNS(SVGNS, 'svg'); svg.setAttribute('class', 'map-route');
  const glow = document.createElementNS(SVGNS, 'polyline'), line = document.createElementNS(SVGNS, 'polyline');
  for (const [p, w, o] of [[glow, 16, 0.35], [line, 7, 0.95]]) { p.setAttribute('fill', 'none'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round'); p.setAttribute('stroke-width', w); p.setAttribute('opacity', o); svg.appendChild(p); }
  svg.style.overflow = 'visible';
  world.appendChild(svg); pivot.appendChild(world); root.appendChild(pivot);
  const car = document.createElement('div'); car.className = 'map-car'; car.innerHTML = '<svg viewBox="-20 -24 40 48"><path d="M0 -22 L16 20 L0 11 L-16 20 Z" fill="#fff" stroke="#000" stroke-opacity=".5" stroke-width="2"/></svg>';
  pivot.appendChild(car);
  const attr = document.createElement('div'); attr.className = 'map-attr'; attr.textContent = '© OpenStreetMap contributors'; root.appendChild(attr);
  line.setAttribute('stroke', routeColor); glow.setAttribute('stroke', routeColor);

  const tiles = new Map();
  let z = 17, ox = 0, oy = 0, anchored = false, rot = 0, lastHeading = 0, wantZ = 17, wantCount = 0, routeRef = null, shown = false;

  function reanchor(px, py) {
    for (const t of tiles.values()) t.remove(); tiles.clear();
    ox = Math.round(px); oy = Math.round(py); anchored = true; drawRoute(true);
  }
  function drawRoute(force) {
    if (!routeRef) { line.setAttribute('points', ''); glow.setAttribute('points', ''); return; }
    if (!force && line.dataset.z === String(z) && line.dataset.r === routeRef.id) return;
    const pts = []; let lx = -1e9, ly = -1e9;
    for (const c of routeRef.coords) {
      const p = worldPx(c.lat, c.lon, z), x = p.x - ox, y = p.y - oy;
      if (Math.abs(x - lx) + Math.abs(y - ly) < 6) continue; // thin out points that land on the same pixels
      lx = x; ly = y; pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    line.setAttribute('points', pts.join(' ')); glow.setAttribute('points', pts.join(' '));
    line.dataset.z = String(z); line.dataset.r = routeRef.id;
  }
  function fillTiles(px, py) {
    const rect = root.getBoundingClientRect(), rad = Math.hypot(rect.width, rect.height) * 0.62 + 40;
    const need = tilesNeeded(px, py, rad, z), keep = new Set(tilesNeeded(px, py, rad, z, 1).map(t => `${z}/${t.x}/${t.y}`));
    for (const t of need) {
      const key = `${z}/${t.x}/${t.y}`; if (tiles.has(key)) continue;
      const img = document.createElement('img');
      img.className = 'map-tile'; img.alt = ''; img.draggable = false; img.decoding = 'async';
      img.style.left = `${t.x * TILE - ox}px`; img.style.top = `${t.y * TILE - oy}px`;
      img.onerror = () => { img.style.visibility = 'hidden'; };
      img.src = tileUrl(z, t.wx, t.y);
      world.insertBefore(img, svg); tiles.set(key, img);
    }
    for (const [k, img] of tiles) if (!keep.has(k)) { img.remove(); tiles.delete(k); }
  }

  return {
    setRoute(route) { routeRef = route ? { coords: route.coords, id: String(route.coords.length) + ':' + route.total } : null; if (anchored) drawRoute(true); },
    update({ lat, lon, heading, speedMs }) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      // zoom changes need a few agreeing readings so it does not flutter around the speed thresholds
      const dz = zoomFor(speedMs);
      if (dz === wantZ) wantCount++; else { wantZ = dz; wantCount = 1; }
      let rebuilt = false;
      if (!anchored || (wantZ !== z && wantCount >= 3)) { z = wantZ; anchored = false; }
      const p = worldPx(lat, lon, z);
      if (!anchored || Math.abs(p.x - ox) > 1500 || Math.abs(p.y - oy) > 1500) { reanchor(p.x, p.y); rebuilt = true; }
      fillTiles(p.x, p.y);
      if (Number.isFinite(heading)) { const d = ((heading - lastHeading + 540) % 360) - 180; rot += d; lastHeading = heading; }
      world.style.transition = rebuilt || !shown ? 'none' : '';
      world.style.transform = `rotate(${(-rot).toFixed(1)}deg) translate(${(-(p.x - ox)).toFixed(1)}px, ${(-(p.y - oy)).toFixed(1)}px)`;
      if (rebuilt || !shown) { void world.offsetWidth; world.style.transition = ''; }
      if (!shown) { shown = true; root.classList.add('ready'); }
    }
  };
}
