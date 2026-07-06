#!/usr/bin/env python3
"""Shard systems3d.json into per-region files for the static site.

Output layout (all under site/data/):
  index.json                      -> {regions:[{name,systems,slug}], generated}
  systems/<slug>.json             -> {region, systems:[ <raw system record>, ... ]}
  summaries/<slug>.json           -> {region, systems:[ {id,name,region,security,gates,planets,moons} ]}

The frontend loads index.json once, then a region's summaries for the dropdown,
then the full systems shard for that region only when a system is selected.
Global system ids are assigned in load order so they're stable across shards.
"""
import json, os, re, sys, hashlib, datetime

SRC = os.environ.get('SYSTEMS3D_PATH', 'data/systems3d.json')
OUT = os.environ.get('SITE_DATA', 'site/data')

def slugify(name):
    s = re.sub(r'[^a-z0-9]+', '-', (name or 'unknown').lower()).strip('-')
    return s or 'unknown'

def main():
    with open(SRC, 'r', encoding='utf-8') as f:
        raw = json.load(f)
    systems = raw.get('systems', raw) if isinstance(raw, dict) else raw

    os.makedirs(os.path.join(OUT, 'systems'), exist_ok=True)
    os.makedirs(os.path.join(OUT, 'summaries'), exist_ok=True)

    # Group by region, assigning a stable global id in load order.
    by_region = {}
    for gid, s in enumerate(systems):
        region = s.get('region') or 'Unknown'
        by_region.setdefault(region, []).append((gid, s))

    # Resolve slug collisions deterministically.
    slugs = {}
    used = set()
    for region in sorted(by_region.keys(), key=lambda r: r.lower()):
        base = slugify(region)
        slug = base
        n = 2
        while slug in used:
            slug = f'{base}-{n}'; n += 1
        used.add(slug)
        slugs[region] = slug

    index_regions = []
    for region, items in by_region.items():
        slug = slugs[region]
        full = {'region': region, 'systems': [s for _, s in items]}
        # Attach the stable global id to each record so the frontend can key on it.
        for (gid, s) in items:
            s['_id'] = gid
        summaries = {'region': region, 'systems': [
            {'id': gid, 'name': s.get('name', f'system-{gid}'), 'region': region,
             'security': s.get('security'), 'gates': len(s.get('gates', [])),
             'planets': len(s.get('planets', [])), 'moons': len(s.get('moons', []))}
            for (gid, s) in items]}
        with open(os.path.join(OUT, 'systems', f'{slug}.json'), 'w', encoding='utf-8') as f:
            json.dump(full, f, separators=(',', ':'))
        with open(os.path.join(OUT, 'summaries', f'{slug}.json'), 'w', encoding='utf-8') as f:
            json.dump(summaries, f, separators=(',', ':'))
        index_regions.append({'name': region, 'slug': slug, 'systems': len(items)})

    # Sort regions: The Forge first (Jita), then alphabetical — matches old app.py.
    index_regions.sort(key=lambda x: (0 if x['name'] == 'The Forge' else 1, x['name'].lower()))
    index = {'regions': index_regions,
             'total_systems': len(systems),
             'generated': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, separators=(',', ':'))

    total_bytes = 0
    for root, _, files in os.walk(OUT):
        for fn in files:
            total_bytes += os.path.getsize(os.path.join(root, fn))
    print(f'Sharded {len(systems)} systems into {len(index_regions)} regions.')
    print(f'Output: {OUT}  ({total_bytes/1e6:.1f} MB total)')
    biggest = max(index_regions, key=lambda x: x['systems'])
    print(f'Largest region: {biggest["name"]} ({biggest["systems"]} systems)')

if __name__ == '__main__':
    main()
