# Not Today Machariel — static build

Fully client-side version of the anti-smartbomb bookmark tool. No server: the
per-system solve (buildable pool, hit-and-run reachable cloud, per-gate
clearance) runs in the browser in `solver.js`, a direct port of `solver.py`.

## Layout

```
index.html      entry point (loads app.js as an ES module)
app.js          UI + rendering; data layer calls solver.js instead of a Flask API
solver.js       port of solver.py — pool, cloud, hull equations, clearance
style.css       (copy your existing stylesheet here)
ntm_logo.svg    (copy your existing logo here)
data/
  index.json            list of regions {name, slug, systems}
  summaries/<slug>.json dropdown data per region (name, sec, gate/planet counts)
  systems/<slug>.json   raw body positions per region (sun/planets/moons/gates)
```

Only body positions are shipped — clouds and pools are generated in-browser, so
the repo stays small even with thousands of systems.

## Build the data shards

From the project root (where `data/systems3d.json` is), with the build script
one level up in `build/shard.py`:

```bash
SYSTEMS3D_PATH=data/systems3d.json SITE_DATA=site/data python3 build/shard.py
```

This writes `index.json`, `summaries/`, and `systems/` under `site/data/`.
Global system ids are assigned in load order and are stable across shards.

## Run locally

ES modules need HTTP (they won't load over `file://`):

```bash
cd site && python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy to GitHub Pages

1. Put the contents of `site/` at the repo root (or in `/docs`).
2. Copy your `style.css` and `ntm_logo.svg` into it.
3. In repo Settings → Pages, set the source branch/folder.
4. Because paths are relative (`./app.js`, `data/...`), it works under the
   `username.github.io/repo/` subpath with no config.

## Notes on the port

- **Clearance is exact.** The gate-to-gate clearance metric (the safety number)
  is identical to the Python backend to full precision.
- **The picked bookmark is exact.** `single` and per-gate recipe picks match.
- **The interior cloud differs by sampling noise.** Hit-and-run uses a JS PRNG
  (mulberry32 + Box–Muller) rather than Python's Mersenne Twister, so the ~4800
  interior points aren't the same draws — the allowed/reachable *counts* differ
  by ~1–2%. The hull silhouette is pinned by the true body vertices, so its
  shape is unchanged.
- **Performance:** ~100 ms to build a system's geometry (once, cached), then
  ~3–9 ms per solve. Threshold slider and re-pick are instant — no network.
