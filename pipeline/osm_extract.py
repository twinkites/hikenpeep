"""Pull trails, parks and points of interest out of a Geofabrik state extract with pyosmium.

Output per state (cached as a pickle so re-running the build is quick):
  ways      {way_id: {name, hw, tags..., nodes: [ids], coords: [(lon, lat)]}}
  parks     [(name or '', shapely polygon)]
  pois      {kind: [(lon, lat, name)]}   kind in viewpoint, peak, bench, toilets, parking
  driveup   set of viewpoint ids that sit beside a drivable road
"""
import math
import pickle
import sys

import osmium
import shapely
from osmium.filter import KeyFilter

from common import CACHE, STATES, UA, densify

TRAIL_HW = {'path', 'footway', 'track', 'bridleway', 'cycleway', 'steps', 'pedestrian'}
ROAD_HW = {'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service',
           'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'}
TRAIL_KEYS = ('surface', 'smoothness', 'sac_scale', 'wheelchair', 'trail_visibility', 'incline',
              'tracktype', 'bicycle', 'foot', 'access', 'footway', 'informal', 'motor_vehicle')
VIEW_CELL = 0.001  # ~100 m; a viewpoint is "drive-up" if a road passes through its cell or a neighbour

GEOFABRIK = 'https://download.geofabrik.de/north-america/us/{}-latest.osm.pbf'


def pbf_path(state):
    return CACHE / 'osm' / f'{STATES[state]}-latest.osm.pbf'


def download(state):
    from common import session
    path = pbf_path(state)
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    print(f'  downloading {path.name}')
    with session.get(GEOFABRIK.format(STATES[state]), stream=True, timeout=600) as r:
        r.raise_for_status()
        with open(path, 'wb') as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    return path


def _vcell(lon, lat):
    return (math.floor(lon / VIEW_CELL), math.floor(lat / VIEW_CELL))


def extract(state, refresh=False):
    out_path = CACHE / f'osm_{state}.pkl'
    if out_path.exists() and not refresh:
        with open(out_path, 'rb') as f:
            return pickle.load(f)
    path = download(state)
    print(f'  reading {path.name}')
    wkb = osmium.geom.WKBFactory()

    ways, parks = {}, []
    pois = {k: [] for k in ('viewpoint', 'peak', 'bench', 'toilets', 'parking')}
    view_cells = {}  # cell -> [viewpoint index]
    driveup = set()

    fp = (osmium.FileProcessor(str(path))
          .with_locations()
          .with_areas(KeyFilter('leisure', 'boundary', 'amenity', 'tourism'))
          .with_filter(KeyFilter('highway', 'leisure', 'boundary', 'amenity', 'tourism', 'natural')))

    for o in fp:
        t = o.tags
        if o.is_node():
            loc = o.location
            if not loc.valid():
                continue
            lon, lat = loc.lon, loc.lat
            if t.get('tourism') == 'viewpoint':
                i = len(pois['viewpoint'])
                pois['viewpoint'].append((lon, lat, t.get('name', ''), f'n{o.id}'))
                view_cells.setdefault(_vcell(lon, lat), []).append(i)
            elif t.get('natural') == 'peak' and 'name' in t:
                ele = t.get('ele', '')
                pois['peak'].append((lon, lat, t['name'], ele))
            elif t.get('amenity') == 'bench' or t.get('leisure') == 'picnic_table':
                pois['bench'].append((lon, lat, ''))
            elif t.get('amenity') == 'toilets':
                pois['toilets'].append((lon, lat, ''))
            elif t.get('amenity') == 'parking':
                pois['parking'].append((lon, lat, t.get('name', '')))

        elif o.is_way():
            hw = t.get('highway')
            if not hw:
                continue
            try:
                coords = [(n.lon, n.lat) for n in o.nodes]
            except osmium.InvalidLocationError:
                continue
            if len(coords) < 2:
                continue
            if hw in ROAD_HW and t.get('access') not in ('private', 'no'):
                # mark viewpoints that a drivable road passes right by
                if view_cells:
                    for lon, lat in densify(coords, 60):
                        cx, cy = _vcell(lon, lat)
                        for dx in (-1, 0, 1):
                            for dy in (-1, 0, 1):
                                for i in view_cells.get((cx + dx, cy + dy), ()):
                                    driveup.add(i)
                continue
            if hw not in TRAIL_HW or 'name' not in t:
                continue
            if t.get('footway') in ('sidewalk', 'crossing') or t.get('area') == 'yes':
                continue
            if t.get('access') in ('private', 'no') or t.get('foot') in ('no', 'private'):
                continue
            rec = {'name': t['name'], 'hw': hw, 'nodes': [n.ref for n in o.nodes], 'coords': coords}
            for k in TRAIL_KEYS:
                if k in t:
                    rec[k] = t[k]
            ways[o.id] = rec

        elif o.is_area():
            leisure, boundary = t.get('leisure'), t.get('boundary')
            is_park = leisure in ('park', 'nature_reserve') or boundary in ('protected_area', 'national_park')
            amenity, tourism = t.get('amenity'), t.get('tourism')
            if not (is_park or amenity in ('parking', 'toilets') or tourism == 'viewpoint'):
                continue
            try:
                geom = shapely.from_wkb(wkb.create_multipolygon(o))
            except Exception:
                continue
            if is_park:
                parks.append((t.get('name', ''), geom))
            else:
                c = geom.representative_point()
                if amenity == 'parking':
                    pois['parking'].append((c.x, c.y, t.get('name', '')))
                elif amenity == 'toilets':
                    pois['toilets'].append((c.x, c.y, ''))
                else:
                    pois['viewpoint'].append((c.x, c.y, t.get('name', ''), f'a{o.id}'))

    result = {'ways': ways, 'parks': parks, 'pois': pois, 'driveup': driveup}
    with open(out_path, 'wb') as f:
        pickle.dump(result, f)
    print(f'  {state}: {len(ways)} named trail ways, {len(parks)} parks, '
          + ', '.join(f'{len(v)} {k}' for k, v in pois.items()) + f', {len(driveup)} drive-up views')
    return result


if __name__ == '__main__':
    for s in sys.argv[1:] or STATES:
        extract(s, refresh=True)
