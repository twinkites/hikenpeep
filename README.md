# Hike and Peep

Do you like hiking and leaf peeping (AKA going to look at the changing leaves)? 



Here is a static web app for GitHub Pages that predicts when New England's fall foliage will peak, and provides the best day to hike each trail.

- **Peak map.** A 4 km forecast grid over all six states, colored by stage (mostly green, patchy, near peak, peak, past peak, leaves down) for any day from September 1 to November 20. Tap a spot to see its predicted peak and window. A table gives the outlook for 16 well-known areas.
- **Hikes.** About 15,000 hikes built from OpenStreetMap, each with a color curve for the season. Sort by color on a chosen day, or by the best day in the next two weeks once rain, cloud cover and weekend crowds are counted. Each hike shows its window, where the summit and trailhead differ, distance, climb, surface, forest type and views, with links for directions, AllTrails search (which honestly is a much better interface, please use them!) and OpenStreetMap. Forty-three classic foliage hikes are starred.
- **Grandma mode.** Bigger type, and only short or flat walks with easy surfaces, about 970 drive-up overlooks and 21 scenic drives. Benches, restrooms, parking, loops and wheelchair access are shown for each walk. For that extra special grandma in your life. 
- **Color reports.** Anyone with a GitHub account can report what the leaves look like. Each report becomes an issue, and reports from the last 12 days nudge the forecast nearby.

Everything the browser needs is in `data/`. A nightly GitHub Action refreshes the weather and reports. A monthly one rebuilds trails and refits the model.

## How the forecast works

1. **Normal-year peak.** For a grid square or a point on a trail:
   `peak = b0 + bLat·(lat − 42) + bElev·(ft above 1,000) / 1,000 + coastDays·e^(−km to ocean / 15)`.
   `pipeline/calibrate.py` fits the latitude, elevation and coast slopes to about 2,500 USA National Phenology Network observations of red and sugar maples in New England (2010–2025). Each slope is blended with a prior from regional foliage reporting. The intercept (October 12 at 42°N and 1,000 ft) is a prior: NPN's "colored leaves" period describes single trees, not a hillside at its best. With the current fit, color comes about 7 days earlier per 1,000 ft and 2 days earlier per degree north.
2. **Forest type.** The USDA Forest Service BIGMAP forest type group raster (30 m, sampled at about 300 m) shifts timing by type and sets how vivid a place can get. Maple, beech and birch are the baseline. Oak and hickory peak about 6 days later and are less vivid; spruce and fir add little color.
3. **This season.** `pipeline/daily.py` compares this season's temperatures and rainfall with a 2016–2025 climatology from Open-Meteo, at 52 points across the region. Each °F warmer than normal over September 1 to October 20 (including the next 7 days of forecast) delays peak by 1.2 days, capped at −6 to +9 days. Less than 60% of normal rain over the last 60 days brings peak 3 days earlier and makes color 15% less vivid.
4. **State forecasts.** In Massachusetts, the Department of Conservation and Recreation publishes a week-by-week stage forecast for about 700 forest-type polygons (the [interactive fall foliage map](https://www.mass.gov/news/dcr-unveils-2026-interactive-fall-foliage-map); data from the `Foliage_Predictions` ArcGIS layer). `daily.py` turns each polygon's forecast into a peak date (the middle of its "Peak" weeks), pooled into about 185 points. Within about 12 km of those points, the model moves halfway toward DCR's date. At the start of the 2026 season, DCR's dates were about 9 days later than our model on average, so this shift is noticeable in eastern Massachusetts.
5. **Reports.** Each report implies a peak date: "near peak" means about 4 days away, "past peak" about 6 days ago, and so on. The difference from the model is spread over about 30 km with a Gaussian weight, and shrunk toward zero (`Σw·Δ / (Σw + 1)`), so one report moves the forecast only part of the way.
6. **Scores.** A hike's elevation range is split into quantiles and crossed with its forest mix, and each piece gets its own peak date. Its color on a day is the weighted share of those pieces near peak, using a curve that rises over about 9 days and falls over about 6.5. Score = 100 × color × (0.35 + 0.65 × vividness), × 0.85 when there's no view or summit. In the two-week planner, a 100% chance of rain cuts the score by 45%, full cloud by 15%, weekends by 7–15%, and Indigenous Peoples' Day weekend by 15–25%. Popular hikes take the larger crowd penalties.

The model runs in the browser (`js/model.js`), so the map, list and details always agree. `node --test tests/` checks it against normal-year peak windows for seven reference places, and both workflows run these checks before committing.

## Grandma mode rules

A trail qualifies (score ≥ 60 of 100) when:
- the round trip is under 3 mi with under 450 ft of climbing, and
- under 15% of its length is rocky, rooty, stepped or graded as mountain hiking.

A flat out-and-back (under 60 ft of climb per mile) of any length also counts, because you can turn around whenever you like.

Paved or smooth surfaces, benches, restrooms within 300 m of the start, parking within 400 m, wheelchair tags, loops and views raise the score. Unmapped surfaces lower it.

An overlook counts as drive-up if a public road passes within about 100 m or a parking lot is within 150 m.

The scenic drives and the grandma notes on classic hikes are curated in `pipeline/curated/`.

## Data pipeline

```sh
python -m venv .venv && . .venv/bin/activate
pip install -r pipeline/requirements.txt
cd pipeline
python build_static.py      # ~2 min plus downloads: Geofabrik extracts (~800 MB), terrain tiles, forest raster
python climatology.py       # once a year: 10 years of late-season weather from Open-Meteo's archive
python calibrate.py         # fit the model to NPN observations; writes data/model.json
python daily.py             # weather and reports; needs GITHUB_REPOSITORY (and GITHUB_TOKEN) for reports
```

Downloads are cached in `pipeline/.cache/` (git-ignored).

Hikes are connected OpenStreetMap ways with the same name. They're kept if they're inside a park or protected area, or if they're a path at least 0.5 mi long. A hike starts at the end nearest a parking lot, or else the lowest end. Distance assumes an out-and-back unless the trail is a loop. Climb counts every ascent in both directions, using 30 m terrain at zoom 12.

## Files

```
index.html                 page
css/style.css              styles
js/app.js                  map, outlook, hike list, detail view, grandma mode
js/model.js                the foliage model (pure functions)
js/photos.js               finds a Wikimedia Commons photo for a place, on demand
js/config.js               GitHub repo for color reports
img/twinkites-logo.png     Twin Kites mark (used as a CSS mask so it follows the theme)
data/                      everything the page loads (written by the pipeline)
pipeline/build_static.py   trails, overlooks, drives, forecast grid
pipeline/osm_extract.py    reads Geofabrik extracts with pyosmium
pipeline/calibrate.py      fits the model to NPN observations
pipeline/climatology.py    10-year weather normals (writes pipeline/climatology.json)
pipeline/daily.py          nightly weather, color reports and the Massachusetts DCR forecast
pipeline/curated/          scenic drives and classic hikes, written by hand
tests/model.test.mjs       model sanity checks (node --test tests/)
.github/workflows/         nightly and monthly data jobs
.github/ISSUE_TEMPLATE/    the color report form
```

## Why not AllTrails?

AllTrails has no public API, and its terms don't allow scraping. Hike and Peep builds its own trail data from OpenStreetMap, and each trail links to an AllTrails search so you can read recent reviews there. We love using Alltrails, and hope you use them.

## Credits

Trails, parks and points of interest © OpenStreetMap contributors (ODbL), via Geofabrik. Base map © OpenStreetMap contributors. Forest type groups: USDA Forest Service FIA BIGMAP. Elevation: Terrain Tiles on AWS (USGS 3DEP and others). Weather: Open-Meteo (CC BY 4.0), including ERA5 reanalysis. Massachusetts foliage forecast: Department of Conservation and Recreation. Phenology: USA National Phenology Network. Photos: Wikimedia Commons contributors (each credited with its license). Driving routes: OSRM. State outlines: US Census Bureau TIGERweb. Place search by Nominatim.

© Twin Kites LLC, [twinkites.com](https://twinkites.com)
