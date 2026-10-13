"""Normal late-season temperature and rainfall at each weather point, from Open-Meteo's ERA5 archive.

Writes pipeline/climatology.json (committed; re-run once a year). daily.py compares this
season against it to decide whether color is running early or late.

Usage: python climatology.py [first_year] [last_year]
"""
import datetime as dt
import sys
import time

import numpy as np

from common import DATA, ROOT, get, read_json, write_json

ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive'
START, END = '07-01', '11-15'
CHUNK = 15


def season_days():
    d, out = dt.date(2001, 7, 1), []
    while d <= dt.date(2001, 11, 15):
        out.append(d.strftime('%m-%d'))
        d += dt.timedelta(days=1)
    return out


def main():
    last = int(sys.argv[2]) if len(sys.argv) > 2 else dt.date.today().year - 1
    first = int(sys.argv[1]) if len(sys.argv) > 1 else last - 9
    pts = read_json(DATA / 'wxpoints.json')
    days = season_days()
    temp = np.zeros((len(pts), len(days)))
    rain = np.zeros((len(pts), len(days)))
    for year in range(first, last + 1):
        for i in range(0, len(pts), CHUNK):
            chunk = pts[i:i + CHUNK]
            r = get(ARCHIVE, params={
                'latitude': ','.join(str(p[0]) for p in chunk), 'longitude': ','.join(str(p[1]) for p in chunk),
                'start_date': f'{year}-{START}', 'end_date': f'{year}-{END}',
                'daily': 'temperature_2m_mean,precipitation_sum',
                'temperature_unit': 'fahrenheit', 'precipitation_unit': 'inch', 'timezone': 'America/New_York',
            }, timeout=180).json()
            if isinstance(r, dict):
                r = [r]
            for j, loc in enumerate(r):
                t = np.array([v if v is not None else np.nan for v in loc['daily']['temperature_2m_mean']])
                p = np.array([v if v is not None else 0 for v in loc['daily']['precipitation_sum']])
                temp[i + j] += np.nan_to_num(t, nan=np.nanmean(t))
                rain[i + j] += p
            time.sleep(3)  # stay well inside Open-Meteo's free-tier rate limits
        print(f'  {year} done')
    n = last - first + 1
    temp /= n
    rain /= n
    # smooth temperature with a 7-day running mean; rain is summed over windows later, so leave it
    k = np.ones(7) / 7
    temp = np.array([np.convolve(np.pad(row, 3, mode='edge'), k, mode='valid') for row in temp])
    write_json(ROOT / 'pipeline' / 'climatology.json', {
        'years': f'{first}-{last}', 'days': days, 'points': pts,
        'tempF': np.round(temp, 1).tolist(), 'rainIn': np.round(rain, 3).tolist(),
    })


if __name__ == '__main__':
    main()
