// Diorama — global illumination: light that has bounced, and what the shiny things reflect.
//
// three.js lights a surface only with light that comes straight from a lamp. In a closed box that is most of
// the way to wrong: the underside of a graphics card is lit by the floor it lights, a heatsink in shadow is lit
// by the wall beside it, and everything takes the colour of what is near it. This module supplies the missing
// light, measured from the scene itself and kept up to date while it runs.
//
// Diffuse: an irradiance volume.
//   A grid of probes fills the box. At each one the scene is rendered into a small cube map (what light
//   arrives at this point from every direction), which is reduced to four numbers per colour channel: the
//   light's average and its lean along x, y and z (order-1 spherical harmonics, convolved with the cosine
//   lobe, so what is stored is irradiance as a linear function of the surface normal). Those go into a 3D
//   texture; a surface looks its own irradiance up there, interpolated between the eight probes round it.
//
//   The probes see surfaces lit by the lamps AND by the volume as it stood a moment ago, so every pass round
//   the grid adds another bounce, and the light converges on the full multi-bounce answer. A few probes are
//   redone each frame, for ever: when an LED changes colour the bounced light follows within a second or so.
//
// Specular: one reflection cube.
//   A cube map rendered from the middle of the box, one face a frame, with mip levels standing in for
//   roughness. Because the box is small and the viewer's head moves, the lookup is parallax-corrected against
//   the box's own walls (a reflected ray is followed to the wall it would hit, and the cube is asked for
//   THAT point), so reflections slide over the metal as they should when the head moves. A reflection is
//   also held down where the volume says little light arrives, which keeps a bright wall from shining out of
//   a crevice that cannot see it.
//
// Both are applied by patching three's physical material (GI.patch), so they obey its BRDF, its roughness and
// metalness maps and its energy conservation.

import * as THREE from 'three';

const PROBE_FACE = 32;      // pixels across one face of a probe's cube map
const PROBE_LOD = 2;        // the mip the probe is read at (8 x 8 a face): no small bright LED falls between samples
const SH_SAMPLES = 384;     // directions the cube is read in
const ENV_FACE = 256;

const QUAD_VERT = /* glsl */ `void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }`;

// One probe's cube map to four texels: the irradiance's constant term, then its x, y and z gradients.
//   E(n) = a + b . n,  a = (1/4) * integral of L,  b = (1/2) * integral of L * direction
// (the order-0 and order-1 spherical harmonics of L, each scaled by the cosine lobe's own coefficient).
const SH_FRAG = /* glsl */ `
precision highp float;
uniform samplerCube tProbe;
uniform int coef;     // which of the four: 0 the constant term, 1 to 3 the x, y and z gradients
out vec4 outColor;
void main() {
  int k = coef;
  vec3 sum = vec3( 0.0 );
  const float GOLDEN = 2.39996323;
  for ( int i = 0; i < ${SH_SAMPLES}; i ++ ) {
    float z = 1.0 - ( 2.0 * float( i ) + 1.0 ) / float( ${SH_SAMPLES} );
    float r = sqrt( max( 0.0, 1.0 - z * z ) ), a = GOLDEN * float( i );
    vec3 d = vec3( r * cos( a ), r * sin( a ), z );
    vec3 L = min( textureLod( tProbe, d, float( ${PROBE_LOD} ) ).rgb, vec3( 64.0 ) );
    sum += L * ( k == 0 ? 0.25 : 0.5 * d[ k - 1 ] );
  }
  outColor = vec4( sum * ( 12.566370614 / float( ${SH_SAMPLES} ) ), 1.0 );
}
`;

const GI_PARS = /* glsl */ `
uniform highp sampler3D giVolume;
uniform vec3 giMin;
uniform vec3 giInvSize;
uniform vec3 giCounts;
uniform float giBias;
uniform float giOn;
uniform samplerCube giEnv;
uniform vec3 giEnvPos;
uniform vec3 giBoxMin;
uniform vec3 giBoxMax;
uniform float giEnvMip;
uniform float giEnvOn;
vec3 giIrradiance( vec3 p, vec3 n ) {
  vec3 q = clamp( ( p - giMin ) * giInvSize, 0.0, 1.0 );
  // Four blocks side by side along x, one per coefficient; keep each lookup inside its own block.
  float x = clamp( q.x * giCounts.x, 0.5, giCounts.x - 0.5 );
  float w = 1.0 / ( 4.0 * giCounts.x );
  vec3 a = texture( giVolume, vec3( x * w, q.y, q.z ) ).rgb;
  vec3 bx = texture( giVolume, vec3( ( x + giCounts.x ) * w, q.y, q.z ) ).rgb;
  vec3 by = texture( giVolume, vec3( ( x + 2.0 * giCounts.x ) * w, q.y, q.z ) ).rgb;
  vec3 bz = texture( giVolume, vec3( ( x + 3.0 * giCounts.x ) * w, q.y, q.z ) ).rgb;
  // Order-1 harmonics can dip below zero behind a strong light; never let a surface be lit negatively, and
  // never let it fall to nothing while light is arriving at all.
  return max( a + bx * n.x + by * n.y + bz * n.z, a * 0.12 );
}
vec3 giReflection( vec3 p, vec3 r, float roughness ) {
  // Follow the reflected ray to the wall of the box it hits, and look that point up from the cube's centre.
  vec3 rr = r + vec3( 1e-5 ) * sign( r + vec3( 1e-6 ) );
  vec3 t = max( ( giBoxMax - p ) / rr, ( giBoxMin - p ) / rr );
  vec3 hit = p + rr * min( min( t.x, t.y ), t.z );
  return textureLod( giEnv, hit - giEnvPos, giEnvMip * sqrt( clamp( roughness, 0.0, 1.0 ) ) ).rgb;
}
`;

const GI_APPLY = /* glsl */ `
{
  mat3 giRot = transpose( mat3( viewMatrix ) );
  vec3 giN = normalize( giRot * normal );
  vec3 giP = giRot * ( - vViewPosition - viewMatrix[ 3 ].xyz );
  vec3 giE = giIrradiance( giP + giN * giBias, giN ) * giOn;
  iblIrradiance += giE;
  #if defined( RE_IndirectSpecular )
    vec3 giV = normalize( cameraPosition - giP );
    vec3 giR = reflect( - giV, giN );
    vec3 giL = giReflection( giP, giR, material.roughness );
    // What the volume says arrives here, against what the cube says is out there: a crevice sees less.
    vec3 giFar = textureLod( giEnv, giN, giEnvMip ).rgb * 3.14159265;
    float giSeen = clamp( dot( giE, vec3( 0.333 ) ) / max( dot( giFar, vec3( 0.333 ) ), 1e-4 ), 0.0, 1.0 );
    radiance += giL * giEnvOn * mix( 1.0, sqrt( giSeen ), giOn );
  #endif
}
`;

export class GI {
  /**
   * @param min, max the box the probes fill (world metres)
   * @param counts probes along x, y, z
   * @param reflectBoxMax the far corner reflections are followed to (the open, glass side reaches out into the room)
   */
  constructor(renderer, scene, { min, max, counts, reflectBoxMax = max, probeLayers = [0], envLayers = [0] }) {
    this.renderer = renderer;
    this.scene = scene;
    this.min = min.clone(); this.size = max.clone().sub(min);
    this.counts = counts;
    const [nx, ny, nz] = counts;
    this.total = nx * ny * nz;
    this.cursor = 0;
    this.sweeps = 0;
    this.envFace = 0;
    this.hurry = 3; // sweeps still to be done at full speed (the first few, and after a change of lighting)

    // The volume: 4 coefficient blocks side by side along x. Two copies: surfaces read one while probes are
    // written into the other, and they swap at the end of each pass round the grid.
    const makeVolume = () => {
      const v = new THREE.WebGL3DRenderTarget(nx * 4, ny, nz, { type: THREE.HalfFloatType, depthBuffer: false });
      v.texture.minFilter = v.texture.magFilter = THREE.LinearFilter;
      v.texture.generateMipmaps = false;
      return v;
    };
    this.front = makeVolume(); this.back = makeVolume();

    const near = Math.min(this.size.x, this.size.y, this.size.z) * 0.004, far = this.size.length() * 12;
    this.probeTarget = new THREE.WebGLCubeRenderTarget(PROBE_FACE, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
    this.probeCam = new THREE.CubeCamera(near, far, this.probeTarget);
    this.probeCam.layers.disableAll(); probeLayers.forEach((l) => this.probeCam.layers.enable(l));

    // Two reflection cubes: surfaces read one while the other is redrawn a face at a time (a material cannot
    // sample the texture it is being rendered into), and they swap when all six faces are done.
    const makeEnv = () => new THREE.WebGLCubeRenderTarget(ENV_FACE, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
    this.envFront = makeEnv(); this.envTarget = makeEnv();
    this.envCam = new THREE.CubeCamera(near, far, this.envTarget);
    this.envCam.layers.disableAll(); envLayers.forEach((l) => this.envCam.layers.enable(l));
    this.envCam.position.copy(min).addScaledVector(this.size, 0.5);
    this.envCam.updateMatrixWorld(true);
    this.envPrimed = false;

    this.shMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { tProbe: { value: this.probeTarget.texture }, coef: { value: 0 } },
      vertexShader: `in vec3 position;\n${QUAD_VERT}`, fragmentShader: SH_FRAG, depthTest: false, depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.shMaterial);
    this.quad.frustumCulled = false;
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.uniforms = {
      giVolume: { value: this.front.texture },
      giMin: { value: this.min.clone() },
      giInvSize: { value: new THREE.Vector3(1 / this.size.x, 1 / this.size.y, 1 / this.size.z) },
      giCounts: { value: new THREE.Vector3(nx, ny, nz) },
      giBias: { value: Math.min(this.size.x / nx, this.size.y / ny, this.size.z / nz) * 0.35 },
      giOn: { value: 0 },
      giEnv: { value: this.envFront.texture },
      giEnvPos: { value: this.envCam.position.clone() },
      giBoxMin: { value: min.clone() },
      giBoxMax: { value: reflectBoxMax.clone() },
      giEnvMip: { value: Math.log2(ENV_FACE) - 1 },
      giEnvOn: { value: 0 },
    };
  }

  /** Makes a MeshStandardMaterial / MeshPhysicalMaterial take its indirect light from this volume and cube. */
  patch(material) {
    const prior = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      prior?.call(material, shader, renderer);
      Object.assign(shader.uniforms, this.uniforms);
      const anchor = '#include <lights_fragment_end>';
      if (!shader.fragmentShader.includes(anchor)) { console.warn('GI: this material has no indirect-light stage to patch', material.type); return; }
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', `${GI_PARS}\nvoid main() {`)
        .replace(anchor, `${GI_APPLY}\n${anchor}`);
    };
    const key = material.customProgramCacheKey?.bind(material);
    material.customProgramCacheKey = () => `${key ? key() : ''}|gi`;
    material.needsUpdate = true;
    return material;
  }

  /** Lighting changed in a way a slow follow would show (a mode switch): redo the grid at full speed for a while. */
  rush(sweeps = 2) { this.hurry = Math.max(this.hurry, sweeps); }

  /** Where probe number i stands. */
  probePosition(i, out = new THREE.Vector3()) {
    const [nx, ny] = this.counts;
    const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
    return out.set(this.min.x + (x + 0.5) / nx * this.size.x, this.min.y + (y + 0.5) / ny * this.size.y, this.min.z + (z + 0.5) / this.counts[2] * this.size.z);
  }

  /**
   * Does a frame's share of the work: some probes and one face of the reflection cube. Call before the main
   * render. `budget` is how many probes to redo when nothing is pressing.
   */
  update(budget = 2) {
    const r = this.renderer, [nx, ny] = this.counts;
    const prevTarget = r.getRenderTarget(), prevXr = r.xr.enabled, prevAuto = r.autoClear;
    r.xr.enabled = false; r.autoClear = true;
    const n = this.hurry > 0 ? Math.ceil(this.total / 10) : budget;
    for (let k = 0; k < n; k++) {
      const i = this.cursor;
      this.probePosition(i, this.probeCam.position);
      this.probeCam.updateMatrixWorld(true);
      this.probeCam.update(r, this.scene);
      // Reduce the cube to this probe's four texels in the back volume: one texel-sized viewport each.
      const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
      r.autoClear = false;
      for (let c = 0; c < 4; c++) {
        this.back.viewport.set(c * nx + x, y, 1, 1);
        this.back.scissor.set(c * nx + x, y, 1, 1);
        this.back.scissorTest = true;
        this.shMaterial.uniforms.coef.value = c;
        r.setRenderTarget(this.back, z);
        r.render(this.quad, this.quadCam);
      }
      r.autoClear = true;
      this.cursor++;
      if (this.cursor >= this.total) {
        this.cursor = 0; this.sweeps++;
        if (this.hurry > 0) this.hurry--;
        [this.front, this.back] = [this.back, this.front];
        this.uniforms.giVolume.value = this.front.texture;
        this.uniforms.giOn.value = 1;
      }
    }
    // The reflection cube: all six faces the first time, then one a frame, swapping after the sixth.
    if (!this.envPrimed) {
      this.envCam.update(r, this.scene);
      this.swapEnv();
      this.envPrimed = true; this.uniforms.giEnvOn.value = 1; this.envFace = 0;
    } else {
      this.updateEnvFace(this.envFace);
      if (++this.envFace === 6) { this.envFace = 0; this.swapEnv(); }
    }
    r.setRenderTarget(prevTarget);
    r.xr.enabled = prevXr; r.autoClear = prevAuto;
  }

  swapEnv() {
    [this.envFront, this.envTarget] = [this.envTarget, this.envFront];
    this.envCam.renderTarget = this.envTarget;
    this.uniforms.giEnv.value = this.envFront.texture;
  }

  /** Re-renders one face of the reflection cube (three's CubeCamera only does all six). */
  updateEnvFace(face) {
    const r = this.renderer, cam = this.envCam.children[face], target = this.envTarget;
    const mips = target.texture.generateMipmaps;
    target.texture.generateMipmaps = face === 5 && mips; // build the mip chain once per round, after the last face
    r.setRenderTarget(target, face);
    r.render(this.scene, cam);
    target.texture.generateMipmaps = mips;
  }

  dispose() {
    this.front.dispose(); this.back.dispose();
    this.probeTarget.dispose(); this.envTarget.dispose(); this.envFront.dispose();
    this.shMaterial.dispose(); this.quad.geometry.dispose();
  }
}
