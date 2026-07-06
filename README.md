# Not Today Machariel!

A browser tool for finding and testing **anti-smartbomb shared bookmarks** in EVE Online.

Pick a system, tune a clearance threshold, and drag a bookmark around a 3D map of
the system to find perch positions that keep your warp-in vector clear of gate
camps — before a smartbombing Machariel on the other side of a gate turns your
ship into fireworks.

It runs entirely in your browser. No account, no download, no server.

---

## What problem it solves

A common gank on a gate is the **smartbomb camp**: a battleship (classically a
Machariel) sits cloaked near a gate and detonates area-of-effect smartbombs the
instant something lands, before it can react. If your shared fleet bookmark sits
on a straight line between two gates, everyone warping that route lands in the
same predictable spot — easy pickings.

The defense is a bookmark placed *off* the natural warp lines, so your warp-in
approach vector doesn't line up with where a threat would sit. Working out where
that is, by eye, in three dimensions, is hard. This tool does the geometry for you.

## How to read the map

- **Blue region** — the *reachable* space: everywhere you can actually build a
  bookmark using in-game warp-to-and-bookmark maneuvers between celestial objects.
- **Green region** — the *allowed* space: the subset of reachable positions that
  clear your current angle **threshold** (see below).
- **Black star** — your candidate shared bookmark. Drag it anywhere on the map.
  It snaps to the nearest *buildable* position and shows you the exact warp steps
  to create it in-game.
- **Coloured squares** — stargates. **Purple/orange dots** — planets and moons.
  Hover anything for details.

Rotate the view by dragging empty space. Use **2D view** and **Lay flat** to
orient a system's plane toward you.

## What "clearance" actually means

Clearance is the angle between your **warp-in vector to a gate** and the direction
from that gate to **every other gate** in the system. A high clearance angle means
your approach doesn't line up with a threat camping a different gate.

The **threshold** slider (5°–45°) sets how much clearance you require. Raising it
shrinks the green region toward the safest positions.

**Important honesty note:** in a system with only **one gate**, this metric is
**undefined — not "safe."** With no second gate there's no angle to measure
against, but a hostile can still camp the lone gate and catch an aligned warp-in.
The tool says *"not evaluated"* in that case and does **not** imply you're clear.
Treat it as a geometry aid, not a safety guarantee — your own judgement and
d-scan still matter.

## Using it

1. Open the site.
2. Choose a **region**, then a **system**.
3. Adjust the **threshold** to taste.
4. Drag the **black star** to explore positions; read off the warp steps to build
   the bookmark in-game.
5. Hit **Re-pick** to sample a different candidate at the same threshold.

---

## For developers

The site is fully static — safe to fork, host anywhere, or run offline.

### Structure

```
index.html      entry point
app.js          UI, 3D projection, rendering, interaction (ES module)
solver.js       the geometry engine (ES module)
style.css       styles
data/
  index.json            list of regions
  summaries/<slug>.json per-region system lists (for the dropdown)
  systems/<slug>.json   per-region celestial body positions
```

Only celestial **body positions** are shipped as data. Everything else — the
buildable bookmark pool, the reachable point cloud, the convex-hull silhouettes,
and all clearance angles — is computed in the browser by `solver.js` when you
select a system. This keeps the whole dataset small even at full-map scale.

### Run locally

ES modules require HTTP (they won't load from `file://`):

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

### Regenerating the data

If you have an updated `systems3d.json` (sun / planets / moons / gates per
system), reshard it:

```bash
SYSTEMS3D_PATH=path/to/systems3d.json SITE_DATA=data python3 build/shard.py
```

### Performance

Building a system's geometry takes ~100 ms (once, then cached). Re-solving on a
threshold change or re-pick is a few milliseconds — there's no network round-trip,
so the slider and drag are instant.

---

## Support

If the tool saved your ship, the author **Kahre** appreciates a token ISK
donation in-game — even a single ISK is a nice sign someone found it useful.

## Disclaimer

This is a fan-made tool. It models gate-to-gate warp-in geometry only; it cannot
see cloaked ships, bubbles, d-scan, or anything happening live in your system. Use
it to plan smarter bookmarks, not as a guarantee of safety. Fly safe. o7

EVE Online is a registered trademark of CCP hf. This project is not affiliated
with or endorsed by CCP.
