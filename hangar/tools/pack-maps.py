#!/usr/bin/env python3
"""Normalise one raw material folder before encoding (needs Pillow).

    python3 hangar/tools/pack-maps.py hangar/tools/raw/materials/<slug>

Writes <slug>/out/{color,normal,orm,height}.png, each 2048x2048, 8 bits per channel:
  color   RGB, or RGBA when opacity.png exists (alpha = opacity, for grating)
  normal  RGB, OpenGL convention (green up), as downloaded
  orm     R = ambient occlusion, G = roughness, B = metalness. Taken from orm.png when the source ships
          one (Poly Haven's `arm`), else packed from ao.png (default white), rough.png, metal.png (default black)
  height  greyscale, 16-bit sources reduced to 8 bits
"""
import os
import sys
from PIL import Image

SIZE = 2048


def load(path, mode):
    im = Image.open(path)
    if im.mode in ('I;16', 'I;16B', 'I;16L', 'I'):
        # 16-bit greyscale: scale to 8 bits rather than letting Pillow clip.
        im = im.point(lambda v: v / 256).convert('L')
    im = im.convert(mode)
    if im.size != (SIZE, SIZE):
        im = im.resize((SIZE, SIZE), Image.LANCZOS)
    return im


def main(d):
    out = os.path.join(d, 'out')
    os.makedirs(out, exist_ok=True)
    p = lambda n: os.path.join(d, n + '.png')
    have = lambda n: os.path.exists(p(n))

    color = load(p('color'), 'RGB')
    if have('opacity'):
        color.putalpha(load(p('opacity'), 'L'))
    color.save(os.path.join(out, 'color.png'))
    load(p('normal'), 'RGB').save(os.path.join(out, 'normal.png'))

    if have('orm'):
        orm = load(p('orm'), 'RGB')
    else:
        ao = load(p('ao'), 'L') if have('ao') else Image.new('L', (SIZE, SIZE), 255)
        metal = load(p('metal'), 'L') if have('metal') else Image.new('L', (SIZE, SIZE), 0)
        orm = Image.merge('RGB', (ao, load(p('rough'), 'L'), metal))
    orm.save(os.path.join(out, 'orm.png'))
    load(p('height'), 'L').save(os.path.join(out, 'height.png'))


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
