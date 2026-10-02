"""Deterministic, disclosed Golden comparison. Requires Pillow and NumPy."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter

parser = argparse.ArgumentParser()
parser.add_argument('--actual', required=True)
parser.add_argument('--capture', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--config', default=str(Path(__file__).resolve().parents[1] / 'design/golden/app-trends-v1.json'))
args = parser.parse_args()
config_path = Path(args.config)
config = json.loads(config_path.read_text())
golden_path = config_path.parent / config['image']
golden = Image.open(golden_path).convert('RGB')
actual = Image.open(args.actual).convert('RGB')
size = (config['viewport']['width'], config['viewport']['height'])
if golden.size != size or actual.size != size:
    raise SystemExit('Golden and screenshot must have the exact declared size; resizing is prohibited')

def box_mean(value, radius=5):
    padded = np.pad(value, ((radius, radius), (radius, radius), (0, 0)), mode='reflect')
    integral = np.pad(padded, ((1, 0), (1, 0), (0, 0))).cumsum(0).cumsum(1)
    n = 2 * radius + 1
    return (integral[n:, n:] - integral[:-n, n:] - integral[n:, :-n] + integral[:-n, :-n]) / (n * n)

a = np.asarray(golden.filter(ImageFilter.GaussianBlur(1)), dtype=np.float64) / 255
b = np.asarray(actual.filter(ImageFilter.GaussianBlur(1)), dtype=np.float64) / 255
ma, mb = box_mean(a), box_mean(b)
va = np.maximum(0, box_mean(a*a) - ma*ma)
vb = np.maximum(0, box_mean(b*b) - mb*mb)
cov = box_mean(a*b) - ma*mb
ssim = (((2*ma*mb + .01**2) * (2*cov + .03**2)) / ((ma*ma + mb*mb + .01**2) * (va + vb + .03**2))).mean(2)
mask = np.zeros(ssim.shape, dtype=bool)
for region in config['dynamicRegions']:
    x,y,w,h = region['rect']
    mask[y:y+h, x:x+w] = True
# Only saturated chart series strokes are dynamic; axes, grid, background and panel remain scored.
series = config['seriesMask']
x,y,w,h = series['region']
colored = np.zeros(mask.shape, dtype=bool)
for source in (golden, actual):
    pixels = np.asarray(source, dtype=np.float64) / 255
    high, low = pixels.max(2), pixels.min(2)
    saturation = (high-low) / np.maximum(high, .001)
    colored[y:y+h, x:x+w] |= saturation[y:y+h, x:x+w] >= series['saturationMinimum']
dilated = Image.fromarray(colored.astype('uint8') * 255).filter(ImageFilter.MaxFilter(series['dilationPx'] * 2 + 1))
mask |= np.asarray(dilated) > 0
raw = float(ssim.mean())
masked = float(ssim[~mask].mean())
excluded = float(mask.mean())
capture = json.loads(Path(args.capture).read_text())
geometry_errors = []
for selector, expected in config['geometry'].items():
    found = capture['geometry'].get(selector)
    if not found:
        geometry_errors.append(selector + ': missing')
        continue
    delta = max(abs(found[key] - wanted) for key, wanted in zip(('x','y','width','height'), expected))
    if delta > config['geometryTolerancePx']:
        geometry_errors.append(f'{selector}: delta {delta:.2f}px')
checks = capture['checks']
required_checks = ('hoverTooltip', 'clickPinsTooltip', 'wheelChangesRange', 'escapeClosesTooltip', 'keyboardAppSwitch', 'keyboardPinsTooltip', 'dragPansRange', 'fullHistoryAccessible', 'ratesCannotAccumulate', 'stabilityNotMoney', 'allAppsInPicker', 'clearAppsRemovesLines', 'selectAllRestoresLines', 'allTableFieldsSortable', 'allAppsHitTestingPassed', 'reviewMetadataReadable', 'reviewExpandControlsPassed')
required_checks += ('tooltipBoundaryPinControl', 'allAppSeriesVisible', 'mobileNavigationSingleLine', 'mobileMetricValuesFit', 'mobileChartLabelsReadable', 'mobileTapPinsTooltip')
functional = (not capture['errors'] and not checks.get('mobileOverflow') and all(checks.get(key) is True for key in required_checks) and checks.get('dailyMode') == 'true')
passed = bool(masked >= config['threshold'] and raw >= config['rawFloor'] and excluded <= config['maximumExcludedFraction'] and not geometry_errors and functional)
result = {
    'schemaVersion': 1,
    'capturedAt': capture['capturedAt'],
    'goldenSha256': hashlib.sha256(golden_path.read_bytes()).hexdigest(),
    'configSha256': hashlib.sha256(config_path.read_bytes()).hexdigest(),
    'actualSha256': hashlib.sha256(Path(args.actual).read_bytes()).hexdigest(),
    'htmlHash': capture['htmlHash'],
    'files': capture.get('files', {}),
    'rawSimilarity': raw,
    'maskedSimilarity': masked,
    'excludedFraction': excluded,
    'threshold': config['threshold'],
    'geometryErrors': geometry_errors,
    'functionalChecksPassed': bool(functional),
    'passed': passed,
    'metric': config['metric'],
    'dynamicRegions': config['dynamicRegions'],
    'seriesMask': series,
}
out = Path(args.output)
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
with (out.parent / 'golden-score-history.jsonl').open('a') as history:
    history.write(json.dumps({key:value for key,value in result.items() if key not in ('dynamicRegions','seriesMask')}) + '\n')
central = config_path.resolve().parents[1] / 'verification' / 'golden-score-history.jsonl'
central.parent.mkdir(parents=True, exist_ok=True)
if central.resolve() != (out.parent / 'golden-score-history.jsonl').resolve():
    with central.open('a') as history:
        history.write(json.dumps({key:value for key,value in result.items() if key not in ('dynamicRegions','seriesMask')}) + '\n')
# Diagnostic image distinguishes excluded pixels; it is not used in the score.
view = np.asarray(actual).copy()
view[mask] = (.5 * view[mask] + .5 * np.array([234, 128, 97])).astype('uint8')
Image.fromarray(view).save(out.parent / 'golden-excluded-regions.png')
print(json.dumps({key:value for key,value in result.items() if key not in ('dynamicRegions','seriesMask')}, indent=2))
raise SystemExit(0 if passed else 1)
