// Pure maths, no DOM. Prices in pence, distances in miles, energy in kWh.
export const LITRES_PER_UK_GALLON = 4.54609;

export const DEFAULTS = {
  price: 27,        // pence per kWh you pay at the plug
  loss: 10,         // % lost between the plug and the battery (home charging is about 8-12%)
  battery: 75,      // usable kWh (edit for your trim)
  rated: 4.4,       // manufacturer miles per kWh to compare against
  petrolPrice: 140, // pence per litre
  petrolMpg: 40     // UK mpg of the petrol car you would otherwise run
};

const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** kWh taken from the battery for a drive, from either kWh shown by the car or a battery % drop. */
export function batteryKwh(entry, settings) {
  if (n(entry.kwh) > 0) return n(entry.kwh);
  const used = n(entry.startPct) - n(entry.endPct);
  return used > 0 ? (used / 100) * n(settings.battery) : 0;
}

/** Analyse one drive. Returns null if there is not enough to work with. */
export function analyseEntry(entry, settings) {
  const miles = n(entry.miles);
  const kwh = batteryKwh(entry, settings);
  const keep = 1 - n(settings.loss) / 100;
  if (miles <= 0 || kwh <= 0 || keep <= 0) return null;
  const milesPerKwh = miles / kwh;
  const plugKwh = kwh / keep;
  const cost = (plugKwh * n(entry.price ?? settings.price)) / 100; // pounds
  return {
    miles, kwh, milesPerKwh,
    whPerMile: (kwh * 1000) / miles,
    plugKwh,
    cost,
    pencePerMile: (cost * 100) / miles,
    vsRated: milesPerKwh / n(settings.rated) - 1 // 0.1 = 10% better than rated
  };
}

export function petrolPencePerMile(s) {
  return n(s.petrolMpg) > 0 ? (n(s.petrolPrice) * LITRES_PER_UK_GALLON) / n(s.petrolMpg) : 0;
}

/** Totals across all drives, weighted by distance (not an average of averages). */
export function summarise(entries, settings) {
  const rows = entries.map(e => ({ entry: e, a: analyseEntry(e, settings) })).filter(r => r.a);
  if (!rows.length) return null;
  const miles = rows.reduce((t, r) => t + r.a.miles, 0);
  const kwh = rows.reduce((t, r) => t + r.a.kwh, 0);
  const cost = rows.reduce((t, r) => t + r.a.cost, 0);
  const petrolCost = (miles * petrolPencePerMile(settings)) / 100;
  const pencePerMile = (cost * 100) / miles;
  const petrolPpm = petrolPencePerMile(settings);
  return {
    drives: rows.length, miles, kwh, cost,
    milesPerKwh: miles / kwh,
    whPerMile: (kwh * 1000) / miles,
    pencePerMile,
    per100: cost * 100 / miles, // pounds per 100 miles
    vsRated: miles / kwh / n(settings.rated) - 1,
    equivalentMpg: pencePerMile > 0 ? (n(settings.petrolPrice) * LITRES_PER_UK_GALLON) / pencePerMile : 0,
    petrolCost,
    saving: petrolCost - cost,
    petrolPencePerMile: petrolPpm
  };
}
