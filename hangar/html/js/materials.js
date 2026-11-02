// Hangar — Materials: the scanned PBR sets as MeshPhysicalMaterials with parallax-occlusion relief.
//
// makeMaterials(assets, manifest, renderer) -> Map<tag, MeshPhysicalMaterial> for every material in the
// manifest; makeMaterial(tag, maps, entry, renderer) builds (or returns the cached) one as its maps arrive.
// Maps: colour (sRGB) -> map, normal -> normalMap, orm (R AO, G roughness, B metalness) -> aoMap, roughnessMap
// and metalnessMap, height -> the parallax patch below. Geometry UVs are metres / 2 (Ruling R3), so every map
// repeats 2 / tile.
//
// Parallax occlusion: the view ray is marched into the height field (surface at white, full depth at black)
// in 16 to 32 layers (more at grazing angles), then refined by 5 bisection steps between the last two layers;
// every map is then read at the displaced coordinate, so seams, rivets and grate bars occlude each other and
// slide against one another as the camera moves. The tangent frame comes from screen-space derivatives of the
// view position and the map coordinate, which also gives the metres-per-uv scale exactly, so the height scale
// is in metres. The effect fades to nothing between 6 m and 10 m from the camera; beyond that the normal map
// carries the relief on its own. All texture reads inside the patch use the un-displaced derivatives
// (textureGrad), so mip selection is the same as without POM and nothing shimmers at relief edges.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Relief depth in metres for a full black-to-white height range. Panels, grating and concrete are the
// plan's values; the others are judged from their scans (brushed steel is grain, not relief).
export const HEIGHT_SCALE = {
  'mat:panel-brown': 0.012, 'mat:steel': 0.012, 'mat:computer': 0.012, 'mat:diamond-plate': 0.012, 'mat:hazard': 0.012,
  'mat:grate': 0.02,
  'mat:concrete': 0.006, 'mat:concrete-cracked': 0.006, 'mat:concrete-painted': 0.006, 'mat:concrete-stained': 0.006,
  'mat:regolith': 0.01, 'mat:rust': 0.008, 'mat:rubber': 0.006, 'mat:steel-brushed': 0.003,
};
const DEFAULT_HEIGHT = 0.006;

// Shared by reference with every patched material (never merged or cloned, which would copy them).
export const pomUniforms = {
  pomFadeNear: { value: 6 },
  pomFadeFar: { value: 10 },
  pomEnabled: { value: 1 },
};

const cache = new Map(); // tag -> { maps, material }: one material per tag for the life of the page

/** Every map: tiling, maximum anisotropy, trilinear mips (the loader already sets these; they are restated). */
function prepare(tex, repeat, anisotropy) {
  if (!tex) return tex;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = anisotropy;
  if (!tex.userData.fallback) tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// ---- shader patch ------------------------------------------------------------------------------------------

const POM_PARS = /* glsl */ `
uniform sampler2D pomHeightMap;
uniform float pomScale;
uniform float pomFadeNear;
uniform float pomFadeFar;
uniform float pomEnabled;
vec2 pomUv;
vec2 pomDx;
vec2 pomDy;
vec3 pomQ0;
vec3 pomQ1;
float pomHit; // depth (0 surface, 1 floor of the height field) where the view ray met the relief
float pomDepthAt( vec2 uv ) { return 1.0 - textureGrad( pomHeightMap, uv, pomDx, pomDy ).r; }
// Displace uv along the view ray. V is the unit vector from the surface to the eye, N the geometric normal,
// both in view space. Returns uv unchanged when the effect is faded out or the frame is degenerate. The screen
// derivatives (pomDx, pomDy, pomQ0, pomQ1) are taken in main before any branch, where they are defined.
vec2 pomDisplace( vec2 uv, vec3 V, vec3 N ) {
  float dist = length( vViewPosition );
  float fade = pomEnabled * ( 1.0 - smoothstep( pomFadeNear, pomFadeFar, dist ) );
  pomHit = 0.0;
  if ( fade <= 0.0 || pomScale <= 0.0 ) return uv;
  // Surface tangents in metres per uv unit, from the 2x2 inverse of the uv derivatives.
  vec3 q0 = pomQ0, q1 = pomQ1;
  float det = pomDx.x * pomDy.y - pomDy.x * pomDx.y;
  if ( abs( det ) < 1e-12 ) return uv;
  vec3 T = ( q0 * pomDy.y - q1 * pomDx.y ) / det;
  vec3 B = ( q1 * pomDx.x - q0 * pomDy.x ) / det;
  float tt = dot( T, T ), bb = dot( B, B );
  if ( tt < 1e-12 || bb < 1e-12 ) return uv;
  float vz = dot( V, N );
  if ( vz <= 0.0 ) return uv;
  // uv shift for a ray reaching full depth, in uv units (view ray component along T and B, over its depth).
  vec2 vt = vec2( dot( V, T ) / tt, dot( V, B ) / bb );
  vec2 shift = - vt / max( vz, 0.08 ) * pomScale * fade;
  float layers = mix( 32.0, 16.0, vz );
  float layerStep = 1.0 / layers;
  vec2 dUv = shift * layerStep;
  float layer = 0.0;
  vec2 cur = uv;
  float d = pomDepthAt( cur );
  for ( int i = 0; i < 32; i ++ ) {
    if ( float( i ) >= layers || layer >= d ) break;
    cur += dUv;
    layer += layerStep;
    d = pomDepthAt( cur );
  }
  // Bisect between the last layer above the surface and the first below it.
  vec2 lo = cur - dUv, hi = cur;
  float llo = layer - layerStep, lhi = layer;
  for ( int i = 0; i < 5; i ++ ) {
    vec2 mid = 0.5 * ( lo + hi );
    float lmid = 0.5 * ( llo + lhi );
    if ( lmid >= pomDepthAt( mid ) ) { hi = mid; lhi = lmid; } else { lo = mid; llo = lmid; }
  }
  pomHit = 0.5 * ( llo + lhi ) * fade;
  return 0.5 * ( lo + hi );
}
`;

const POM_MAIN = /* glsl */ `
  pomDx = dFdx( vMapUv );
  pomDy = dFdy( vMapUv );
  pomQ0 = dFdx( - vViewPosition );
  pomQ1 = dFdy( - vViewPosition );
  pomUv = pomDisplace( vMapUv, normalize( vViewPosition ), normalize( vNormal ) );
`;

// A chunk with its texture reads moved to the displaced coordinate, sampled with the un-displaced gradients.
const displaced = (name, sampler, varying) => {
  const src = THREE.ShaderChunk[name];
  const from = `texture2D( ${sampler}, ${varying} )`;
  if (!src.includes(from)) throw new Error(`materials: chunk ${name} no longer reads ${from}`);
  return src.replaceAll(from, `textureGrad( ${sampler}, pomUv, pomDx, pomDy )`);
};

// Grating: the colour alpha is the open area. The level has no geometry under a walkway, so the holes are
// drawn as a dark, rough, deep void rather than cut out (real see-through bars are geometry, a later task).
const GRATE_HOLES = /* glsl */ `
  #ifdef POM_HOLES
    float pomSolid = smoothstep( 0.35, 0.65, diffuseColor.a );
    diffuseColor.rgb *= mix( 0.025, 1.0, pomSolid );
    // The sides of the bars, seen down into the grating, face away from the room: shade them by depth so
    // the few edge texels POM stretches over them read as shadowed steel rather than bright smears.
    diffuseColor.rgb *= 1.0 - 0.7 * smoothstep( 0.2, 0.75, pomHit );
    diffuseColor.a = 1.0;
  #endif
`;

function patch(material, heightMap, scale, holes) {
  const own = { pomHeightMap: { value: heightMap }, pomScale: { value: scale } };
  material.userData.pom = own;
  if (holes) material.defines = { ...(material.defines ?? {}), POM_HOLES: '' };
  material.onBeforeCompile = (shader) => {
    // Shared uniform objects by reference, per-material ones from userData; nothing is copied.
    Object.assign(shader.uniforms, pomUniforms, own);
    let fs = shader.fragmentShader;
    const swap = (inc, text) => {
      if (!fs.includes(inc)) throw new Error(`materials: ${inc} missing from the physical fragment shader`);
      fs = fs.replace(inc, text);
    };
    swap('void main() {', `${POM_PARS}\nvoid main() {`);
    swap('#include <map_fragment>', `${POM_MAIN}\n${displaced('map_fragment', 'map', 'vMapUv')}\n${GRATE_HOLES}`);
    swap('#include <roughnessmap_fragment>', `${displaced('roughnessmap_fragment', 'roughnessMap', 'vRoughnessMapUv')}
  #ifdef POM_HOLES
    roughnessFactor = mix( 1.0, roughnessFactor, pomSolid );
    roughnessFactor = mix( roughnessFactor, 1.0, 0.6 * smoothstep( 0.2, 0.75, pomHit ) );
  #endif`);
    swap('#include <metalnessmap_fragment>', `${displaced('metalnessmap_fragment', 'metalnessMap', 'vMetalnessMapUv')}
  #ifdef POM_HOLES
    metalnessFactor *= pomSolid;
  #endif`);
    swap('#include <normal_fragment_maps>', displaced('normal_fragment_maps', 'normalMap', 'vNormalMapUv'));
    swap('#include <aomap_fragment>', displaced('aomap_fragment', 'aoMap', 'vAoMapUv').replace(
      'reflectedLight.indirectDiffuse *= ambientOcclusion;',
      '#ifdef POM_HOLES\n\tambientOcclusion *= mix( 0.05, 1.0, pomSolid );\n#endif\n\treflectedLight.indirectDiffuse *= ambientOcclusion;'));
    shader.fragmentShader = fs; // write the edited source back (guidelines section 4)
  };
  material.customProgramCacheKey = () => `hangar-pom-1${holes ? '-holes' : ''}`;
}

/**
 * One material for a manifest tag from its four maps ({ color, normal, orm, height }). Cached per tag: a
 * reseeded scene gets the same material (and compiled program) back. `entry` is the manifest entry (tile).
 */
export function makeMaterial(tag, maps, entry, renderer) {
  const hit = cache.get(tag);
  if (hit && hit.maps.color === maps.color) return hit.material;
  const anisotropy = renderer.capabilities.getMaxAnisotropy();
  const tile = entry?.tile > 0 ? entry.tile : 2;
  const repeat = 2 / tile; // geometry UVs are metres / 2
  for (const k of ['color', 'normal', 'orm', 'height']) prepare(maps[k], repeat, anisotropy);
  const material = new THREE.MeshPhysicalMaterial({
    name: tag,
    map: maps.color,
    normalMap: maps.normal,
    aoMap: maps.orm,
    roughnessMap: maps.orm,
    metalnessMap: maps.orm,
    roughness: 1,
    metalness: 1,
    side: THREE.FrontSide,
  });
  material.userData.shared = true; // owned by this module, not by a scene: Scene.dispose leaves it
  patch(material, maps.height, HEIGHT_SCALE[tag] ?? DEFAULT_HEIGHT, !!entry?.alpha);
  cache.set(tag, { maps, material });
  return material;
}

/** Map<tag, material> for every manifest material whose maps are in `assets.textures` (`<tag>.<map>` keys). */
export function makeMaterials(assets, manifest, renderer) {
  const out = new Map();
  for (const [tag, entry] of Object.entries(manifest?.materials ?? {})) {
    const maps = {};
    for (const k of ['color', 'normal', 'orm', 'height']) maps[k] = assets.textures.get(`${tag}.${k}`);
    if (!maps.color || !maps.normal || !maps.orm || !maps.height) continue;
    out.set(tag, makeMaterial(tag, maps, entry, renderer));
  }
  return out;
}

const envs = new WeakMap();
/**
 * A dim neutral room for image-based reflections, so metal has something to reflect before the real fixtures
 * and probes arrive (a metal under only a hemisphere light reflects nothing and reads as black).
 */
export function environmentFor(renderer) {
  if (!envs.has(renderer)) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    envs.set(renderer, pmrem.fromScene(room, 0.04).texture);
    room.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
    pmrem.dispose();
  }
  return envs.get(renderer);
}
