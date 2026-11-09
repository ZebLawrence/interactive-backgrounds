#!/usr/bin/env python3
"""Make the land's macro textures from NASA Earth Observatory Landsat scenes (needs Pillow, numpy).

    python trawler/tools/satellite.py [--fetch] [class ...]

The scanned ground materials (rock, heath, scree, snow) are one- and two-metre tiles. They are
right at arm's length and wrong at a kilometre: averaged over a hillside they come out as a flat
colour, and the hill reads as a gradient; and close in, on a shore a hundred metres off, the tile's
repeat is twenty pixels wide and the eye counts it. What is missing is everything between ten
metres and ten kilometres - the lichen on the shoulders and the bog in the hollows, the scree fans,
the snow lying in the gullies - and that is exactly what a satellite photograph has. Each class gets
one macro tile cut from a natural-colour Landsat scene at about fifteen metres a pixel; the terrain
shader lays it over the ground at world scale, multiplies the scan detail by it near to, and lets it
carry the hill alone at range (terrain.js).

For each class this script: cuts a window from the scene; paints out the water and the cloud in it,
by cloning land from elsewhere in the window (a lake is real fjord country, but on a hillside with
no lake in its shape it reads as a black hole); makes the tile seamless with the offset-and-blend
method (the tile is rolled by half its size, so its seams fall across the middle, and the middle is
then covered with a feathered copy of the original, which has no seam there); and writes it to
trawler/html/assets/satellite/<class>.webp as sRGB at 1024 pixels.

The scenes are NASA Earth Observatory images built from USGS Landsat data, public domain. --fetch
downloads them to trawler/tools/raw/sat/ (git-ignored); the manifest entries, with the credits the
Earth Observatory asks for, are written by hand in html/assets/manifest.json.
"""
import os
import sys
import urllib.request

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, 'raw', 'sat')
OUT = os.path.join(HERE, '..', 'html', 'assets', 'satellite')
EO = 'https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords'

SCENES = {
    # Saltfjorden and the hills behind Bodo, Nordland, Norway. Landsat 8 OLI, 11 July 2016.
    # https://earthobservatory.nasa.gov/images/89984/ungovernable-fury
    'salt': f'{EO}/89000/89984/saltstraumen_oli_2016193_lrg.jpg',
    # The glaciers above Tunulliarfik Fjord, southern Greenland. Landsat 9 OLI-2, 3 August 2023.
    # https://earthobservatory.nasa.gov/images/151870/ephemeral-arc-spans-greenland-fjord
    'sept': f'{EO}/151000/151870/septpuzzlerwide_oli2_2023215.jpg_lrg.jpg',
}

# class: (scene, left, top, size) in the scene's pixels. Chosen by eye from contact sheets of the
# scenes: windows that are the land cover they are named for, with as little water and cloud in
# them as the terrain allows (what is left is painted out below). In the Saltfjorden scene a band
# of cirrus crosses rows 1600-2200; the heath sits above it and the upland below. There is no
# tile for the steep rock: a satellite looks down, and a cliff face in one is a line, so the
# shader gives the steep ground the plateau's picture, turned and darkened (terrain.js). A
# Greenland Landsat 7 scene was tried for it and had a lavender cast the fjord does not.
WINDOWS = {
    'heath': ('salt', 2480, 1030, 520),  # green-brown hillsides behind the fjord, birch and bog
    'upland': ('salt', 3300, 2250, 700),  # the bare grey-brown plateau, snow in the hollows
    'snow': ('sept', 200, 1800, 800),  # snowfield and glacier with the ridges standing out of it
}
SIZE = 1024


def fetch():
    os.makedirs(RAW, exist_ok=True)
    for key, url in SCENES.items():
        path = os.path.join(RAW, os.path.basename(url))
        if os.path.exists(path) and os.path.getsize(path) > 0:
            continue
        print('fetching', key, url)
        urllib.request.urlretrieve(url, path)


def masks(a):
    """
    Water and cloud, as booleans. In a natural-colour Landsat scene a lake or a fjord is either
    dark navy - blue well over red and over green, and dim - or, where it carries glacial silt, a
    bright turquoise with green and blue both far over red. Shadowed rock is grey and vegetation
    has red over blue, so neither is caught; an earlier test of merely 'bluer than red' took half
    of every hillside with it. Cloud and bare ice are white: every channel high.
    """
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    lum = a.mean(2)
    # A shadowed slope is lit by the sky and so is bluish too, but it is not as dark as a lake:
    # lakes in these scenes sit under 60 and shadowed ground over it.
    navy = (b > r * 1.3) & (b > g * 1.02) & (lum < 60)
    turquoise = (g > r * 1.5) & (b > r * 1.5) & (lum > 80)
    black = lum < 22
    water = navy | turquoise | black
    cloud = a.min(2) > 205
    return water, cloud


def grow(mask, n):
    """Dilates a boolean mask by n pixels, so a lake's wet shore goes with the lake."""
    m = mask.copy()
    for _ in range(n):
        p = np.pad(m, 1)
        m = p[1:-1, 1:-1] | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]
    return m


def inpaint(a, bad):
    """
    Fills the masked pixels with land cloned from elsewhere in the same tile: for each of a set of
    offsets, every bad pixel whose offset twin is good takes the twin's colour. What is still bad
    after that (a lake bigger than every offset) is filled from its nearest good neighbour. The
    clones carry the tile's own texture, so a filled lake is a patch of hillside and not a smear.
    """
    h, w = bad.shape
    out = a.copy()
    good = ~bad
    rng = np.random.default_rng(7)
    for _ in range(40):
        if not bad.any():
            break
        dy, dx = int(rng.integers(h // 6, h // 2)) * int(rng.choice([-1, 1])), int(rng.integers(w // 6, w // 2)) * int(rng.choice([-1, 1]))
        src = np.roll(np.roll(out, dy, 0), dx, 1)
        srcGood = np.roll(np.roll(good, dy, 0), dx, 1)
        take = bad & srcGood
        out[take] = src[take]
        bad = bad & ~take
        good = ~bad
    # Anything left: flood from the nearest good pixel, a ring at a time.
    while bad.any():
        p = np.pad(out, ((1, 1), (1, 1), (0, 0)), mode='edge')
        g = np.pad(good, 1, mode='edge')
        acc = np.zeros_like(out)
        cnt = np.zeros(bad.shape, np.float32)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            sl = p[1 + dy:h + 1 + dy, 1 + dx:w + 1 + dx]
            gl = g[1 + dy:h + 1 + dy, 1 + dx:w + 1 + dx]
            acc += sl * gl[..., None]
            cnt += gl
        fill = bad & (cnt > 0)
        out[fill] = acc[fill] / cnt[fill][..., None]
        bad = bad & ~fill
        good = ~bad
    return out


def seamless(a):
    """
    Offset-and-blend. Rolled by half, the tile's four edges meet in a cross through the middle;
    the original, which is continuous there, is laid over that cross with a feathered mask. The
    result's own edges are the rolled tile's, which were the original's middle, and so wrap.
    """
    h, w, _ = a.shape
    rolled = np.roll(np.roll(a, h // 2, 0), w // 2, 1)
    yy, xx = np.mgrid[0:h, 0:w]
    # Distance to the centre cross, in units of the feather width.
    feather = 0.18
    dy = np.abs(yy - h / 2) / (h * feather)
    dx = np.abs(xx - w / 2) / (w * feather)
    m = np.clip(1 - np.minimum(dy, dx), 0, 1)
    m = m * m * (3 - 2 * m)
    return rolled * (1 - m[..., None]) + a * m[..., None]


def build(name):
    scene, x, y, s = WINDOWS[name]
    path = os.path.join(RAW, os.path.basename(SCENES[scene]))
    im = Image.open(path).convert('RGB').crop((x, y, x + s, y + s))
    a = np.asarray(im).astype(np.float32)
    water, cloud = masks(a)
    bad = grow(water, 2) | (grow(cloud, 1) if name != 'snow' else np.zeros_like(cloud))
    print(f'{name}: {scene} ({x},{y},{s}) water {water.mean()*100:.1f}% white {cloud.mean()*100:.1f}% painted {bad.mean()*100:.1f}%')
    # The mask, over the window, for checking by eye: what is painted out shows magenta.
    os.makedirs(OUT, exist_ok=True)
    shown = a.copy()
    shown[bad] = shown[bad] * 0.3 + np.array([255, 0, 200], np.float32) * 0.7
    Image.fromarray(np.clip(shown, 0, 255).astype(np.uint8)).save(os.path.join(OUT, f'{name}.mask.jpg'), quality=80)
    a = inpaint(a, bad)
    a = seamless(a)
    out = Image.fromarray(np.clip(a + 0.5, 0, 255).astype(np.uint8)).resize((SIZE, SIZE), Image.LANCZOS)
    os.makedirs(OUT, exist_ok=True)
    out.save(os.path.join(OUT, f'{name}.webp'), quality=90, method=6)
    # And a 2 x 2 tiling, for checking the seams by eye.
    check = Image.new('RGB', (SIZE, SIZE))
    half = out.resize((SIZE // 2, SIZE // 2), Image.LANCZOS)
    for i in range(2):
        for j in range(2):
            check.paste(half, (i * SIZE // 2, j * SIZE // 2))
    check.save(os.path.join(OUT, f'{name}.check.jpg'), quality=80)


def main(argv):
    if '--fetch' in argv:
        fetch()
        argv = [a for a in argv if a != '--fetch']
    names = argv or list(WINDOWS)
    for n in names:
        build(n)


if __name__ == '__main__':
    main(sys.argv[1:])
