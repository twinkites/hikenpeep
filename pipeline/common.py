"""Shared helpers for the HikeNPeep data pipeline: paths, HTTP, geometry, terrain and forest rasters."""
import io
import json
import math
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'
CACHE = ROOT / 'pipeline' / '.cache'
CURATED = ROOT / 'pipeline' / 'curated'

STATES = {
    'ME': 'maine', 'NH': 'new-hampshire', 'VT': 'vermont',
    'MA': 'massachusetts', 'CT': 'connecticut', 'RI': 'rhode-island',
}
# lon_min, lat_min, lon_max, lat_max: all of New England with a little margin
BBOX = (-73.75, 40.9, -66.85, 47.5)

UA = 'HikeNPeep/1.0 (+https://github.com/twinkites/hikenpeep)'
session = requests.Session()
session.headers['User-Agent'] = UA


def get(url, *, params=None, timeout=120, tries=5, **kw):
    """GET with retries and backoff. Free public services hiccup; don't fail the whole build on one."""
    for attempt in range(tries):
        try:
            r = session.get(url, params=params, timeout=timeout, **kw)
            if r.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(f'{r.status_code} {r.text[:200]}')
            r.raise_for_status()
            return r
        except (requests.RequestException, ValueError) as err:
            if attempt == tries - 1:
                raise
            wait = 5 * 2 ** attempt
            print(f'  retry {url[:80]} in {wait}s ({err})')
            time.sleep(wait)


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(',', ':'), ensure_ascii=False))
    print(f'wrote {path.relative_to(ROOT)} ({path.stat().st_size / 1024:.0f} KB)')


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return default


# ---------- geometry ----------
R_EARTH = 6371008.8


def haversine(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_EARTH * math.asin(math.sqrt(a))


def line_length(coords):
    """coords: [(lon, lat), ...] -> metres"""
    return sum(haversine(a[1], a[0], b[1], b[0]) for a, b in zip(coords, coords[1:]))


def densify(coords, step=40.0):
    """Points every ~step metres along a line, keeping the vertices."""
    out = [coords[0]]
    for a, b in zip(coords, coords[1:]):
        d = haversine(a[1], a[0], b[1], b[0])
        n = max(1, int(d // step))
        for i in range(1, n + 1):
            t = i / n
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out


def encode_polyline(coords, precision=5):
    """Google encoded polyline of [(lon, lat), ...] (encoded as lat, lng)."""
    f = 10 ** precision
    out, plat, plon = [], 0, 0
    for lon, lat in coords:
        ilat, ilon = round(lat * f), round(lon * f)
        for v in (ilat - plat, ilon - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1f)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return ''.join(out)


class GridIndex:
    """Bucket points into ~cell-degree cells for fast 'what is near here' lookups."""

    def __init__(self, cell=0.01):
        self.cell = cell
        self.buckets = {}

    def key(self, lon, lat):
        return (int(math.floor(lon / self.cell)), int(math.floor(lat / self.cell)))

    def add(self, lon, lat, item):
        self.buckets.setdefault(self.key(lon, lat), []).append((lon, lat, item))

    def near(self, lon, lat, radius_m):
        """Items within radius_m, as (distance, item), nearest first."""
        kx, ky = self.key(lon, lat)
        r = int(math.ceil(radius_m / (111_000 * self.cell * max(0.3, math.cos(math.radians(lat)))))) + 1
        hits = []
        for dx in range(-r, r + 1):
            for dy in range(-r, r + 1):
                for plon, plat, item in self.buckets.get((kx + dx, ky + dy), ()):
                    d = haversine(lat, lon, plat, plon)
                    if d <= radius_m:
                        hits.append((d, item))
        hits.sort(key=lambda h: h[0])
        return hits


# ---------- terrain (AWS Terrain Tiles, Terrarium encoding, public, no key) ----------
TERRAIN_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'


class Terrain:
    """Bilinear elevation sampler (metres) over cached Terrarium tiles at one zoom level."""

    def __init__(self, zoom):
        self.z = zoom
        self.dir = CACHE / 'terrain' / str(zoom)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.tiles = {}

    def _tile_xy(self, lon, lat):
        n = 2 ** self.z
        x = (lon + 180) / 360 * n
        y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
        return x, y

    def _fetch(self, tx, ty):
        path = self.dir / f'{tx}_{ty}.png'
        if not path.exists():
            r = get(TERRAIN_URL.format(z=self.z, x=tx, y=ty), timeout=60)
            path.write_bytes(r.content)
        return path

    def _load(self, tx, ty):
        key = (tx, ty)
        if key not in self.tiles:
            rgb = np.asarray(Image.open(self._fetch(tx, ty)).convert('RGB'), dtype=np.float32)
            self.tiles[key] = rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768
        return self.tiles[key]

    def prefetch(self, points):
        """Download every tile the (lon, lat) points touch, in parallel."""
        need = set()
        for lon, lat in points:
            x, y = self._tile_xy(lon, lat)
            need.add((int(x), int(y)))
        missing = [t for t in need if not (self.dir / f'{t[0]}_{t[1]}.png').exists()]
        if len(missing) > 20:
            print(f'  fetching {len(missing)} terrain tiles at z{self.z}')
            with ThreadPoolExecutor(16) as pool:
                list(pool.map(lambda t: self._fetch(*t), missing))

    def sample(self, lon, lat):
        x, y = self._tile_xy(lon, lat)
        px, py = (x % 1) * 256 - 0.5, (y % 1) * 256 - 0.5
        tx, ty = int(x), int(y)
        a = self._load(tx, ty)
        # clamp to this tile's pixels; edge error of half a pixel is fine for our purposes
        x0 = min(max(int(math.floor(px)), 0), 254)
        y0 = min(max(int(math.floor(py)), 0), 254)
        fx = min(max(px - x0, 0), 1)
        fy = min(max(py - y0, 0), 1)
        top = a[y0, x0] * (1 - fx) + a[y0, x0 + 1] * fx
        bot = a[y0 + 1, x0] * (1 - fx) + a[y0 + 1, x0 + 1] * fx
        return float(top * (1 - fy) + bot * fy)


# ---------- forest type groups (USFS FIA BIGMAP 2018, 30 m, public ImageServer) ----------
FOREST_URL = ('https://imagery.geoplatform.gov/iipp/rest/services/Vegetation/'
              'USFS_FIA_BIGMAP_CONUS_ForestTypeGroup_2018/ImageServer/exportImage')
# FIA forest type group codes that occur in New England. Anything else in the raster is
# treated as "other". 0 = not forest (fields, towns, water, bare summits).
FOREST_GROUPS = {
    0: 'Not forest', 100: 'White/red/jack pine', 120: 'Spruce/fir', 160: 'Loblolly/shortleaf pine',
    380: 'Exotic softwoods', 400: 'Oak/pine', 500: 'Oak/hickory', 700: 'Elm/ash/cottonwood',
    800: 'Maple/beech/birch', 900: 'Aspen/birch', 990: 'Other hardwoods',
}


class Forest:
    """Nearest-pixel lookup into a ~300 m export of the forest type group raster."""

    W, H = 2400, 2296  # keeps pixels roughly square over New England

    def __init__(self):
        path = CACHE / 'forest_type_groups.tif'
        if not path.exists():
            print('  downloading forest type groups raster')
            r = get(FOREST_URL, params={
                'f': 'image', 'bbox': ','.join(map(str, BBOX)), 'bboxSR': 4326, 'imageSR': 4326,
                'size': f'{self.W},{self.H}', 'format': 'tiff', 'pixelType': 'U16',
                'interpolation': 'RSP_NearestNeighbor', 'noData': 65535,
            }, timeout=600)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(r.content)
        a = np.asarray(Image.open(path)).astype(np.int32)
        self.h, self.w = a.shape
        # A handful of pixels in the export decode as junk; anything not a known code but in a
        # plausible FIA range becomes "other hardwoods", the rest nodata.
        known = np.isin(a, list(FOREST_GROUPS))
        other = (~known) & (a >= 100) & (a <= 999) & (a % 10 == 0)
        a = np.where(known, a, np.where(other, 990, -1))
        self.a = a

    def code(self, lon, lat):
        x0, y0, x1, y1 = BBOX
        col = int((lon - x0) / (x1 - x0) * self.w)
        row = int((y1 - lat) / (y1 - y0) * self.h)
        if not (0 <= col < self.w and 0 <= row < self.h):
            return -1
        return int(self.a[row, col])

    def mix(self, points):
        """Forest composition of a set of (lon, lat) points as [[code, fraction], ...], top 3."""
        counts = {}
        for lon, lat in points:
            c = self.code(lon, lat)
            if c >= 0:
                counts[c] = counts.get(c, 0) + 1
        total = sum(counts.values())
        if not total:
            return [[0, 1.0]]
        top = sorted(counts.items(), key=lambda kv: -kv[1])[:3]
        return [[c, round(n / total, 2)] for c, n in top]


def ring_points(lon, lat, radius_m, n=12):
    """n points on a circle around (lon, lat)."""
    out = []
    for i in range(n):
        a = 2 * math.pi * i / n
        dlat = radius_m * math.cos(a) / 111_320
        dlon = radius_m * math.sin(a) / (111_320 * math.cos(math.radians(lat)))
        out.append((lon + dlon, lat + dlat))
    return out


def quantiles(values, qs=(0, 25, 50, 75, 100)):
    return [round(float(v)) for v in np.percentile(np.asarray(values, dtype=float), qs)]
