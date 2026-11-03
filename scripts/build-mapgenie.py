"""Build FH4/FH5 WebP pyramids and runtime data from the MapGenie snapshot.

Requires Pillow. Downloaded source tiles remain in ignored source/originals/.
"""
import concurrent.futures
import hashlib
import io
import json
import math
from pathlib import Path
import subprocess
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOT = json.loads((ROOT / 'source/mapgenie.json').read_text())
CACHE = ROOT / 'source/originals/mapgenie'
SIZE = 512

LABELS = {
    'Fast Travel Board': '快速移动广告牌', 'Festival Site': '嘉年华',
    'House': '玩家房屋', 'Player House': '玩家房屋', 'Barn Find': '车房宝物',
    'Beauty Spot': '美景地点', 'Influence Board': '影响力广告牌', 'XP Board': '经验广告牌',
    'Treasure Chest': '宝箱', 'Treasure': '宝藏', 'Alien Energy Cell': '外星能量电池',
    'Alien Plant': '外星植物', 'Tank Balloon': '坦克气球', 'Piñata Truck': '皮纳塔卡车',
    'Grit Reaper Crate': 'Grit Reaper 补给箱', 'Landmark': '地标',
    'Playground Game': '游乐场游戏', 'Showcase': '表演赛', 'Exhibition Event': '展演赛事',
    'Road Racing Series': '公路竞速系列赛', 'Road Racing Event': '公路竞速赛',
    'Dirt Racing Series': '泥地系列赛', 'Dirt Racing Event': '泥地竞速赛',
    'Cross Country Series': '越野系列赛', 'Cross Country Event': '越野竞速赛',
    'Street Scenes': '街头赛', 'Street Racing Event': '街头竞速赛',
    'The Drag Strips': '短程加速赛', 'Drag Racing Event': '短程加速赛',
    'Speed Trap': '测速照相', 'Speed Zone': '区间测速', 'Danger Sign': '危险标志',
    'Drift Zone': '漂移区域', 'Trailblazer': '拓荒者', 'Trailblazer Finish': '拓荒者终点',
    'Expedition': '远征', 'Expedition Accolade': '远征赞赏', 'Miscellaneous': '其他',
    'Vehicle': '车辆', 'Hazard Circuit': '危险环道赛', 'Hazard Sprint': '危险冲刺赛',
    'Speed Circuit': '极速环道赛', 'Speed Sprint': '极速冲刺赛', 'Dragon': '巨龙',
}


def project(point, zoom):
    world = 256 * 2 ** zoom
    x = (point['longitude'] + 180) / 360 * world
    y = (1 - math.asinh(math.tan(math.radians(point['latitude']))) / math.pi) / 2 * world
    return x, y


def style(category):
    icon = category['icon']
    if icon == 'fast_travel_board': return '#f34599', 'travel'
    if icon == 'barn_find': return '#a998f7', 'barn'
    if icon in ('beauty_spot', 'landmark'): return '#69d9c6', 'camera'
    if 'board' in icon: return '#f7c85b', 'XP'
    if icon in ('house', 'player_house'): return '#a998f7', 'house'
    if 'speed' in icon: return '#84d0f9', 'speed'
    if 'danger' in icon: return '#ff9554', '!'
    if 'drift' in icon: return '#ee6d4e', 'drift'
    if 'treasure' in icon or 'crate' in icon: return '#f7c85b', 'chest'
    if 'alien' in icon: return '#8cdb91', 'alien'
    return '#84d0f9', 'flag'


def download(task):
    url, path = task
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            ['curl', '--fail', '--silent', '--show-error', '--max-time', '30', url],
            check=True, capture_output=True,
        )
        image = Image.open(io.BytesIO(result.stdout))
        assert image.size == (256, 256), (url, image.size)
        path.write_bytes(result.stdout)
    return path


def build(record):
    key = record['game'] + '-' + record['slug']
    tile_set = next((t for t in record['mapConfig']['tile_sets'] if t['name'] == 'Summer'), record['mapConfig']['tile_sets'][0])
    zoom = min(14, tile_set['tiles_max_zoom'])
    if record['slug'] == 'horizon-hot-wheels-park': zoom = 13
    coordinates = [project(p, zoom) for p in record['locations']]
    # Crop to the collecting area with two source tiles of context on each edge.
    bounds = tile_set['bounds'][str(zoom)]
    x0 = max(bounds['x']['min'], math.floor(min(p[0] for p in coordinates) / 256) - 2)
    y0 = max(bounds['y']['min'], math.floor(min(p[1] for p in coordinates) / 256) - 2)
    x1 = min(bounds['x']['max'], math.floor(max(p[0] for p in coordinates) / 256) + 2)
    y1 = min(bounds['y']['max'], math.floor(max(p[1] for p in coordinates) / 256) + 2)
    tasks = []
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            path = CACHE / key / str(zoom) / f'{x}-{y}.jpg'
            url = record['tilesCdnUrl'] + tile_set['pattern'].replace('{z}', str(zoom)).replace('{x}', str(x)).replace('{y}', str(y))
            tasks.append((url, path))
    print(f'{key}: {len(tasks)} source tiles at zoom {zoom}', flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for i, _ in enumerate(pool.map(download, tasks), 1):
            if i % 200 == 0: print(f'  {key}: {i}/{len(tasks)}', flush=True)
    width, height = (x1 - x0 + 1) * 256, (y1 - y0 + 1) * 256
    image = Image.new('RGB', (width, height))
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            with Image.open(CACHE / key / str(zoom) / f'{x}-{y}.jpg') as tile:
                image.paste(tile, ((x - x0) * 256, (y - y0) * 256))
    digest = hashlib.sha256(image.tobytes() + b'webp-q80-512-v1').hexdigest()[:12]
    base = f'assets/maps/{key}/{digest}'
    levels = []
    last = max(0, math.ceil(math.log2(max(width, height) / SIZE)))
    for z in range(last + 1):
        divisor = 2 ** (last - z)
        w, h = math.ceil(width / divisor), math.ceil(height / divisor)
        resized = image.resize((w, h), Image.Resampling.LANCZOS)
        cols, rows = math.ceil(w / SIZE), math.ceil(h / SIZE)
        target = ROOT / base / str(z)
        target.mkdir(parents=True, exist_ok=True)
        for y in range(rows):
            for x in range(cols):
                resized.crop((x * SIZE, y * SIZE, min((x + 1) * SIZE, w), min((y + 1) * SIZE, h))).save(target / f'{x}-{y}.webp', quality=80, method=6)
        levels.append({'z': z, 'width': w, 'height': h, 'cols': cols, 'rows': rows})
    config = {
        'name': 'Sierra Nueva' if record['slug'] == 'sierra-nueva' else record['name'], 'tag': '本体' if record['slug'] in ('britain', 'mexico') else 'DLC',
        'width': width, 'height': height, 'crop': [0, 0, width, height], 'unit': 2000 / max(width, height),
        'position': [0, 0], 'oldToImage': [[1, 0, 0], [0, 1, 0]],
        'source': record['url'], 'sourceZoom': zoom, 'sourceOrigin': [x0 * 256, y0 * 256],
        'tiles': {'size': SIZE, 'base': base, 'levels': levels},
    }
    points, types = [], {}
    for point, (x, y) in zip(record['locations'], coordinates):
        type_id = record['map']['id'] * 100000 + point['category_id']
        category = record['categories'][str(point['category_id'])]
        if type_id not in types:
            color, icon = style(category)
            label = LABELS.get(category['title'], category['title'])
            types[type_id] = {'name': label, 'short': label, 'color': color, 'icon': icon, 'region': key, 'total': 0}
        types[type_id]['total'] += 1
        points.append([point['id'], type_id, round(x - x0 * 256, 3), round(y - y0 * 256, 3), '' if point['title'] == category['title'] else point['title']])
    files = list((ROOT / base).rglob('*.webp'))
    print(f'  {key}: {width}x{height}, {len(files)} WebP tiles, {sum(p.stat().st_size for p in files):,} bytes', flush=True)
    return key, config, types, points


games = {}
for record in SNAPSHOT['maps']:
    key, config, types, points = build(record)
    game = games.setdefault(record['game'], {'name': 'Forza Horizon ' + record['game'][2:], 'maps': {}, 'data': {'source': f'https://mapgenie.io/forza-horizon-{record["game"][2:]}', 'types': {}, 'points': []}})
    game['maps'][key] = config
    game['data']['types'].update(types)
    game['data']['points'].extend(points)

text = '/* Generated by scripts/build-mapgenie.py from public MapGenie maps. */\nwindow.FH_GAMES = {\n  fh3: {name: "Forza Horizon 3", data: window.FH3_DATA, maps: window.FH3_MAPS},\n  ...' + json.dumps(games, ensure_ascii=False, separators=(',', ':')) + '\n};\n'
(ROOT / 'games.js').write_text(text)
print('Wrote games.js', flush=True)
