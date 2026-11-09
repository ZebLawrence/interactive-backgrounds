#!/usr/bin/env python3
"""Turn a raw material folder into the three WebP maps the page loads (needs Pillow).

    python trawler/tools/pack.py [--size 1024] [tag ...]

With no tags it packs every folder under trawler/tools/raw/materials/. For each one it writes
trawler/html/assets/materials/<slug>/:

    color.webp   RGB albedo, sRGB, lossy quality 92
    normal.webp  RGB, OpenGL convention (green up), lossless: a normal map is a vector field and
                 lossy chroma subsampling puts visible facets into it
    orm.webp     R = ambient occlusion, G = roughness, B = metalness, lossy quality 95

The size is the texture's width in pixels. The page's materials then tile them at the number of
metres recorded in the manifest, which is what sets the pixels per metre: 1024 over a 1 m tile is
1024 px/m, the project's rule for anything the viewer can reach.

Height maps are deliberately not packed. Hangar's lesson was that parallax on a surface seen at a
grazing angle smears and shimmers, and that relief the camera gets close to is better built as
geometry; the normal map carries the rest.
"""
import os
import sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, 'raw', 'materials')
OUT = os.path.join(HERE, '..', 'html', 'assets', 'materials')


def load(path, mode, size):
    im = Image.open(path)
    if im.mode in ('I;16', 'I;16B', 'I;16L', 'I'):
        im = im.point(lambda v: v / 256).convert('L')
    im = im.convert(mode)
    if im.size != (size, size):
        im = im.resize((size, size), Image.LANCZOS)
    return im


def pack(slug, size):
    d = os.path.join(RAW, slug)
    out = os.path.join(OUT, slug)
    os.makedirs(out, exist_ok=True)

    def p(n):
        return os.path.join(d, n + '.png')

    def have(n):
        return os.path.exists(p(n))

    if not have('color'):
        raise SystemExit(f'{slug}: no color.png in {d}')
    load(p('color'), 'RGB', size).save(os.path.join(out, 'color.webp'), quality=92, method=5)
    if have('normal'):
        load(p('normal'), 'RGB', size).save(os.path.join(out, 'normal.webp'), lossless=True, method=5)

    if have('orm'):
        orm = load(p('orm'), 'RGB', size)
    else:
        ao = load(p('ao'), 'L', size) if have('ao') else Image.new('L', (size, size), 255)
        metal = load(p('metal'), 'L', size) if have('metal') else Image.new('L', (size, size), 0)
        rough = load(p('rough'), 'L', size) if have('rough') else Image.new('L', (size, size), 180)
        orm = Image.merge('RGB', (ao, rough, metal))
    orm.save(os.path.join(out, 'orm.webp'), quality=95, method=5)

    total = sum(os.path.getsize(os.path.join(out, f)) for f in os.listdir(out))
    print(f'  {slug}: {size}px, {total / 1e6:.2f} MB')


def main(argv):
    size = 1024
    tags = []
    i = 0
    while i < len(argv):
        if argv[i] == '--size':
            size = int(argv[i + 1])
            i += 2
        else:
            tags.append(argv[i].replace('mat:', ''))
            i += 1
    if not tags:
        tags = sorted(d for d in os.listdir(RAW) if os.path.isdir(os.path.join(RAW, d)))
    for t in tags:
        pack(t, size)


if __name__ == '__main__':
    main(sys.argv[1:])
