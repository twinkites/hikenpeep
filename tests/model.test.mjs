// Sanity checks for the foliage model. Run with: node --test tests/
// The ranges are normal-year peak windows from New England state foliage reports; a
// calibration that lands outside them is more likely broken than insightful.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  basePeak, curve, stageOf, samples, peakWindow, crowdFactor, doyOf, dateOf, makeReports,
} from '../js/model.js';

const M = JSON.parse(readFileSync(new URL('../data/model.json', import.meta.url)));
const doy = s => doyOf(new Date(`2026-${s}T12:00`));

const PLACES = [
  // name, lat, elevation m, km to ocean, earliest, latest
  ['Northern Maine woods', 46.5, 300, 150, '09-22', '10-06'],
  ['White Mountains, 2,000 ft', 44.1, 610, 90, '09-25', '10-08'],
  ['Central Vermont valley', 43.5, 300, 170, '10-01', '10-14'],
  ['Berkshires', 42.4, 450, 130, '10-01', '10-15'],
  ['Acadia', 44.35, 90, 0, '10-06', '10-22'],
  ['Inland Connecticut', 41.6, 120, 40, '10-12', '10-27'],
  ['Connecticut shore', 41.3, 20, 1, '10-17', '11-03'],
];

for (const [name, lat, el, coast, lo, hi] of PLACES) {
  test(`normal-year peak: ${name}`, () => {
    const d = basePeak(M, lat, el, coast);
    assert.ok(d >= doy(lo) && d <= doy(hi), `${name}: got ${dateOf(Math.round(d), 2026).toDateString()}, expected ${lo}..${hi}`);
  });
}

test('higher and farther north means earlier', () => {
  assert.ok(basePeak(M, 44, 900, 100) < basePeak(M, 44, 300, 100));
  assert.ok(basePeak(M, 46, 300, 100) < basePeak(M, 42, 300, 100));
  assert.ok(basePeak(M, 42, 50, 0) > basePeak(M, 42, 50, 100));
});

test('color curve peaks at 1 and falls off on both sides', () => {
  assert.equal(curve(M, 0), 1);
  assert.ok(curve(M, -7) < 1 && curve(M, 7) < 1);
  assert.ok(curve(M, 20) < 0.01);
});

test('stages run in order', () => {
  assert.equal(stageOf(-20)[0], 'green');
  assert.equal(stageOf(0)[0], 'peak');
  assert.equal(stageOf(6)[0], 'past');
  assert.equal(stageOf(30)[0], 'bare');
});

test('a maple ridge is more vivid than a spruce flat, and oaks peak later', () => {
  const env = { shift: 0, vivid: 1, corr: 0 };
  const maple = samples(M, { lat: 43, e: [400], c: 100, f: [[800, 1]] }, env);
  const spruce = samples(M, { lat: 43, e: [400], c: 100, f: [[120, 1]] }, env);
  const oak = samples(M, { lat: 43, e: [400], c: 100, f: [[500, 1]] }, env);
  assert.ok(maple.vivid > spruce.vivid);
  assert.ok(peakWindow(M, oak).peak > peakWindow(M, maple).peak);
});

test('a trail spanning elevations has a wider window than a flat one', () => {
  const env = { shift: 0, vivid: 1, corr: 0 };
  const flat = peakWindow(M, samples(M, { lat: 44, e: [300, 300, 300, 300, 300], c: 100, f: [[800, 1]] }, env));
  const tall = peakWindow(M, samples(M, { lat: 44, e: [300, 500, 700, 900, 1100], c: 100, f: [[800, 1]] }, env));
  assert.ok(tall.to - tall.from > flat.to - flat.from);
});

test("Indigenous Peoples' Day weekend is the most crowded", () => {
  // 2026: second Monday of October is Oct 12
  const sat = new Date(2026, 9, 10), mon = new Date(2026, 9, 12), tue = new Date(2026, 9, 13), sat2 = new Date(2026, 9, 17);
  assert.ok(crowdFactor(sat, true) < crowdFactor(sat2, true));
  assert.ok(crowdFactor(mon, false) < 1);
  assert.equal(crowdFactor(tue, true), 1);
});

test('day-of-year ignores leap days', () => {
  assert.equal(doyOf(new Date(2026, 9, 1)), doyOf(new Date(2028, 9, 1)));
  assert.equal(dateOf(274, 2028).getDate(), 1);
});

test('a peak report pulls nearby forecasts toward it, a little', () => {
  const site = { lat: 44, elev: 400, c: 100, f: [[800, 1]] };
  const today = new Date(2026, 9, 13);
  const R = makeReports(M, null, [{ lat: 44, lon: -71.5, date: '2026-10-12', stage: 'peak', id: 1 }], () => site, today);
  const env = { shift: 0, vivid: 1, corr: 0 };
  const model = peakWindow(M, samples(M, site, env)).peak;
  const corr = R.correctionAt(44, -71.5);
  const implied = doyOf(new Date(2026, 9, 12));
  assert.ok(Math.sign(corr) === Math.sign(implied - model) || implied === model);
  assert.ok(Math.abs(corr) < Math.abs(implied - model) + 0.01);
  assert.equal(R.correctionAt(42, -73), 0); // far away: no effect
});
