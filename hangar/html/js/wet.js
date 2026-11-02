// Hangar — Wet floors: puddles as thin decals over the floor (positions: wetplan.planWetPatches).
//
// A patch is a flat disc 3 mm above the floor, stretched and turned. Its outline is procedural, evaluated
// per pixel: a radius that wobbles with the angle (four harmonics, seeded per patch by `shape`), cut with a
// one-pixel antialiased edge (fwidth), so the water's edge is crisp at any distance and texel density is not
// a question. Inside, the film darkens the floor a little (more where it is deeper, toward the middle, and
// in a thin wet margin along the edge) and reflects: a smooth water material (roughness 0.05 to 0.15, ior
// 1.33) whose light is added at full strength (ONE, ONE_MINUS_SRC_ALPHA), so the nearest lamp shows in it
// as the live light's sharp highlight and in the room probe.

import * as THREE from 'three';
import { edit } from './materials.js';
import { makeRng } from './rng.js';

const WET_PARS_V = 'varying vec2 vWetQ;';
const WET_PARS_F = /* glsl */ `
varying vec2 vWetQ;
uniform vec4 wetAmp;
uniform vec4 wetPhase;
uniform float wetR0;
uniform float wetMetres; // metres per unit of vWetQ (the patch's shorter half-axis)
float wetCover;
`;
// Outline radius at angle th: wetR0 x (1 + harmonics 2, 3, 5, 7); continuous across atan's branch cut.
const WET_ALPHA = /* glsl */ `
  {
    float r = length( vWetQ );
    float th = atan( vWetQ.y, vWetQ.x );
    float rho = wetR0 * ( 1.0 + wetAmp.x * cos( 2.0 * th + wetPhase.x ) + wetAmp.y * cos( 3.0 * th + wetPhase.y )
      + wetAmp.z * cos( 5.0 * th + wetPhase.z ) + wetAmp.w * cos( 7.0 * th + wetPhase.w ) );
    float aa = max( fwidth( r ), 1e-5 );
    wetCover = smoothstep( - 0.5, 0.5, ( rho - r ) / aa );
    float inside = max( rho - r, 0.0 ) * wetMetres; // metres in from the edge
    float margin = 1.0 - smoothstep( 0.004, 0.02, inside ); // the wet margin along the edge
    float depth = smoothstep( 0.0, 0.25, inside ); // deeper toward the middle
    diffuseColor.a *= wetCover * ( 0.55 + 0.45 * depth + 0.3 * margin );
  }
`;
const FILM = /* glsl */ `
  outgoingLight *= wetCover;
`;

/** Builds the patches as a Group; each mesh has userData.sector and its own material (for its probe). */
export function buildWetPatches(patches, renderer) {
  const group = new THREE.Group();
  group.name = 'wet';
  const geo = new THREE.CircleGeometry(0.5, 48).rotateX(-Math.PI / 2); // unit diameter, facing up
  for (const p of patches) {
    const m = new THREE.MeshPhysicalMaterial({
      name: 'wet', color: 0x0a0a0a, roughness: p.roughness, metalness: 0, ior: 1.33,
      transparent: true, opacity: 0.32, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    m.userData.envDirect = true;
    const rng = makeRng(p.shape);
    const own = {
      wetAmp: { value: new THREE.Vector4(rng.range(0.06, 0.13), rng.range(0.04, 0.09), rng.range(0.02, 0.05), rng.range(0.01, 0.03)) },
      wetPhase: { value: new THREE.Vector4(rng.range(0, 6.3), rng.range(0, 6.3), rng.range(0, 6.3), rng.range(0, 6.3)) },
      wetR0: { value: 0.74 }, // the harmonics' sum stays under 0.3, so the outline stays inside the disc
      wetMetres: { value: p.r },
    };
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, own);
      let vs = shader.vertexShader, fs = shader.fragmentShader;
      vs = edit(vs, 'void main() {', `${WET_PARS_V}\nvoid main() {`, 'the wet vertex shader');
      vs = edit(vs, '#include <uv_vertex>', '#include <uv_vertex>\n\tvWetQ = uv * 2.0 - 1.0;', 'the wet vertex shader');
      fs = edit(fs, 'void main() {', `${WET_PARS_F}\nvoid main() {`, 'the wet fragment shader');
      fs = edit(fs, '#include <alphamap_fragment>', `#include <alphamap_fragment>\n${WET_ALPHA}`, 'the wet fragment shader');
      fs = edit(fs, '#include <opaque_fragment>', `${FILM}\n#include <opaque_fragment>`, 'the wet fragment shader');
      shader.vertexShader = vs;
      shader.fragmentShader = fs;
    };
    m.customProgramCacheKey = () => 'hangar-wet-2';
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
