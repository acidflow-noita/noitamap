#!/usr/bin/env python3
"""Offline area audit. No image generation, servers, sampling or deployment.

Every source record and connected chunk component is accounted for. The SVG
paths describe logical chunk ownership, not pixel-perfect terrain borders.
The JSON retains cells/runs so holes and disconnected areas never become one
bounding-box hit. Source-art rectangles/marker points stay explicitly unready.
"""
import argparse
import csv
import hashlib
import html
import json
import re
from collections import Counter, deque
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CHUNK, COLUMNS, ROWS = 512, 70, 48
ORIGIN_X, ORIGIN_Y = -17920, -7168


def read(name):
    return json.loads((ROOT / name).read_text())


def rings(path):
    tokens = re.findall(r'[MLZ]|-?\d+(?:\.\d+)?', path)
    if re.sub(r'[MLZ\d\s.\-]', '', path):
        raise ValueError('Unsupported boundary path')
    result, current, i = [], [], 0
    while i < len(tokens):
        command = tokens[i]; i += 1
        if command == 'Z':
            assert len(current) >= 3
            result.append(current); current = []
        else:
            assert command in ('M', 'L')
            x, y = float(tokens[i]), float(tokens[i + 1]); i += 2
            assert x.is_integer() and y.is_integer()
            if command == 'M': assert not current
            current.append((int(x), int(y)))
    assert not current
    return result


def inside(ring, x, y):
    result = False
    for (ax, ay), (bx, by) in zip(ring, ring[1:] + ring[:1]):
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
            result = not result
    return result


def cells_for(paths):
    xs = [x for ring in paths for x, y in ring]
    ys = [y for ring in paths for x, y in ring]
    return {(x, y) for y in range(min(ys), max(ys))
            for x in range(min(xs), max(xs))
            if sum(inside(r, x + .5, y + .5) for r in paths) % 2}


def components(cells):
    todo, output = set(cells), []
    while todo:
        first = min(todo, key=lambda p: (p[1], p[0]))
        todo.remove(first); queue = deque([first]); part = {first}
        while queue:
            x, y = queue.popleft()
            for point in [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)]:
                if point in todo:
                    todo.remove(point); part.add(point); queue.append(point)
        output.append(part)
    return output


def row_runs(cells):
    runs = []
    for x, y in sorted(cells, key=lambda p: (p[1], p[0])):
        if runs and runs[-1][0] == y and runs[-1][2] == x:
            runs[-1][2] += 1
        else: runs.append([y, x, x + 1])
    return runs


def bbox(cells, origin_y=ORIGIN_Y):
    x0, x1 = min(x for x, y in cells), max(x for x, y in cells) + 1
    y0, y1 = min(y for x, y in cells), max(y for x, y in cells) + 1
    return dict(x=ORIGIN_X + x0 * CHUNK, y=origin_y + y0 * CHUNK,
                width=(x1 - x0) * CHUNK, height=(y1 - y0) * CHUNK)


def test_geometry():
    hole = cells_for(rings('M 0 0 L 4 0 L 4 4 L 0 4 Z M 1 1 L 3 1 L 3 3 L 1 3 Z'))
    assert len(hole) == 12 and len(components(hole)) == 1
    assert (1, 1) not in hole and (3, 3) in hole
    assert len(components({(0, 0), (1, 1)})) == 2
    assert len(components({(0, 0), (1, 0)})) == 1
    assert row_runs({(0, 0), (1, 0), (3, 0), (0, 1)}) == [[0, 0, 2], [0, 3, 4], [1, 0, 1]]


def curate(areas, english, capture):
    """Explicit semantic decisions; never promote all connected components.

    Normalize source runs to the capture origin before unioning across realms.
    A union retains holes; its bounding rectangle is only a viewing aid.
    Unassigned records remain visible in the audit, not invented puzzle areas.
    """
    config = read('build_scripts/guessr/area-curation.json')
    by_id = {a['id']: a for a in areas}
    ownership, puzzles = {}, []
    assert set(config['scoringProfiles']) == {'easy', 'normal', 'hard'}

    def score_policy(rule, members=()):
        temple = any(a.get('engine') in config['easyTempleEngines'] for a in members)
        tier = rule.get('difficultyTier', 'easy' if temple else 'normal')
        assert tier in config['scoringProfiles']
        score = rule.get('scoreOverride', config['scoringProfiles'][tier])
        assert score['area'] + score['position'] == score['maximum'] == 5000
        if condition := rule.get('difficultyRule'):
            assert condition['kind'] == 'initial-view-snow'
            assert condition['unknown'] == 'requires-review' and condition['frozenForRound'] is True
            variants = {t: config['scoringProfiles'][t] for t in [condition['withSnow'], condition['withoutSnow']]}
            # A pending snow classification must not silently become Normal
            # or Hard, and later travel must not change the initial score split.
            return dict(difficultyTier=None, scoring=None, difficultyRule=condition, scoringVariants=variants)
        return dict(difficultyTier=tier, scoring=score, scoreOverride='scoreOverride' in rule)

    for a in areas:
        if a.get('engine') in config['easyTempleEngines']:
            a.update(score_policy({}, [a]))
    for identifier, reason in config['excludedSources'].items():
        by_id[identifier].update(status='excluded', reason=reason)
    groups = list(config['groups'])
    for engine, reason in config['singleAreas'].items():
        matches = [a for a in areas if a.get('engine') == engine and a['realm'] == 'main']
        assert len(matches) == 1, f'Explicit single-area rule needs review: {engine}'
        a = matches[0]
        groups.append(dict(id=f'biome/{engine}', label=a['label'], nameKey=a['translationKey'],
                           sourceIds=[a['id']], reason=reason))
    mountain_engines = {'temple_wall', 'temple_altar_left', 'temple_altar',
                        'temple_altar_right', 'temple_altar_right_snowcastle'}
    for depth, row in enumerate(config['holyMountainRows'], 1):
        members = [a['id'] for a in areas if a['realm'] == 'main' and a.get('engine') in mountain_engines
                   and all(y == row for y, x0, x1 in a['runs'])]
        assert len(members) == 5, (row, members)
        groups.append(dict(id=f'landmark/holy-mountain-{depth}', nameKey='biome_holymountain',
                           qualifier=f'depth {depth}', sourceIds=members,
                           difficultyTier='normal', scoreOverride=config['holyMountainScoreOverride'],
                           reason='One Holy Mountain at this depth, including its wall, altar and exit pieces. Normal tier with the explicit 1500 area / 3500 proximity split. The seventh, lowest Holy Mountain beside Kolmi is a separate Easy exception.'))
    for rule in groups:
        identifiers = set(rule.get('sourceIds', []))
        if match := rule.get('match'):
            selected = [a['id'] for a in areas if a.get('runs')
                        and ('engines' not in match or a.get('engine') in match['engines'])
                        and ('realms' not in match or a['realm'] in match['realms'])]
            assert selected, rule['id']
            identifiers.update(selected)
        assert identifiers, rule['id']
        cells, members = set(), []
        for identifier in sorted(identifiers):
            a = by_id[identifier]
            assert a.get('runs'), f'Cannot invent a mask from a marker or recipe: {identifier}'
            assert a['status'] != 'excluded', f'Excluded source grouped: {identifier}'
            assert identifier not in ownership, f'Source assigned twice: {identifier}'
            assert (a['originY'] - capture['originY']) % CHUNK == 0
            dy = (a['originY'] - capture['originY']) // CHUNK
            part = {(x, y + dy) for y, x0, x1 in a['runs'] for x in range(x0, x1)}
            assert not cells.intersection(part), identifier
            cells.update(part)
            ownership[identifier] = rule['id']
            a['puzzleAreaId'] = rule['id']
            members.append(a)
        key = rule.get('nameKey')
        if key:
            assert key in english, f'Missing original game name: {key}'
            name = english[key]
        else: name = rule['label']
        if rule.get('label') and rule['label'] != name:
            assert rule.get('labelOverrideReason'), f'Undocumented game-name override: {rule["id"]}'
            name = rule['label']
        if rule.get('qualifier'): name += ' (' + rule['qualifier'] + ')'
        puzzles.append(dict(id=rule['id'], label=name, translationKey=key,
                            status='mask-review', geometry='curated-source-union',
                            source='build_scripts/guessr/area-curation.json', sourceIds=sorted(identifiers),
                            engine=sorted({a['engine'] for a in members}), realm='/'.join(sorted({a['realm'] for a in members})),
                            reason=rule['reason'], evidence=rule.get('evidence', []),
                            runs=row_runs(cells), cells=len(cells), originY=capture['originY'], bounds=bbox(cells, capture['originY']),
                            **score_policy(rule, members),
                            samplingEnabled=False, captureVerified=False))
    for rule in config['pendingLandmarks']:
        matches = [a for a in areas if a['label'] == rule['sourceLabel'] and a.get('point') == rule['point']]
        assert len(matches) == 1, rule['id']
        source = matches[0]
        source['puzzleAreaId'] = rule['id']
        puzzles.append(dict(id=rule['id'], label=english[rule['nameKey']]+' ('+rule['qualifier']+')',
                            translationKey=rule['nameKey'], status='review-footprint', geometry='point-only',
                            realm=source['realm'], point=rule['point'], source=source['source'],
                            reason=rule['reason'], evidence=rule['evidence'],
                            containingComponents=source['containingComponents'],
                            **score_policy(rule), samplingEnabled=False, captureVerified=False))
    # Derived shaft rectangle is an alias for the two actual source masks.
    by_id['special/hiidet-elevator']['puzzleAreaId'] = 'landmark/hiidet-elevator'
    for a in areas:
        if a.get('mapsTo') == 'special/hiidet-elevator':
            a['mapsTo'] = 'landmark/hiidet-elevator'
    return puzzles, ownership, config['scoringProfiles']


def build(common_path, out):
    test_geometry()
    records = read('src/data/biome_boundries_py.json')['biomes']
    source = read('task/guessr/site/captured/source.json')
    pack = read('task/guessr/site/pack.json')
    policy = read('build_scripts/guessr/area-policy.json')
    scene = read('task/guessr/area-inventory/scene-audit.json')
    with common_path.open(newline='', encoding='utf-8-sig') as file:
        english = {r[0]: r[1] for r in csv.reader(file) if len(r) > 1 and r[0] and r[1]}
    all_cells, rows, entries, areas = {}, [], [], []

    def label(record):
        key = record['name'].removeprefix('$')
        if not key or key == '_EMPTY_': return record['filename'], None
        if key and not key.startswith('biome_'): key = 'biome_' + key
        return english.get(key, record['filename']), key if key in english else None

    def disposition(record):
        if record['biome_color'] in policy['colorOverrides']:
            item = policy['colorOverrides'][record['biome_color']]
            return item['status'], item['reason']
        for field, status in [('excluded', 'excluded'), ('terrainSources', 'terrain-source'), ('reviewSources', 'review-content'), ('structureParts', 'structure-part')]:
            if record['filename'] in policy[field]: return status, policy[field][record['filename']]
        return 'candidate', 'Named biome/room geometry candidate; inspect actual content and final eligible mask before sampling.'

    for index, record in enumerate(records):
        paths = rings(record['svg_map_path']); cells = cells_for(paths)
        assert cells and all(0 <= x < COLUMNS and 0 <= y < ROWS for x, y in cells)
        assert not (cells & all_cells.keys()), record['filename']
        for cell in cells: all_cells[cell] = index
        parts = components(cells); name, translation = label(record)
        status, reason = disposition(record)
        ids = []
        for number, part in enumerate(parts, 1):
            first = min(part, key=lambda p: (p[1], p[0]))
            identifier = f"main/{record['filename']}/{record['biome_color'][1:]}/{first[0]}-{first[1]}"
            ids.append(identifier)
            area = dict(id=identifier, label=name, engine=record['filename'], color=record['biome_color'],
                        realm='main', status=status, reason=reason, source=f'src/data/biome_boundries_py.json#/biomes/{index}',
                        translationKey=translation, component=number, componentCount=len(parts),
                        cells=len(part), runs=row_runs(part), originY=ORIGIN_Y, bounds=bbox(part),
                        geometry='logical-chunk-component', samplingEnabled=False, captureVerified=False)
            if record['filename'] == 'robobase' and len(part) == 1 and first[1] == ROWS - 1:
                area.update(status='special-part', reason='Starting stub of the elevator; joined to its Hell continuation in special/hiidet-elevator.', mapsTo='special/hiidet-elevator')
                shaft_bounds = bbox(part)
                shaft_bounds['height'] = source['originY'] + source['height'] - shaft_bounds['y']
                areas.append(dict(id='special/hiidet-elevator', label='Infinite Hiidet elevator', engine='robobase',
                                  realm='main/hell', status='candidate', bounds=shaft_bounds, geometry='explicit-continuation',
                                  reason='Separate from Power Plant. Width512; continuous from the bottom-row stub to the capture edge. Validate the captured strip before sampling.',
                                  source='src/telescope/terrain-elevator.ts', samplingEnabled=False, captureVerified=False))
            rows.append(area)
        entries.append(dict(index=index, engine=record['filename'], color=record['biome_color'], label=name,
                            translationKey=translation, ringCount=len(paths), cellCount=len(cells), componentCount=len(parts), ids=ids))
    assert len(all_cells) == COLUMNS * ROWS
    areas = rows + areas

    # Repeated edge-row ownership is an audit input, never proof of visible
    # lake/winter/hills/etc terrain in the vertical planes.
    projected = []
    for realm, base_row, oy in [('heaven', 0, -31744), ('hell', ROWS - 1, 17408)]:
        for index, record in enumerate(records):
            cells = {(x, y) for x in range(COLUMNS) if all_cells[(x, base_row)] == index for y in range(ROWS)}
            for number, part in enumerate(components(cells), 1):
                name, translation = label(record); first = min(part)
                status, reason = 'review-vertical', 'Projected engine ownership only: inspect capture; do not assume this main-world biome renders here.'
                if record['filename'] in ['solid_wall', 'solid_wall_tower']:
                    status, reason = 'terrain-source', 'Projected rock ownership; no automatic puzzle split or difficulty rating. Capture/mask validation remains necessary.'
                elif record['filename'] in ['the_sky', 'the_end']:
                    status, reason = 'candidate', 'The Work vertical region candidate; verify capture content and subtract separately defined landmark masks.'
                elif record['filename'] in policy['excluded']:
                    status, reason = 'excluded', policy['excluded'][record['filename']]
                elif record['filename'] == 'robobase' and realm == 'hell':
                    status, reason = 'special-part', 'Continuation belongs to special/hiidet-elevator, not the main Power Plant.'
                projected.append(dict(id=f'{realm}/{record["filename"]}/{record["biome_color"][1:]}/{first[0]}',
                                      label=name, engine=record['filename'], realm=realm, status=status, reason=reason,
                                      bounds=bbox(part, oy), runs=row_runs(part), cells=len(part), originY=oy,
                                      geometry='edge-row-projection', source='lib/noita-telescope-vm/js/biome_generator.js',
                                      samplingEnabled=False, captureVerified=False))
    areas += projected
    margin = source['width'] - COLUMNS * CHUNK
    if margin:
        areas.append(dict(id='capture/east-margin', label='Capture east margin', realm='capture', status='excluded',
                          bounds=dict(x=ORIGIN_X+COLUMNS*CHUNK,y=source['originY'],width=margin,height=source['height']),
                          geometry='capture-margin', reason='Extra capture width beyond the70-column main biome map; do not infer an eligible parallel-world region.',
                          source='task/guessr/site/captured/source.json', samplingEnabled=False, captureVerified=False))

    # Preserve source markers/recipes even if duplicated; link markers to
    # candidate containing components rather than fabricating room bounds.
    for index, item in enumerate(scene['points']):
        x, y = item['x'], item['y']
        cell = (int((x-ORIGIN_X)//CHUNK), int((y-ORIGIN_Y)//CHUNK))
        matches = [r['id'] for r in rows if any(yy == cell[1] and x0 <= cell[0] < x1 for yy, x0, x1 in r['runs'])]
        areas.append(dict(id=f'landmark/{index}',label=item['name'],realm='main' if -7168<=y<17408 else 'heaven' if y<-7168 else 'hell',
                          status='excluded' if item['status'].startswith('exclude') else 'review-footprint',
                          reason=item['reason'],point=dict(x=x,y=y),geometry='point-only',source=item['source'],
                          containingComponents=matches,samplingEnabled=False,captureVerified=False))
    for index, item in enumerate(scene['staticSceneRecipes']):
        areas.append(dict(id=f'scene-recipe/{index}',label=item['name'],realm='recipe',
                          status='excluded' if item['status'].startswith('exclude') else 'review-capture',
                          reason=item['reason'],bounds=item.get('recipeRectangle'),geometry='source-scene-rectangle',
                          source=item['source'],samplingEnabled=False,captureVerified=False))

    content_audit_path = out / 'content-audit.json'
    content_audit = json.loads(content_audit_path.read_text()) if content_audit_path.exists() else None
    if content_audit and content_audit['captureSha256'] == source['sha256'] and content_audit['boundarySha256'] == hashlib.sha256((ROOT/'src/data/biome_boundries_py.json').read_bytes()).hexdigest():
        stats = {s['id']: s for s in content_audit['overview']['entries']}
        for area in areas:
            if area['id'] in stats:
                area['overviewStatistics'] = stats[area['id']]
                sample = stats[area['id']]
                if area['status'] == 'candidate' and sample['dominantColor'] == '#000000' and sample['dominantFraction'] >= .90:
                    area['status'] = 'review-content'
                    area['reason'] += ' Over90% of the overview mask is black: review actual content and tighten the eligible footprint. This flag does not automatically exclude a small but real landmark.'
            if area['id'] == content_audit['hills2']['id']:
                area['nativeContentAudit'] = content_audit['hills2']
    else: content_audit = None
    puzzles, ownership, scoring_profiles = curate(areas, english, source)
    counts = dict(boundaryRecords=len(entries), mainComponents=len(rows), mainCells=len(all_cells),
                  splitSourceEntries=sum(r['componentCount']>1 for r in entries), projectedComponents=len(projected),
                  reviewRows=len(areas), statuses=dict(Counter(r['status'] for r in areas)),
                  curatedAreas=len(puzzles), assignedSourceComponents=len(ownership),
                  unassignedSourceRecords=sum('puzzleAreaId' not in a and a['status'] != 'excluded' for a in areas))
    result = dict(version=2, scope='Explicit puzzle-area groupings plus the complete source audit; final valid-start masks are still pending.',
                  capture={**source,'seed':pack['seed']}, counts=counts, entries=entries, areas=areas,
                  puzzleAreas=puzzles, sourceAssignments=ownership, scoringProfiles=scoring_profiles,
                  sceneAuditCounts=scene['counts'],
                  contentAudit='content-audit.json' if content_audit else None,
                  sourceIdentity={name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in
                    ['src/data/biome_boundries_py.json','build_scripts/guessr/area-policy.json','build_scripts/guessr/area-curation.json','task/guessr/area-inventory/scene-audit.json']},
                  translationSource=dict(path=str(common_path),sha256=hashlib.sha256(common_path.read_bytes()).hexdigest()),
                  validation=dict(geometrySelfChecks=True, coveredMainCells=len(all_cells), overlaps=0, unassignedMainCells=0,
                                  componentsReconstructSource=True, coordinateRule='x=column*512-17920,y=row*512-7168; do not use stale svg_real_world_path_corrected fields.'),
                  remaining=['Validate captured content and final sampling masks; inventory status does not enable a question.',
                             'Trace named point-only landmarks; source PNG dimensions are not occupied masks.',
                             'Obtain capture-aligned placements for seed-dependent large scenes; asset variants are not extra locations.',
                             'Review remaining unassigned sources by recognizable place; connectivity and engine names alone do not determine an area.'])
    out.mkdir(parents=True,exist_ok=True)
    (out/'inventory.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    fields=['id','label','engine','realm','status','puzzleAreaId','difficultyTier','component','componentCount','cells','x','y','width','height','dominantFractionOverview','reason','source']
    with (out/'areas.csv').open('w',newline='',encoding='utf-8') as file:
        writer=csv.DictWriter(file,fieldnames=fields);writer.writeheader()
        for area in areas:
            flat={**area,**(area.get('bounds') or area.get('point') or {})}
            flat['dominantFractionOverview'] = area.get('overviewStatistics',{}).get('dominantFraction','')
            writer.writerow({k:flat.get(k,'') for k in fields})
    with (out/'puzzle-areas.csv').open('w',newline='',encoding='utf-8') as file:
        writer=csv.DictWriter(file,fieldnames=['id','label','sourceComponents','cells','difficultyTier','areaPoints','positionPoints','difficultyRule','reason'])
        writer.writeheader()
        for a in puzzles:
            scores = a.get('scoringVariants') or {a['difficultyTier']: a['scoring']}
            writer.writerow(dict(id=a['id'],label=a['label'],sourceComponents=len(a.get('sourceIds',[])),cells=a.get('cells',''),
                difficultyTier=' | '.join(scores),areaPoints=' | '.join(str(s['area']) for s in scores.values()),
                positionPoints=' | '.join(str(s['position']) for s in scores.values()),
                difficultyRule=json.dumps(a['difficultyRule']) if a.get('difficultyRule') else '',reason=a['reason']))
    (out/'biome-grid.json').write_text(json.dumps({'width':COLUMNS,'height':ROWS,'colors':
        [records[all_cells[(x,y)]]['biome_color'] for y in range(ROWS) for x in range(COLUMNS)]})+'\n')
    split='\n'.join(f"{r['engine']} {r['color']}: {r['componentCount']} components, {r['cellCount']} chunks" for r in entries if r['componentCount']>1)
    (out/'summary.txt').write_text('NOITAGUESSR AREA INVENTORY\n\n'+json.dumps(counts,indent=2)+'\n\nAll split source entries:\n'+split+
        '\n\nThree tiers: Easy 500/4500, Normal 1000/4000, Hard 3000/2000 (area/proximity). EDR uses Normal.\n'
        '\nAll temples use Easy. Ordinary Holy Mountains use Normal with a 1500/3500 override; the lowest beside Kolmi is Easy.\n'
        '\nSnowy Wasteland: snow in the original clue means Normal; no snow means Hard. Pending snow classification is not silently assigned a tier.\n'
        '\nPyramid pieces and each Holy Mountain are combined. Surface winter and underground winter patches form Snowy Wasteland and Snowy Chasm.\n'
        '\nThe bridge and its cavern are included with Frozen Vault. The Tower uses the requested display name. Alchemist boss room and laboratory remain separate.\n'
        '\nHills2/hills_2, sky_light_injector and explicitly reviewed blank elevated strips are excluded as independent questions; no blanket empty-ID exclusion.\n'
        '\nAll rows are audit records, not activated game content. Gray scene boxes are source-art extents, not confirmed captured footprints.\n'
        '\nRemaining work:\n'+'\n'.join('- '+x for x in result['remaining'])+'\n')
    html_template = (ROOT/'build_scripts/guessr/area-inventory.html').read_text()
    payload=json.dumps(result,ensure_ascii=False).replace('<','\\u003c')
    (out/'index.html').write_text(html_template.replace('__INVENTORY_JSON__',payload))
    print(json.dumps(counts))


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--common',type=Path,default=ROOT.parent/'noita-sources/noita_bin/data/translations/common.csv')
    parser.add_argument('--out',type=Path,default=ROOT/'task/guessr/area-inventory')
    args=parser.parse_args();build(args.common,args.out)
