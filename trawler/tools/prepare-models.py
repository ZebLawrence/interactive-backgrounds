#!/usr/bin/env python3
"""Copy the downloaded glTF props into the page's assets, with their textures as WebP.

    python trawler/tools/prepare-models.py [--size 1024] [name ...]

Reads trawler/tools/raw/models/<name>/ (a Poly Haven glTF: one .gltf, one .bin and a handful of
PNG maps) and writes trawler/html/assets/models/<name>/ with the same geometry, the maps converted
to WebP, and the .gltf's image URIs pointed at them.

three.js loads a WebP image through the ordinary image loader, so no glTF extension is needed; the
file stays a plain glTF 2.0 that any viewer with WebP support will open. The geometry is left
exactly as downloaded: these props are a handful of objects seen close up, not a forest, so there
is nothing to gain by decimating them and a lot of detail to lose.
"""
import json
import os
import shutil
import sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, 'raw', 'models')
OUT = os.path.join(HERE, '..', 'html', 'assets', 'models')

# A normal map is a vector field: lossy chroma subsampling puts visible facets into it.
LOSSLESS_HINTS = ('nor', 'normal')


def convert(src, dst, size):
    im = Image.open(src)
    if im.mode in ('I;16', 'I;16B', 'I;16L', 'I'):
        im = im.point(lambda v: v / 256).convert('L')
    has_alpha = im.mode in ('RGBA', 'LA') or (im.mode == 'P' and 'transparency' in im.info)
    im = im.convert('RGBA' if has_alpha else 'RGB')
    if max(im.size) > size:
        im = im.resize((size, size), Image.LANCZOS)
    name = os.path.basename(src).lower()
    if any(h in name for h in LOSSLESS_HINTS):
        im.save(dst, lossless=True, method=5)
    else:
        im.save(dst, quality=92, method=5)


def prepare(name, size):
    d = os.path.join(RAW, name)
    out = os.path.join(OUT, name)
    if not os.path.isdir(d):
        raise SystemExit(f'{name}: nothing downloaded in {d}')
    os.makedirs(out, exist_ok=True)
    gltf_src = next(f for f in os.listdir(d) if f.endswith('.gltf'))
    with open(os.path.join(d, gltf_src), encoding='utf-8') as f:
        doc = json.load(f)

    for img in doc.get('images', []):
        uri = img.get('uri')
        if not uri or uri.startswith('data:'):
            continue
        rel = uri.replace('\\', '/')
        src = os.path.join(d, *rel.split('/'))
        base = os.path.splitext(os.path.basename(rel))[0]
        convert(src, os.path.join(out, base + '.webp'), size)
        img['uri'] = base + '.webp'
        img['mimeType'] = 'image/webp'

    for buf in doc.get('buffers', []):
        uri = buf.get('uri')
        if not uri or uri.startswith('data:'):
            continue
        rel = uri.replace('\\', '/')
        shutil.copyfile(os.path.join(d, *rel.split('/')), os.path.join(out, os.path.basename(rel)))
        buf['uri'] = os.path.basename(rel)

    with open(os.path.join(out, name + '.gltf'), 'w', encoding='utf-8') as f:
        json.dump(doc, f, separators=(',', ':'))

    total = sum(os.path.getsize(os.path.join(out, f)) for f in os.listdir(out))
    tris = 0
    for mesh in doc.get('meshes', []):
        for prim in mesh.get('primitives', []):
            acc = doc['accessors'][prim['indices']] if 'indices' in prim else None
            if acc:
                tris += acc['count'] // 3
    print(f'  {name}: {total / 1e6:.2f} MB, {tris / 1000:.0f}k triangles')


def main(argv):
    size = 1024
    names = []
    i = 0
    while i < len(argv):
        if argv[i] == '--size':
            size = int(argv[i + 1])
            i += 2
        else:
            names.append(argv[i])
            i += 1
    if not names:
        names = sorted(d for d in os.listdir(RAW) if os.path.isdir(os.path.join(RAW, d)))
    for n in names:
        prepare(n, size)


if __name__ == '__main__':
    main(sys.argv[1:])
