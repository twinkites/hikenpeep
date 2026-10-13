// The foliage model. Everything here is a pure function of the data files, so the map, the
// hike list and the detail view all agree. Coefficients come from data/model.json, which
// pipeline/calibrate.py writes; see "How it works" in the page for the reasoning.

export const SEASON_START = 244; // Sep 1 (day of year, non-leap); the slider and curves start here
export const SEASON_END = 324;   // Nov 20

export const STAGES = [
  // [key, label, upper bound of (day - peak)]
  ['green', 'Mostly green', -14],
  ['patchy', 'Patchy color', -7],
  ['near', 'Near peak', -3],
  ['peak', 'Peak', 3],
  ['past', 'Past peak', 10],
  ['bare', 'Leaves down', Infinity],
];

export const FOREST_NAMES = {
  0: 'Open land', 100: 'White pine', 120: 'Spruce and fir', 160: 'Pitch pine', 380: 'Planted conifers',
  400: 'Oak and pine', 500: 'Oak and hickory', 700: 'Ash and elm', 800: 'Maple, beech and birch',
  900: 'Aspen and birch', 990: 'Mixed hardwoods',
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function doyOf(date) {
  const start = Date.UTC(date.getFullYear(), 0, 0);
  const d = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  let doy = Math.round((d - start) / 864e5);
  if (isLeap(date.getFullYear()) && doy > 59) doy -= 1; // keep Oct 1 = 274 in every year
  return doy;
}

export function dateOf(doy, year) {
  if (isLeap(year) && doy > 59) doy += 1;
  return new Date(year, 0, doy);
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function stageOf(t) {
  for (const s of STAGES) if (t <= s[2]) return s;
  return STAGES[STAGES.length - 1];
}

/** When a hillside would peak in a normal year, before weather and reports. */
export function basePeak(M, lat, elevM, coastKm) {
  const kft = elevM / 304.8 - M.refFt / 1000;
  const d = M.b0 + M.bLat * (lat - 42) + M.bElev * kft + M.coastDays * Math.exp(-coastKm / M.coastKm);
  return clamp(d, M.min, M.max);
}

/** Share of leaves in color t days from peak (0-1). Rises slower than it falls. */
export function curve(M, t) {
  const w = t < 0 ? M.curve.before : M.curve.after;
  return Math.exp(-((t / w) ** 2));
}

function species(M, code) {
  return M.species[code] || M.species['990'];
}

/**
 * A place to look at leaves: a trail, overlook, drive or grid cell.
 * site: { lat, e: [elevation quantiles m] | elev, c: coast km, f: [[forestCode, fraction], ...] }
 * env:  { shift: days, vivid: multiplier, corr: days from reports }
 * Returns peak-date samples weighted by how much of the view they cover.
 */
export function samples(M, site, env) {
  const elevs = site.e || [site.elev];
  const out = [];
  let vivid = 0;
  for (const [code, frac] of site.f) {
    const [offset, intensity] = species(M, code);
    vivid += frac * intensity;
    for (const el of elevs) {
      const pk = basePeak(M, site.lat, el, site.c) + offset + env.shift + env.corr;
      out.push([pk, frac / elevs.length]);
    }
  }
  return { pts: out, vivid: clamp(vivid * env.vivid, 0, 1) };
}

/** Fraction of the view in color on day d. */
export function colorOn(M, s, d) {
  let c = 0;
  for (const [pk, w] of s.pts) c += w * curve(M, d - pk);
  return c;
}

/** The day color is at its fullest, and the window within 80% of that. */
export function peakWindow(M, s) {
  let best = SEASON_START, bestC = -1;
  const series = [];
  for (let d = SEASON_START; d <= SEASON_END; d++) {
    const c = colorOn(M, s, d);
    series.push(c);
    if (c > bestC) { bestC = c; best = d; }
  }
  let a = best, b = best;
  while (a > SEASON_START && series[a - 1 - SEASON_START] >= 0.8 * bestC) a--;
  while (b < SEASON_END && series[b + 1 - SEASON_START] >= 0.8 * bestC) b++;
  return { peak: best, from: a, to: b, max: bestC, series };
}

/** 0-100: how good the leaves are on day d, before weather and crowds. */
export function peepScore(M, s, d, hasView = true) {
  return 100 * colorOn(M, s, d) * (0.35 + 0.65 * s.vivid) * (hasView ? 1 : 0.85);
}

/** Multiplier for a day's forecast: rain and cloud make for a worse outing. */
export function weatherFactor(fc) {
  if (!fc) return 1;
  const [, , , pop, cloud] = fc;
  return (1 - 0.45 * (pop ?? 0) / 100) * (1 - 0.15 * (cloud ?? 0) / 100);
}

/** Multiplier for crowds: weekends, and the Indigenous Peoples' Day / Columbus Day weekend. */
export function crowdFactor(date, popular) {
  const dow = date.getDay();
  const weekend = dow === 0 || dow === 6;
  // second Monday of October, plus the Saturday and Sunday before it
  const oct1 = new Date(date.getFullYear(), 9, 1);
  const holiday = new Date(date.getFullYear(), 9, 1 + ((8 - oct1.getDay()) % 7) + 7);
  const diff = Math.round((holiday - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / 864e5);
  if (diff >= 0 && diff <= 2) return popular ? 0.75 : 0.85;
  if (weekend) return popular ? 0.85 : 0.93;
  return 1;
}

// ---------- environment: this season's weather and visitors' reports ----------

function distKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const x = (lon2 - lon1) * r * Math.cos(((lat1 + lat2) / 2) * r);
  const y = (lat2 - lat1) * r;
  return 6371 * Math.hypot(x, y);
}

/** Inverse-distance weighting of the nearest weather points. */
export function weatherAt(W, lat, lon) {
  const near = W.points
    .map(p => [distKm(lat, lon, p.lat, p.lon), p])
    .sort((a, b) => a[0] - b[0])
    .slice(0, 3);
  let sw = 0, anom = 0, rain = 0;
  for (const [d, p] of near) {
    const w = 1 / Math.max(d, 5) ** 2;
    sw += w; anom += w * p.anomF; rain += w * p.rain;
  }
  return { anomF: anom / sw, rain: rain / sw, fc: near[0][1].fc, nearest: near[0][1] };
}

export function envFor(M, W, R, lat, lon) {
  const w = W ? weatherAt(W, lat, lon) : { anomF: 0, rain: 1, fc: [] };
  let shift = clamp(M.tempSens * w.anomF, M.tempCap[0], M.tempCap[1]);
  let vivid = 1;
  if (w.rain < M.drought.ratio) { shift += M.drought.days; vivid = M.drought.intensity; }
  return { shift, vivid, corr: R ? R.correctionAt(lat, lon) : 0, weather: w };
}

/**
 * Turns color reports into a smooth correction (days) to add to the model.
 * Each report implies a peak date; the difference from the model is spread over nearby
 * places, shrunk toward zero when there are only a few reports.
 */
export function makeReports(M, W, reports, gridSiteAt, today) {
  const todayDoy = doyOf(today);
  const used = [];
  for (const r of reports || []) {
    const d = doyOf(new Date(r.date + 'T12:00'));
    const age = todayDoy - d;
    if (age < 0 || age > M.reports.maxAgeDays) continue;
    const site = gridSiteAt(r.lat, r.lon);
    if (!site) continue;
    const env = envFor(M, W, null, r.lat, r.lon);
    const s = samples(M, site, env);
    const modelPeak = peakWindow(M, s).peak;
    const implied = d + M.reports.stages[r.stage];
    used.push({ ...r, resid: clamp(implied - modelPeak, -15, 15), wAge: 1 - age / (M.reports.maxAgeDays * 1.5) });
  }
  return {
    used,
    correctionAt(lat, lon) {
      let sw = 0, s = 0;
      for (const r of used) {
        const d = distKm(lat, lon, r.lat, r.lon);
        if (d > M.reports.radiusKm * 2.5) continue;
        const w = Math.exp(-((d / M.reports.radiusKm) ** 2)) * r.wAge;
        sw += w; s += w * r.resid;
      }
      return sw ? clamp(s / (sw + 1), -10, 10) : 0;
    },
  };
}
