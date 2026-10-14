import {
  SEASON_START, SEASON_END, STAGES, FOREST_NAMES, doyOf, dateOf, stageOf, samples, colorOn, peakWindow,
  peepScore, weatherFactor, crowdFactor, envFor, makeReports, makeAgency, combine,
} from './model.js';
import { REPO } from './config.js';
import { photoFor, cachedPhoto } from './photos.js';

const $ = sel => document.querySelector(sel);
const PAGE = 40;

// ---------- storage (every access guarded: private windows can throw) ----------
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not persisted */ }
  },
};

// ---------- state ----------
const today = new Date();
const todayDoy = doyOf(today);
let M, G, W, R, A, C, meta, year; // C: agency + reports corrections combined
let day;                      // day of year being planned for
let items = [];               // trails, overlooks and drives, each with precomputed color samples
let grandma = store.get('hnp.grandma', false);
let shown = PAGE;
let selected = null;
let geom = null;

// ---------- map ----------
const view = store.get('hnp.view', { center: [44.0, -71.6], zoom: 7 });
const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView(view.center, view.zoom);
L.control.zoom({ position: 'topright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
map.createPane('foliage').style.zIndex = 350;

const renderer = L.canvas({ padding: 0.3 });
const trailLayer = L.layerGroup().addTo(map);
const overlookLayer = L.layerGroup().addTo(map);
const driveLayer = L.layerGroup().addTo(map);
const reportLayer = L.layerGroup().addTo(map);
const selLayer = L.layerGroup().addTo(map);
let foliageLayer = null;
let layersControl = null;

map.on('moveend', () => {
  const c = map.getCenter();
  store.set('hnp.view', { center: [c.lat, c.lng], zoom: map.getZoom() });
  updateReportLink();
  if ($('#in-view').checked || $('#sort').value === 'near') renderList();
});

// ---------- load ----------
async function getJSON(path, fallback) {
  try {
    const r = await fetch(path, { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

async function init() {
  let trails, overlooks, drives, reports, states, agency;
  try {
    [M, G, trails, overlooks, drives, W, reports, meta, states, agency] = await Promise.all([
      getJSON('data/model.json'), getJSON('data/grid.json'), getJSON('data/trails.json'),
      getJSON('data/overlooks.json', []), getJSON('data/drives.json', []), getJSON('data/weather.json', null),
      getJSON('data/reports.json', []), getJSON('data/meta.json', {}), getJSON('data/states.json', null),
      getJSON('data/agency.json', null),
    ]);
  } catch (err) {
    $('#loading').textContent = 'Could not load the forecast data. Try reloading the page.';
    console.error(err);
    return;
  }
  year = W?.season ?? today.getFullYear();
  if (states) {
    L.geoJSON(states, { interactive: false, style: { color: cssVar('--pine'), weight: 1.2, fill: false, opacity: 0.6 } }).addTo(map);
  }
  M.agency ??= { radiusKm: 12, weight: 0.5 };
  A = makeAgency(M, W, agency, gridSiteAt);
  R = makeReports(M, W, reports, gridSiteAt, today, A);
  C = combine(A, R);

  const prep = (it, kind) => {
    it.kind = kind;
    it.env = envFor(M, W, C, it.lat, it.lon);
    it.smp = samples(M, it, it.env);
    it.win = peakWindow(M, it.smp);
    it.view = kind !== 'trail' || it.v.length > 0 || it.pk.length > 0;
    it.popular = !!it.ft || (kind === 'trail' && it.v.length > 0 && it.pk.length > 0);
    return it;
  };
  items = [
    ...trails.map(t => prep(t, 'trail')),
    ...overlooks.map(o => prep(o, 'overlook')),
    ...drives.map(d => prep(d, 'drive')),
  ];
  computeGrid();

  const inSeason = year === today.getFullYear() && todayDoy >= SEASON_START && todayDoy <= SEASON_END;
  day = store.get('hnp.day', null) ?? (inSeason ? todayDoy : 280);
  if (!inSeason) $('#today').hidden = true;
  $('#day').value = day;

  drawFoliage();
  buildMarkers();
  buildReports();
  layersControl = L.control.layers(null, {
    'Foliage forecast': foliageLayer,
    'Hikes': trailLayer,
    'Drive-up overlooks': overlookLayer,
    'Scenic drives': driveLayer,
    'Color reports': reportLayer,
  }, { position: 'topright' }).addTo(map);

  fillAbout();
  buildLegend();
  setGrandma(grandma);
  setDay(day);
  $('#loading').hidden = true;

  const hash = location.hash.slice(1);
  if (hash) {
    const it = items.find(i => i.id === hash);
    if (it) { selectTab($('#tab-hikes')); openDetail(it); }
  }
}

// ---------- grid ----------
function gridSiteAt(lat, lon) {
  const c = Math.floor((lon - G.lon0) / G.step);
  const r = Math.floor((G.lat1 - lat) / G.step);
  if (r < 0 || c < 0 || r >= G.nrows || c >= G.ncols) return null;
  const cell = G.cells[r * G.ncols + c];
  if (!cell) return null;
  return { lat, lon, elev: cell[0], c: cell[1], f: cell[2], r, col: c };
}

let gridPeaks = null; // per cell: { smp, peak } or null

function computeGrid() {
  gridPeaks = G.cells.map((cell, i) => {
    if (!cell) return null;
    const r = Math.floor(i / G.ncols), c = i % G.ncols;
    const lat = G.lat1 - (r + 0.5) * G.step, lon = G.lon0 + (c + 0.5) * G.step;
    const site = { lat, elev: cell[0], c: cell[1], f: cell[2] };
    const smp = samples(M, site, envFor(M, W, C, lat, lon));
    return { smp, win: peakWindow(M, smp) };
  });
}

const STAGE_RGB = {};
function stageRGB(key) {
  if (!STAGE_RGB[key]) {
    const hex = cssVar(`--st-${key}`).replace('#', '');
    STAGE_RGB[key] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
  }
  return STAGE_RGB[key];
}

const canvas = document.createElement('canvas');

function drawFoliage() {
  // Rows are laid out in Web Mercator so the image lines up with the base map.
  const lat0 = G.lat1 - G.nrows * G.step;
  const lon1 = G.lon0 + G.ncols * G.step;
  const merc = lat => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const yTop = merc(G.lat1), yBot = merc(lat0);
  const H = G.nrows * 2, Wd = G.ncols;
  canvas.width = Wd; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(Wd, H);
  for (let y = 0; y < H; y++) {
    const my = yTop - ((y + 0.5) / H) * (yTop - yBot);
    const lat = (Math.atan(Math.exp(my)) * 360) / Math.PI - 90;
    const r = Math.floor((G.lat1 - lat) / G.step);
    for (let c = 0; c < Wd; c++) {
      const g = gridPeaks[r * G.ncols + c];
      if (!g) continue;
      const st = stageOf(day - g.win.peak);
      const [R_, G_, B_] = stageRGB(st[0]);
      const k = (y * Wd + c) * 4;
      img.data[k] = R_; img.data[k + 1] = G_; img.data[k + 2] = B_;
      img.data[k + 3] = Math.round(255 * (0.4 + 0.6 * g.smp.vivid));
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = canvas.toDataURL();
  const bounds = [[lat0, G.lon0], [G.lat1, lon1]];
  if (!foliageLayer) {
    foliageLayer = L.imageOverlay(url, bounds, { pane: 'foliage', opacity: foliageOpacity(), className: 'foliage', interactive: false }).addTo(map);
  } else {
    foliageLayer.setUrl(url);
  }
}

// ---------- markers ----------
function markerStyle(it) {
  const st = stageOf(day - it.win.peak);
  return {
    radius: it.kind === 'trail' ? (it.ft ? 7 : 4.5) : 6.5,
    color: it.kind === 'overlook' ? cssVar('--ink') : cssVar('--marker-ring'),
    weight: it.kind === 'overlook' ? 2 : 1.2,
    fillColor: cssVar(`--st-${st[0]}`),
    fillOpacity: 0.95,
  };
}

// Zoomed out, every trail at once hides the forecast, so only classics and drives show.
const DETAIL_ZOOM = 9;

function visibleOnMap(it) {
  if (it.kind === 'drive') return true;
  const close = map.getZoom() >= DETAIL_ZOOM;
  if (!close && !it.ft) return false;
  if (grandma) return it.kind === 'overlook' || it.gm >= 60;
  return it.kind === 'trail' || it.kind === 'overlook';
}

let wasClose = map.getZoom() >= DETAIL_ZOOM;
// The forecast is a regional picture; up close, let the base map show through.
const foliageOpacity = () => Math.max(0.3, Math.min(0.8, 0.8 - (map.getZoom() - 8) * 0.17));
map.on('zoomend', () => {
  foliageLayer?.setOpacity(foliageOpacity());
  const close = map.getZoom() >= DETAIL_ZOOM;
  if (close !== wasClose && items.length) placeMarkers();
  wasClose = close;
});

function buildMarkers() {
  for (const it of items) {
    it.marker = L.circleMarker([it.lat, it.lon], { ...markerStyle(it), renderer, bubblingMouseEvents: false });
    if (it.kind === 'drive' && it.line) {
      // the route itself, colored by stage; the dot marks where it starts
      it.route = L.polyline(decodePolyline(it.line), { renderer, weight: 5, opacity: 0.85, color: markerStyle(it).fillColor, bubblingMouseEvents: false });
      it.route.on('click', e => { L.DomEvent.stop(e); it.marker.openPopup(); });
      withPhotoTooltip(it, it.route, { sticky: true });
    }
    withPhotoTooltip(it, it.marker, { direction: 'top', offset: [0, -4] });
    it.marker.bindPopup(() => popupHTML(it), { maxWidth: 300, minWidth: 260, autoPanPadding: [20, 20], autoPanPaddingBottomRight: [20, 70] });
    it.marker.on('popupopen', e => {
      it.marker.closeTooltip(); it.route?.closeTooltip();
      const el = e.popup.getElement();
      el.querySelector('[data-detail]').onclick = () => { map.closePopup(); selectTab($('#tab-hikes')); openDetail(it); };
      if (cachedPhoto(it) === undefined) photoFor(it).then(() => { if (e.popup.isOpen()) e.popup.update(); });
    });
  }
  placeMarkers();
}

// Hovering shows the name, stage and (once found) a photo. Tooltips can't hold links, so
// a click opens a popup with the photo credit, Google Maps and the full details.
function withPhotoTooltip(it, layer, opts) {
  layer.bindTooltip(() => tooltipHTML(it), { ...opts, className: 'photo-tip', opacity: 1 });
  let timer;
  layer.on('tooltipopen', e => {
    if (cachedPhoto(it) !== undefined) return;
    clearTimeout(timer);
    timer = setTimeout(() => photoFor(it).then(p => { if (p && e.tooltip.isOpen()) e.tooltip.update(); }), 200);
  });
  layer.on('tooltipclose', () => clearTimeout(timer));
}

function photoHTML(p, linked) {
  if (!p) return '';
  const credit = esc(p.credit || 'Wikimedia Commons');
  return `<figure class="pop-photo"><img src="${esc(p.src)}" alt="${esc(p.title)}" width="260" height="146" decoding="async">
    <figcaption>${linked ? `<a href="${esc(p.page)}" target="_blank" rel="noopener">${credit}</a>` : credit} · Wikimedia Commons</figcaption></figure>`;
}

function tooltipHTML(it) {
  return `<div class="pop">${photoHTML(cachedPhoto(it), false)}<b>${esc(it.ft?.title || it.n)}</b>
    <span>${esc(kindLabel(it))} · ${esc(stageOf(day - it.win.peak)[1])}</span></div>`;
}

function popupHTML(it) {
  const w = it.win;
  const p = cachedPhoto(it);
  return `<div class="pop">${p === undefined ? '<div class="pop-photo loading-photo">Looking for a photo…</div>' : photoHTML(p, true)}
    <b>${esc(it.ft?.title || it.n)}</b>
    <span>${esc(kindLabel(it))}${it.park ? ` · ${esc(it.park)}` : ''} · ${esc(stageOf(day - it.win.peak)[1])} on ${fmtDate(dateOf(day, year))}</span>
    <p>Peak around <b>${fmtDate(dateOf(w.peak, year))}</b> (${fmtDate(dateOf(w.from, year))}–${fmtDate(dateOf(w.to, year))})</p>
    <div class="pop-links">
      <a class="primary button" href="${mapsURL(it)}" target="_blank" rel="noopener">Open in Google Maps</a>
      <button class="secondary" data-detail>Details and best days</button>
    </div></div>`;
}

function mapsURL(it) {
  return `https://www.google.com/maps/search/?api=1&query=${it.lat},${it.lon}`;
}

function placeMarkers() {
  trailLayer.clearLayers(); overlookLayer.clearLayers(); driveLayer.clearLayers();
  for (const it of items) {
    if (!visibleOnMap(it)) continue;
    const layer = ({ trail: trailLayer, overlook: overlookLayer, drive: driveLayer })[it.kind];
    if (it.route) layer.addLayer(it.route);
    layer.addLayer(it.marker);
  }
}

function restyleMarkers() {
  for (const it of items) {
    const st = markerStyle(it);
    it.marker.setStyle(st);
    it.route?.setStyle({ color: st.fillColor });
  }
}

function buildReports() {
  reportLayer.clearLayers();
  for (const r of R.used) {
    const st = STAGES.find(s => s[0] === r.stage);
    L.circleMarker([r.lat, r.lon], {
      radius: 5, renderer, color: cssVar('--ink'), weight: 1.5, dashArray: '2 2',
      fillColor: cssVar(`--st-${r.stage}`), fillOpacity: 0.9,
    }).bindPopup(`<div class="pop"><b>${esc(st[1])}</b><span>Reported ${esc(fmtDate(new Date(r.date + 'T12:00')))}${r.place ? ', ' + esc(r.place) : ''}</span><br><a href="https://github.com/${REPO}/issues/${r.id}" target="_blank" rel="noopener">See report</a></div>`)
      .addTo(reportLayer);
  }
}

// ---------- day ----------
function setDay(d) {
  day = Math.max(SEASON_START, Math.min(SEASON_END, d));
  $('#day').value = day;
  const date = dateOf(day, year);
  const rel = year === today.getFullYear() ? relDay(day - todayDoy) : '';
  $('#day-out').textContent = fmtDate(date, true) + (rel ? ` (${rel})` : '');
  $('#outlook-day').textContent = fmtDate(date);
  drawFoliage();
  restyleMarkers();
  renderOutlook();
  renderSpot();
  renderList();
  if (selected) renderDetail(selected);
}

let dayTimer;
$('#day').addEventListener('input', e => {
  const d = +e.target.value;
  $('#day-out').textContent = fmtDate(dateOf(d, year), true);
  clearTimeout(dayTimer);
  dayTimer = setTimeout(() => { store.set('hnp.day', d === todayDoy ? null : d); setDay(d); }, 60);
});
$('#today').onclick = () => { store.set('hnp.day', null); setDay(todayDoy); };

// ---------- grandma mode ----------
function setGrandma(on) {
  grandma = on;
  store.set('hnp.grandma', on);
  document.body.classList.toggle('grandma', on);
  $('#grandma').setAttribute('aria-pressed', String(on));
  $('#tab-hikes').textContent = on ? 'Easy outings' : 'Hikes';
  placeMarkers();
  shown = PAGE;
  renderList();
  if (selected) renderDetail(selected);
}
$('#grandma').onclick = () => setGrandma(!grandma);

// ---------- outlook ----------
const OUTLOOK = [
  ['Northern Maine', 'Millinocket', 45.66, -68.71],
  ['Rangeley Lakes', 'Western Maine', 44.97, -70.64],
  ['Northeast Kingdom', 'Lake Willoughby, VT', 44.75, -72.06],
  ['White Mountains', 'Lincoln, NH', 44.05, -71.67],
  ['Stowe', 'Vermont', 44.47, -72.69],
  ['Acadia', 'Mount Desert Island, ME', 44.35, -68.25],
  ['Lakes Region', 'Meredith, NH', 43.66, -71.50],
  ['Woodstock', 'Vermont', 43.62, -72.52],
  ['Monadnock', 'Jaffrey, NH', 42.81, -72.02],
  ['Berkshires', 'Lenox, MA', 42.36, -73.28],
  ['Pioneer Valley', 'Amherst, MA', 42.37, -72.52],
  ['Litchfield Hills', 'Connecticut', 41.75, -73.19],
  ['Greater Boston', 'Blue Hills, MA', 42.22, -71.08],
  ['Quiet Corner', 'Pomfret, CT', 41.87, -71.96],
  ['Arcadia', 'Rhode Island', 41.58, -71.72],
  ['Cape Cod', 'Brewster, MA', 41.76, -70.06],
];

function gridPeakAt(lat, lon) {
  const s = gridSiteAt(lat, lon);
  if (!s) return null;
  return { site: s, g: gridPeaks[s.r * G.ncols + s.col] };
}

function renderOutlook() {
  const tb = $('#outlook');
  tb.innerHTML = '';
  for (const [name, sub, lat, lon] of OUTLOOK) {
    const p = gridPeakAt(lat, lon);
    if (!p?.g) continue;
    const st = stageOf(day - p.g.win.peak);
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    tr.innerHTML = `<td>${esc(name)}<small>${esc(sub)}</small></td><td>${fmtDate(dateOf(p.g.win.peak, year))}</td><td><span class="chip st-${st[0]}">${esc(st[1])}</span></td>`;
    const go = () => { map.setView([lat, lon], 10); showSpot(lat, lon); };
    tr.onclick = go;
    tr.onkeydown = e => { if (e.key === 'Enter') go(); };
    tb.append(tr);
  }
}

// ---------- spot: click the map ----------
let spot = null;
const spotMarker = L.circleMarker([0, 0], { radius: 8, color: cssVar('--ink'), weight: 2, fill: false, renderer });

map.on('click', e => showSpot(e.latlng.lat, e.latlng.lng));

function showSpot(lat, lon) {
  spot = { lat, lon };
  spotMarker.setLatLng([lat, lon]).addTo(map);
  selectTab($('#tab-map'));
  renderSpot();
}

function renderSpot() {
  const box = $('#spot');
  if (!spot || !gridPeaks) return;
  const p = gridPeakAt(spot.lat, spot.lon);
  $('#spot-hint').hidden = true;
  box.hidden = false;
  if (!p?.g) {
    box.innerHTML = `<h3>Outside the forecast</h3><p>Hike and Peep covers the six New England states. Try a spot on land inside the outline.</p>`;
    return;
  }
  const { site, g } = p;
  const st = stageOf(day - g.win.peak);
  const forest = site.f.filter(([, f]) => f >= 0.15).map(([c]) => FOREST_NAMES[c] || 'Other').join(', ');
  const env = envFor(M, W, C, spot.lat, spot.lon);
  box.innerHTML = `
    <h3><span class="chip st-${st[0]}">${esc(st[1])}</span> on ${fmtDate(dateOf(day, year))}</h3>
    <p>Peak around <b>${fmtDate(dateOf(g.win.peak, year))}</b>, best from ${fmtDate(dateOf(g.win.from, year))} to ${fmtDate(dateOf(g.win.to, year))}.</p>
    <p>About ${ft(site.elev)} ft up. ${esc(forest || 'Mostly open land')}.</p>
    <p>${seasonSentence(env, spot.lat, spot.lon)}</p>${agencyLine(spot.lat, spot.lon)}`;
}

function agencyLine(lat, lon) {
  const pk = A?.peakNear(lat, lon);
  if (pk == null) return '';
  return `<p>${esc(A.source)} predicts peak around <b>${fmtDate(dateOf(Math.round(pk), year))}</b> here; this forecast leans halfway toward theirs.</p>`;
}

function seasonSentence(env, lat, lon) {
  if (!W) return '';
  const parts = [];
  const shift = Math.round(env.shift + env.corr);
  if (Math.abs(env.weather.anomF) >= 1) parts.push(`${env.weather.anomF > 0 ? 'warmer' : 'cooler'} than normal by ${Math.abs(env.weather.anomF).toFixed(1)}°F`);
  if (env.weather.rain < M.drought.ratio) parts.push(`dry (${Math.round(env.weather.rain * 100)}% of normal rain)`);
  if (Math.abs(env.corr) >= 1 && lat != null) {
    const src = [];
    if (Math.abs(A.correctionAt(lat, lon)) >= 0.5) src.push(`${A.source}'s forecast`);
    if (Math.abs(R.correctionAt(lat, lon)) >= 0.5) src.push('color reports nearby');
    if (src.length) parts.push(`adjusted toward ${src.join(' and ')}`);
  }
  if (!parts.length) return 'This season is close to normal here.';
  const dir = shift === 0 ? 'about on schedule' : `${Math.abs(shift)} day${Math.abs(shift) === 1 ? '' : 's'} ${shift < 0 ? 'earlier' : 'later'} than usual`;
  return `This season: ${parts.join(', ')}, so color is running ${dir}.`;
}

// ---------- place search ----------
$('#place-form').onsubmit = async e => {
  e.preventDefault();
  const q = $('#place').value.trim();
  if (!q) return;
  const status = $('#place-status');
  status.className = 'status';
  status.textContent = 'Searching…';
  try {
    const p = new URLSearchParams({ q, format: 'json', limit: 1, countrycodes: 'us', viewbox: '-73.8,47.5,-66.8,40.9', bounded: 1 });
    const r = await fetch(`https://nominatim.openstreetmap.org/search?${p}`, { headers: { 'Accept-Language': 'en' } });
    const [hit] = await r.json();
    if (!hit) { status.textContent = 'No match in New England.'; return; }
    status.textContent = '';
    map.setView([+hit.lat, +hit.lon], 11);
    showSpot(+hit.lat, +hit.lon);
  } catch {
    status.className = 'status error';
    status.textContent = 'Search is unavailable right now.';
  }
};
$('#locate').onclick = () => {
  const status = $('#place-status');
  if (!navigator.geolocation) { status.textContent = 'Location is not available in this browser.'; return; }
  status.textContent = 'Finding you…';
  navigator.geolocation.getCurrentPosition(pos => {
    status.textContent = '';
    map.setView([pos.coords.latitude, pos.coords.longitude], 11);
    showSpot(pos.coords.latitude, pos.coords.longitude);
  }, () => { status.textContent = 'Could not get your location.'; });
};

// ---------- report link ----------
function reportURL(lat, lon, place = '') {
  const p = new URLSearchParams({
    template: 'foliage-report.yml', labels: 'foliage-report',
    title: `Color report: ${place || `${lat.toFixed(3)}, ${lon.toFixed(3)}`}`,
    location: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
    'date-seen': isoDate(today), place,
  });
  return `https://github.com/${REPO}/issues/new?${p}`;
}
function updateReportLink() {
  const c = map.getCenter();
  $('#report-link').href = reportURL(c.lat, c.lng);
}

// ---------- hike list ----------
function kindLabel(it) {
  return { trail: 'Trail', overlook: 'Drive-up overlook', drive: 'Scenic drive' }[it.kind];
}

function effortOf(it) {
  if (it.kind !== 'trail') return 'easy';
  if (it.rt < 3 && it.g < 500) return 'easy';
  if (it.rt < 7 && it.g < 1800) return 'moderate';
  return 'hard';
}

// forecast rows are [MM-DD, high, low, rain %, cloud %, code]
function forecastFor(it, i) {
  const fc = it.env.weather.fc;
  if (!fc?.length) return null;
  const md = isoDate(dateOf(todayDoy + i, year)).slice(5);
  return fc.find(row => row[0] === md) || null;
}

function bestSoon(it) {
  let best = null;
  for (let i = 0; i < 14; i++) {
    const d = todayDoy + i;
    if (d > SEASON_END) break;
    const date = dateOf(d, year);
    const s = peepScore(M, it.smp, d, it.view) * weatherFactor(forecastFor(it, i)) * crowdFactor(date, it.popular);
    if (!best || s > best.s) best = { d, s };
  }
  return best;
}

function passes(it) {
  if (grandma) {
    if (it.kind === 'trail' && it.gm < 60) return false;
    const kind = $('#kind').value;
    if (kind && it.kind !== kind) return false;
  } else {
    if (it.kind !== 'trail') return false;
    const eff = $('#effort').value;
    if (eff && effortOf(it) !== eff) return false;
    if ($('#views').checked && !it.view) return false;
  }
  const st = $('#state').value;
  if (st && it.s !== st) return false;
  if ($('#featured').checked && !it.ft && it.kind !== 'drive') return false;
  return true;
}

function renderList() {
  if (!items.length) return;
  const ul = $('#hike-list');
  const bounds = map.getBounds();
  const inView = $('#in-view').checked;
  const sort = $('#sort').value;
  const c = map.getCenter();
  let list = items.filter(it => passes(it) && (!inView || bounds.contains([it.lat, it.lon])));
  const year0 = year === today.getFullYear();
  for (const it of list) {
    it._day = peepScore(M, it.smp, day, it.view);
    if (grandma && it.kind === 'trail') it._day *= 0.7 + 0.3 * it.gm / 100;
    if (sort === 'soon') it._soon = year0 ? bestSoon(it) : null;
    if (sort === 'near') it._dist = map.distance(c, [it.lat, it.lon]);
  }
  if (sort === 'soon' && year0) list.sort((a, b) => (b._soon?.s ?? 0) - (a._soon?.s ?? 0));
  else if (sort === 'near') list.sort((a, b) => a._dist - b._dist);
  else list.sort((a, b) => b._day - a._day);

  const noun = grandma ? 'places' : 'hikes';
  $('#list-count').textContent = list.length
    ? `${list.length.toLocaleString()} ${noun}${inView ? ' on the map' : ''}${list.length > shown ? `, showing the top ${shown}` : ''}`
    : '';
  ul.innerHTML = '';
  if (!list.length) {
    ul.innerHTML = `<li class="empty" style="cursor:default">Nothing matches here. Zoom out, move the map or loosen the filters.</li>`;
  }
  for (const it of list.slice(0, shown)) {
    const st = stageOf(day - it.win.peak);
    const li = document.createElement('li');
    li.tabIndex = 0;
    let scoreHTML = `${Math.round(it._day)}<small>score</small>`;
    let when = `<span class="chip st-${st[0]}">${esc(st[1])}</span> · peak ~${fmtDate(dateOf(it.win.peak, year))}`;
    if (sort === 'soon' && it._soon) {
      scoreHTML = `${Math.round(it._soon.s)}<small>${fmtDow(dateOf(it._soon.d, year))}</small>`;
      when = `Best soon: <b>${fmtDate(dateOf(it._soon.d, year), true)}</b>`;
    }
    li.innerHTML = `
      <span class="name">${esc(it.ft?.title || it.n)}${it.ft ? '<span class="star" title="A classic">★</span>' : ''}</span>
      <span class="score">${scoreHTML}</span>
      <span class="sub">${esc(subline(it))}</span>
      <span class="when-tag">${when}</span>`;
    const open = () => openDetail(it);
    li.onclick = open;
    li.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
    ul.append(li);
  }
  $('#more').hidden = list.length <= shown;
}

function subline(it) {
  if (it.kind === 'drive') return `Scenic drive · ${it.mi} mi${it.min ? `, about ${fmtMinutes(it.min)}` : ''} · ${it.s}`;
  if (it.kind === 'overlook') return `Drive-up overlook · ${it.s}`;
  const bits = [];
  if (it.ft && it.ft.title !== it.n) bits.push(it.n);
  bits.push(it.part ? 'Flat, go as far as you like' : `${it.rt} mi ${it.loop ? 'loop' : 'round trip'}`);
  if (!it.part) bits.push(`${it.g.toLocaleString()} ft climb`);
  bits.push(it.park ? `${it.park}, ${it.s}` : it.s);
  return bits.join(' · ');
}

for (const id of ['#sort', '#state', '#effort', '#kind', '#in-view', '#views', '#featured']) {
  $(id).addEventListener('change', () => { shown = PAGE; renderList(); });
}
$('#more').onclick = () => { shown += PAGE; renderList(); };

// ---------- detail ----------
async function openDetail(it) {
  selected = it;
  $('#hike-list-view').hidden = true;
  $('#detail').hidden = false;
  history.replaceState(null, '', '#' + it.id);
  renderDetail(it);
  $('#detail').scrollIntoView?.({ block: 'start' });
  selLayer.clearLayers();
  L.circleMarker([it.lat, it.lon], { radius: 11, color: cssVar('--maple'), weight: 3, fill: false, renderer }).addTo(selLayer);
  if (it.kind === 'overlook') {
    map.setView([it.lat, it.lon], Math.max(map.getZoom(), 12));
    return;
  }
  try {
    geom ??= await getJSON('data/geom.json');
  } catch { return; }
  if (selected !== it) return;
  const lines = (geom[it.id] || []).map(decodePolyline);
  if (!lines.length) return;
  const pl = L.polyline(lines, { color: cssVar('--maple'), weight: it.kind === 'drive' ? 5 : 4, opacity: 0.9, renderer }).addTo(selLayer);
  map.fitBounds(pl.getBounds(), { maxZoom: 14, padding: [30, 30] });
}

function closeDetail() {
  selected = null;
  selLayer.clearLayers();
  history.replaceState(null, '', location.pathname + location.search);
  $('#detail').hidden = true;
  $('#hike-list-view').hidden = false;
  renderList();
}

function renderDetail(it) {
  const el = $('#detail');
  const st = stageOf(day - it.win.peak);
  const w = it.win;
  const score = Math.round(peepScore(M, it.smp, day, it.view));
  const name = it.ft?.title || it.n;
  const where = it.kind === 'trail'
    ? [it.ft && it.ft.title !== it.n ? it.n : '', it.park, it.s].filter(Boolean).join(' · ')
    : `${kindLabel(it)} · ${it.s}`;

  // a summit and its trailhead can be at different stages
  let spread = '';
  if (it.e && it.e[4] - it.e[0] > 150) {
    const top = samples(M, { ...it, e: [it.e[4]] }, it.env), bot = samples(M, { ...it, e: [it.e[0]] }, it.env);
    const pt = peakWindow(M, top).peak, pb = peakWindow(M, bot).peak;
    if (Math.abs(pt - pb) >= 3) spread = ` Up top it peaks around ${fmtDate(dateOf(pt, year))}; at the bottom, around ${fmtDate(dateOf(pb, year))}.`;
  }

  const facts = [];
  if (it.kind === 'trail') {
    facts.push(['Distance', it.part ? `${it.rt} mi round trip in full, but flat enough to turn back any time` : `${it.rt} mi ${it.loop ? 'loop' : 'out and back'}`]);
    facts.push(['Climb', `about ${it.g.toLocaleString()} ft in total`]);
    facts.push(['Elevation', `${ft(it.e[0]).toLocaleString()}–${ft(it.e[4]).toLocaleString()} ft`]);
    const surf = Object.entries(it.su).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${SURFACE[k] || k}${v < 0.95 ? ` ${Math.round(v * 100)}%` : ''}`).join(', ');
    facts.push(['Surface', surf]);
  } else if (it.kind === 'drive') {
    facts.push(['Drive', `${it.mi} mi${it.min ? `, about ${fmtMinutes(it.min)} without stops` : ''}`]);
    facts.push(['Elevation', `${ft(it.e[0]).toLocaleString()}–${ft(it.e[4]).toLocaleString()} ft`]);
  } else {
    facts.push(['Elevation', `${ft(it.elev).toLocaleString()} ft, looking over land from ${ft(it.e[0]).toLocaleString()} to ${ft(it.e[4]).toLocaleString()} ft`]);
  }
  facts.push(['Forest', it.f.filter(([, f]) => f >= 0.1).map(([c, f]) => `${FOREST_NAMES[c] || 'Other'} ${Math.round(f * 100)}%`).join(', ')]);
  if (it.v?.length) facts.push(['Views', it.v.filter(v => v !== 'Viewpoint').join(', ') || `${it.v.length} viewpoint${it.v.length > 1 ? 's' : ''}`]);
  if (it.pk?.length) facts.push(['Summits', it.pk.join(', ')]);

  const comfort = [];
  if (it.kind === 'trail') {
    if (it.su.paved >= 0.5) comfort.push(['Paved', true]);
    else if ((it.su.paved || 0) + (it.su.smooth || 0) >= 0.5) comfort.push(['Smooth surface', true]);
    if (it.loop) comfort.push(['Loop', true]);
    if (it.part) comfort.push(['Flat: turn back any time', true]);
    if (it.b) comfort.push([`${it.b} bench${it.b > 1 ? 'es' : ''} mapped`, true]);
    comfort.push([it.t ? 'Restroom near the start' : 'No restroom mapped', it.t]);
    comfort.push([it.p ? 'Parking near the start' : 'No parking mapped', it.p]);
    if (it.wc === 'yes') comfort.push(['Wheelchair accessible', true]);
    if (it.wc === 'no') comfort.push(['Not wheelchair accessible', false]);
    if ((it.su.rough || 0) + (it.su.steps || 0) > 0.05) comfort.push(['Rough or stepped sections', false]);
  } else if (it.kind === 'overlook') {
    comfort.push([it.p ? 'Parking at the view' : 'Roadside pull-off', true]);
  }

  // next two weeks
  let days = '';
  if (year === today.getFullYear() && todayDoy <= SEASON_END) {
    const cells = [];
    let best = -1, bestI = -1;
    for (let i = 0; i < 16; i++) {
      const d = todayDoy + i;
      const date = dateOf(d, year);
      const fc = forecastFor(it, i);
      const s = peepScore(M, it.smp, d, it.view) * weatherFactor(fc) * crowdFactor(date, it.popular);
      if (i < 14 && s > best) { best = s; bestI = i; }
      cells.push({ d, date, fc, s });
    }
    days = `<h3 class="mini">Next two weeks</h3><div class="days">` + cells.map((c, i) => `
      <div class="day${i === bestI ? ' best' : ''}" title="${esc(fmtDate(c.date, true))}">
        <b>${fmtDow(c.date)}</b>${c.date.getDate()}
        ${c.fc ? `<br>${c.fc[1]}°<br><span class="rain">${c.fc[3] ?? 0}%</span>` : ''}
        <div class="bar" style="--o:${(0.15 + 0.85 * Math.min(1, c.s / 100)).toFixed(2)}"></div>
      </div>`).join('') + `</div>
      <p class="note">High temperature and chance of rain. <b>Best day:</b> ${bestI >= 0 ? fmtDate(cells[bestI].date, true) : '—'}, counting color, weather and ${it.popular ? 'weekend crowds (this one is popular)' : 'weekend crowds'}.</p>`;
  }

  const q = encodeURIComponent(`${it.n} ${it.park || ''} ${STATE_NAMES[it.s]}`.trim());
  const links = [`<a class="secondary button" href="https://www.google.com/maps/dir/?api=1&destination=${it.lat},${it.lon}" target="_blank" rel="noopener">Directions to the start</a>`];
  if (it.kind === 'trail') {
    links.push(`<a class="secondary button" href="https://www.google.com/search?q=site%3Aalltrails.com+${q}" target="_blank" rel="noopener">Find on AllTrails</a>`);
    links.push(`<a class="secondary button" href="https://www.openstreetmap.org/way/${it.id.slice(1)}" target="_blank" rel="noopener">OpenStreetMap</a>`);
  } else if (it.kind === 'overlook') {
    // osmium area ids are 2 × way id, or 2 × relation id + 1
    const n = +it.id.slice(1);
    const osm = it.id[0] === 'n' ? `node/${n}` : n % 2 ? `relation/${(n - 1) / 2}` : `way/${n / 2}`;
    links.push(`<a class="secondary button" href="https://www.openstreetmap.org/${osm}" target="_blank" rel="noopener">OpenStreetMap</a>`);
  }
  links.push(`<a class="secondary button" href="${reportURL(it.lat, it.lon, it.ft?.title || it.n)}" target="_blank" rel="noopener">Report color here</a>`);

  el.innerHTML = `
    <div class="detail">
      <button class="ghost back" id="back">← Back to the list</button>
      <h2>${esc(name)}</h2>
      <p class="where">${esc(where)}</p>
      <div id="detail-photo">${photoHTML(cachedPhoto(it), true)}</div>
      ${it.ft ? `<p class="blurb">${esc(it.ft.blurb)}</p>` : it.blurb ? `<p class="blurb">${esc(it.blurb)}</p>` : ''}
      ${grandma && (it.ft?.gnote || it.note) ? `<p class="gnote">${esc(it.ft?.gnote || it.note)}</p>` : ''}
      <div class="verdict">
        <p class="big"><span class="chip st-${st[0]}">${esc(st[1])}</span> on ${fmtDate(dateOf(day, year))} · score ${score}</p>
        <p>Best from <b>${fmtDate(dateOf(w.from, year))}</b> to <b>${fmtDate(dateOf(w.to, year))}</b>, peaking around <b>${fmtDate(dateOf(w.peak, year))}</b>.${spread}</p>
        ${curveSVG(it)}
        <div class="curve-axis"><span>Sep 1</span><span>Oct 1</span><span>Nov 1</span></div>
        <p style="margin-top:6px">${seasonSentence(it.env, it.lat, it.lon)}</p>
        ${agencyLine(it.lat, it.lon)}
      </div>
      ${days}
      ${comfort.length ? `<ul class="comfort">${comfort.map(([t, ok]) => `<li class="${ok ? '' : 'no'}">${esc(t)}</li>`).join('')}</ul>` : ''}
      <dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      ${!grandma && it.note ? `<p class="note">${esc(it.note)}</p>` : ''}
      <div class="links">${links.join('')}</div>
      <p class="note">${it.kind === 'trail' ? 'Built from OpenStreetMap trail segments with this name; distance and climb are estimates. ' : ''}Check conditions, closures and parking before you go.</p>
    </div>`;
  $('#back').onclick = closeDetail;
  if (cachedPhoto(it) === undefined) photoFor(it).then(p => { if (selected === it && p) $('#detail-photo').innerHTML = photoHTML(p, true); });
}

const SURFACE = { paved: 'Paved', smooth: 'Gravel or packed', natural: 'Dirt', rough: 'Rocky or rough', steps: 'Steps', unknown: 'Not mapped' };
const STATE_NAMES = { CT: 'Connecticut', MA: 'Massachusetts', ME: 'Maine', NH: 'New Hampshire', RI: 'Rhode Island', VT: 'Vermont' };

function curveSVG(it) {
  const s = it.win.series, n = s.length, max = Math.max(...s, 0.01);
  const W_ = 300, H_ = 80;
  const x = i => (i / (n - 1)) * W_;
  const y = v => H_ - 4 - (v / max) * (H_ - 10);
  const path = s.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const a = x(it.win.from - SEASON_START), b = x(it.win.to - SEASON_START);
  const dx = x(day - SEASON_START);
  const tx = x(todayDoy - SEASON_START);
  const showToday = year === today.getFullYear() && todayDoy >= SEASON_START && todayDoy <= SEASON_END;
  const oct1 = x(274 - SEASON_START), nov1 = x(305 - SEASON_START);
  return `<svg class="curve" viewBox="0 0 ${W_} ${H_}" preserveAspectRatio="none" role="img" aria-label="Share of leaves in color through the season">
    <rect x="${a}" y="0" width="${Math.max(2, b - a)}" height="${H_}" fill="var(--maple)" opacity="0.12"/>
    <line x1="${oct1}" x2="${oct1}" y1="0" y2="${H_}" stroke="var(--line)"/>
    <line x1="${nov1}" x2="${nov1}" y1="0" y2="${H_}" stroke="var(--line)"/>
    <path d="${path} L${W_},${H_} L0,${H_}Z" fill="var(--maple)" opacity="0.18"/>
    <path d="${path}" fill="none" stroke="var(--maple)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    ${showToday ? `<line x1="${tx}" x2="${tx}" y1="0" y2="${H_}" stroke="var(--ink-soft)" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>` : ''}
    <line x1="${dx}" x2="${dx}" y1="0" y2="${H_}" stroke="var(--ink)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

// ---------- about ----------
function fillAbout() {
  const fit = M.fit;
  if (fit) {
    $('#fit-note').textContent = `Calibrated against ${fit.n.toLocaleString()} USA National Phenology Network maple observations (${fit.years}): color comes about ${Math.abs(M.bElev).toFixed(1)} days earlier per 1,000 ft of elevation and ${Math.abs(M.bLat).toFixed(1)} days earlier per degree north. Individual trees vary a lot (±${Math.round(fit.rmseDays)} days), which is why the map shows whole hillsides rather than single trees.`;
  }
  if (W?.points?.length) {
    const avg = W.points.reduce((s, p) => s + p.anomF, 0) / W.points.length;
    const dry = W.points.filter(p => p.rain < M.drought.ratio).length;
    $('#season-note').textContent = `So far this season New England is averaging ${Math.abs(avg).toFixed(1)}°F ${avg >= 0 ? 'warmer' : 'cooler'} than normal${dry ? `, and ${Math.round((100 * dry) / W.points.length)}% of the region is in a dry spell` : ''}.`;
  }
  if (A?.pts.length) {
    const avg = A.pts.reduce((s, p) => s + p.resid, 0) / A.pts.length;
    $('#agency-note').textContent = `This season DCR's dates average ${Math.abs(avg).toFixed(0)} days ${avg >= 0 ? 'later' : 'earlier'} than our own model across ${A.pts.length} areas.`;
  }
  if (meta?.updated) {
    $('#updated').textContent = `Weather and reports last updated ${new Date(meta.updated).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}. ${meta.reports ? `${meta.reports} color reports in the last month.` : ''}`;
  }
  $('#year').textContent = today.getFullYear();
  $('#source-link').href = `https://github.com/${REPO}`;
}

function buildLegend() {
  $('#legend').innerHTML = STAGES.map(([k, label]) => `<span class="chip st-${k}">${label}</span>`).join('');
}

// ---------- tabs ----------
const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(tab) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $('#' + t.getAttribute('aria-controls')).hidden = !on;
  }
  if (tab.id === 'tab-hikes' && !selected) renderList();
}
tabs.forEach((t, i) => {
  t.onclick = () => selectTab(t);
  t.onkeydown = e => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (d) { const n = tabs[(i + d + tabs.length) % tabs.length]; selectTab(n); n.focus(); }
  };
});

// ---------- helpers ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function ft(m) { return Math.round(m * 3.28084 / 10) * 10; }
function fmtDate(d, withDow = false) {
  return d.toLocaleDateString('en-US', withDow ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' });
}
function fmtDow(d) { return d.toLocaleDateString('en-US', { weekday: 'short' }); }
function fmtMinutes(m) { return m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr ${m % 60 ? `${m % 60} min` : ''}`.trim(); }
function isoDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function relDay(n) {
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}
function decodePolyline(str) {
  let i = 0, lat = 0, lng = 0;
  const out = [];
  while (i < str.length) {
    for (const k of [0, 1]) {
      let b, shift = 0, result = 0;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const v = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += v; else lng += v;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

updateReportLink();
init();
