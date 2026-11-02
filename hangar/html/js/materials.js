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

// Relief depth in metres for a full black-to-white height range. Panels, grating and concrete are the
// plan's values; the others are judged from their scans (brushed steel is grain, not relief).
export const HEIGHT_SCALE = {
  'mat:panel-brown': 0.012, 'mat:steel': 0.012, 'mat:computer': 0.012, 'mat:diamond-plate': 0.012, 'mat:hazard': 0.012,
  // Grating: the plan's 0.02 m made POM stretch edge texels down the bar sides (smears at fov 20 and 10).
  // Until the walkway gets real bar geometry (Ruling R15) it is held to 8 mm, with the sides flattened below.
  'mat:grate': 0.008,
  'mat:concrete': 0.006, 'mat:concrete-cracked': 0.006, 'mat:concrete-painted': 0.006, 'mat:concrete-stained': 0.006,
  'mat:regolith': 0.01, 'mat:rust': 0.008, 'mat:rubber': 0.006, 'mat:steel-brushed': 0.003,
};
const DEFAULT_HEIGHT = 0.006;

// Metalness multipliers for scans whose metal map does not match their albedo. Metal Plate 02 (panel-brown)
// marks 91% of its area metallic (B channel mean 0.91, min 0.40) while its colour averages 0.07 linear: as
// metal F0 that is a near-black mirror, so the brown panels rendered black under any light. Its paint and
// rust are dielectric; the scaled map keeps a hint of metal where the scan is most metallic.
export const METALNESS = { 'mat:panel-brown': 0.15 };

// Shared by reference with every patched material (never merged or cloned, which would copy them).
export const pomUniforms = {
  pomFadeNear: { value: 6 },
  pomFadeFar: { value: 10 },
  pomEnabled: { value: 1 },
  // Anti-tiling: a low-frequency grime field in world metres varies albedo and roughness across a surface,
  // so the 1-2 m repeat of a scan stops reading as wallpaper. Painted once at load (mipmapped, see
  // macroTexture), never evaluated as noise per pixel.
  pomMacroMap: { value: null },
  pomMacroAmount: { value: 1 },
};

const cache = new Map(); // tag -> { maps, material }: one material per tag for the life of the page

/**
 * The anti-tiling grime field: 256x256, tileable, two independent channels of smooth value-noise fBm
 * (R albedo, G roughness) with 3 octaves of 4, 8 and 16 cells across the tile. Painted once, mipmapped.
 * A fixed seed: the field is part of the surfaces, not of the tour.
 */
export function macroTexture() {
  if (pomUniforms.pomMacroMap.value) return pomUniforms.pomMacroMap.value;
  const N = 256;
  let seed = 0x9e3779b9;
  const rand = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = Math.imul(seed ^ (seed >>> 15), seed | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const channel = () => {
    const out = new Float32Array(N * N);
    let amp = 1, total = 0;
    for (const cells of [4, 8, 16]) {
      const g = Array.from({ length: cells * cells }, rand);
      const at = (i, j) => g[((j + cells) % cells) * cells + ((i + cells) % cells)];
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const fx = (x / N) * cells, fy = (y / N) * cells;
        const i = Math.floor(fx), j = Math.floor(fy);
        const sx = fx - i, sy = fy - j;
        const ux = sx * sx * (3 - 2 * sx), uy = sy * sy * (3 - 2 * sy);
        const v = (at(i, j) * (1 - ux) + at(i + 1, j) * ux) * (1 - uy) + (at(i, j + 1) * (1 - ux) + at(i + 1, j + 1) * ux) * uy;
        out[y * N + x] += v * amp;
      }
      total += amp; amp *= 0.5;
    }
    // Stretch to the full 0..1 range so the strength in the shader means what it says.
    let lo = Infinity, hi = -Infinity;
    for (const v of out) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return out.map((v) => (v - lo) / (hi - lo || 1));
  };
  const r = channel(), gch = channel();
  const data = new Uint8Array(N * N * 4);
  for (let k = 0; k < N * N; k++) { data[k * 4] = r[k] * 255; data[k * 4 + 1] = gch[k] * 255; data[k * 4 + 2] = 0; data[k * 4 + 3] = 255; }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.colorSpace = THREE.NoColorSpace;
  t.name = 'hangar-macro';
  t.needsUpdate = true;
  pomUniforms.pomMacroMap.value = t;
  return t;
}

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
float pomSteep; // height change across the hit along the ray: large where the ray met a side wall
uniform sampler2D pomMacroMap;
uniform float pomMacroAmount;
varying vec3 vHangarWorld;
// Grime field at world position p with geometric world normal n: floors and ceilings use x/z, walls use
// (distance along the wall, height), so it runs on continuously across sectors in the same plane.
vec2 pomMacro( vec3 p, vec3 n ) {
  vec2 q = abs( n.y ) > 0.5 ? p.xz : vec2( dot( p.xz, normalize( vec2( - n.z, n.x ) + 1e-6 ) ), p.y );
  vec4 a = texture2D( pomMacroMap, q / 9.7 );
  vec4 b = texture2D( pomMacroMap, mat2( 0.8, 0.6, - 0.6, 0.8 ) * q / 3.3 + 0.37 );
  return vec2( 0.62 * a.r + 0.38 * b.r, 0.5 * ( a.g + b.g ) );
}
float pomDepthAt( vec2 uv ) { return 1.0 - textureGrad( pomHeightMap, uv, pomDx, pomDy ).r; }
// Displace uv along the view ray. V is the unit vector from the surface to the eye, N the geometric normal,
// both in view space. Returns uv unchanged when the effect is faded out or the frame is degenerate. The screen
// derivatives (pomDx, pomDy, pomQ0, pomQ1) are taken in main before any branch, where they are defined.
vec2 pomDisplace( vec2 uv, vec3 V, vec3 N ) {
  float dist = length( vViewPosition );
  float fade = pomEnabled * ( 1.0 - smoothstep( pomFadeNear, pomFadeFar, dist ) );
  pomHit = 0.0;
  pomSteep = 0.0;
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
  vec2 hitUv = 0.5 * ( lo + hi );
  // Side-wall test: the height either side of the hit, 1.5 texels along the ray direction.
  float sl = length( shift );
  if ( sl > 1e-9 ) {
    vec2 e = shift / sl * ( 1.5 / float( textureSize( pomHeightMap, 0 ).x ) );
    pomSteep = abs( pomDepthAt( hitUv + e ) - pomDepthAt( hitUv - e ) ) * fade;
  }
  return hitUv;
}
`;

const POM_MAIN = /* glsl */ `
  pomDx = dFdx( vMapUv );
  pomDy = dFdy( vMapUv );
  pomQ0 = dFdx( - vViewPosition );
  pomQ1 = dFdy( - vViewPosition );
  pomUv = pomDisplace( vMapUv, normalize( vViewPosition ), normalize( vNormal ) );
`;

/** Replace `from` in `src` (first occurrence), or throw: a silently skipped shader edit is a lost feature. */
export function edit(src, from, to, where) {
  if (!src.includes(from)) throw new Error(`materials: "${from}" missing from ${where}`);
  return src.replace(from, to);
}

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
    // Bar sides: where the ray met a steep height step, POM would stretch one or two edge texels down
    // the side. Paint the side instead with the bar's local mean colour (a coarse mip, so it is flat and
    // has no streaks), in shade, and treat it as solid steel.
    float pomSide = smoothstep( 0.02, 0.08, pomSteep );
    vec4 pomMean = textureLod( map, pomUv, 6.0 );
    vec3 pomSideCol = pomMean.rgb / max( pomMean.a, 0.25 ) * 0.4;
    diffuseColor.rgb = mix( diffuseColor.rgb, pomSideCol, pomSide );
    pomSolid = max( pomSolid, pomSide );
    diffuseColor.rgb *= mix( 0.025, 1.0, pomSolid );
    diffuseColor.a = 1.0;
  #endif
`;
// Anti-tiling, part 2 (part 1 is per-room uv offsets in scene.js). A scan's visible repeat is its
// low-frequency content: the blotches and streaks every tile. Divide that out (the colour at a coarse mip) and
// put back the same scan's low frequencies taken at 2.7x the scale, plus a world-space grime field. Only
// luminance changes, and only low frequencies: seams, bolts and cracks stay exactly where the normal and
// height maps put them, at full sharpness. Both coarse reads are at or above the pixel's own mip, so
// nothing is sampled finer than its footprint (no shimmer at distance).
const MACRO_ALBEDO = /* glsl */ `
  vec3 pomWorldN = normalize( ( vec4( vNormal, 0.0 ) * viewMatrix ).xyz );
  vec2 pomGrime = pomMacro( vHangarWorld, pomWorldN );
  #ifndef POM_HOLES
  {
    float texels = float( textureSize( map, 0 ).x );
    float autoLod = log2( max( max( length( pomDx ), length( pomDy ) ) * texels, 1e-6 ) );
    float lodA = max( 6.5, autoLod );
    float lodB = max( 7.0, autoLod - 1.43 );
    vec3 lw = vec3( 0.2126, 0.7152, 0.0722 );
    float lowHere = dot( textureLod( map, pomUv, lodA ).rgb, lw );
    float lowElse = dot( textureLod( map, pomUv * 0.37 + vec2( 0.21, 0.63 ), lodB ).rgb, lw );
    float detrend = clamp( lowElse / max( lowHere, 0.004 ), 0.45, 2.2 );
    diffuseColor.rgb *= mix( 1.0, detrend, 0.85 * pomMacroAmount );
  }
  #endif
  diffuseColor.rgb *= mix( 1.0, mix( 0.8, 1.12, pomGrime.x ), pomMacroAmount );
`;

function patch(material, heightMap, scale, holes) {
  const own = { pomHeightMap: { value: heightMap }, pomScale: { value: scale } };
  material.userData.pom = own;
  if (holes) material.defines = { ...(material.defines ?? {}), POM_HOLES: '' };
  material.onBeforeCompile = (shader) => {
    // Shared uniform objects by reference, per-material ones from userData; nothing is copied.
    Object.assign(shader.uniforms, pomUniforms, own);
    let fs = shader.fragmentShader;
    const swap = (inc, text) => { fs = edit(fs, inc, text, 'the physical fragment shader'); };
    shader.vertexShader = edit(edit(shader.vertexShader, 'void main() {', 'varying vec3 vHangarWorld;\nvoid main() {', 'the vertex shader'),
      '#include <project_vertex>', '#include <project_vertex>\n\tvHangarWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;', 'the vertex shader');
    swap('void main() {', `${POM_PARS}\nvoid main() {`);
    swap('#include <map_fragment>', `${POM_MAIN}\n${displaced('map_fragment', 'map', 'vMapUv')}\n${GRATE_HOLES}\n${MACRO_ALBEDO}`);
    swap('#include <roughnessmap_fragment>', `${displaced('roughnessmap_fragment', 'roughnessMap', 'vRoughnessMapUv')}
  #ifdef POM_HOLES
    roughnessFactor = mix( 1.0, roughnessFactor, pomSolid );
    roughnessFactor = mix( roughnessFactor, 0.85, pomSide );
  #endif
  roughnessFactor = clamp( roughnessFactor + ( pomGrime.y - 0.5 ) * 0.3 * pomMacroAmount, 0.04, 1.0 );`);
    swap('#include <metalnessmap_fragment>', `${displaced('metalnessmap_fragment', 'metalnessMap', 'vMetalnessMapUv')}
  #ifdef POM_HOLES
    metalnessFactor = mix( metalnessFactor * pomSolid, 0.6, pomSide );
  #endif`);
    // Bar sides take the flat geometric normal: the stretched edge texels of the normal map would streak.
    swap('#include <normal_fragment_maps>', `${displaced('normal_fragment_maps', 'normalMap', 'vNormalMapUv')}
  #ifdef POM_HOLES
    normal = normalize( mix( normal, nonPerturbedNormal, pomSide ) );
  #endif`);
    swap('#include <aomap_fragment>', edit(displaced('aomap_fragment', 'aoMap', 'vAoMapUv'),
      'reflectedLight.indirectDiffuse *= ambientOcclusion;',
      '#ifdef POM_HOLES\n\tambientOcclusion = mix( ambientOcclusion, 0.6, pomSide ) * mix( 0.05, 1.0, pomSolid );\n#endif\n\treflectedLight.indirectDiffuse *= ambientOcclusion;', 'aomap_fragment'));
    shader.fragmentShader = fs; // write the edited source back (guidelines section 4)
  };
  material.customProgramCacheKey = () => `hangar-pom-3${holes ? '-holes' : ''}`;
}

/**
 * One material for a manifest tag from its four maps ({ color, normal, orm, height }). Cached per tag: a
 * reseeded scene gets the same material (and compiled program) back. `entry` is the manifest entry (tile).
 */
export function makeMaterial(tag, maps, entry, renderer) {
  const hit = cache.get(tag);
  if (hit && hit.maps.color === maps.color) return hit.material;
  const anisotropy = renderer.capabilities.getMaxAnisotropy();
  macroTexture().anisotropy = anisotropy;
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
    metalness: METALNESS[tag] ?? 1,
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

// Ruling R22: surfaces the sun can never reach skip its light and its 4096 PCF-soft shadow lookup. The
// directional-light block of lights_fragment_begin is compiled out under HANGAR_NO_SUN (the only directional
// light in the scene is the sun); the define is part of the program key, so lit and unlit variants never mix.
const DIR_LIGHTS = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )';
const LIGHTS_NO_SUN = edit(THREE.ShaderChunk.lights_fragment_begin, DIR_LIGHTS, `${DIR_LIGHTS} && ! defined( HANGAR_NO_SUN )`, 'lights_fragment_begin');

/**
 * `material` with its own `envMap` (a room probe, probes.js): a copy sharing every map, define and shader
 * patch, so it compiles to the same program. Scenes keep the variants they make and dispose them; the base
 * material stays page-owned. userData is shared by reference (Material.copy would JSON-clone it, which
 * cannot hold the patch's textures). `opts.noSun`: the copy skips the sun (LIGHTS_NO_SUN above).
 */
export function envVariant(material, envMap, opts = {}) {
  const ud = material.userData;
  material.userData = {};
  const v = material.clone();
  material.userData = ud;
  v.userData = { ...ud, shared: false, base: material };
  v.defines = { ...(material.defines ?? {}) };
  v.onBeforeCompile = material.onBeforeCompile;
  if (opts.noSun) {
    v.defines.HANGAR_NO_SUN = '';
    const base = material.onBeforeCompile;
    v.onBeforeCompile = function (shader, renderer) {
      base.call(this, shader, renderer);
      shader.fragmentShader = edit(shader.fragmentShader, '#include <lights_fragment_begin>', LIGHTS_NO_SUN, 'a no-sun variant');
    };
  }
  v.customProgramCacheKey = material.customProgramCacheKey;
  v.envMap = envMap;
  return v;
}

/**
 * A plain physical material wearing a scanned set's colour, normal and ORM maps (no parallax: bars,
 * tubes and channels are real geometry, so the relief is the mesh). Geometry UVs are metres / 2 like the
 * level's, so the maps' own repeat applies unchanged. `setMaps` swaps the maps in when they arrive.
 */
export function partMaterial(fallbackColor, opts = {}) {
  const m = new THREE.MeshPhysicalMaterial({ color: fallbackColor, roughness: 0.55, metalness: 0.8, side: opts.side ?? THREE.FrontSide });
  m.userData.setMaps = (maps) => {
    if (!maps?.color) return;
    Object.assign(m, { map: maps.color, normalMap: maps.normal ?? null, aoMap: maps.orm ?? null, roughnessMap: maps.orm ?? null, metalnessMap: maps.orm ?? null });
    m.color.set(0xffffff);
    m.roughness = 1;
    m.metalness = 1;
    m.needsUpdate = true;
  };
  return m;
}
