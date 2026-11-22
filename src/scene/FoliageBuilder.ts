import * as THREE from 'three';
import { hash2D } from '../core/noise';
import type { PBRTextureCache } from '../modules/PBRTextureCache';
import type { PondShapeSDF } from '../modules/PondShapeSDF';

export interface WindUniformRef {
  uTime: { value: number };
  uWindStrength: { value: number };
}

export interface FoliageRig {
  group: THREE.Group;
  updateDynamic(time: number, dt: number, windStrength: number): void;
}

export function applyWindSway(
  material: THREE.MeshStandardMaterial,
  uniforms: WindUniformRef,
  amplitude: number,
  freqScale: number
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uWindStrength = uniforms.uWindStrength;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform float uWindStrength;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vec4 wPos = modelMatrix * vec4(transformed, 1.0);
         float hMask = clamp((position.y + 0.35) * 0.42, 0.0, 1.0);
         float gust = sin(uTime * ${freqScale.toFixed(2)} + wPos.x * 0.32 + wPos.z * 0.25)
                    + 0.42 * sin(uTime * ${(freqScale * 1.75).toFixed(2)} - wPos.x * 0.48);
         float sway = gust * mix(0.22, 1.0, uWindStrength) * ${amplitude.toFixed(3)} * hMask * hMask;
         transformed.x += sway;
         transformed.z += sway * 0.42;`
      );
  };
}

/**
 * Natural forest trees (alpha-tested pine boughs & organic broadleaf canopies),
 * arched shoreline reeds with velvet cattails, and floating lily pads in quiet coves.
 */
export function buildForestAndShoreFoliage(
  sdf: PondShapeSDF,
  textureCache: PBRTextureCache,
  windUniforms: WindUniformRef
): FoliageRig {
  const group = new THREE.Group();
  group.name = 'ForestAndShoreFoliage';

  buildWoodlandTrees(group, sdf, textureCache, windUniforms);
  buildBankGrassAndShrubs(group, sdf, textureCache, windUniforms);
  buildReedsAndCattails(group, sdf, windUniforms);
  buildForegroundFallenLog(group, sdf, textureCache);
  const lilyPads = buildLilyPads(group, sdf);
  const floatingLeaves = buildFloatingLeaves(group, sdf);

  return {
    group,
    updateDynamic(time: number, dt: number, windStrength: number): void {
      const amp = 0.008 + windStrength * 0.015;
      for (let i = 0; i < lilyPads.length; i++) {
        const pad = lilyPads[i];
        pad.mesh.position.y =
          sdf.waterLevel + 0.014 + Math.sin(time * 1.35 + pad.phase) * amp;
        pad.mesh.rotation.z = Math.sin(time * 1.1 + pad.phase) * (0.03 + windStrength * 0.04);
      }

      // Gently drift fallen autumn leaves across the pond with wind
      const driftSpeed = 0.04 + windStrength * 0.24;
      for (let i = 0; i < floatingLeaves.length; i++) {
        const lf = floatingLeaves[i];
        lf.x += driftSpeed * dt * (0.75 + 0.25 * Math.sin(time * 0.4 + lf.phase));
        lf.z += driftSpeed * 0.28 * dt * Math.cos(time * 0.35 + lf.phase);
        if (!sdf.isNavigable(lf.x, lf.z, 0.55)) {
          lf.x = lf.originX;
          lf.z = lf.originZ;
        }
        lf.mesh.position.set(
          lf.x,
          sdf.waterLevel + 0.013 + Math.sin(time * 1.6 + lf.phase) * (0.005 + windStrength * 0.01),
          lf.z
        );
        lf.mesh.rotation.y += dt * (0.08 + windStrength * 0.28) * lf.spinDir;
      }
    },
  };
}

function buildWoodlandTrees(
  parent: THREE.Group,
  sdf: PondShapeSDF,
  textureCache: PBRTextureCache,
  windUniforms: WindUniformRef
): void {
  const barkPBR = textureCache.getProceduralPBR('bark', 2, 4);
  const trunkMat = new THREE.MeshStandardMaterial({
    map: barkPBR.map,
    roughnessMap: barkPBR.roughnessMap,
    normalMap: barkPBR.normalMap,
    roughness: 0.92,
  });

  const pineTex = textureCache.getFoliageTexture('pine');
  const leafTex = textureCache.getFoliageTexture('leaf');

  const pineMat = new THREE.MeshStandardMaterial({
    map: pineTex,
    color: '#8cae8d',
    alphaTest: 0.36,
    side: THREE.DoubleSide,
    roughness: 0.96,
    metalness: 0.0,
    envMapIntensity: 0.22,
  });
  applyWindSway(pineMat, windUniforms, 0.14, 1.1);

  const leafMatA = new THREE.MeshStandardMaterial({
    map: leafTex,
    color: '#9db582',
    alphaTest: 0.36,
    side: THREE.DoubleSide,
    roughness: 0.96,
    metalness: 0.0,
    envMapIntensity: 0.22,
  });
  applyWindSway(leafMatA, windUniforms, 0.22, 1.35);

  const leafMatB = new THREE.MeshStandardMaterial({
    map: leafTex,
    color: '#b8a878',
    alphaTest: 0.36,
    side: THREE.DoubleSide,
    roughness: 0.96,
    metalness: 0.0,
    envMapIntensity: 0.22,
  });
  applyWindSway(leafMatB, windUniforms, 0.2, 1.25);

  // Reusable crossed alpha-tested foliage cluster + organic flared tree trunks
  const boughCardGeo = createCrossedFoliageGeo(1.0);
  const pineTrunkGeo = createFlaredTrunkGeo(5.15, 0.28, 0.17, 0.025);
  const broadleafTrunkGeo = createFlaredTrunkGeo(2.45, 0.32, 0.19, 0.11);

  for (let i = 0; i < 66; i++) {
    const ang = (i / 66) * Math.PI * 2 + (hash2D(i, 19.3) - 0.5) * 0.16;
    const dist = 10.2 + hash2D(i, 3.7) * 13.5;
    const x = Math.cos(ang) * dist * 1.16;
    const z = Math.sin(ang) * dist * 0.92 - 1.1;

    // Keep south camera corridor & immediate cabin sightline open
    if (z > 6.0 && Math.abs(x) < 6.5) continue;
    if (sdf.signedDistance(x, z) < 1.25) continue;
    if (Math.hypot(x - 5.1, z + 9.6) < 3.4) continue;

    const groundY = sdf.terrainHeight(x, z);
    const isPine = hash2D(i, 8.8) > 0.4;
    const scale = 0.85 + hash2D(i, 14.2) * 0.95;

    const tree = new THREE.Group();
    tree.position.set(x, groundY - 0.14, z);
    tree.rotation.set(
      (hash2D(i, 2.3) - 0.5) * 0.06,
      hash2D(i, 6.1) * Math.PI * 2,
      (hash2D(i, 9.7) - 0.5) * 0.06
    );
    tree.scale.setScalar(scale);

    if (isPine) {
      const trunk = new THREE.Mesh(pineTrunkGeo, trunkMat);
      tree.add(trunk);

      // 10 densely overlapping organic pine bough layers forming a full, natural spruce silhouette
      for (let t = 0; t < 10; t++) {
        const frac = t / 9;
        const y = 1.45 + frac * 3.95;
        const radius = (1 - frac * 0.64) * 2.95;
        const layer = new THREE.Mesh(boughCardGeo, pineMat);
        layer.position.y = y;
        layer.rotation.y = t * 0.85;
        layer.scale.set(radius, radius * 0.78, radius);
        tree.add(layer);
      }
    } else {
      const trunk = new THREE.Mesh(broadleafTrunkGeo, trunkMat);
      tree.add(trunk);

      // Forked secondary branch for organic silhouette
      const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.1, 1.5, 6), trunkMat);
      branch.position.set(0.45, 2.35, 0.18);
      branch.rotation.z = -0.58;
      tree.add(branch);

      const canopyMat = hash2D(i, 11.4) > 0.35 ? leafMatA : leafMatB;
      const puffs = [
        { x: 0, y: 3.1, z: 0, s: 2.35 },
        { x: 0.92, y: 2.85, z: 0.35, s: 1.75 },
        { x: -0.78, y: 2.75, z: -0.25, s: 1.85 },
        { x: 0.15, y: 3.85, z: -0.15, s: 1.65 },
      ];
      for (let p = 0; p < puffs.length; p++) {
        const pf = puffs[p];
        const cluster = new THREE.Mesh(boughCardGeo, canopyMat);
        cluster.position.set(pf.x, pf.y, pf.z);
        cluster.rotation.set((p - 1.5) * 0.18, p * 1.3, (p % 2 ? 1 : -1) * 0.14);
        cluster.scale.setScalar(pf.s);
        tree.add(cluster);
      }
    }

    parent.add(tree);
  }
}

function createCrossedFoliageGeo(size: number): THREE.BufferGeometry {
  const p1 = new THREE.PlaneGeometry(size, size);
  const p2 = new THREE.PlaneGeometry(size, size);
  p2.rotateY(Math.PI / 3);
  const p3 = new THREE.PlaneGeometry(size, size);
  p3.rotateY(-Math.PI / 3);
  const p4 = new THREE.PlaneGeometry(size, size);
  p4.rotateX(Math.PI * 0.38);

  return mergeSimpleGeos([p1, p2, p3, p4]);
}

function mergeSimpleGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vertCount = 0;
  let idxCount = 0;
  for (const g of geos) {
    vertCount += g.attributes.position.count;
    idxCount += g.index ? g.index.count : g.attributes.position.count;
  }

  const pos = new Float32Array(vertCount * 3);
  const norm = new Float32Array(vertCount * 3);
  const uv = new Float32Array(vertCount * 2);
  const indices = new Uint16Array(idxCount);

  let vOff = 0;
  let iOff = 0;
  for (const g of geos) {
    const p = g.attributes.position as THREE.BufferAttribute;
    const n = g.attributes.normal as THREE.BufferAttribute;
    const u = g.attributes.uv as THREE.BufferAttribute;
    pos.set(p.array as Float32Array, vOff * 3);
    norm.set(n.array as Float32Array, vOff * 3);
    uv.set(u.array as Float32Array, vOff * 2);

    if (g.index) {
      const idx = g.index.array;
      for (let k = 0; k < idx.length; k++) {
        indices[iOff + k] = idx[k] + vOff;
      }
      iOff += idx.length;
    } else {
      for (let k = 0; k < p.count; k++) {
        indices[iOff + k] = vOff + k;
      }
      iOff += p.count;
    }
    vOff += p.count;
    g.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  return merged;
}

function buildReedsAndCattails(
  parent: THREE.Group,
  sdf: PondShapeSDF,
  windUniforms: WindUniformRef
): void {
  // Gently curved slender reed blade
  const bladeGeo = new THREE.PlaneGeometry(0.055, 1.05, 1, 5);
  const bPos = bladeGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < bPos.count; i++) {
    const y = bPos.getY(i) + 0.525; // 0..1.05
    const t = y / 1.05;
    bPos.setX(i, bPos.getX(i) * (1 - t * 0.85));
    bPos.setY(i, y);
    bPos.setZ(i, t * t * 0.24); // Graceful arch
  }
  bladeGeo.computeVertexNormals();

  const reedMat = new THREE.MeshStandardMaterial({
    color: '#798f5c',
    roughness: 0.82,
    side: THREE.DoubleSide,
  });
  applyWindSway(reedMat, windUniforms, 0.26, 1.75);

  const cattailHeadGeo = new THREE.CapsuleGeometry(0.028, 0.14, 4, 6);
  cattailHeadGeo.translate(0, 0.92, 0.16);
  const cattailMat = new THREE.MeshStandardMaterial({ color: '#6b4731', roughness: 0.92 });
  applyWindSway(cattailMat, windUniforms, 0.26, 1.75);

  const bladeMatrices: THREE.Matrix4[] = [];
  const headMatrices: THREE.Matrix4[] = [];
  const dummy = new THREE.Object3D();

  for (let cluster = 0; cluster < 38; cluster++) {
    const ang = (cluster / 38) * Math.PI * 2 + (hash2D(cluster, 12.1) - 0.5) * 0.22;
    if (Math.sin(ang) > 0.66 && Math.abs(Math.cos(ang)) < 0.44) continue;

    let cx = 0;
    let cz = 0;
    let found = false;
    for (let r = 3.2; r < 12.5; r += 0.24) {
      const tx = Math.cos(ang) * r;
      const tz = Math.sin(ang) * r * 0.85;
      const sd = sdf.signedDistance(tx, tz);
      if (sd >= -0.25 && sd <= 0.42) {
        cx = tx;
        cz = tz;
        found = true;
        break;
      }
    }
    if (!found) continue;

    const stalks = 9 + Math.floor(hash2D(cluster, 21.3) * 9);
    for (let s = 0; s < stalks; s++) {
      const x = cx + (hash2D(cluster * 31 + s, 1.3) - 0.5) * 0.95;
      const z = cz + (hash2D(cluster * 31 + s, 4.9) - 0.5) * 0.95;
      // Leave a natural boat-landing clearing around the cabin jetty & moored rowboat
      if (x > 0.2 && x < 3.8 && z > -6.8 && z < -2.6) continue;
      const y = Math.min(0.16, sdf.terrainHeight(x, z));
      const h = 0.62 + hash2D(cluster * 17 + s, 8.2) * 0.72;
      dummy.position.set(x, y - 0.05, z);
      dummy.rotation.set(0, hash2D(s, cluster + 5.7) * Math.PI * 2, 0);
      dummy.scale.set(1, h, 1);
      dummy.updateMatrix();
      bladeMatrices.push(dummy.matrix.clone());

      // ~22% of taller stalks carry a velvet cattail head
      if (s % 4 === 0 && h > 0.92) {
        headMatrices.push(dummy.matrix.clone());
      }
    }
  }

  const bladeInst = new THREE.InstancedMesh(bladeGeo, reedMat, bladeMatrices.length);
  bladeMatrices.forEach((m, i) => bladeInst.setMatrixAt(i, m));
  bladeInst.instanceMatrix.needsUpdate = true;
  parent.add(bladeInst);

  if (headMatrices.length > 0) {
    const headInst = new THREE.InstancedMesh(cattailHeadGeo, cattailMat, headMatrices.length);
    headMatrices.forEach((m, i) => headInst.setMatrixAt(i, m));
    headInst.instanceMatrix.needsUpdate = true;
    parent.add(headInst);
  }
}

function buildLilyPads(
  parent: THREE.Group,
  sdf: PondShapeSDF
): Array<{ mesh: THREE.Mesh; phase: number }> {
  // Classic notched lily pad disc
  const padGeo = new THREE.CircleGeometry(0.26, 18, 0.22, Math.PI * 2 - 0.44);
  padGeo.rotateX(-Math.PI / 2);

  const padMat = new THREE.MeshStandardMaterial({
    color: '#4d7345',
    roughness: 0.84,
    metalness: 0.0,
    envMapIntensity: 0.24,
  });
  const petalMat = new THREE.MeshStandardMaterial({
    color: '#f5e4dc',
    roughness: 0.65,
  });
  const stamenMat = new THREE.MeshStandardMaterial({
    color: '#e5b84b',
    roughness: 0.7,
  });

  const pads: Array<{ mesh: THREE.Mesh; phase: number }> = [];
  const placed: Array<{ x: number; z: number; r: number }> = [];
  const coves = [
    { x: -4.8, z: -1.4, count: 6 },
    { x: 4.5, z: 1.8, count: 5 },
    { x: -2.8, z: 2.9, count: 4 },
  ];

  for (let c = 0; c < coves.length; c++) {
    const cove = coves[c];
    for (let i = 0; i < cove.count; i++) {
      const px = cove.x + (hash2D(c * 19 + i, 2.1) - 0.5) * 2.2;
      const pz = cove.z + (hash2D(c * 19 + i, 7.4) - 0.5) * 1.9;
      if (sdf.signedDistance(px, pz) > -0.7) continue;

      const s = 0.65 + hash2D(c * 13 + i, 4.4) * 0.68;
      const rad = 0.28 * s;
      if (placed.some((p) => Math.hypot(p.x - px, p.z - pz) < p.r + rad + 0.08)) continue;
      placed.push({ x: px, z: pz, r: rad });

      const mesh = new THREE.Mesh(padGeo, padMat);
      mesh.position.set(px, sdf.waterLevel + 0.014, pz);
      mesh.rotation.y = hash2D(c * 29 + i, 9.1) * Math.PI * 2;
      mesh.scale.set(s, 1, s * (0.9 + hash2D(i, 3.3) * 0.2));

      // Add a delicate pale water-lily blossom to 1 pad per cove
      if (i === 1) {
        const flower = new THREE.Group();
        flower.position.set(0, 0.025, 0);
        for (let p = 0; p < 7; p++) {
          const a = (p / 7) * Math.PI * 2;
          const petal = new THREE.Mesh(new THREE.ConeGeometry(0.028, 0.085, 5), petalMat);
          petal.position.set(Math.cos(a) * 0.035, 0.02, Math.sin(a) * 0.035);
          petal.rotation.set(0.65, -a, 0);
          flower.add(petal);
        }
        const core = new THREE.Mesh(new THREE.SphereGeometry(0.024, 6, 6), stamenMat);
        core.position.y = 0.025;
        flower.add(core);
        mesh.add(flower);
      }

      parent.add(mesh);
      pads.push({ mesh, phase: hash2D(c, i) * Math.PI * 2 });
    }
  }
  return pads;
}

function buildForegroundFallenLog(
  parent: THREE.Group,
  sdf: PondShapeSDF,
  textureCache: PBRTextureCache
): void {
  const barkPBR = textureCache.getProceduralPBR('bark', 3, 2);
  const logMat = new THREE.MeshStandardMaterial({
    map: barkPBR.map,
    roughnessMap: barkPBR.roughnessMap,
    normalMap: barkPBR.normalMap,
    color: '#9b8d7e',
    roughness: 0.9,
  });
  const mossMat = new THREE.MeshStandardMaterial({
    color: '#5f7848',
    roughness: 0.95,
  });

  const logGroup = new THREE.Group();
  const lx = -5.6;
  const lz = 4.6;
  const ly = sdf.terrainHeight(lx, lz);
  logGroup.position.set(lx, ly + 0.04, lz);
  logGroup.rotation.set(0.08, 0.62, -0.06);

  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.21, 3.1, 9), logMat);
  trunk.rotation.z = Math.PI / 2;
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  logGroup.add(trunk);

  // Soft mossy patches resting along the top of the fallen shoreline log
  for (const ox of [-0.65, 0.15, 0.72]) {
    const patch = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), mossMat);
    patch.scale.set(1.6, 0.35, 0.9);
    patch.position.set(ox, 0.13, 0);
    logGroup.add(patch);
  }

  parent.add(logGroup);
}

function createFlaredTrunkGeo(
  height: number,
  rootR: number,
  midR: number,
  topR: number
): THREE.LatheGeometry {
  const pts = [
    new THREE.Vector2(rootR * 1.15, -0.1),
    new THREE.Vector2(rootR, 0.05),
    new THREE.Vector2(midR * 1.08, height * 0.14),
    new THREE.Vector2(midR * 0.92, height * 0.45),
    new THREE.Vector2(topR * 1.35, height * 0.82),
    new THREE.Vector2(topR, height),
  ];
  return new THREE.LatheGeometry(pts, 8);
}

function buildBankGrassAndShrubs(
  parent: THREE.Group,
  sdf: PondShapeSDF,
  textureCache: PBRTextureCache,
  windUniforms: WindUniformRef
): void {
  // Multi-blade organic grass tussock merged into one instanced mesh
  const blades: THREE.BufferGeometry[] = [];
  for (let b = 0; b < 5; b++) {
    const g = new THREE.PlaneGeometry(0.055, 0.42, 1, 3);
    const p = g.attributes.position as THREE.BufferAttribute;
    const ang = (b / 5) * Math.PI * 2 + b * 0.3;
    const lean = 0.08 + (b % 2) * 0.06;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i) + 0.21;
      const t = y / 0.42;
      p.setX(i, p.getX(i) * (1 - t * 0.85));
      p.setY(i, y);
      p.setZ(i, t * t * lean);
    }
    g.rotateY(ang);
    g.translate(Math.cos(ang) * 0.04, 0, Math.sin(ang) * 0.04);
    g.computeVertexNormals();
    blades.push(g);
  }
  const tuftGeo = mergeSimpleGeos(blades);
  const tuftMat = new THREE.MeshStandardMaterial({
    color: '#4f613b',
    roughness: 0.94,
    side: THREE.DoubleSide,
  });
  applyWindSway(tuftMat, windUniforms, 0.16, 2.0);

  const tuftMatrices: THREE.Matrix4[] = [];
  const dummy = new THREE.Object3D();

  for (let i = 0; i < 340; i++) {
    const ang = hash2D(i, 3.3) * Math.PI * 2;
    const r = 6.2 + hash2D(i, 7.9) * 11.5;
    const x = Math.cos(ang) * r * 1.15;
    const z = Math.sin(ang) * r * 0.88 - 0.8;
    const sd = sdf.signedDistance(x, z);
    if (sd < 0.35 || sd > 6.2) continue;
    if (z > 5.8 && Math.abs(x) < 5.5) continue;
    if (Math.hypot(x - 5.1, z + 9.6) < 2.2) continue;

    const y = sdf.terrainHeight(x, z);
    const s = 0.58 + hash2D(i, 11.1) * 0.68;
    dummy.position.set(x, y - 0.03, z);
    dummy.rotation.set(0, hash2D(i, 15.2) * Math.PI * 2, 0);
    dummy.scale.set(s, s * (0.75 + hash2D(i, 18.4) * 0.65), s);
    dummy.updateMatrix();
    tuftMatrices.push(dummy.matrix.clone());
  }

  if (tuftMatrices.length > 0) {
    const tuftInst = new THREE.InstancedMesh(tuftGeo, tuftMat, tuftMatrices.length);
    tuftMatrices.forEach((m, idx) => tuftInst.setMatrixAt(idx, m));
    tuftInst.instanceMatrix.needsUpdate = true;
    parent.add(tuftInst);
  }

  // Low woodland shrubs / ferns anchoring tree bases & far hillside
  const shrubGeo = createCrossedFoliageGeo(0.95);
  const shrubMat = new THREE.MeshStandardMaterial({
    map: textureCache.getFoliageTexture('leaf'),
    color: '#6e8458',
    alphaTest: 0.36,
    side: THREE.DoubleSide,
    roughness: 0.95,
    envMapIntensity: 0.16,
  });
  applyWindSway(shrubMat, windUniforms, 0.14, 1.5);

  const shrubMatrices: THREE.Matrix4[] = [];
  for (let i = 0; i < 42; i++) {
    const ang = (i / 42) * Math.PI * 2 + (hash2D(i, 22.1) - 0.5) * 0.2;
    const r = 8.4 + hash2D(i, 27.6) * 8.2;
    const x = Math.cos(ang) * r * 1.12;
    const z = Math.sin(ang) * r * 0.85 - 1.0;
    const sd = sdf.signedDistance(x, z);
    if (sd < 0.95 || sd > 7.5) continue;
    if (z > 5.5 && Math.abs(x) < 6.0) continue;
    if (Math.hypot(x - 5.1, z + 9.6) < 2.8) continue;

    const y = sdf.terrainHeight(x, z);
    const s = 0.85 + hash2D(i, 31.4) * 0.85;
    dummy.position.set(x, y + s * 0.34, z);
    dummy.rotation.set(0, hash2D(i, 35.8) * Math.PI * 2, 0);
    dummy.scale.set(s * 1.25, s * 0.78, s * 1.25);
    dummy.updateMatrix();
    shrubMatrices.push(dummy.matrix.clone());
  }

  if (shrubMatrices.length > 0) {
    const shrubInst = new THREE.InstancedMesh(shrubGeo, shrubMat, shrubMatrices.length);
    shrubMatrices.forEach((m, idx) => shrubInst.setMatrixAt(idx, m));
    shrubInst.instanceMatrix.needsUpdate = true;
    parent.add(shrubInst);
  }
}

function buildFloatingLeaves(
  parent: THREE.Group,
  sdf: PondShapeSDF
): Array<{
  mesh: THREE.Mesh;
  x: number;
  z: number;
  originX: number;
  originZ: number;
  phase: number;
  spinDir: number;
}> {
  const leafGeo = new THREE.CircleGeometry(0.055, 7);
  leafGeo.rotateX(-Math.PI / 2);
  leafGeo.scale(1.45, 1, 0.78);

  const colors = ['#9e6338', '#b67d3d', '#845937', '#a86f3b'];
  const leaves: Array<{
    mesh: THREE.Mesh;
    x: number;
    z: number;
    originX: number;
    originZ: number;
    phase: number;
    spinDir: number;
  }> = [];

  for (let i = 0; i < 16; i++) {
    const x = -5.2 + hash2D(i, 44.1) * 10.4;
    const z = -3.8 + hash2D(i, 49.7) * 6.4;
    if (!sdf.isNavigable(x, z, 0.8)) continue;

    const mat = new THREE.MeshStandardMaterial({
      color: colors[i % colors.length],
      roughness: 0.72,
    });
    const mesh = new THREE.Mesh(leafGeo, mat);
    mesh.position.set(x, sdf.waterLevel + 0.013, z);
    mesh.rotation.y = hash2D(i, 53.2) * Math.PI * 2;
    const s = 0.75 + hash2D(i, 57.8) * 0.7;
    mesh.scale.setScalar(s);
    parent.add(mesh);

    leaves.push({
      mesh,
      x,
      z,
      originX: -5.2 + hash2D(i, 61.3) * 2.5,
      originZ: z,
      phase: hash2D(i, 66.1) * Math.PI * 2,
      spinDir: i % 2 === 0 ? 1 : -1,
    });
  }
  return leaves;
}
