// Hangar — Wet floors: puddles and damp patches as thin decals over the floor (positions: wetplan).
//
// A patch is a flat disc 3 mm above the floor, stretched and turned, cut to a soft irregular outline by one of
// four mask textures (painted once, seeded, mipmapped). Its material is a smooth water film: near-black
// diffuse, roughness 0.05 to 0.15, ior 1.33, so the floor shows through darkened and the nearest lamp shows
// in it twice: as the sharp specular highlight of the live light and in the room probe's reflection. The
// blend is premultiplied by hand (ONE, ONE_MINUS_SRC_ALPHA, the light faded by the mask in the shader), so
// the reflection keeps its full strength inside the outline instead of being halved by the darkening.

import * as THREE from 'three';
import { edit } from './materials.js';
import { makeRng } from './rng.js';

const MASKS = 4;
let masks = null;

/** Four soft blob outlines: clusters of overlapping radial gradients, kept inside the disc. */
function maskTextures(anisotropy) {
  if (masks) return masks;
  const rng = makeRng(0x5eed);
  masks = Array.from({ length: MASKS }, (_, k) => {
    const N = 256, c = document.createElement('canvas');
    c.width = c.height = N;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, N, N);
    g.globalCompositeOperation = 'lighter';
    const blobs = 7 + k * 2;
    for (let i = 0; i < blobs; i++) {
      const a = rng.range(0, Math.PI * 2), d = rng.range(0, 0.42) * N * 0.5;
      const x = N / 2 + Math.cos(a) * d, y = N / 2 + Math.sin(a) * d;
      const r = rng.range(0.22, 0.42) * N * 0.5 * (1 - d / (N * 0.5) * 0.6);
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,0.55)');
      gr.addColorStop(0.6, 'rgba(255,255,255,0.35)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    // Fade everything to zero before the disc's rim.
    g.globalCompositeOperation = 'source-over';
    const rim = g.createRadialGradient(N / 2, N / 2, N * 0.3, N / 2, N / 2, N * 0.49);
    rim.addColorStop(0, 'rgba(0,0,0,0)');
    rim.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = rim;
    g.fillRect(0, 0, N, N);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.NoColorSpace;
    t.anisotropy = anisotropy;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    return t;
  });
  return masks;
}

// The light reflected by the film fades with the mask, then the blend adds it to the darkened floor.
const FILM = /* glsl */ `
  float wetCover = smoothstep( 0.0, 0.22, diffuseColor.a );
  outgoingLight *= wetCover;
`;

/** Builds the patches as a Group; each mesh has userData.sector and its own material (for its probe). */
export function buildWetPatches(patches, renderer) {
  const group = new THREE.Group();
  group.name = 'wet';
  const tex = maskTextures(renderer.capabilities.getMaxAnisotropy());
  const geo = new THREE.CircleGeometry(0.5, 48).rotateX(-Math.PI / 2); // unit diameter, facing up
  for (const p of patches) {
    const m = new THREE.MeshPhysicalMaterial({
      name: 'wet', color: 0x0a0a0a, roughness: p.roughness, metalness: 0, ior: 1.33,
      alphaMap: tex[p.mask], transparent: true, opacity: 0.4, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    m.userData.envDirect = true;
    m.onBeforeCompile = (shader) => {
      shader.fragmentShader = edit(shader.fragmentShader, '#include <opaque_fragment>', `${FILM}\n#include <opaque_fragment>`, 'the wet fragment shader');
    };
    m.customProgramCacheKey = () => 'hangar-wet-1';
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(p.x, p.y + 0.003, p.z);
    mesh.rotation.y = p.rot;
    mesh.scale.set(2 * p.r * p.stretch, 1, 2 * p.r);
    mesh.receiveShadow = true;
    mesh.userData.sector = p.sector;
    group.add(mesh);
  }
  group.userData.dispose = () => { geo.dispose(); group.children.forEach((c) => c.material.dispose()); };
  return group;
}
