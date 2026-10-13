"""Build the slow-changing data the site needs. Run monthly (or by hand).

  data/states.json    New England outline (GeoJSON)
  data/grid.json      ~4 km grid: elevation, distance to the ocean, forest mix
  data/trails.json    hikes merged from OpenStreetMap trail segments, with stats
  data/geom.json      simplified trail lines (encoded polylines), loaded on demand
  data/overlooks.json drive-up viewpoints
  data/drives.json    curated scenic drives with routed geometry
  data/wxpoints.json  the points daily weather is fetched for

Usage: python build_static.py [--states RI,CT] [--skip-drives]
"""
import argparse
import math
import re
from collections import Counter, defaultdict

import numpy as np
import shapely
from shapely.geometry import LineString, Point, shape
from shapely.strtree import STRtree

from common import (BBOX, CACHE, CURATED, DATA, STATES, Forest, GridIndex, Terrain, densify,
                    encode_polyline, get, haversine, line_length, quantiles, read_json, ring_points,
                    write_json)
from osm_extract import extract

M_PER_MI = 1609.344
FT_PER_M = 3.28084

TIGER = ('https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/0/query')


# ---------- states ----------
def build_states():
    path = CACHE / 'states.json'
    gj = read_json(path)
    if not gj:
        r = get(TIGER, params={
            'where': "STUSAB IN ('ME','NH','VT','MA','CT','RI')", 'outFields': 'STUSAB,NAME',
            'outSR': 4326, 'maxAllowableOffset': 0.004, 'f': 'geojson'})
        gj = r.json()
        path.write_text(r.text)
    feats = []
    for f in gj['features']:
        g = shape(f['geometry'])
        feats.append({'type': 'Feature', 'properties': {'st': f['properties']['STUSAB'], 'name': f['properties']['NAME']},
                      'geometry': shapely.geometry.mapping(shapely.set_precision(g, 0.001))})
    write_json(DATA / 'states.json', {'type': 'FeatureCollection', 'features': feats})
    return {f['properties']['st']: shape(f['geometry']) for f in feats}


def state_of(states, lon, lat):
    p = Point(lon, lat)
    for st, g in states.items():
        if g.contains(p):
            return st
    best = min(states, key=lambda s: states[s].distance(p))
    return best


# ---------- grid ----------
GRID_STEP = 0.04  # degrees; ~4.4 km north-south, ~3.2 km east-west


def coast_distance_km(ocean, dlat_km, dlon_km):
    """Chamfer distance transform (km) from every cell to the nearest ocean cell."""
    INF = 1e9
    h, w = ocean.shape
    d = np.where(ocean, 0.0, INF)
    diag = math.hypot(dlat_km, dlon_km)
    for _ in range(2):
        for y in range(h):
            for x in range(w):
                v = d[y, x]
                if y > 0:
                    v = min(v, d[y - 1, x] + dlat_km)
                    if x > 0: v = min(v, d[y - 1, x - 1] + diag)
                    if x < w - 1: v = min(v, d[y - 1, x + 1] + diag)
                if x > 0: v = min(v, d[y, x - 1] + dlon_km)
                d[y, x] = v
        for y in range(h - 1, -1, -1):
            for x in range(w - 1, -1, -1):
                v = d[y, x]
                if y < h - 1:
                    v = min(v, d[y + 1, x] + dlat_km)
                    if x > 0: v = min(v, d[y + 1, x - 1] + diag)
                    if x < w - 1: v = min(v, d[y + 1, x + 1] + diag)
                if x < w - 1: v = min(v, d[y, x + 1] + dlon_km)
                d[y, x] = v
    return d


def build_grid(states, terrain_lo, forest):
    lon0, lat0, lon1, lat1 = BBOX
    ncols = int(round((lon1 - lon0) / GRID_STEP))
    nrows = int(round((lat1 - lat0) / GRID_STEP))
    centers = [(lon0 + (c + 0.5) * GRID_STEP, lat1 - (r + 0.5) * GRID_STEP) for r in range(nrows) for c in range(ncols)]
    terrain_lo.prefetch(centers)
    elev = np.array([terrain_lo.sample(lon, lat) for lon, lat in centers]).reshape(nrows, ncols)
    ocean = elev <= 0.5
    mid = math.radians((lat0 + lat1) / 2)
    coast = coast_distance_km(ocean, GRID_STEP * 111.32, GRID_STEP * 111.32 * math.cos(mid))

    ne = shapely.union_all(list(states.values()))
    shapely.prepare(ne)
    pts = shapely.points(np.array(centers))
    inside = shapely.contains(ne, pts).reshape(nrows, ncols)

    # forest mix per cell from a 5x5 sub-sample of the ~300 m forest raster
    sub = [(i + 0.5) / 5 - 0.5 for i in range(5)]
    cells = []
    for r in range(nrows):
        for c in range(ncols):
            if not inside[r, c] or ocean[r, c]:
                cells.append(None)
                continue
            lon, lat = centers[r * ncols + c]
            mix = forest.mix([(lon + dx * GRID_STEP, lat + dy * GRID_STEP) for dx in sub for dy in sub])
            cells.append([round(float(elev[r, c])), round(float(coast[r, c]), 1), mix])
    land = sum(1 for x in cells if x)
    print(f'  grid {nrows}x{ncols}, {land} New England land cells')
    write_json(DATA / 'grid.json', {
        'lon0': lon0, 'lat1': lat1, 'step': GRID_STEP, 'nrows': nrows, 'ncols': ncols,
        'fields': ['elev_m', 'coast_km', 'forest_mix'], 'cells': cells})
    return {'lon0': lon0, 'lat1': lat1, 'nrows': nrows, 'ncols': ncols, 'coast': coast}


def coast_at(grid, lon, lat):
    c = int((lon - grid['lon0']) / GRID_STEP)
    r = int((grid['lat1'] - lat) / GRID_STEP)
    r = min(max(r, 0), grid['nrows'] - 1)
    c = min(max(c, 0), grid['ncols'] - 1)
    return round(float(grid['coast'][r, c]), 1)


# ---------- trails ----------
GENERIC = re.compile(r'^(trail|path|footpath|foot path|walkway|walking path|sidewalk|service road|'
                     r'unnamed|bike path|connector|spur|access road|driveway)$', re.I)
PAVED = {'asphalt', 'paved', 'concrete', 'concrete:plates', 'concrete:lanes', 'paving_stones', 'sett',
         'wood', 'metal', 'bricks', 'boardwalk'}
SMOOTH = {'compacted', 'fine_gravel', 'gravel', 'woodchips', 'pebblestone', 'stepping_stones:no'}
NATURAL = {'ground', 'dirt', 'earth', 'grass', 'unpaved', 'sand', 'mud', 'soil', 'forest_floor'}
ROUGH = {'rock', 'stone', 'rocks', 'roots', 'boulders', 'scree'}
HARD_SAC = {'mountain_hiking', 'demanding_mountain_hiking', 'alpine_hiking',
            'demanding_alpine_hiking', 'difficult_alpine_hiking'}


def surface_class(w):
    s = w.get('surface', '')
    if w['hw'] == 'steps':
        return 'steps'
    if w.get('sac_scale') in HARD_SAC or s in ROUGH or w.get('trail_visibility') in ('bad', 'horrible', 'no'):
        return 'rough'
    if s in PAVED:
        return 'paved'
    if s in SMOOTH:
        return 'smooth'
    if s in NATURAL:
        return 'natural'
    return 'unknown'


class UnionFind:
    def __init__(self):
        self.p = {}

    def find(self, x):
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        self.p[self.find(a)] = self.find(b)


def up_down(elevs, hysteresis=3.0):
    """Cumulative climb and descent (m) along a profile, ignoring wiggles under the hysteresis."""
    up = down = 0.0
    ref = elevs[0]
    for e in elevs[1:]:
        if e - ref >= hysteresis:
            up += e - ref
            ref = e
        elif ref - e >= hysteresis:
            down += ref - e
            ref = e
    return up, down


def norm_name(n):
    return re.sub(r'\s+', ' ', n.strip().lower())


def build_trails(states, grid, terrain, forest, osm):
    # 1. pool every state's ways (extracts overlap at borders, so dedupe by way id)
    ways, parks, pois, driveup_views = {}, [], defaultdict(list), []
    for st, o in osm.items():
        ways.update(o['ways'])
        parks.extend(o['parks'])
        for k, v in o['pois'].items():
            pois[k].extend(v)
        driveup_views.extend(o['pois']['viewpoint'][i] for i in o['driveup'])
    print(f'  {len(ways)} trail ways, {len(parks)} park polygons')

    # dedupe POIs that came from two overlapping extracts
    for k in pois:
        pois[k] = list({(round(p[0], 5), round(p[1], 5)): p for p in pois[k]}.values())

    idx = {k: GridIndex(0.01) for k in ('viewpoint', 'peak', 'bench', 'toilets', 'parking')}
    for k, g in idx.items():
        for p in pois[k]:
            g.add(p[0], p[1], p)

    park_geoms = [g for _, g in parks]
    park_tree = STRtree(park_geoms)
    park_area = [g.area for g in park_geoms]

    def park_at(lon, lat):
        hits = park_tree.query(Point(lon, lat), predicate='within')
        named = [i for i in hits if parks[i][0]]
        if not len(hits):
            return None
        if named:
            return parks[min(named, key=lambda i: park_area[i])][0]
        return ''

    # 2. connected components of same-named ways that share a node
    uf = UnionFind()
    by_node = defaultdict(list)
    for wid, w in ways.items():
        if GENERIC.match(w['name'].strip()):
            continue
        key = norm_name(w['name'])
        uf.find(wid)
        for n in w['nodes']:
            for other in by_node[(key, n)]:
                uf.union(wid, other)
            by_node[(key, n)].append(wid)
    comps = defaultdict(list)
    for wid in uf.p:
        comps[uf.find(wid)].append(wid)
    print(f'  {len(comps)} named trail components')

    # elevation tiles for every trail vertex up front, in parallel
    terrain.prefetch([c for w in ways.values() for c in w['coords'][::4]])

    trails, geom = [], {}
    for comp in comps.values():
        cw = [ways[i] for i in comp]
        L = sum(line_length(w['coords']) for w in cw)
        if L < 300 or L > 40_000:
            continue
        name = cw[0]['name'].strip()

        # endpoints of degree 1 are the trail's ends; none means a loop
        deg = Counter()
        for w in cw:
            deg[w['nodes'][0]] += 1
            deg[w['nodes'][-1]] += 1
        node_xy = {}
        for w in cw:
            node_xy[w['nodes'][0]] = w['coords'][0]
            node_xy[w['nodes'][-1]] = w['coords'][-1]
        ends = [node_xy[n] for n, d in deg.items() if d == 1]
        loop = not ends or (len(ends) == 2 and haversine(ends[0][1], ends[0][0], ends[1][1], ends[1][0]) < 150)

        # profile along every way
        samples, up, down, by_surface = [], 0.0, 0.0, Counter()
        wheel, sac = Counter(), set()
        for w in cw:
            pts = densify(w['coords'], 40)
            el = [terrain.sample(lon, lat) for lon, lat in pts]
            u, d = up_down(el)
            up, down = up + u, down + d
            samples.extend(zip(pts, el))
            wl = line_length(w['coords'])
            by_surface[surface_class(w)] += wl
            if 'wheelchair' in w:
                wheel[w['wheelchair']] += wl
            if 'sac_scale' in w:
                sac.add(w['sac_scale'])
        elevs = [e for _, e in samples]

        # where to start: the end nearest a car park, else the lowest end
        cands = ends or [w['coords'][0] for w in cw]
        def start_key(p):
            pk = idx['parking'].near(p[0], p[1], 400)
            return (0 if pk else 1, pk[0][0] if pk else terrain.sample(*p))
        start = min(cands, key=start_key)

        # midpoint for park / state lookups
        mid_lon, mid_lat = samples[len(samples) // 2][0]
        park = park_at(mid_lon, mid_lat)
        in_park = park is not None
        trailish = cw[0]['hw'] in ('path', 'bridleway') or sac
        if not in_park and not (trailish and L >= 800):
            continue  # a named footway on a street or campus, not a hike

        st = state_of(states, start[0], start[1])

        # features along the trail
        views, summits, benches = {}, {}, set()
        for i, ((lon, lat), _) in enumerate(samples):
            for d, v in idx['viewpoint'].near(lon, lat, 80):
                views[v[3]] = v[2]
            if i % 3 == 0:
                for d, p in idx['peak'].near(lon, lat, 120):
                    summits[p[2]] = p
            for d, b in idx['bench'].near(lon, lat, 20):
                benches.add((b[0], b[1]))
        toilets = bool(idx['toilets'].near(start[0], start[1], 300))
        parking = bool(idx['parking'].near(start[0], start[1], 400))

        surf_total = sum(by_surface.values()) or 1
        surf = {k: round(v / surf_total, 2) for k, v in by_surface.items() if v / surf_total >= 0.05}
        wc = 'yes' if wheel.get('yes', 0) > surf_total * 0.5 else ('no' if wheel.get('no', 0) > surf_total * 0.5 else '')

        rt = L if loop else 2 * L
        gain = up if loop else up + down  # out-and-back climbs every descent on the way home
        sub = samples[:: max(1, len(samples) // 60)]

        tid = f'w{min(comp)}'
        rec = {
            'id': tid, 'n': name, 's': st, 'park': park or '',
            'lat': round(start[1], 5), 'lon': round(start[0], 5),
            'rt': round(rt / M_PER_MI, 2), 'loop': loop, 'g': round(gain * FT_PER_M),
            'e': quantiles(elevs), 'c': coast_at(grid, mid_lon, mid_lat),
            'f': forest.mix([p for p, _ in sub]),
            'v': [n or 'Viewpoint' for n in views.values()][:4],
            'pk': sorted(summits)[:3],
            'su': surf, 'wc': wc, 'b': len(benches), 't': toilets, 'p': parking,
            'sac': sorted(sac), 'hw': Counter(w['hw'] for w in cw).most_common(1)[0][0],
        }
        rec['gm'] = grandma_score(rec)
        trails.append(rec)
        geom[tid] = [encode_polyline(list(LineString(w['coords']).simplify(0.00008).coords)) for w in cw]

    print(f'  kept {len(trails)} hikes')
    return trails, geom, idx, driveup_views


def grandma_score(t):
    """0-100: how comfortable this is for an older walker. 0 means not suitable at all."""
    su = t['su']
    rough = su.get('rough', 0) + su.get('steps', 0)
    rt, gain = t['rt'], t['g']
    # A flat out-and-back works at any length: walk a little way and turn around.
    if not t['loop'] and rt > 1.5 and gain / rt < 60 and rough < 0.05:
        t['part'] = True
        gain = round(gain * 1.5 / rt)
        rt = 1.5
    if rt > 3.0 or gain > 450 or rough > 0.15 or set(t['sac']) & HARD_SAC:
        return 0
    score = 100.0
    score -= 18 * max(0.0, rt - 1.0)
    score -= 0.12 * max(0, gain - 80)
    score += 12 * su.get('paved', 0) + 6 * su.get('smooth', 0)
    score -= 12 * su.get('unknown', 0) + 6 * su.get('natural', 0)
    score -= 60 * rough
    if t['wc'] == 'yes':
        score += 12
    elif t['wc'] == 'no':
        score -= 15
    score += 3 * min(t['b'], 4)
    score += 6 if t['t'] else 0
    score += 6 if t['p'] else -10
    score += 4 if t['loop'] else 0
    score += 6 if t['v'] else 0
    return int(max(0, min(100, round(score - 20))))


# ---------- overlooks ----------
def build_overlooks(states, grid, terrain, forest, idx, driveup_views):
    seen, out = set(), []
    cands = list(driveup_views)
    # viewpoints with a car park right next to them also count
    for v in idx['viewpoint'].buckets.values():
        for lon, lat, p in v:
            if idx['parking'].near(lon, lat, 150):
                cands.append(p)
    for lon, lat, name, oid in cands:
        if oid in seen:
            continue
        seen.add(oid)
        ring = [(lon, lat)] + ring_points(lon, lat, 1500, 8) + ring_points(lon, lat, 3500, 12)
        terrain.prefetch(ring)
        el = [terrain.sample(*p) for p in ring]
        out.append({
            'id': oid, 'n': name or 'Scenic viewpoint', 's': state_of(states, lon, lat),
            'lat': round(lat, 5), 'lon': round(lon, 5), 'elev': round(el[0]),
            'e': quantiles(el), 'c': coast_at(grid, lon, lat), 'f': forest.mix(ring),
            'p': bool(idx['parking'].near(lon, lat, 150)),
        })
    print(f'  {len(out)} drive-up overlooks')
    return out


# ---------- scenic drives ----------
OSRM = 'https://router.project-osrm.org/route/v1/driving/'


def build_drives(states, grid, terrain, forest, skip_route=False):
    curated = read_json(CURATED / 'drives.json')
    cache = read_json(CACHE / 'drive_routes.json', {})
    out, geom = [], {}
    for i, d in enumerate(curated):
        key = ';'.join(f'{lon},{lat}' for lat, lon in d['via'])
        if key not in cache and not skip_route:
            try:
                r = get(OSRM + key, params={'overview': 'full', 'geometries': 'geojson'}, timeout=60).json()
                route = r['routes'][0]
                cache[key] = {'coords': route['geometry']['coordinates'], 'm': route['distance'], 's': route['duration']}
            except Exception as err:  # fall back to a straight line between waypoints
                print(f'  routing failed for {d["name"]}: {err}')
        rt = cache.get(key) or {'coords': [[lon, lat] for lat, lon in d['via']], 'm': None, 's': None}
        coords = [tuple(c) for c in rt['coords']]
        pts = densify(coords, 1500)[::1]
        terrain.prefetch(pts)
        el = [terrain.sample(*p) for p in pts]
        ring = [q for p in pts[::2] for q in ring_points(p[0], p[1], 1200, 4)]
        did = f'd{i}'
        mid = coords[len(coords) // 2]
        out.append({
            'id': did, 'n': d['name'], 's': d['state'], 'blurb': d['blurb'],
            'lat': round(coords[0][1], 5), 'lon': round(coords[0][0], 5),
            'mi': round((rt['m'] or line_length(coords)) / M_PER_MI, 1),
            'min': round(rt['s'] / 60) if rt['s'] else None,
            'e': quantiles(el), 'c': coast_at(grid, mid[0], mid[1]), 'f': forest.mix(pts + ring),
            'note': d.get('note', ''),
            'line': encode_polyline(list(LineString(coords).simplify(0.0003).coords)),
        })
        geom[did] = [out[-1]['line']]
    (CACHE / 'drive_routes.json').write_text(__import__('json').dumps(cache))
    print(f'  {len(out)} scenic drives')
    return out, geom


# ---------- featured hikes ----------
def mark_featured(trails):
    curated = read_json(CURATED / 'featured.json') or []
    by_name = defaultdict(list)
    for t in trails:
        by_name[norm_name(t['n'])].append(t)
    for i, f in enumerate(curated):
        lat, lon = f['near']
        hits = [t for t in by_name.get(norm_name(f['match']), [])
                if haversine(lat, lon, t['lat'], t['lon']) < 15_000]
        if not hits:
            print(f'  featured not matched: {f["match"]} ({f["state"]})')
            continue
        t = min(hits, key=lambda t: haversine(lat, lon, t['lat'], t['lon']))
        t['ft'] = {'title': f['title'], 'blurb': f['blurb']}
        if f.get('grandma'):
            t['ft']['gnote'] = f['grandma']
            t['gm'] = max(t['gm'], 65)  # a hand-checked easy section exists


def weather_points(states):
    ne = shapely.union_all(list(states.values()))
    pts = []
    lat = 41.15
    while lat < 47.4:
        lon = -73.45
        while lon < -66.9:
            p = Point(lon, lat)
            if ne.distance(p) < 0.12:
                pts.append([round(lat, 2), round(lon, 2)])
            lon += 0.8
        lat += 0.6
    print(f'  {len(pts)} weather points')
    write_json(DATA / 'wxpoints.json', pts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--states', default=','.join(STATES))
    ap.add_argument('--refresh-osm', action='store_true')
    ap.add_argument('--skip-drives', action='store_true')
    args = ap.parse_args()

    states = build_states()
    weather_points(states)
    forest = Forest()
    terrain_lo, terrain = Terrain(10), Terrain(12)
    print('grid')
    grid = build_grid(states, terrain_lo, forest)
    print('osm')
    osm = {s: extract(s, refresh=args.refresh_osm) for s in args.states.split(',')}
    print('trails')
    trails, geom, idx, driveup_views = build_trails(states, grid, terrain, forest, osm)
    mark_featured(trails)
    print('overlooks')
    overlooks = build_overlooks(states, grid, terrain, forest, idx, driveup_views)
    print('drives')
    drives, dgeom = build_drives(states, grid, terrain, forest, skip_route=args.skip_drives)
    geom.update(dgeom)

    for t in trails:
        del t['sac'], t['hw']  # only needed for scoring
    trails.sort(key=lambda t: (t['s'], t['n']))
    write_json(DATA / 'trails.json', trails)
    write_json(DATA / 'geom.json', geom)
    write_json(DATA / 'overlooks.json', overlooks)
    write_json(DATA / 'drives.json', drives)


if __name__ == '__main__':
    main()
