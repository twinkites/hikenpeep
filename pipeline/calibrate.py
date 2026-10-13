"""Fit the foliage model's slopes to USA National Phenology Network observations and write data/model.json.

NPN volunteers record when individual maples show "colored leaves". The middle of that period
is a decent stand-in for a tree's peak, but it is not the same thing as a hillside looking
its best, and the volunteers are mostly in Massachusetts. So the fit is used for what it can
tell us (how much later color comes per 1,000 ft lower and per degree south, and red vs sugar
maple), each blended with a prior from regional foliage reports by precision. The intercept
(when a hillside at 42°N and 1,000 ft peaks) stays at the prior.

Usage: python calibrate.py
"""
import datetime as dt

import numpy as np

from common import CACHE, DATA, get, read_json, write_json

NPN = 'https://services.usanpn.org/npn_portal/observations/getSummarizedData.json'
RED_MAPLE, SUGAR_MAPLE = 3, 61

# Everything the browser model needs. Values marked "prior" come from regional foliage
# reporting (state foliage reports, Yankee, USFS) rather than from a fit.
MODEL = {
    'b0': 285,          # prior: day of year a hillside at 42°N and 1,000 ft peaks (Oct 12)
    'refFt': 1000,
    'bLat': -4.0,       # prior: days per degree north
    'bElev': -5.0,      # prior: days per 1,000 ft up
    'coastDays': 6,     # prior: the ocean delays color right at the shore by about this much
    'coastKm': 15,      # ...fading out over roughly this distance inland
    'min': 255, 'max': 312,
    # forest type group -> [days relative to maple/beech/birch, color intensity 0-1]
    'species': {
        '0': [0, 0.15], '100': [3, 0.35], '120': [0, 0.3], '160': [4, 0.35], '380': [3, 0.3],
        '400': [4, 0.55], '500': [6, 0.7], '700': [-2, 0.6], '800': [0, 1.0], '900': [2, 0.75],
        '990': [3, 0.6],
    },
    'curve': {'before': 9, 'after': 6.5},   # days: width of the color curve before / after peak
    'tempSens': 1.2,          # prior: days later per °F the late season runs warm
    'tempCap': [-6, 9],
    'drought': {'ratio': 0.6, 'days': -3, 'intensity': 0.85},
    'agency': {'radiusKm': 12, 'weight': 0.5},  # how far to trust a state agency's own forecast
    'reports': {'radiusKm': 30, 'maxAgeDays': 12,
                'stages': {'green': 14, 'patchy': 9, 'near': 4, 'peak': 0, 'past': -6, 'bare': -14}},
}

# NPN sites are almost all below 2,500 ft, so don't let them set the mountain slope alone.
PRIOR_SD = {'bLat': 1.0, 'bElev': 1.5, 'coastDays': 3.0}


def fetch(years):
    path = CACHE / f'npn_{years[0]}_{years[-1]}.json'
    data = read_json(path)
    if data is None:
        params = [('request_src', 'hikenpeep'), ('start_date', f'{years[0]}-01-01'),
                  ('end_date', f'{years[-1]}-12-31'), ('phenophase_category', 'Leaves')]
        params += [('species_id[]', s) for s in (RED_MAPLE, SUGAR_MAPLE)]
        params += [('state[]', s) for s in ('ME', 'NH', 'VT', 'MA', 'CT', 'RI')]
        data = get(NPN, params=params, timeout=300).json()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(__import__('json').dumps(data))
    return data


def coast_factor(grid, lon, lat):
    """exp(-km to the ocean / coastKm), the shape the browser model uses for the coastal delay."""
    if not grid:
        return 0.0
    c = int((lon - grid['lon0']) / grid['step'])
    r = int((grid['lat1'] - lat) / grid['step'])
    if 0 <= r < grid['nrows'] and 0 <= c < grid['ncols']:
        cell = grid['cells'][r * grid['ncols'] + c]
        if cell:
            return float(np.exp(-cell[1] / MODEL['coastKm']))
    return 1.0  # off the land grid means on the water's edge


def main():
    grid = read_json(DATA / 'grid.json')
    year = dt.date.today().year
    years = list(range(2010, year))
    rows = [r for r in fetch(years)
            if r['phenophase_description'] == 'Colored leaves'
            and 230 <= r['first_yes_doy'] <= 320 and r['last_yes_doy'] >= r['first_yes_doy']
            and r['elevation_in_meters'] is not None and r['elevation_in_meters'] >= -5]
    model = dict(MODEL)
    if len(rows) < 200:
        print(f'only {len(rows)} NPN rows; keeping priors')
    else:
        y = np.array([(r['first_yes_doy'] + r['last_yes_doy']) / 2 for r in rows])
        lat = np.array([r['latitude'] for r in rows])
        kft = np.array([r['elevation_in_meters'] for r in rows]) / 304.8 - 1
        sugar = np.array([r['species_id'] == SUGAR_MAPLE for r in rows], dtype=float)
        coast = np.array([coast_factor(grid, r['longitude'], r['latitude']) for r in rows])
        X = np.c_[np.ones(len(rows)), lat - 42, kft, sugar, coast]
        b, *_ = np.linalg.lstsq(X, y, rcond=None)
        resid = y - X @ b
        sigma = float(np.sqrt(np.mean(resid ** 2)))
        # Observations cluster by site and year, so inflate the textbook standard errors.
        se = np.sqrt(np.diag(np.linalg.inv(X.T @ X))) * sigma * 3
        b = [float(v) for v in b]
        fit = {'n': len(rows), 'years': f'{years[0]}-{years[-1]}', 'rmseDays': round(sigma, 1),
               'raw': {'intercept': round(b[0], 1), 'bLat': round(b[1], 2), 'bElev': round(b[2], 2),
                       'sugarMinusRed': round(b[3], 1), 'coastDays': round(b[4], 1)}}
        for i, key in ((1, 'bLat'), (2, 'bElev'), (4, 'coastDays')):
            wp, wd = 1 / PRIOR_SD[key] ** 2, 1 / se[i] ** 2
            model[key] = round(float((MODEL[key] * wp + b[i] * wd) / (wp + wd)), 2)
        fit['blended'] = {k: model[k] for k in PRIOR_SD}
        fit = __import__('json').loads(__import__('json').dumps(fit, default=float))
        model['fit'] = fit
        print('NPN fit', fit)
    model['updated'] = dt.date.today().isoformat()
    write_json(DATA / 'model.json', model)


if __name__ == '__main__':
    main()
