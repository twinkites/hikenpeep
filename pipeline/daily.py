"""Nightly refresh: this season's weather and visitors' color reports.

  data/weather.json  per weather point: how warm the season has run versus normal, how dry
                     it has been, and a 16-day forecast for planning
  data/reports.json  color reports filed as GitHub issues (label: foliage-report)
  data/meta.json     when this ran and for which season

The browser does the actual foliage model (js/model.js), so these files are all it needs.

Usage: python daily.py   (GITHUB_REPOSITORY and GITHUB_TOKEN are used for reports when set)
"""
import datetime as dt
import os
import re
import time

import numpy as np

from common import BBOX, DATA, ROOT, get, read_json, session, write_json

FORECAST = 'https://api.open-meteo.com/v1/forecast'
CHUNK = 20
PAST_DAYS = 92
TEMP_WINDOW = ('09-01', '10-20')   # warm or cool nights in this window shift peak
RAIN_DAYS = 60                     # dryness over the last two months


def season_for(today):
    return today.year + 1 if today.month == 12 else today.year


def fetch_weather(pts):
    out = []
    for i in range(0, len(pts), CHUNK):
        chunk = pts[i:i + CHUNK]
        r = get(FORECAST, params={
            'latitude': ','.join(str(p[0]) for p in chunk), 'longitude': ','.join(str(p[1]) for p in chunk),
            'daily': ('temperature_2m_mean,temperature_2m_max,temperature_2m_min,precipitation_sum,'
                      'precipitation_probability_max,cloud_cover_mean,weather_code'),
            'past_days': PAST_DAYS, 'forecast_days': 16,
            'temperature_unit': 'fahrenheit', 'precipitation_unit': 'inch', 'timezone': 'America/New_York',
        }, timeout=120).json()
        out.extend(r if isinstance(r, list) else [r])
        time.sleep(1)
    return out


def anomalies(loc, clim_t, clim_r, clim_days, today, season):
    """(warmth anomaly °F over the color-setting window, rain as a fraction of normal)."""
    d = loc['daily']
    dates = d['time']
    idx = {md: i for i, md in enumerate(clim_days)}
    t_diff, obs_rain, norm_rain = [], 0.0, 0.0
    w0, w1 = (dt.date.fromisoformat(f'{season}-{x}') for x in TEMP_WINDOW)
    horizon = today + dt.timedelta(days=7)  # a week of forecast still counts
    for k, ds in enumerate(dates):
        day = dt.date.fromisoformat(ds)
        md = ds[5:]
        if md not in idx:
            continue
        t = d['temperature_2m_mean'][k]
        if w0 <= day <= min(w1, horizon) and t is not None:
            t_diff.append(t - clim_t[idx[md]])
        if today - dt.timedelta(days=RAIN_DAYS) <= day < today:
            obs_rain += d['precipitation_sum'][k] or 0
            norm_rain += clim_r[idx[md]]
    anom = round(float(np.mean(t_diff)), 1) if len(t_diff) >= 5 else 0.0
    ratio = round(obs_rain / norm_rain, 2) if norm_rain > 0.5 else 1.0
    return anom, ratio, len(t_diff)


def build_weather(today, season):
    pts = read_json(DATA / 'wxpoints.json')
    clim = read_json(ROOT / 'pipeline' / 'climatology.json')
    locs = fetch_weather(pts)
    out = []
    for i, (p, loc) in enumerate(zip(pts, locs)):
        if clim and season == today.year and today.month >= 8:
            anom, ratio, n = anomalies(loc, clim['tempF'][i], clim['rainIn'][i], clim['days'], today, season)
        else:
            anom, ratio, n = 0.0, 1.0, 0  # off-season: forecast the coming season from normals
        d = loc['daily']
        fc = []
        for k, ds in enumerate(d['time']):
            if ds < today.isoformat():
                continue
            fc.append([ds[5:], round(d['temperature_2m_max'][k] or 0), round(d['temperature_2m_min'][k] or 0),
                       d['precipitation_probability_max'][k], d['cloud_cover_mean'][k], d['weather_code'][k]])
        out.append({'lat': p[0], 'lon': p[1], 'anomF': anom, 'rain': ratio, 'nDays': n, 'fc': fc})
    print(f'  weather for {len(out)} points; mean warmth anomaly {np.mean([o["anomF"] for o in out]):+.1f}°F')
    return out


# ---------- reports filed as GitHub issues ----------
STAGES = {'mostly green': 'green', 'patchy': 'patchy', 'near peak': 'near', 'peak': 'peak',
          'past peak': 'past', 'leaves down': 'bare'}


def parse_issue(body):
    fields = {}
    for m in re.finditer(r'^###\s+(.+?)\s*\n+(.*?)(?=^###\s|\Z)', body or '', re.S | re.M):
        fields[m.group(1).strip().lower()] = m.group(2).strip()
    loc = re.findall(r'-?\d+\.\d+', fields.get('location', ''))
    if len(loc) < 2:
        return None
    lat, lon = float(loc[0]), float(loc[1])
    if not (BBOX[1] <= lat <= BBOX[3] and BBOX[0] <= lon <= BBOX[2]):
        return None
    stage_txt = fields.get('color stage', '').lower()
    stage = next((v for k, v in sorted(STAGES.items(), key=lambda kv: -len(kv[0])) if stage_txt.startswith(k)), None)
    date = re.search(r'\d{4}-\d{2}-\d{2}', fields.get('date seen', ''))
    if not stage or not date:
        return None
    return {'lat': round(lat, 4), 'lon': round(lon, 4), 'date': date.group(0), 'stage': stage,
            'place': fields.get('place', '')[:80].replace('_No response_', '')}


def build_reports(today):
    repo, token = os.environ.get('GITHUB_REPOSITORY'), os.environ.get('GITHUB_TOKEN')
    if not repo:
        print('  GITHUB_REPOSITORY not set; keeping existing reports')
        return read_json(DATA / 'reports.json', [])
    headers = {'Accept': 'application/vnd.github+json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    since = (today - dt.timedelta(days=30)).isoformat() + 'T00:00:00Z'
    out, page = [], 1
    while True:
        r = session.get(f'https://api.github.com/repos/{repo}/issues', headers=headers, timeout=60, params={
            'labels': 'foliage-report', 'state': 'all', 'since': since, 'per_page': 100, 'page': page})
        r.raise_for_status()
        items = r.json()
        for it in items:
            labels = {l['name'] for l in it.get('labels', [])}
            if labels & {'invalid', 'spam', 'duplicate'}:
                continue
            rep = parse_issue(it.get('body'))
            if rep and rep['date'] <= today.isoformat():
                rep['id'] = it['number']
                out.append(rep)
        if len(items) < 100:
            break
        page += 1
    print(f'  {len(out)} color reports')
    return out


# ---------- Massachusetts DCR foliage forecast ----------
# DCR publishes week-by-week predicted stages for forest-type polygons across the state
# (https://www.mass.gov/info-details/fall-foliage-season-in-the-parks). Each polygon's
# predicted peak becomes a point the browser model blends toward.
DCR_LAYER = ('https://services1.arcgis.com/7iJyYTjCtKsZS1LR/arcgis/rest/services/'
             'Foliage_Predictions/FeatureServer/0')
DCR_STAGES = {'No Change': None, 'Just Changing': None, 'Mid Point': None,
              'Near Peak': 'near', 'Peak': 'peak', 'Past Peak': 'past'}
MONTHS = {m: i for i, m in enumerate(['january', 'february', 'march', 'april', 'may', 'june', 'july',
                                      'august', 'september', 'october', 'november', 'december'], 1)}


def doy(d):
    """Day of year that ignores leap days, matching js/model.js."""
    n = d.timetuple().tm_yday
    return n - 1 if d.year % 4 == 0 and n > 59 else n


def build_agency(season):
    info = get(DCR_LAYER, params={'f': 'json'}, timeout=60).json()
    weeks = []  # (field, date) from aliases like "October 13, 2026"
    for f in info['fields']:
        m = re.match(r'([A-Za-z]+)\s+(\d+),\s+(\d{4})', f.get('alias') or '')
        if f['name'].startswith('F_') and m and m.group(1).lower() in MONTHS:
            weeks.append((f['name'], dt.date(int(m.group(3)), MONTHS[m.group(1).lower()], int(m.group(2)))))
    if not weeks or weeks[0][1].year != season:
        print(f'  DCR layer is not for {season}; skipping')
        return None
    gj = get(DCR_LAYER + '/query', timeout=120, params={
        'where': '1=1', 'outFields': ','.join(f for f, _ in weeks) + ',Shape__Area', 'returnGeometry': 'true',
        'outSR': 4326, 'maxAllowableOffset': 0.002, 'geometryPrecision': 4, 'f': 'geojson',
        'resultRecordCount': 4000}).json()
    cells = {}
    for feat in gj['features']:
        p = feat['properties']
        stages = [(DCR_STAGES.get(p[f]), d) for f, d in weeks]
        peaks = [doy(d) for s, d in stages if s == 'peak']
        if peaks:
            pk = sum(peaks) / len(peaks)
        else:
            near = [doy(d) for s, d in stages if s == 'near']
            past = [doy(d) for s, d in stages if s == 'past']
            if not (near and past):
                continue
            pk = (max(near) + min(past)) / 2
        ring = feat['geometry']['coordinates'][0]
        if feat['geometry']['type'] == 'MultiPolygon':
            ring = ring[0]
        lon = sum(c[0] for c in ring) / len(ring)
        lat = sum(c[1] for c in ring) / len(ring)
        key = (round(lat / 0.04), round(lon / 0.04))  # pool small polygons into ~4 km cells
        w = max(p.get('Shape__Area') or 1, 1)
        c = cells.setdefault(key, [0.0, 0.0, 0.0, 0.0])
        c[0] += w * lat; c[1] += w * lon; c[2] += w * pk; c[3] += w
    pts = [[round(a / w, 4), round(b / w, 4), round(c / w, 1)] for a, b, c, w in cells.values()]
    print(f'  DCR: {len(gj["features"])} polygons -> {len(pts)} forecast points')
    return {'source': 'Massachusetts DCR', 'url': 'https://www.mass.gov/info-details/fall-foliage-season-in-the-parks',
            'weeks': [d.isoformat() for _, d in weeks], 'points': pts}


def main():
    today = dt.date.today()
    season = season_for(today)
    weather = build_weather(today, season)
    reports = build_reports(today)
    try:
        agency = build_agency(season)
    except Exception as err:  # never let a third-party layer break the nightly run
        print(f'  DCR forecast unavailable: {err}')
        agency = None
    if agency:
        write_json(DATA / 'agency.json', agency)
    clim = read_json(ROOT / 'pipeline' / 'climatology.json')
    write_json(DATA / 'weather.json', {'generated': today.isoformat(), 'season': season, 'points': weather})
    write_json(DATA / 'reports.json', reports)
    write_json(DATA / 'meta.json', {
        'updated': dt.datetime.now(dt.timezone.utc).isoformat(timespec='minutes'),
        'today': today.isoformat(), 'season': season,
        'climatology': clim['years'] if clim else None, 'reports': len(reports),
    })


if __name__ == '__main__':
    main()
