// Re-encodes every texture of a glTF/GLB as KTX2 UASTC with basisu and marks it KHR_texture_basisu.
//
//   node hangar/tools/ktx2-textures.mjs <in.gltf|glb> <out.glb>
//
// Stands in for `gltf-transform optimize --texture-compress ktx2`, which shells out to KTX-Software's `ktx`
// CLI; Homebrew has no formula for it, so this drives basisu (Homebrew `basis_universal`) with the same
// settings as prepare-textures.sh. Colour slots are sRGB, normal maps use -normal_map, the rest are linear.
// No -y_flip here: glTF UVs already have their origin at the top left, like KTX2.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [input, output] = process.argv.slice(2);
if (!input || !output) { console.error('usage: ktx2-textures.mjs <in> <out.glb>'); process.exit(2); }

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(input);
const root = doc.getRoot();

// Which material slots use each texture decides its colour space.
const role = new Map();
for (const mat of root.listMaterials()) {
  const mark = (tex, r) => { if (tex && !role.has(tex)) role.set(tex, r); };
  mark(mat.getBaseColorTexture(), 'srgb');
  mark(mat.getEmissiveTexture(), 'srgb');
  mark(mat.getNormalTexture(), 'normal');
  mark(mat.getOcclusionTexture(), 'linear');
  mark(mat.getMetallicRoughnessTexture(), 'linear');
}

const tmp = mkdtempSync(path.join(tmpdir(), 'hangar-ktx2-'));
try {
  root.listTextures().forEach((tex, i) => {
    if (tex.getMimeType() === 'image/ktx2') return;
    const ext = tex.getMimeType() === 'image/png' ? 'png' : 'jpg';
    const src = path.join(tmp, `t${i}.${ext}`), dst = path.join(tmp, `t${i}.ktx2`);
    writeFileSync(src, tex.getImage());
    const r = role.get(tex) ?? 'linear';
    const flags = r === 'srgb' ? [] : r === 'normal' ? ['-normal_map'] : ['-linear'];
    execFileSync('basisu', ['-ktx2', '-uastc', '-uastc_level', '3', '-ktx2_zstandard_level', '19', '-mipmap', ...flags, src, '-output_file', dst], { stdio: 'ignore' });
    tex.setImage(new Uint8Array(readFileSync(dst))).setMimeType('image/ktx2');
    if (tex.getURI()) tex.setURI(tex.getURI().replace(/\.(png|jpe?g)$/i, '.ktx2'));
    console.log(`  ${tex.getName() || tex.getURI() || i}: ${r}`);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
doc.createExtension(KHRTextureBasisu).setRequired(true);
await io.write(output, doc);
