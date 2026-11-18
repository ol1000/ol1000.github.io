// Tesla data for the HUD: a small client for the tesla-remote server plus the maths built on it. No DOM.

/** Returns an error message if the server address can't work from this page, else null. */
export function validateBase(base, pageProtocol) {
  let u;
  try { u = new URL(base); } catch { return 'Enter the full address, e.g. https://name.tailnet.ts.net'; }
  if (!/^https?:$/.test(u.protocol)) return 'Address must start with https://';
  if (pageProtocol === 'https:' && u.protocol === 'http:' && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname))
    return 'This page is https, so the server address must be https too (see the Tailscale steps).';
  return null;
}

/** Miles per kWh since the trip began, from the battery drop. Needs a drop of at least 2 points to mean anything. */
export function liveEfficiency(startPct, nowPct, miles, batteryKwh) {
  const drop = Number(startPct) - Number(nowPct);
  if (!(drop >= 2) || !(miles > 0) || !(batteryKwh > 0)) return null;
  return miles / ((drop / 100) * batteryKwh);
}

/**
 * Battery % left on arrival. `factor` scales the rated range down to what you will really get
 * (0.85 is a cautious default; pass real-world/rated once you have a live efficiency).
 */
export function arrivalPct({ batteryPct, rangeMi, remainingMi, factor = 0.85 }) {
  if (![batteryPct, rangeMi, remainingMi].every(Number.isFinite) || rangeMi <= 0) return null;
  const usable = rangeMi * factor;
  return Math.max(0, Math.round(batteryPct * (1 - remainingMi / usable)));
}

export function carStatus(s) {
  if (!s) return '';
  if (s.asleep) return 'Car asleep';
  if (s.charging) return 'Charging';
  if (s.user_present) return 'Ready';
  if (s.climate) return 'Climate on';
  return '';
}

export function ageSeconds(s, now = Date.now()) { return s && s.updated ? Math.max(0, Math.round((now - s.updated) / 1000)) : null; }

export function createTesla({ base, token, fetchImpl = fetch, timeoutMs = 8000 }) {
  const root = base.replace(/\/+$/, '');
  return {
    async state() {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${root}/api/state`, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
        const json = await res.json().catch(() => ({}));
        if (res.status === 401) throw new Error('Wrong app token');
        if (json.needs_login) throw Object.assign(new Error('Tesla sign-in needed'), { needsLogin: true });
        if (!res.ok) throw new Error(json.error || `Server error ${res.status}`);
        return json;
      } finally { clearTimeout(t); }
    },
    // Ask the server for the Tesla sign-in URL; the Pages callback forwards the code back to `root`.
    async startAuth() {
      const res = await fetchImpl(`${root}/api/auth/start`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: root }) });
      const json = await res.json().catch(() => ({}));
      if (res.status === 401) throw new Error('Wrong app token');
      if (!res.ok || !json.url) throw new Error(json.error || `Server error ${res.status}`);
      return json.url;
    }
  };
}
