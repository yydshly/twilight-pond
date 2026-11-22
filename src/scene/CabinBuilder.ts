import * as THREE from 'three';
import { lerp } from '../core/noise';
import type { PBRTextureCache } from '../modules/PBRTextureCache';
import type { PondShapeSDF } from '../modules/PondShapeSDF';
import type { WaterSystem } from '../modules/WaterSystem';

export interface CabinRig {
  group: THREE.Group;
  update(time: number, dayPhase: number, windStrength: number, water: WaterSystem): void;
}

/**
 * Far-Shore Woodland Cabin (远岸小屋)
 * Detailed lakeside timber cabin with stone foundation, gabled overhanging eaves,
 * timber porch with hanging lantern, framed multi-pane glowing windows, wooden dock on pilings,
 * and soft wind-drifting chimney smoke.
 */
export function buildFarShoreCabin(
  sdf: PondShapeSDF,
  textureCache: PBRTextureCache
): CabinRig {
  const cabinX = 5.1;
  const cabinZ = -9.6;
  const cabinY = sdf.terrainHeight(cabinX, cabinZ);

  const cabin = new THREE.Group();
  cabin.name = 'FarShoreCabin';
  cabin.position.set(cabinX, cabinY - 0.04, cabinZ);
  cabin.rotation.y = -0.46;

  const woodPBR = textureCache.getProceduralPBR('cabinWood', 2, 2);
  const wallMat = new THREE.MeshStandardMaterial({
    map: woodPBR.map,
    roughnessMap: woodPBR.roughnessMap,
    normalMap: woodPBR.normalMap,
    roughness: 0.88,
  });
  const trimMat = new THREE.MeshStandardMaterial({ color: '#3b2c22', roughness: 0.9 });
  const roofMat = new THREE.MeshStandardMaterial({
    map: woodPBR.map,
    normalMap: woodPBR.normalMap,
    normalScale: new THREE.Vector2(0.9, 0.9),
    color: '#424952',
    roughness: 0.86,
  });
  const stoneMat = new THREE.MeshStandardMaterial({ color: '#4c4e52', roughness: 0.94 });

  // Solid stone foundation plinth anchored deep into the hillside
  const foundation = new THREE.Mesh(new THREE.BoxGeometry(3.15, 1.1, 2.65), stoneMat);
  foundation.position.y = -0.42;
  cabin.add(foundation);

  // Main timber walls
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.9, 1.75, 2.35), wallMat);
  body.position.y = 0.92;
  cabin.add(body);

  // Corner timber posts
  for (const sx of [-1.45, 1.45]) {
    for (const sz of [-1.17, 1.17]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.82, 0.14), trimMat);
      post.position.set(sx, 0.94, sz);
      cabin.add(post);
    }
  }

  // Authentic pitched gable roof (two overhanging roof planes + gable end triangles)
  const roofW = 3.55;
  const slopeLen = 1.98;
  const roofTilt = 0.56;
  const leftSlope = new THREE.Mesh(new THREE.BoxGeometry(roofW, 0.1, slopeLen), roofMat);
  leftSlope.position.set(0, 2.24, -0.78);
  leftSlope.rotation.x = -roofTilt;
  cabin.add(leftSlope);

  const rightSlope = new THREE.Mesh(new THREE.BoxGeometry(roofW, 0.1, slopeLen + 0.45), roofMat);
  rightSlope.position.set(0, 2.13, 0.96);
  rightSlope.rotation.x = roofTilt;
  cabin.add(rightSlope);

  const ridgeBeam = new THREE.Mesh(new THREE.BoxGeometry(roofW + 0.08, 0.12, 0.14), trimMat);
  ridgeBeam.position.set(0, 2.77, 0);
  cabin.add(ridgeBeam);

  // Triangular gable end walls under roof peak
  const gableShape = new THREE.Shape();
  gableShape.moveTo(-1.18, 0);
  gableShape.lineTo(1.18, 0);
  gableShape.lineTo(0, 0.98);
  gableShape.closePath();
  const gableGeo = new THREE.ExtrudeGeometry(gableShape, { depth: 2.86, bevelEnabled: false });
  gableGeo.rotateY(Math.PI / 2);
  gableGeo.translate(-1.43, 1.78, 0);
  const gableMesh = new THREE.Mesh(gableGeo, wallMat);
  cabin.add(gableMesh);

  // Cozy front timber porch deck + grounded support stilts + roof posts
  const porchDeck = new THREE.Mesh(new THREE.BoxGeometry(3.05, 0.14, 1.15), wallMat);
  porchDeck.position.set(0, 0.1, 1.72);
  cabin.add(porchDeck);

  // Dark foundation skirt & timber stilts anchoring the porch firmly into the sloped bank
  const porchBase = new THREE.Mesh(new THREE.BoxGeometry(2.96, 1.15, 1.02), stoneMat);
  porchBase.position.set(0, -0.52, 1.66);
  cabin.add(porchBase);

  for (const sx of [-1.35, 1.35]) {
    const pPost = new THREE.Mesh(new THREE.BoxGeometry(0.11, 1.65, 0.11), trimMat);
    pPost.position.set(sx, 0.92, 2.18);
    cabin.add(pPost);

    const stilt = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.25, 0.14), trimMat);
    stilt.position.set(sx, -0.56, 2.18);
    cabin.add(stilt);
  }

  // Two cozy wooden steps descending from the porch toward the shore
  const step1 = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.14, 0.36), wallMat);
  step1.position.set(0, -0.1, 2.42);
  const step2 = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.14, 0.36), wallMat);
  step2.position.set(0, -0.32, 2.74);
  cabin.add(step1, step2);

  // Stone chimney
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.25, 0.42), stoneMat);
  chimney.position.set(-0.92, 2.75, -0.45);
  cabin.add(chimney);

  // Warm glowing amber windows with wooden frames & 4-pane mullions
  const windowMat = new THREE.MeshStandardMaterial({
    color: '#ffe3ad',
    emissive: new THREE.Color('#ff9c3b'),
    emissiveIntensity: 1.5,
    roughness: 0.2,
  });

  const glowTex = textureCache.getSoftGlowTexture();
  const haloSprites: THREE.Sprite[] = [];
  const createWindow = (wx: number, wy: number, wz: number, rotY = 0) => {
    const winGroup = new THREE.Group();
    winGroup.position.set(wx, wy, wz);
    winGroup.rotation.y = rotY;

    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.6), windowMat);
    winGroup.add(glass);

    // Outer wooden frame + inner mullions (crossbars)
    const topF = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.06, 0.06), trimMat);
    topF.position.y = 0.31;
    const botF = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.07, 0.08), trimMat);
    botF.position.y = -0.32;
    const leftF = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.64, 0.06), trimMat);
    leftF.position.x = -0.3;
    const rightF = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.64, 0.06), trimMat);
    rightF.position.x = 0.3;
    const midV = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.6, 0.04), trimMat);
    midV.position.z = 0.015;
    const midH = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.035, 0.04), trimMat);
    midH.position.z = 0.015;
    winGroup.add(topF, botF, leftF, rightF, midV, midH);

    // Subtle soft warm glow bloom halo
    const haloMat = new THREE.SpriteMaterial({
      map: glowTex,
      color: '#ffaa4d',
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const halo = new THREE.Sprite(haloMat);
    halo.position.z = 0.08;
    halo.scale.set(1.35, 1.35, 1);
    winGroup.add(halo);
    haloSprites.push(halo);

    cabin.add(winGroup);
  };

  createWindow(-0.74, 1.04, 1.19);
  createWindow(0.74, 1.04, 1.19);
  createWindow(-1.46, 1.06, 0.12, -Math.PI / 2);

  // Timber door & hanging warm porch lantern
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.56, 1.18, 0.08), trimMat);
  door.position.set(0, 0.68, 1.18);
  cabin.add(door);

  const lantern = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), windowMat);
  lantern.position.set(0.42, 1.48, 1.72);
  cabin.add(lantern);

  const lanternHalo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTex,
      color: '#ffba66',
      transparent: true,
      opacity: 0.36,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  lanternHalo.position.copy(lantern.position);
  lanternHalo.scale.set(0.95, 0.95, 1);
  cabin.add(lanternHalo);
  haloSprites.push(lanternHalo);

  // Weathered wooden jetty extending clearly past the cattails out over open pond water
  const dockGroup = new THREE.Group();
  const dockY = -cabinY + 0.19;
  for (let p = 0; p < 14; p++) {
    const plank = new THREE.Mesh(new THREE.BoxGeometry(1.08, 0.06, 0.24), wallMat);
    plank.position.set(-0.35, dockY, 2.95 + p * 0.28);
    plank.rotation.y = (p % 2 === 0 ? 1 : -1) * 0.015;
    dockGroup.add(plank);
  }
  // Two longitudinal deck stringer beams underneath the planks
  for (const bx of [-0.74, 0.04]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 3.85), trimMat);
    beam.position.set(bx, dockY - 0.06, 4.78);
    dockGroup.add(beam);
  }
  for (const px of [-0.82, 0.12]) {
    for (const pz of [3.2, 4.4, 5.6, 6.65]) {
      const piling = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.075, 1.45, 7), trimMat);
      piling.position.set(px, dockY - 0.34, pz);
      dockGroup.add(piling);
    }
  }
  cabin.add(dockGroup);

  // Moored weathered wooden rowboat floating gently beside the jetty
  const boatPivot = new THREE.Group();
  boatPivot.name = 'MooredRowboat';
  const boatLocalX = -1.65;
  const boatLocalZ = 5.95;
  boatPivot.position.set(boatLocalX, -cabinY + 0.02, boatLocalZ);
  boatPivot.rotation.y = 0.58;

  const boatHullMat = new THREE.MeshStandardMaterial({
    map: woodPBR.map,
    roughnessMap: woodPBR.roughnessMap,
    normalMap: woodPBR.normalMap,
    color: '#8f7257',
    roughness: 0.86,
  });
  const boatInnerMat = new THREE.MeshStandardMaterial({ color: '#4d3a2c', roughness: 0.92 });

  // Sculpted tapered canoe/rowboat outer hull & dark recessed inner deck
  const hullGeo = buildRowboatHullGeo();
  const hullMesh = new THREE.Mesh(hullGeo, boatHullMat);
  boatPivot.add(hullMesh);

  const floorDeck = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.03, 1.38), boatInnerMat);
  floorDeck.position.set(0, 0.06, 0);
  boatPivot.add(floorDeck);

  // Two wooden rowing benches (thwarts) + a single resting wooden oar
  for (const sz of [-0.36, 0.24]) {
    const bench = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.035, 0.18), boatHullMat);
    bench.position.set(0, 0.2, sz);
    boatPivot.add(bench);
  }
  const oarShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.017, 1.45, 6), trimMat);
  oarShaft.rotation.x = Math.PI / 2 - 0.04;
  oarShaft.rotation.z = 0.14;
  oarShaft.position.set(0.14, 0.24, -0.05);
  boatPivot.add(oarShaft);
  const oarBlade = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.016, 0.34), boatHullMat);
  oarBlade.position.set(0.24, 0.21, -0.78);
  oarBlade.rotation.y = -0.14;
  boatPivot.add(oarBlade);

  cabin.add(boatPivot);

  // Sagging mooring rope connecting the rowboat bow to the jetty end piling
  const ropeCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.82, dockY + 0.16, 6.65),
    new THREE.Vector3(-1.12, dockY - 0.08, 6.45),
    new THREE.Vector3(boatLocalX + 0.42, -cabinY + 0.26, boatLocalZ + 0.56),
  ]);
  const ropeMesh = new THREE.Mesh(
    new THREE.TubeGeometry(ropeCurve, 10, 0.014, 5, false),
    new THREE.MeshStandardMaterial({ color: '#786852', roughness: 0.95 })
  );
  cabin.add(ropeMesh);

  // Compute boat world coordinates once so we can sample WaterSystem accurately
  cabin.updateMatrixWorld(true);
  const boatWorldPos = new THREE.Vector3();
  boatPivot.getWorldPosition(boatWorldPos);
  const lanternBaseX = lantern.position.x;

  const cabinWarmLight = new THREE.PointLight('#ffa94d', 3.0, 15, 1.5);
  cabinWarmLight.position.set(0.15, 1.45, 2.1);
  cabin.add(cabinWarmLight);

  // Soft wispy chimney smoke using smooth radial puff texture
  const smokeCount = 12;
  const smokePos = new Float32Array(smokeCount * 3);
  const smokeOffsets = new Float32Array(smokeCount);
  for (let i = 0; i < smokeCount; i++) {
    smokeOffsets[i] = i / smokeCount;
    smokePos[i * 3] = -0.92;
    smokePos[i * 3 + 1] = 3.45 + i * 0.25;
    smokePos[i * 3 + 2] = -0.45;
  }
  const smokeGeo = new THREE.BufferGeometry();
  smokeGeo.setAttribute('position', new THREE.BufferAttribute(smokePos, 3));
  const smokeMat = new THREE.PointsMaterial({
    color: '#d4cdd4',
    map: glowTex,
    size: 0.92,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
  });
  const smokePoints = new THREE.Points(smokeGeo, smokeMat);
  cabin.add(smokePoints);

  return {
    group: cabin,
    update(time: number, dayPhase: number, windStrength: number, water: WaterSystem): void {
      const flicker = 1 + Math.sin(time * 2.9) * 0.03 + Math.sin(time * 5.3) * 0.02;
      windowMat.emissiveIntensity = lerp(1.15, 2.55, dayPhase) * flicker;
      cabinWarmLight.intensity = lerp(2.1, 5.8, dayPhase) * flicker;
      const haloOpacity = lerp(0.18, 0.42, dayPhase) * flicker;
      for (const s of haloSprites) {
        (s.material as THREE.SpriteMaterial).opacity = haloOpacity;
      }

      // Porch lantern sways gently with wind gusts
      const lanternSway = Math.sin(time * (1.8 + windStrength * 1.4)) * (0.012 + windStrength * 0.045);
      lantern.position.x = lanternBaseX + lanternSway;
      lanternHalo.position.x = lantern.position.x;

      // Physically-coupled moored rowboat bobbing & gentle roll on the pond waves
      const ws = water.sample(boatWorldPos.x, boatWorldPos.z, time, windStrength);
      boatPivot.position.y = -cabinY + ws.height + 0.01;
      boatPivot.rotation.z = Math.sin(time * 1.15 + 0.8) * (0.022 + windStrength * 0.045) + ws.nx * 0.35;
      boatPivot.rotation.x = Math.cos(time * 0.92) * (0.015 + windStrength * 0.028) + ws.nz * 0.3;
      boatPivot.rotation.y = 0.58 + Math.sin(time * 0.42) * (0.025 + windStrength * 0.04);

      const attr = smokePoints.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < smokeOffsets.length; i++) {
        const life = (smokeOffsets[i] + time * 0.11) % 1;
        const drift = (0.3 + windStrength * 1.4) * life * life;
        attr.setXYZ(
          i,
          -0.92 + drift + Math.sin(time * 0.75 + i * 1.4) * 0.16 * life,
          3.42 + life * 2.6,
          -0.45 + drift * 0.25
        );
      }
      attr.needsUpdate = true;
    },
  };
}

function buildRowboatHullGeo(): THREE.BufferGeometry {
  // Open-top curved wooden rowboat hull loft (bow to stern along Z, -1.05 .. +1.05)
  const rings = 14;
  const arcSegs = 12;
  const cols = arcSegs + 1;
  const positions = new Float32Array((rings + 1) * cols * 3);
  const uvs = new Float32Array((rings + 1) * cols * 2);
  const indices: number[] = [];

  for (let r = 0; r <= rings; r++) {
    const v = r / rings; // 0 = stern, 1 = bow
    const z = (v - 0.5) * 2.15;
    // Tapered bow (+Z) and slightly blunter classic rowboat stern (-Z)
    const widthCurve = Math.sin(Math.pow(v, 0.88) * Math.PI);
    const halfW = Math.max(0.03, widthCurve * 0.44);
    const sheerLift = Math.pow((v - 0.5) * 2, 2) * 0.12;
    const gunwaleY = 0.26 + sheerLift;
    const keelY = -0.04 + sheerLift * 0.35;

    for (let c = 0; c <= arcSegs; c++) {
      const u = c / arcSegs; // 0 = port gunwale -> 0.5 = keel -> 1 = starboard gunwale
      const ang = (u - 0.5) * Math.PI; // -PI/2 .. +PI/2
      const x = Math.sin(ang) * halfW;
      const y = lerp(keelY, gunwaleY, 1 - Math.cos(ang));

      const idx = r * cols + c;
      positions[idx * 3] = x;
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = z;
      uvs[idx * 2] = u;
      uvs[idx * 2 + 1] = v * 2;
    }
  }

  for (let r = 0; r < rings; r++) {
    for (let c = 0; c < arcSegs; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = (r + 1) * cols + c;
      const e = d + 1;
      indices.push(a, d, b);
      indices.push(b, d, e);
      // Double-sided inner hull wall
      indices.push(a, b, d);
      indices.push(b, e, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}
