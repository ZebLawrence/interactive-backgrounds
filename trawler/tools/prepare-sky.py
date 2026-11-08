#!/usr/bin/env python3
"""Turn NASA's starless Milky Way map into the WebP the page loads (needs numpy, Pillow, OpenEXR).

    python trawler/tools/prepare-sky.py [--size 4096]

Input, downloaded by hand into trawler/tools/raw/sky/ (git-ignored):

    milkyway_2020_4k.exr    NASA SVS Deep Star Maps 2020, the Milky Way with the Hipparcos and
                            Tycho stars taken out, in equatorial (ICRS) coordinates, 4096 x 2048
                            https://svs.gsfc.nasa.gov/4851/

Output (committed):

    html/assets/milkyway.webp   4096 x 2048 equirectangular, RA 0 at the centre with RA rising to
                                the left, north at the top row, linear radiance / MW_SCALE stored
                                sRGB-encoded.

The stars in this scene are the Hipparcos catalogue drawn as points, so the starless version of the
map is the one that is wanted: the other one would draw the bright stars a second time, as blurs
under the real ones.

Why the top row is north and no flip is applied. three's SphereGeometry puts uv.y = 1 at +y, and a
THREE.Texture uploads with flipY = true, which maps the image's top row to v = 1. So an image with
north at the top arrives at the top of the sphere. (Hangar's copy is KTX2, which cannot be flipped
at upload, so its encoder flips the rows instead; this one does not need to.)

MW_SCALE is the radiance that is stored as 1.0. It is Hangar's number, and it is a clip rather than
a normalisation: the brightest hundredth of a per cent of the map goes over.
"""
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, 'raw', 'sky')
OUT = os.path.join(HERE, '..', 'html', 'assets')

MW_SCALE = 0.2


def srgb(x):
    """Linear to sRGB, the exact piecewise curve."""
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1.0 / 2.4) - 0.055)


def main(size=4096):
    import OpenEXR

    src = os.path.join(RAW, 'milkyway_2020_4k.exr')
    if not os.path.exists(src):
        sys.exit('missing %s - see the docstring for where to download it' % src)
    rgb = OpenEXR.File(src).channels()['RGB'].pixels.astype(np.float32)
    h, w = rgb.shape[:2]
    over = float((rgb.max(axis=2) > MW_SCALE).mean())
    print('  read %d x %d, max %.4f, %.4f%% of texels clip at MW_SCALE %.2f'
          % (w, h, rgb.max(), over * 100, MW_SCALE))

    img = Image.fromarray(np.round(srgb(rgb / MW_SCALE) * 255).astype(np.uint8), 'RGB')
    if img.width != size:
        img = img.resize((size, size // 2), Image.LANCZOS)
    os.makedirs(OUT, exist_ok=True)
    dst = os.path.join(OUT, 'milkyway.webp')
    img.save(dst, 'WEBP', quality=92, method=6)
    print('  assets/milkyway.webp: %d x %d, %.2f MB' % (img.width, img.height, os.path.getsize(dst) / 1e6))

    # The galactic centre is at RA 17h45m40s, dec -28.94, and it is by a long way the brightest
    # part of the map. Finding it where it belongs is what says the image's own convention - RA 0
    # at the centre, RA rising to the left, north at the top - is the one this file assumes.
    ra, dec = (17 + 45 / 60 + 40 / 3600) * 15.0, -28.94
    u = (0.5 - ra / 360.0) % 1.0
    v = (90.0 - dec) / 180.0
    a = np.asarray(img.convert('L'), dtype=np.float32)
    gy, gx = int(v * a.shape[0]), int(u * a.shape[1])
    patch = a[max(gy - 24, 0):gy + 24, max(gx - 24, 0):gx + 24].mean()
    iy, ix = np.unravel_index(int(np.argmax(a)), a.shape)
    print('  galactic centre expected at u %.3f v %.3f (px %d, %d): mean %.0f of 255' % (u, v, gx, gy, patch))
    print('  brightest texel in the map: px %d, %d -> RA %.1f dec %+.1f'
          % (ix, iy, ((0.5 - ix / a.shape[1]) % 1.0) * 360.0, 90.0 - 180.0 * iy / a.shape[0]))
    print('  map mean %.1f, galactic-centre patch is %.1fx the mean' % (a.mean(), patch / max(a.mean(), 1e-6)))


if __name__ == '__main__':
    n = 4096
    if '--size' in sys.argv:
        n = int(sys.argv[sys.argv.index('--size') + 1])
    main(n)
