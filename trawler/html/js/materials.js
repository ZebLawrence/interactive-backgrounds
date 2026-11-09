// Trawler — Materials: the scanned maps wrapped in three.js materials, with plain stand-ins until
// they arrive, and the atmosphere patched into every one of them.
//
// One rule holds the whole thing together: **every UV in this scene is in metres**. A surface two
// metres wide has a u that runs from 0 to 2. The texture's `repeat` is then one over the tile size
// the manifest records, and nothing anywhere has to carry a UV scale. It also makes the texel
// density checkable by hand: a 1024 px map on a 1 m tile is 1024 px per metre, which is the
// project's rule for anything within arm's reach of the viewer.
//
// The scanned sets are packed as colour, normal and ORM (ambient occlusion in red, roughness in
// green, metalness in blue), which is exactly how three reads aoMap, roughnessMap and
// metalnessMap, so one texture serves all three.

import * as THREE from 'three';
import { G, patchStandardFog, chain } from './shaders.js';
import { srgb } from './util.js';

/** What a tag looks like before (or without) its scan: a plain colour and a sensible finish. */
export const STAND_IN = {
  'mat:teak': { color: 0x6b4426, roughness: 0.45, metalness: 0 },
  'mat:plywood': { color: 0xb08c5e, roughness: 0.72, metalness: 0 },
  'mat:paint': { color: 0xcfd2cf, roughness: 0.46, metalness: 0.05 },
  'mat:enamel': { color: 0xe8e9e4, roughness: 0.38, metalness: 0.04 },
  'mat:paint-worn': { color: 0x9aa09c, roughness: 0.68, metalness: 0.1 },
  'mat:rubber': { color: 0x2b2f31, roughness: 0.88, metalness: 0 },
  'mat:leather': { color: 0x4a2f20, roughness: 0.62, metalness: 0 },
  'mat:deck': { color: 0x8a7352, roughness: 0.74, metalness: 0 },
  'mat:steel': { color: 0x9aa0a6, roughness: 0.42, metalness: 0.85 },
  'mat:steel-brushed': { color: 0xaab0b6, roughness: 0.3, metalness: 0.9 },
  'mat:steel-rust': { color: 0x6b4a36, roughness: 0.8, metalness: 0.4 },
  'mat:rock': { color: 0x4a4c4a, roughness: 0.88, metalness: 0 },
  'mat:rock-cliff': { color: 0x575550, roughness: 0.9, metalness: 0 },
  'mat:scree': { color: 0x6a5f50, roughness: 0.92, metalness: 0 },
  'mat:heath': { color: 0x3a4030, roughness: 0.94, metalness: 0 },
  'mat:shore': { color: 0x5c5a52, roughness: 0.9, metalness: 0 },
  'mat:snow': { color: 0xdfe6ef, roughness: 0.6, metalness: 0 },
};

/**
 * Holds the material for every tag, hands them out, and swaps the scans in as they arrive.
 * Materials are shared: ask for the same tag twice and you get the same object, so a scan
 * arriving updates everything built from it at once.
 */
export class Materials {
  constructor() {
    this.byTag = new Map();
    this.assets = new Map(); // tag -> { tile, color, normal, orm }
    this.manifest = null;
  }

  /** The manifest, as soon as it is known: the tile sizes come from it. */
  setManifest(manifest) { this.manifest = manifest; }

  tileOf(tag) { return this.manifest?.materials?.[tag]?.tile ?? 1; }

  /**
   * The material for a tag. `opts` are applied on top of the stand-in and kept across a swap:
   * `color` (a tint multiplied into the map), `roughness`, `metalness`, `side`, `aoIntensity`,
   * `normalScale`, `envMapIntensity`, `extra` (an onBeforeCompile to chain on).
   */
  get(tag, opts = {}) {
    const key = `${tag}|${JSON.stringify(opts.key ?? opts)}`;
    const found = this.byTag.get(key);
    if (found) return found;
    const stand = STAND_IN[tag] ?? { color: 0x8a8a8a, roughness: 0.7, metalness: 0 };
    const m = new THREE.MeshStandardMaterial({
      color: opts.color ?? stand.color,
      roughness: opts.roughness ?? stand.roughness,
      metalness: opts.metalness ?? stand.metalness,
      side: opts.side ?? THREE.FrontSide,
      transparent: opts.transparent ?? false,
      opacity: opts.opacity ?? 1,
      emissive: opts.emissive ?? 0x000000,
      emissiveIntensity: opts.emissiveIntensity ?? 1,
      // How much of the scene's environment a surface reflects. Polished metal wants more than
      // one: the environment here is a 32 x 16 picture of the sky and the sea, and a wheel rim
      // that is nothing but reflections needs all of it and then some to read as stainless.
      envMapIntensity: opts.envMapIntensity ?? 1,
    });
    m.name = tag;
    m.userData.tag = tag;
    m.userData.opts = opts;
    if (opts.desaturate) m.onBeforeCompile = chain(m.onBeforeCompile, desaturateMap(opts.desaturate));
    if (opts.extra) m.onBeforeCompile = chain(m.onBeforeCompile, opts.extra);
    patchStandardFog(m);
    this.byTag.set(key, m);
    const asset = this.assets.get(tag);
    if (asset) this.applyMaps(m, asset);
    return m;
  }

  /** Called by the loader as each material's three maps land. */
  setAsset(tag, asset) {
    this.assets.set(tag, asset);
    for (const [key, m] of this.byTag) {
      if (m.userData.tag === tag) this.applyMaps(m, asset);
    }
  }

  applyMaps(m, asset) {
    const opts = m.userData.opts ?? {};
    if (asset.color) m.map = asset.color;
    if (asset.normal) {
      m.normalMap = asset.normal;
      const s = opts.normalScale ?? 1;
      m.normalScale = new THREE.Vector2(s, s);
    }
    if (asset.orm) {
      // Red is ambient occlusion, green roughness, blue metalness: one texture, three slots.
      m.aoMap = asset.orm;
      m.roughnessMap = asset.orm;
      m.metalnessMap = asset.orm;
      m.aoMap.channel = 0;
      m.aoMapIntensity = opts.aoIntensity ?? 1;
      // The map multiplies these, so they have to be the full value unless a tint was asked for.
      m.roughness = opts.roughness ?? 1;
      m.metalness = opts.metalness ?? 1;
    }
    // A tint stays a tint: the map is multiplied by it, so a white tint shows the scan as it is.
    if (opts.tint !== undefined) m.color.set(opts.tint);
    else if (asset.color && opts.color === undefined) m.color.setRGB(1, 1, 1);
    m.needsUpdate = true;
  }

  dispose() {
    for (const m of this.byTag.values()) m.dispose();
    this.byTag.clear();
  }
}

/**
 * Takes the colour out of a scan before the tint goes on, so one weathered-paint set can be the
 * cream of a mast, the red lead inside a bulwark and the dark green of a hull. Without it a scan
 * that happens to be green (and the best weathered-paint scan on Poly Haven is) makes everything
 * built from it green, whatever tint is asked for.
 */
export function desaturateMap(amount = 1) {
  return (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
        vec4 sampledDiffuse = texture2D( map, vMapUv );
        float sampledGrey = dot( sampledDiffuse.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
        sampledDiffuse.rgb = mix( sampledDiffuse.rgb, vec3( sampledGrey ), ${amount.toFixed(3)} );
        diffuseColor *= sampledDiffuse;
      #endif`,
    );
  };
}

/**
 * A plain painted material with no scan behind it: the window frames' enamel, a dial face, the
 * inside of a locker. Still gets the atmosphere so it fogs like everything else.
 */
export function paint(color, roughness = 0.45, metalness = 0.05, opts = {}) {
  const m = new THREE.MeshStandardMaterial({
    color: typeof color === 'number' ? color : srgb(color[0], color[1], color[2]),
    roughness, metalness, side: opts.side ?? THREE.FrontSide,
    envMapIntensity: opts.envMapIntensity ?? 1,
    transparent: opts.transparent ?? false, opacity: opts.opacity ?? 1,
    emissive: opts.emissive ?? 0x000000, emissiveIntensity: opts.emissiveIntensity ?? 1,
  });
  patchStandardFog(m);
  return m;
}

/**
 * Sets a box geometry's UVs to metres. three builds a box with UVs in 0..1 per face, so each face
 * is scaled by its own size; after this a 2 m wide face really does have u running 0 to 2.
 */
export function metreUvsBox(geometry, w, h, d) {
  const uv = geometry.attributes.uv;
  // three's BoxGeometry lays the faces out +x, -x, +y, -y, +z, -z, four vertices each.
  const sizes = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = sizes[f];
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * su, uv.getY(k) * sv);
    }
  }
  uv.needsUpdate = true;
  return geometry;
}

/** The same for a plane: u and v in metres across its width and height. */
export function metreUvsPlane(geometry, w, h) {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * h);
  uv.needsUpdate = true;
  return geometry;
}

/**
 * Scales a geometry's existing UVs by a factor. Lathes, cylinders and tubes come out of three with
 * 0..1 UVs whose real size depends on the shape, so this is the escape hatch for them.
 */
export function scaleUvs(geometry, su, sv = su) {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return geometry;
}
