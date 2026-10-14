// A photo for a place, from Wikimedia Commons (free, no key). Looked up on demand and cached
// for the visit. Commons has plenty of nearby photos of birds, signs and buildings, so a photo
// is used only when its title names the place or describes a view; no photo beats a wrong one.

const API = 'https://commons.wikimedia.org/w/api.php';
const cache = new Map(); // id -> photo | null (settled) or Promise

const SEASON = /\b(autumn|foliage|october|fall colou?rs?|fall leaves)\b/i;
const VIEW = /\b(views?|summit|overlook|lookout|vista|panoram\w*|seen from|scenic|ledges?|cliffs?|tower)\b/i;
const LAND = /\b(mount|mt|mountain|hill|peak|ridge|notch|lake|pond|river|brook|falls|gorge|trail|forest|woods|park|reservation|valley|sunset|sunrise|harbor|cove)\b/i;
const BAD = new RegExp('\\b(' + [
  'signs?', 'marker', 'plaque', 'map', 'diagram', 'logo', 'kiosk', 'photosphere', '360', 'interior', 'roof', 'window', 'door',
  'toilet', 'restroom', 'parking', 'generator', 'camp', 'rail(road|way)', 'postcard', 'dinner', 'menu', 'church', 'meeting house',
  'house', 'hall', 'school', 'station', 'building', 'visitor center', 'pumphouse', 'shack', 'cabin', 'museum', 'portrait', 'grave',
  'cemetery', 'sticker', 'ticket', 'downtown', 'bus', 'underpass', 'truck', 'car', 'iss\\d*', 'earth', 'astronaut',
  // wildlife and close-ups: common on Commons, but not a view
  'birds?', 'ducks?', 'geese', 'goose', 'gulls?', 'herons?', 'hawk', 'eagle', 'owl', 'warbler', 'sparrow', 'finch', 'goldfinch',
  'cormorant', 'deer', 'squirrel', 'chipmunk', 'insect', 'butterfly', 'moth', 'beetle', 'dragonfly', 'mushroom', 'fungus', 'lichen',
  'snake', 'frog', 'toad', 'turtle', 'salamander', 'flowers?', 'blossoms?',
].join('|') + ')\\b', 'i');
const SPECIES = /^[A-Z][a-z]+ [a-z]+(?: [a-z]+)?(?: - | \(?\d{5,}| \d{8}|\.\w+$)/; // iNaturalist-style "Genus species …"
const GENERIC = /^(scenic )?(view ?point|overlook|vista|lookout|view|scenic view|summit)$/i;

/** Names worth searching for: the place itself, its summits and views, its park. */
function hintsFor(it) {
  const hints = [it.ft?.title, ...(it.pk || []).slice(0, 2), ...(it.v || []).slice(0, 2), it.n, it.park];
  if (it.kind === 'drive') hints.push(it.n.replace(/\s*\(.*\)$/, ''));
  const seen = new Set();
  return hints.filter(h => {
    if (!h || GENERIC.test(h) || h.length < 4) return false;
    const k = h.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 4);
}

async function query(params) {
  const url = new URL(API);
  Object.entries({
    action: 'query', format: 'json', origin: '*', prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata', iiurlwidth: 500,
    iiextmetadatafilter: 'Artist|LicenseShortName|DateTimeOriginal', ...params,
  }).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status);
  const pages = (await r.json()).query?.pages || {};
  return Object.values(pages).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

function score(p, i, hints, fromSearch) {
  const ii = p.imageinfo?.[0];
  if (!ii || !/jpeg|png/.test(ii.mime) || ii.width < 400 || !ii.thumburl) return -Infinity;
  const title = p.title.replace(/^File:/, '').replace(/\.\w+$/, '');
  if (BAD.test(title) || SPECIES.test(title)) return -Infinity;
  const named = hints.some(h => title.toLowerCase().includes(h.toLowerCase()));
  const view = VIEW.test(title), land = LAND.test(title);
  const season = SEASON.test(title);
  if (!fromSearch && !named && !view && !season) return -Infinity;
  const month = +(ii.extmetadata?.DateTimeOriginal?.value || '').match(/\d{4}[-:/](\d{2})/)?.[1];
  let s = 3 * season + 2 * view + land + 2 * named - 0.1 * i;
  if (/\b\d{5}, US/.test(title)) s -= 2; // street-address titles: often a building
  s += month === 10 ? 2 : month === 9 || month === 11 ? 1 : 0;
  if (ii.width > ii.height) s += 1; // the box is wide
  return s;
}

function plain(html) {
  const div = document.createElement('div');
  div.innerHTML = html || '';
  const t = div.textContent.replace(/\s+/g, ' ').trim();
  return t.length > 40 ? t.slice(0, 38) + '…' : t;
}

function pick(pages, hints, fromSearch, minScore) {
  let best = null, bestS = minScore;
  pages.forEach((p, i) => {
    const s = score(p, i, hints, fromSearch);
    if (s >= bestS) { best = p; bestS = s; }
  });
  if (!best) return null;
  const ii = best.imageinfo[0], m = ii.extmetadata || {};
  return {
    src: ii.thumburl,
    page: ii.descriptionurl,
    title: best.title.replace(/^File:/, '').replace(/\.\w+$/, ''),
    credit: [plain(m.Artist?.value), m.LicenseShortName?.value].filter(Boolean).join(', '),
  };
}

async function lookup(it) {
  const hints = hintsFor(it);
  const km = it.kind === 'drive' ? 20 : it.kind === 'trail' ? 5 : 3;
  if (hints.length) {
    const s = hints.map(h => `"${h.replace(/"/g, '')}"`).join(' OR ');
    const pages = await query({
      generator: 'search', gsrnamespace: 6, gsrlimit: 15,
      gsrsearch: `${s} nearcoord:${km}km,${it.lat},${it.lon} filetype:bitmap`,
    });
    const hit = pick(pages, hints, true, 0);
    if (hit) return hit;
  }
  const pages = await query({
    generator: 'geosearch', ggsnamespace: 6, ggslimit: 25,
    ggsradius: it.kind === 'overlook' ? 800 : 1500, ggscoord: `${it.lat}|${it.lon}`,
  });
  return pick(pages, hints, false, 2);
}

/** The photo if it's already been looked up: a photo, null for none, or undefined if unknown. */
export function cachedPhoto(it) {
  const v = cache.get(it.id);
  return v instanceof Promise ? undefined : v;
}

/** Resolves to { src, page, title, credit } or null. Never rejects. */
export function photoFor(it) {
  if (cache.has(it.id)) return Promise.resolve(cache.get(it.id));
  const p = lookup(it).catch(() => null).then(photo => { cache.set(it.id, photo); return photo; });
  cache.set(it.id, p);
  return p;
}
