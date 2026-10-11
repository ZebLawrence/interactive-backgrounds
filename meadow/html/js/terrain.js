// Firefly Meadow — The lie of the land and the ground itself.

import * as THREE from 'three';
import { Art } from './util.js';
import { G, FOG_HEAD, LIGHTS_HEAD, SHADE_HEAD, FIREFLY_LIGHT_COLOR } from './shaders.js';

/** Height of the meadow at (x, z): gentle swells, sloping down a little toward the trees. */
export function groundHeight(x, z) {
  return 0.3 * Math.sin(x * 0.11 + 1.3) * Math.cos(z * 0.07 + 0.4)
    + 0.14 * Math.sin(x * 0.31 + z * 0.17 + 2.0)
    + 0.05 * Math.sin(z * 0.53 + x * 0.9)
    + 0.004 * z;
}

/** A big displaced plane under the grass: dark soil and matted grass, moonlit and lit by fireflies. */
export class Ground {
  constructor() {
    const size = 260, segs = 200;
    const geo = new THREE.PlaneGeometry(size, size, segs, segs);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, -70);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, groundHeight(pos.getX(i), pos.getZ(i)));
    geo.computeVertexNormals();

    this.texture = Art.texture(Art.soil(), { repeat: true });
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: this.texture },
        uTime: G.uTime, uLights: G.uLights, uMoon: G.uMoon, uMoonDir: G.uMoonDir, uMoonColor: G.uMoonColor,
        uSkyLight: G.uSkyLight, uFlash: G.uFlash, uStorm: G.uStorm,
        uFogColor: G.uFogColor, uFogNear: G.uFogNear, uFogFar: G.uFogFar,
      },
      vertexShader: `
        varying vec3 vWorld; varying vec3 vNormal;
        void main() {
          vWorld = position; vNormal = normal;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D uMap;
        varying vec3 vWorld; varying vec3 vNormal;
        ${FOG_HEAD}${LIGHTS_HEAD}${SHADE_HEAD}
        void main() {
          vec3 soil = texture2D(uMap, vWorld.xz / 3.0).rgb;
          vec3 wide = texture2D(uMap, vWorld.xz / 23.0 + 0.37).rgb;
          vec3 albedo = soil * (0.6 + 0.8 * wide.g) * 0.55;
          // Wetter and darker in the rain.
          albedo *= 1.0 - 0.35 * uStorm;
          vec3 c = shade(albedo, normalize(vNormal), 0.8);
          c += (albedo * 2.0 + 0.01) * fireflyLight(vWorld) * ${FIREFLY_LIGHT_COLOR};
          c = applyFog(c, length(vWorld - cameraPosition));
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
