#!/usr/bin/env python3
"""Makes the browser copies of the real sky and the real ground (see hangar/README.md, "Sky and ground").

    hangar/tools/raw/.venv/bin/python hangar/tools/prepare-sky-ground.py [stars] [milkyway] [ground]

(the venv: python3 -m venv hangar/tools/raw/.venv && hangar/tools/raw/.venv/bin/pip install numpy pillow
tifffile OpenEXR). Inputs, downloaded into hangar/tools/raw/ (git-ignored) by hand, sources in the README:

  raw/sky/hipparcos.tdat.gz        NASA HEASARC's copy of the Hipparcos main catalogue (118,218 stars)
  raw/sky/milkyway_2020_8k.exr     NASA SVS Deep Star Maps 2020: the Milky Way without the Hipparcos/Tycho stars
  raw/lroc/NAC_DTM_APOLLO16_1.TIF  LROC NAC terrain model of the Apollo 16 site, 2 m posts
  raw/lroc/NAC_DTM_APOLLO16_1_M119754107_50CM.IMG  the matching 0.5 m orthophoto

Outputs (committed):

  html/data/stars.bin        10 bytes a star: int16 x, y, z (ICRS unit vector x 32767), uint8 V magnitude
                             ((V + 2) x 16), uint8 r, g, b (colour from B-V, brightest channel 255)
  html/assets/images/milkyway.ktx2   8192 x 4096 equirectangular (RA 0 at the centre, RA rising to the left,
                             north up), linear radiance / MW_SCALE stored sRGB, UASTC
  html/data/ground.bin       GROUND_N x GROUND_N int16 heights in cm, 2 m posts, 4096 m square, plane removed
  html/assets/images/ground-albedo.ktx2  8192 x 8192 albedo multiplier (mean 0.5, i.e. x2 in the shader), sRGB
  html/assets/images/ground-normal.ktx2  2048 x 2048 normals of the height map: r = x, g = z, b = y (up)

Rows of ground.bin, ground-albedo and ground-normal all run the same way (row 0 first, v = 0; no y flip): the
page samples all three with u along a row (local x) and v down the rows (local z).
"""
import gzip, os, subprocess, sys
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, 'raw')
HTML = os.path.join(HERE, '..', 'html')
IMAGES = os.path.join(HTML, 'assets', 'images')
DATA = os.path.join(HTML, 'data')
Image.MAX_IMAGE_PIXELS = None

MW_SCALE = 0.2  # linear radiance stored as 1.0 (the brightest 0.01% of the map clip)
GROUND_N = 2048  # posts a side at 2 m: 4096 m
ALBEDO_N = 8192  # pixels a side at 0.5 m
# The window of the Apollo 16 strip: line and sample of its top-left corner in the 0.5 m orthophoto
# (a densely cratered stretch of the Descartes highlands, clear of the big rayed crater further south).
WIN_LINE, WIN_SAMPLE = 4600, 600


def basisu(src, dst, *flags):
    if os.path.exists(dst):
        os.remove(dst)
    log = os.path.join(RAW, 'basisu-' + os.path.basename(dst) + '.log')
    with open(log, 'w') as f:
        r = subprocess.run(['basisu', '-ktx2', '-uastc', '-uastc_level', '3', '-ktx2_zstandard_level', '19',
                            '-mipmap', *flags, src, '-output_file', dst], stdout=f, stderr=subprocess.STDOUT)
    if r.returncode or not os.path.exists(dst) or os.path.getsize(dst) == 0:
        sys.exit(f'basisu failed for {dst}: see {log}')
    print(f'  {os.path.relpath(dst, HTML)}: {os.path.getsize(dst) / 1e6:.1f} MB')


def srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def bv_rgb(bv):
    """B-V colour index to a normalised RGB (Ballesteros' temperature, then a blackbody fit)."""
    bv = np.clip(np.nan_to_num(bv, nan=0.6), -0.4, 2.0)
    t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62)) / 100
    r = np.where(t <= 66, 255, 329.698727446 * np.power(np.maximum(t - 60, 1e-3), -0.1332047592))
    g = np.where(t <= 66, 99.4708025861 * np.log(t) - 161.1195681661,
                 288.1221695283 * np.power(np.maximum(t - 60, 1e-3), -0.0755148492))
    b = np.where(t >= 66, 255, np.where(t <= 19, 0, 138.5177312231 * np.log(np.maximum(t - 10, 1e-3)) - 305.0447927307))
    c = np.clip(np.stack([r, g, b], -1), 0, 255)
    return c / c.max(-1, keepdims=True)


def stars():
    src = os.path.join(RAW, 'sky', 'hipparcos.tdat.gz')
    cols, rows, data = [], [], False
    with gzip.open(src, 'rt', errors='replace') as f:
        for line in f:
            if line.startswith('field['):
                cols.append(line[6:line.index(']')])
            elif line.startswith('<DATA>'):
                data = True
            elif line.startswith('<END>'):
                break
            elif data:
                rows.append(line.rstrip('\n').split('|'))
    ix = {c: i for i, c in enumerate(cols)}
    ra, de, v, bv = [], [], [], []
    for r in rows:
        try:
            m = float(r[ix['vmag']])
        except ValueError:
            continue
        ra.append(float(r[ix['ra']])); de.append(float(r[ix['dec']])); v.append(m)
        try:
            bv.append(float(r[ix['bv_color']]))
        except ValueError:
            bv.append(np.nan)
    ra, de, v, bv = (np.radians(ra), np.radians(de), np.array(v), np.array(bv))
    order = np.argsort(v)  # brightest first
    ra, de, v, bv = ra[order], de[order], v[order], bv[order]
    xyz = np.stack([np.cos(de) * np.cos(ra), np.cos(de) * np.sin(ra), np.sin(de)], -1)
    out = np.zeros(len(v), dtype=[('p', '<i2', 3), ('m', 'u1'), ('c', 'u1', 3)])
    out['p'] = np.round(xyz * 32767).astype(np.int16)
    out['m'] = np.clip(np.round((v + 2) * 16), 0, 255).astype(np.uint8)
    out['c'] = np.round(bv_rgb(bv) * 255).astype(np.uint8)
    dst = os.path.join(DATA, 'stars.bin')
    out.tofile(dst)
    print(f'  data/stars.bin: {len(v)} stars, V {v.min():.2f} .. {v.max():.2f}, {os.path.getsize(dst) / 1e6:.2f} MB')


def milkyway():
    import OpenEXR
    a = OpenEXR.File(os.path.join(RAW, 'sky', 'milkyway_2020_8k.exr')).channels()['RGB'].pixels.astype(np.float32)
    png = os.path.join(RAW, 'sky', 'milkyway_8k.png')
    Image.fromarray(np.round(srgb(a / MW_SCALE) * 255).astype(np.uint8)).save(png)
    # -y_flip: bottom row first, so v = 1 is north (three's SphereGeometry: v = 1 at +y).
    basisu(png, os.path.join(IMAGES, 'milkyway.ktx2'), '-y_flip')


def ground():
    import tifffile
    D = tifffile.imread(os.path.join(RAW, 'lroc', 'NAC_DTM_APOLLO16_1.TIF')).astype(np.float64)
    O = np.memmap(os.path.join(RAW, 'lroc', 'NAC_DTM_APOLLO16_1_M119754107_50CM.IMG'), dtype='<i2', mode='r',
                  offset=19626, shape=(56897, 9813))
    # Both products share the strip's grid: one 2 m post is 4 x 4 orthophoto pixels.
    h = D[WIN_LINE // 4: WIN_LINE // 4 + GROUND_N, WIN_SAMPLE // 4: WIN_SAMPLE // 4 + GROUND_N].copy()
    img = np.asarray(O[WIN_LINE: WIN_LINE + ALBEDO_N, WIN_SAMPLE: WIN_SAMPLE + ALBEDO_N]).astype(np.float64)
    assert (h > -1e30).all() and (img != -32768).all(), 'the window reaches past the strip'

    # Heights: the regional tilt removed (a least-squares plane), mean zero.
    yy, xx = np.mgrid[0:GROUND_N, 0:GROUND_N] * 2.0
    A = np.stack([xx.ravel(), yy.ravel(), np.ones(xx.size)], -1)
    coef, *_ = np.linalg.lstsq(A, h.ravel(), rcond=None)
    h -= (A @ coef).reshape(h.shape)
    print(f'  heights after the plane: {h.min():.1f} .. {h.max():.1f} m, sd {h.std():.1f} m')
    np.round(h * 100).astype('<i2').tofile(os.path.join(DATA, 'ground.bin'))

    # Normals of the height map (local x along a row, z down the rows, y up), central differences at 2 m.
    gz, gx = np.gradient(h, 2.0)
    n = np.stack([-gx, np.ones_like(h), -gz], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    nrm = np.round((np.stack([n[..., 0], n[..., 2], n[..., 1]], -1) * 0.5 + 0.5) * 255).astype(np.uint8)
    png = os.path.join(RAW, 'lroc', 'ground_normal.png')
    Image.fromarray(nrm).save(png)
    basisu(png, os.path.join(IMAGES, 'ground-normal.ktx2'), '-normal_map')

    # Albedo: the photo divided by the shading the 2 m terrain explains. A linear model of brightness against
    # slope (I = a + b dh/dx + c dh/dz, fitted on the photo binned to 2 m) finds the sun's direction from the
    # photo itself; dividing by (a + b gx + c gz) / a leaves the albedo (shading finer than 2 m stays in).
    img = np.maximum(img, 1.0)
    bin2 = img.reshape(GROUND_N, 4, GROUND_N, 4).mean((1, 3))
    A = np.stack([np.ones(gx.size), gx.ravel(), gz.ravel()], -1)
    (a, b, c), *_ = np.linalg.lstsq(A, bin2.ravel(), rcond=None)
    print(f'  shading fit: I = {a:.0f} {b:+.0f} dh/dx {c:+.0f} dh/dz')
    shade = np.clip(1 + (b * gx + c * gz) / a, 0.35, 3.0)
    shade4 = np.array(Image.fromarray(shade.astype(np.float32), 'F').resize((ALBEDO_N, ALBEDO_N), Image.BILINEAR))
    alb = img / shade4
    alb /= np.median(alb)
    print(f'  albedo multiplier: 1% {np.percentile(alb, 1):.2f}, 99% {np.percentile(alb, 99):.2f}')
    png = os.path.join(RAW, 'lroc', 'ground_albedo.png')
    Image.fromarray(np.round(srgb(alb * 0.5) * 255).astype(np.uint8), 'L').convert('RGB').save(png)
    basisu(png, os.path.join(IMAGES, 'ground-albedo.ktx2'))


if __name__ == '__main__':
    os.makedirs(IMAGES, exist_ok=True)
    os.makedirs(DATA, exist_ok=True)
    which = sys.argv[1:] or ['stars', 'milkyway', 'ground']
    for step in which:
        print(step)
        {'stars': stars, 'milkyway': milkyway, 'ground': ground}[step]()
