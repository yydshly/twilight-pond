import * as THREE from 'three';
import { hash2D } from '../core/noise';
import type { PBRTextureCache } from '../modules/PBRTextureCache';
import type { PondShapeSDF } from '../modules/PondShapeSDF';
import type { WaterSystem } from '../modules/WaterSystem';

interface FishAgent {
  mesh: THREE.Group;
  centerX: number;
  centerZ: number;
  radiusX: number;
  radiusZ: number;
  speed: number;
  phase: number;
}

interface SkyBird {
  root: THREE.Group;
  leftWing: THREE.Mesh;
  rightWing: THREE.Mesh;
  orbitR: number;
  height: number;
  speed: number;
  phase: number;
}

/**
 * 360-Degree Scenic Pond Landmarks & Quiet Background Life:
 * - West shore: rocky mossy forest brook inlet feeding live ripples into the pond (grounds the stream audio)
 * - East shore: rustic weathered lakeside wooden bench + stepping stones under the weeping willow
 * - South shore: distant background woodland trees closing the 360-degree forest ring cleanly behind the default camera
 * - Quiet life: 4 subtle underwater drifting fish silhouettes + 2 distant soaring dusk sky birds
 */
export class PondLandmarks {
  public readonly group = new THREE.Group();

  private readonly brookMat: THREE.ShaderMaterial;
  private readonly brookEntryPos = new THREE.Vector2(-7.3, 0.35);
  private brookRippleTimer = 0.2;

  private readonly fishes: FishAgent[] = [];
  private readonly birds: SkyBird[] = [];

  constructor(
    private readonly sdf: PondShapeSDF,
    textureCache: PBRTextureCache
  ) {
    this.brookMat = this.buildWestBrookInlet(textureCache);
    this.buildEastShoreBench(textureCache);
    this.buildSouthForestRing(textureCache);
    this.buildUnderwaterFish();
    this.buildDistantSkyBirds();
  }

  private buildWestBrookInlet(textureCache: PBRTextureCache): THREE.ShaderMaterial {
    const brookGroup = new THREE.Group();
    brookGroup.name = 'WestForestBrook';

    const rockPBR = textureCache.getProceduralPBR('wetMud', 2, 2);
    const boulderMat = new THREE.MeshStandardMaterial({
      color: '#5b5e57',
      normalMap: rockPBR.normalMap,
      roughness: 0.62,
      metalness: 0.03,
    });

    // Tiered mossy wet boulders framing the brook channel descending from (-10.8, 0.4) to (-7.3, 0.35)
    const rocks = [
      { x: -10.2, z: -0.45, s: [0.95, 0.65, 0.85] },
      { x: -10.1, z: 1.15, s: [0.85, 0.62, 0.9] },
      { x: -8.9, z: -0.35, s: [0.75, 0.52, 0.72] },
      { x: -8.8, z: 1.05, s: [0.82, 0.55, 0.78] },
      { x: -7.9, z: -0.25, s: [0.58, 0.36, 0.6] },
      { x: -7.8, z: 0.92, s: [0.62, 0.38, 0.62] },
      { x: -9.5, z: 0.38, s: [0.55, 0.25, 0.65] }, // Mid-brook cascade ledge rock
    ];

    for (const r of rocks) {
      const m = new THREE.Mesh(new THREE.DodecahedronGeometry(0.55, 2), boulderMat);
      const gy = this.sdf.terrainHeight(r.x, r.z);
      m.position.set(r.x, gy + r.s[1] * 0.2, r.z);
      m.scale.set(r.s[0], r.s[1], r.s[2]);
      m.rotation.set(hash2D(r.x, 1.1) * 0.5, hash2D(r.z, 2.2) * 3.1, hash2D(r.x, r.z) * 0.4);
      m.castShadow = true;
      m.receiveShadow = true;
      brookGroup.add(m);
    }

    // Animated flowing brook water ribbon gliding down the rocky channel into the pond
    const ribbonGeo = new THREE.PlaneGeometry(3.4, 0.95, 18, 4);
    ribbonGeo.rotateX(-Math.PI / 2);
    const pos = ribbonGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i); // -1.7 (uphill west) .. +1.7 (pond entry)
      const lz = pos.getZ(i);
      const wx = -9.0 + lx;
      const wz = 0.35 + lz;
      const gy = this.sdf.terrainHeight(wx, wz);
      const t = (lx + 1.7) / 3.4; // 0 uphill -> 1 pond level
      const cascadeStep = Math.sin(t * Math.PI * 2.5) * 0.04 * (1 - t);
      pos.setY(i, Math.max(this.sdf.waterLevel + 0.02, gy + 0.09) + cascadeStep);
    }
    ribbonGeo.computeVertexNormals();

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uDayPhase: { value: 0.12 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uDayPhase;
        varying vec2 vUv;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }

        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                     mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }

        void main() {
          // Soft organic stream edge feathering
          float edgeMask = smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.75, 1.0, vUv.y));
          float endFade = smoothstep(0.0, 0.12, vUv.x) * (1.0 - smoothstep(0.84, 1.0, vUv.x));

          float flow1 = noise(vec2(vUv.x * 7.0 - uTime * 2.1, vUv.y * 5.0));
          float flow2 = noise(vec2(vUv.x * 13.0 - uTime * 3.2, vUv.y * 9.0 + 1.7));
          float foam = smoothstep(0.54, 0.85, flow1 * 0.6 + flow2 * 0.4);
          // Extra gentle whitewater froth where stream tumbles over middle ledge & enters pond
          float plunge = smoothstep(0.68, 0.92, vUv.x) * 0.45;

          vec3 waterCol = mix(vec3(0.24, 0.28, 0.28), vec3(0.12, 0.19, 0.28), uDayPhase);
          vec3 foamCol = mix(vec3(0.82, 0.78, 0.76), vec3(0.58, 0.70, 0.84), uDayPhase);
          vec3 col = mix(waterCol, foamCol, clamp(foam * 0.75 + plunge * flow2, 0.0, 1.0));

          float alpha = edgeMask * endFade * (0.58 + foam * 0.32);
          if (alpha < 0.01) discard;
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });

    const ribbon = new THREE.Mesh(ribbonGeo, mat);
    ribbon.position.set(-9.0, 0, 0.35);
    brookGroup.add(ribbon);

    this.group.add(brookGroup);
    return mat;
  }

  private buildEastShoreBench(textureCache: PBRTextureCache): void {
    const woodPBR = textureCache.getProceduralPBR('cabinWood', 2, 1);
    const benchMat = new THREE.MeshStandardMaterial({
      map: woodPBR.map,
      roughnessMap: woodPBR.roughnessMap,
      normalMap: woodPBR.normalMap,
      color: '#9c8369',
      roughness: 0.88,
    });
    const legMat = new THREE.MeshStandardMaterial({ color: '#473c33', roughness: 0.92 });

    const bx = 8.4;
    const bz = 2.4;
    const by = this.sdf.terrainHeight(bx, bz);

    const bench = new THREE.Group();
    bench.name = 'EastShoreBench';
    bench.position.set(bx, by - 0.02, bz);
    bench.rotation.y = -Math.PI * 0.62; // Faces directly across the pond toward sunset & cabin

    // Seat planks
    for (const sz of [-0.14, 0.14]) {
      const plank = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.055, 0.22), benchMat);
      plank.position.set(0, 0.44, sz);
      plank.castShadow = true;
      plank.receiveShadow = true;
      bench.add(plank);
    }
    // Slight angled wooden backrest
    const backPlank = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.22, 0.05), benchMat);
    backPlank.position.set(0, 0.76, -0.26);
    backPlank.rotation.x = -0.18;
    backPlank.castShadow = true;
    bench.add(backPlank);

    // Timber legs anchored firmly into the bank
    for (const lx of [-0.62, 0.62]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.62, 0.46), legMat);
      leg.position.set(lx, 0.16, 0);
      leg.castShadow = true;
      bench.add(leg);

      const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.45, 0.07), legMat);
      post.position.set(lx, 0.64, -0.24);
      post.rotation.x = -0.18;
      bench.add(post);
    }
    this.group.add(bench);

    // 4 flat mossy stepping stones curving down from the bench toward the east wet shore
    const stoneMat = new THREE.MeshStandardMaterial({ color: '#5f635a', roughness: 0.88 });
    const steps = [
      { x: 7.4, z: 2.0 },
      { x: 6.7, z: 1.55 },
      { x: 6.1, z: 1.05 },
      { x: 5.55, z: 0.65 },
    ];
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 0.09, 7), stoneMat);
      disc.position.set(st.x, this.sdf.terrainHeight(st.x, st.z) + 0.01, st.z);
      disc.rotation.y = i * 0.9;
      disc.scale.set(1.15, 1, 0.85);
      disc.receiveShadow = true;
      this.group.add(disc);
    }
  }

  private buildSouthForestRing(textureCache: PBRTextureCache): void {
    // Complete the south woodland backdrop far enough back (z > 13.5m) so default shore camera stays clear
    const barkPBR = textureCache.getProceduralPBR('bark', 2, 4);
    const trunkMat = new THREE.MeshStandardMaterial({
      map: barkPBR.map,
      normalMap: barkPBR.normalMap,
      roughness: 0.92,
    });
    const pineMat = new THREE.MeshStandardMaterial({
      map: textureCache.getFoliageTexture('pine'),
      color: '#88aa89',
      alphaTest: 0.36,
      side: THREE.DoubleSide,
      roughness: 0.96,
      envMapIntensity: 0.2,
    });

    const p1 = new THREE.PlaneGeometry(1, 1);
    const p2 = new THREE.PlaneGeometry(1, 1);
    p2.rotateY(Math.PI / 2);

    for (let i = 0; i < 11; i++) {
      const x = -11.5 + (i / 10) * 23.0 + (hash2D(i, 3.7) - 0.5) * 1.8;
      const z = 14.4 + hash2D(i, 9.1) * 5.8;
      const gy = this.sdf.terrainHeight(x, z);
      const scale = 0.95 + hash2D(i, 12.4) * 0.65;

      const tree = new THREE.Group();
      tree.position.set(x, gy - 0.15, z);
      tree.scale.setScalar(scale);

      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.25, 5.1, 7), trunkMat);
      trunk.position.y = 2.55;
      trunk.castShadow = true;
      tree.add(trunk);

      for (let t = 0; t < 10; t++) {
        const frac = t / 9;
        const r = (1 - frac * 0.62) * 3.0;
        const y = 1.2 + frac * 4.15;
        const mA = new THREE.Mesh(p1, pineMat);
        mA.position.y = y;
        mA.rotation.y = t * 0.72;
        mA.scale.set(r, r * 0.82, 1);
        const mB = new THREE.Mesh(p2, pineMat);
        mB.position.y = y;
        mB.rotation.y = t * 0.72;
        mB.scale.set(r, r * 0.82, 1);
        tree.add(mA, mB);
      }
      this.group.add(tree);
    }
  }

  private buildUnderwaterFish(): void {
    const fishMat = new THREE.MeshStandardMaterial({
      color: '#3a4236',
      roughness: 0.45,
      transparent: true,
      opacity: 0.55,
    });
    const specs = [
      { cx: -3.2, cz: 0.8, rx: 1.4, rz: 0.9, spd: 0.24 },
      { cx: 2.6, cz: -1.1, rx: 1.2, rz: 0.85, spd: -0.2 },
      { cx: -1.2, cz: -2.2, rx: 1.6, rz: 0.75, spd: 0.18 },
      { cx: 1.4, cz: 1.6, rx: 1.1, rz: 0.7, spd: -0.22 },
    ];

    specs.forEach((sp, idx) => {
      const fish = new THREE.Group();
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), fishMat);
      body.scale.set(0.42, 0.65, 2.3);
      fish.add(body);

      const tail = new THREE.Mesh(new THREE.ConeGeometry(0.036, 0.085, 4), fishMat);
      tail.rotation.x = Math.PI / 2;
      tail.scale.set(0.3, 1, 1);
      tail.position.z = -0.14;
      fish.add(tail);

      fish.position.set(sp.cx, this.sdf.waterLevel - 0.18, sp.cz);
      this.group.add(fish);

      this.fishes.push({
        mesh: fish,
        centerX: sp.cx,
        centerZ: sp.cz,
        radiusX: sp.rx,
        radiusZ: sp.rz,
        speed: sp.spd,
        phase: idx * 1.9,
      });
    });
  }

  private buildDistantSkyBirds(): void {
    const birdMat = new THREE.MeshBasicMaterial({
      color: '#2b2833',
      side: THREE.DoubleSide,
    });
    const wingGeo = new THREE.PlaneGeometry(0.36, 0.11);
    wingGeo.translate(0.18, 0, 0);

    for (let i = 0; i < 2; i++) {
      const root = new THREE.Group();
      const lw = new THREE.Mesh(wingGeo, birdMat);
      const rw = new THREE.Mesh(wingGeo, birdMat);
      rw.scale.x = -1;
      root.add(lw, rw);
      this.group.add(root);

      this.birds.push({
        root,
        leftWing: lw,
        rightWing: rw,
        orbitR: 22 + i * 7,
        height: 11.5 + i * 2.8,
        speed: 0.075 + i * 0.02,
        phase: i * 3.4,
      });
    }
  }

  public update(dt: number, time: number, dayPhase: number, water: WaterSystem): void {
    this.brookMat.uniforms.uTime.value = time;
    this.brookMat.uniforms.uDayPhase.value = dayPhase;

    // Gentle continuous ripple inflow where the west forest brook enters the pond
    this.brookRippleTimer -= dt;
    if (this.brookRippleTimer <= 0) {
      this.brookRippleTimer = 0.32 + Math.random() * 0.25;
      water.injectDisturbance(
        this.brookEntryPos.x + (Math.random() - 0.5) * 0.35,
        this.brookEntryPos.y + (Math.random() - 0.5) * 0.35,
        0.13,
        0.34
      );
    }

    // Lazy underwater fish cruising beneath shallow coves
    for (const f of this.fishes) {
      const ang = time * f.speed + f.phase;
      const nx = f.centerX + Math.cos(ang) * f.radiusX;
      const nz = f.centerZ + Math.sin(ang) * f.radiusZ;
      const dx = -Math.sin(ang) * f.radiusX * f.speed;
      const dz = Math.cos(ang) * f.radiusZ * f.speed;
      f.mesh.position.set(nx, this.sdf.waterLevel - 0.18, nz);
      f.mesh.rotation.y = Math.atan2(dx, dz) + Math.sin(time * 5.2 + f.phase) * 0.07;
    }

    // Distant gliding twilight birds (quietly vanish at deep night)
    const showBirds = dayPhase < 0.68;
    for (const b of this.birds) {
      b.root.visible = showBirds;
      if (!showBirds) continue;
      const a = time * b.speed + b.phase;
      const bx = Math.cos(a) * b.orbitR;
      const bz = Math.sin(a) * b.orbitR - 6;
      b.root.position.set(bx, b.height + Math.sin(time * 0.4 + b.phase) * 0.8, bz);
      b.root.rotation.y = Math.atan2(-Math.sin(a), Math.cos(a));

      // Mostly calm soaring with occasional slow wingbeats
      const glideCycle = Math.sin(time * 0.45 + b.phase);
      const flap = glideCycle > 0.35 ? Math.sin(time * 6.5 + b.phase) * 0.42 : 0.12;
      b.leftWing.rotation.z = flap;
      b.rightWing.rotation.z = -flap;
    }
  }
}
