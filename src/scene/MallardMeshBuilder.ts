import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { lerp } from '../core/noise';
import { createMallardPlumageMaps } from './MallardPlumageTexture';

export interface DuckDeformUniforms {
  uHeadYaw: { value: number };
  uHeadPitch: { value: number };
  uTailWag: { value: number };
  uBreath: { value: number };
}

export interface MallardVisualRig {
  root: THREE.Group;
  headPivot: THREE.Group | null;
  tailPivot: THREE.Group | null;
  uniforms: DuckDeformUniforms;
  usingExternalGLB: boolean;
}

interface CrossSection {
  v: number;
  y: number;
  z: number;
  rx: number;
  ryTop: number;
  ryBot: number;
  /** Subtle wing-shelf bulge along upper flanks */
  wingBulge: number;
}

const SECTIONS: CrossSection[] = [
  { v: 0.0, y: 0.145, z: -0.39, rx: 0.004, ryTop: 0.004, ryBot: 0.003, wingBulge: 0 },
  { v: 0.08, y: 0.122, z: -0.32, rx: 0.062, ryTop: 0.032, ryBot: 0.022, wingBulge: 0.004 },
  { v: 0.18, y: 0.095, z: -0.23, rx: 0.118, ryTop: 0.07, ryBot: 0.056, wingBulge: 0.012 },
  { v: 0.3, y: 0.082, z: -0.115, rx: 0.156, ryTop: 0.098, ryBot: 0.088, wingBulge: 0.018 },
  { v: 0.44, y: 0.082, z: 0.015, rx: 0.166, ryTop: 0.106, ryBot: 0.098, wingBulge: 0.014 },
  { v: 0.57, y: 0.096, z: 0.135, rx: 0.148, ryTop: 0.102, ryBot: 0.095, wingBulge: 0.006 },
  { v: 0.66, y: 0.128, z: 0.195, rx: 0.104, ryTop: 0.084, ryBot: 0.078, wingBulge: 0 },
  { v: 0.72, y: 0.168, z: 0.205, rx: 0.068, ryTop: 0.062, ryBot: 0.058, wingBulge: 0 },
  { v: 0.76, y: 0.206, z: 0.196, rx: 0.056, ryTop: 0.052, ryBot: 0.052, wingBulge: 0 },
  { v: 0.805, y: 0.246, z: 0.205, rx: 0.061, ryTop: 0.057, ryBot: 0.053, wingBulge: 0 },
  { v: 0.85, y: 0.275, z: 0.236, rx: 0.068, ryTop: 0.062, ryBot: 0.051, wingBulge: 0 },
  { v: 0.89, y: 0.261, z: 0.285, rx: 0.049, ryTop: 0.039, ryBot: 0.031, wingBulge: 0 },
  { v: 0.93, y: 0.243, z: 0.334, rx: 0.038, ryTop: 0.019, ryBot: 0.015, wingBulge: 0 },
  { v: 0.97, y: 0.236, z: 0.376, rx: 0.031, ryTop: 0.013, ryBot: 0.011, wingBulge: 0 },
  { v: 0.992, y: 0.234, z: 0.396, rx: 0.016, ryTop: 0.007, ryBot: 0.006, wingBulge: 0 },
  { v: 1.0, y: 0.233, z: 0.404, rx: 0.002, ryTop: 0.002, ryBot: 0.002, wingBulge: 0 },
];

/**
 * Seamless anatomically-sculpted Mallard Drake (绿头鸭) built from a single continuous
 * parametric loft with 512x512 feather PBR maps, Fresnel emerald head iridescence,
 * smooth vertex-shader neck/head/tail articulation, delicate curled tail plumes,
 * and glossy eyes with catchlights.
 */
export function createProceduralMallardRig(uniforms: DuckDeformUniforms): MallardVisualRig {
  const root = new THREE.Group();
  root.name = 'AnatomicalMallard';

  const bodyGeo = buildContinuousDuckGeometry(52, 28);
  const plumage = createMallardPlumageMaps();

  const bodyMat = new THREE.MeshStandardMaterial({
    map: plumage.map,
    roughnessMap: plumage.roughnessMap,
    normalMap: plumage.normalMap,
    normalScale: new THREE.Vector2(0.75, 0.75),
    roughness: 0.88,
    metalness: 0.05,
  });

  // Smooth zero-bone spine/neck articulation + subtle iridescent emerald head sheen
  bodyMat.onBeforeCompile = (shader) => {
    shader.uniforms.uHeadYaw = uniforms.uHeadYaw;
    shader.uniforms.uHeadPitch = uniforms.uHeadPitch;
    shader.uniforms.uTailWag = uniforms.uTailWag;
    shader.uniforms.uBreath = uniforms.uBreath;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uHeadYaw;
         uniform float uHeadPitch;
         uniform float uTailWag;
         uniform float uBreath;
         varying float vLongitudinal;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vLongitudinal = uv.y;
         // Smooth neck & head articulation around neck base pivot (0, 0.18, 0.205)
         float neckW = smoothstep(0.67, 0.82, uv.y);
         vec3 pivot = vec3(0.0, 0.17, 0.202);
         vec3 rel = transformed - pivot;
         float yaw = uHeadYaw * neckW;
         float pitch = uHeadPitch * neckW;
         float cy = cos(yaw), sy = sin(yaw);
         float cp = cos(pitch), sp = sin(pitch);
         // Pitch first, then yaw
         vec3 pRot = vec3(rel.x, rel.y * cp - rel.z * sp, rel.y * sp + rel.z * cp);
         vec3 yRot = vec3(pRot.x * cy + pRot.z * sy, pRot.y, -pRot.x * sy + pRot.z * cy);
         transformed = pivot + yRot;

         // Subtle tail flick & gentle chest breathing
         float tailW = 1.0 - smoothstep(0.0, 0.20, uv.y);
         transformed.x += tailW * uTailWag * 0.045;
         float chestW = smoothstep(0.20, 0.45, uv.y) * (1.0 - smoothstep(0.55, 0.72, uv.y));
         transformed.y += chestW * uBreath * 0.006;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying float vLongitudinal;`
      )
      .replace(
        '#include <dithering_fragment>',
        `// Velvety downy-feather grazing rim sheen + emerald-to-peacock iridescence on the drake's head
         vec3 vDir = normalize(vViewPosition);
         float ndv = clamp(abs(dot(normalize(vNormal), vDir)), 0.0, 1.0);
         float velvetRim = pow(1.0 - ndv, 2.6);
         float bodyBand = 1.0 - smoothstep(0.88, 0.92, vLongitudinal);
         gl_FragColor.rgb += vec3(0.085, 0.075, 0.068) * velvetRim * bodyBand;

         float headBand = smoothstep(0.755, 0.78, vLongitudinal) * (1.0 - smoothstep(0.885, 0.905, vLongitudinal));
         if (headBand > 0.01) {
           float irid = pow(1.0 - ndv, 2.0);
           gl_FragColor.rgb += mix(vec3(0.02, 0.18, 0.12), vec3(0.04, 0.16, 0.29), irid) * headBand * (0.28 + irid * 0.58);
         }
         #include <dithering_fragment>`
      );
  };

  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  root.add(bodyMesh);

  // Sculpted 3D overlapping folded wing mantles + tapered dark primary wingtips crossing over the rump
  const wingMantleMat = new THREE.MeshStandardMaterial({
    map: plumage.map,
    normalMap: plumage.normalMap,
    normalScale: new THREE.Vector2(0.95, 0.95),
    color: '#9c9286',
    roughness: 0.78,
    metalness: 0.04,
  });
  const primaryTipMat = new THREE.MeshStandardMaterial({
    color: '#2c2927',
    roughness: 0.72,
  });

  for (const side of [-1, 1]) {
    const mantleGeo = buildFoldedWingMantleGeo(side);
    const mantle = new THREE.Mesh(mantleGeo, wingMantleMat);
    mantle.castShadow = true;
    mantle.receiveShadow = true;
    root.add(mantle);

    // Pointed dark primary flight-feather tip extending neatly across the upper rump
    const tipGeo = new THREE.ConeGeometry(0.036, 0.22, 6);
    tipGeo.scale(0.38, 1.0, 0.85);
    const tip = new THREE.Mesh(tipGeo, primaryTipMat);
    tip.position.set(side * 0.048, 0.168, -0.255);
    tip.rotation.set(-Math.PI * 0.44, side * 0.28, side * -0.18);
    root.add(tip);
  }

  // Articulated eye group tracking the exact same neck pivot & yaw/pitch as the vertex shader
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 0.17, 0.202);
  const eyeMat = new THREE.MeshStandardMaterial({
    color: '#08080a',
    roughness: 0.05,
    metalness: 0.18,
  });
  const eyeRimMat = new THREE.MeshStandardMaterial({ color: '#1b3e2e', roughness: 0.6 });
  for (const side of [-1, 1]) {
    const socket = new THREE.Mesh(new THREE.SphereGeometry(0.015, 10, 8), eyeRimMat);
    socket.position.set(side * 0.056, 0.106, 0.054);
    socket.scale.set(0.7, 0.95, 1.05);
    headPivot.add(socket);

    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), eyeMat);
    eye.position.set(side * 0.061, 0.107, 0.056);
    headPivot.add(eye);
  }
  root.add(headPivot);

  // Delicate curled black central tail feathers (characteristic drake detail)
  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 0.145, -0.355);
  const curlMat = new THREE.MeshStandardMaterial({ color: '#15181b', roughness: 0.42 });
  for (const offset of [-0.012, 0.012]) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(offset, 0.0, 0.02),
      new THREE.Vector3(offset * 1.1, 0.022, -0.045),
      new THREE.Vector3(offset * 0.8, 0.058, -0.055),
      new THREE.Vector3(offset * 0.5, 0.068, -0.022),
    ]);
    const curlMesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 10, 0.0065, 6, false), curlMat);
    tailPivot.add(curlMesh);
  }
  root.add(tailPivot);

  return { root, headPivot, tailPivot, uniforms, usingExternalGLB: false };
}

function buildFoldedWingMantleGeo(side: number): THREE.BufferGeometry {
  // Sculpted 3D layered folded wing shell hugging the upper flank from shoulder (z=+0.11) to rump (z=-0.26)
  const lenSegs = 14;
  const arcSegs = 8;
  const cols = arcSegs + 1;
  const positions = new Float32Array((lenSegs + 1) * cols * 3);
  const uvs = new Float32Array((lenSegs + 1) * cols * 2);
  const indices: number[] = [];

  for (let r = 0; r <= lenSegs; r++) {
    const t = r / lenSegs; // 0 = rear tip near rump, 1 = front shoulder
    const v = lerp(0.18, 0.56, t);
    const sec = sampleSection(v);
    const puff = Math.sin(t * Math.PI) * 0.022;

    for (let c = 0; c <= arcSegs; c++) {
      const s = c / arcSegs; // 0 = upper back edge -> 1 = lower flank feathered rim
      // Arc from near top spine (theta ~ 0.18) down to side flank (theta ~ 1.48)
      const theta = lerp(0.18, 1.48, s);
      const lift = Math.sin(s * Math.PI) * puff + 0.008;
      const x = side * Math.sin(theta) * (sec.rx + lift);
      const ry = Math.cos(theta) >= 0 ? sec.ryTop : sec.ryBot;
      const y = sec.y + Math.cos(theta) * (ry + lift * 0.72);
      const z = sec.z;

      const idx = r * cols + c;
      positions[idx * 3] = x;
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = z;
      uvs[idx * 2] = side > 0 ? lerp(0.03, 0.24, s) : lerp(0.97, 0.76, s);
      uvs[idx * 2 + 1] = v;
    }
  }

  for (let r = 0; r < lenSegs; r++) {
    for (let c = 0; c < arcSegs; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = (r + 1) * cols + c;
      const e = d + 1;
      if (side > 0) {
        indices.push(a, d, b, b, d, e);
      } else {
        indices.push(a, b, d, b, e, d);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function buildContinuousDuckGeometry(rings: number, radialSegs: number): THREE.BufferGeometry {
  const cols = radialSegs + 1;
  const rows = rings + 1;
  const positions = new Float32Array(rows * cols * 3);
  const uvs = new Float32Array(rows * cols * 2);
  const indices: number[] = [];

  for (let r = 0; r <= rings; r++) {
    const v = r / rings;
    const sec = sampleSection(v);

    for (let c = 0; c <= radialSegs; c++) {
      const u = c / radialSegs;
      const theta = u * Math.PI * 2; // 0 = top spine (+Y), PI/2 = right (+X), PI = belly (-Y)
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);

      let rx = sec.rx;
      const ry = cosT >= 0 ? sec.ryTop : sec.ryBot;

      // Subtle folded-wing shoulder ridge on upper flanks
      if (sec.wingBulge > 0 && cosT > -0.15 && cosT < 0.72) {
        rx += sec.wingBulge * Math.sin(((cosT + 0.15) / 0.87) * Math.PI);
      }

      // Flatten bill underside slightly & gently scoop top bridge
      let yOff = cosT * ry;
      if (v > 0.9 && cosT < 0) {
        yOff *= 0.65;
      }

      const x = sinT * rx;
      const y = sec.y + yOff;
      const z = sec.z;

      const idx = r * cols + c;
      positions[idx * 3] = x;
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = z;
      uvs[idx * 2] = u;
      uvs[idx * 2 + 1] = v;
    }
  }

  for (let r = 0; r < rings; r++) {
    for (let c = 0; c < radialSegs; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = (r + 1) * cols + c;
      const e = d + 1;
      indices.push(a, d, b);
      indices.push(b, d, e);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function sampleSection(v: number): CrossSection {
  for (let i = 0; i < SECTIONS.length - 1; i++) {
    const a = SECTIONS[i];
    const b = SECTIONS[i + 1];
    if (v >= a.v && v <= b.v) {
      const rawT = (v - a.v) / Math.max(0.0001, b.v - a.v);
      // Smoothstep interpolation avoids sharp creases between anatomical landmarks
      const t = rawT * rawT * (3 - 2 * rawT);
      return {
        v,
        y: lerp(a.y, b.y, t),
        z: lerp(a.z, b.z, t),
        rx: lerp(a.rx, b.rx, t),
        ryTop: lerp(a.ryTop, b.ryTop, t),
        ryBot: lerp(a.ryBot, b.ryBot, t),
        wingBulge: lerp(a.wingBulge, b.wingBulge, t),
      };
    }
  }
  return SECTIONS[SECTIONS.length - 1];
}

export async function tryLoadExternalMallardGLB(
  uniforms: DuckDeformUniforms,
  url = './assets/models/mallard.glb'
): Promise<THREE.Group | null> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/html')) return null;

    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url);
    const model = gltf.scene;

    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    model.scale.setScalar(0.72 / maxDim);

    const centeredBox = new THREE.Box3().setFromObject(model);
    const center = centeredBox.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -centeredBox.min.y - 0.04, -center.z);

    model.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.material) {
        obj.castShadow = true;
        obj.receiveShadow = true;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (m instanceof THREE.MeshStandardMaterial || m instanceof THREE.MeshPhysicalMaterial) {
            m.onBeforeCompile = (shader) => {
              shader.uniforms.uHeadYaw = uniforms.uHeadYaw;
              shader.uniforms.uHeadPitch = uniforms.uHeadPitch;
              shader.uniforms.uTailWag = uniforms.uTailWag;
              shader.uniforms.uBreath = uniforms.uBreath;
              shader.vertexShader = shader.vertexShader
                .replace(
                  '#include <common>',
                  `#include <common>
                   uniform float uHeadYaw;
                   uniform float uHeadPitch;
                   uniform float uTailWag;
                   uniform float uBreath;`
                )
                .replace(
                  '#include <begin_vertex>',
                  `#include <begin_vertex>
                   float headMask = smoothstep(0.12, 0.28, transformed.z) * smoothstep(0.14, 0.28, transformed.y);
                   float tailMask = smoothstep(-0.14, -0.32, transformed.z);
                   transformed.x += headMask * sin(uHeadYaw) * 0.08 + tailMask * uTailWag * 0.04;
                   transformed.y += headMask * uHeadPitch * 0.05 + uBreath * 0.008;`
                );
            };
          }
        }
      }
    });

    const wrapper = new THREE.Group();
    wrapper.name = 'ExternalMallardGLB';
    wrapper.add(model);
    return wrapper;
  } catch {
    return null;
  }
}
