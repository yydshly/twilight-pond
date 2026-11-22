import * as THREE from 'three';
import { clamp, hash2D, organicDuration } from '../core/noise';
import type { PondShapeSDF } from '../modules/PondShapeSDF';
import type { WaterSystem } from '../modules/WaterSystem';

interface DragonflyAgent {
  root: THREE.Group;
  leftWings: THREE.Mesh[];
  rightWings: THREE.Mesh[];
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  target: THREE.Vector3;
  state: 'DART' | 'HOVER' | 'SKIM';
  timer: number;
  skimFired: boolean;
  phase: number;
}

interface WillowStrand {
  pivot: THREE.Group;
  baseRotZ: number;
  baseRotX: number;
  phase: number;
  flex: number;
}

/**
 * Poetic Pond Micro-Life & Pro-Grade Rain Layer:
 * - 2 twilight dragonflies that hover, dart, and lightly skim the water (spawning micro-ripples)
 * - 340 tapered translucent shader-driven rain streaks + 42 surface micro-splash crowns
 * - Graceful foreground weeping willow strands framing the upper corners
 */
export class PondMicroLife {
  public readonly group = new THREE.Group();

  private readonly dragonflies: DragonflyAgent[] = [];
  private readonly willowStrands: WillowStrand[] = [];

  private readonly rainCount = 340;
  private readonly rainMesh: THREE.InstancedMesh;
  private readonly rainMat: THREE.ShaderMaterial;
  private readonly rainSeeds: Float32Array;
  private readonly dummy = new THREE.Object3D();

  private readonly splashCount = 42;
  private readonly splashMesh: THREE.InstancedMesh;
  private readonly splashMat: THREE.ShaderMaterial;
  private readonly splashData: Float32Array; // x, z, phase, speed

  constructor(private readonly sdf: PondShapeSDF) {
    this.buildDragonflies();
    this.buildForegroundWillows();

    // 1. Tapered, silky translucent rain streaks (no harsh 1px digital lines!)
    const streakGeo = new THREE.PlaneGeometry(0.016, 0.44);
    this.rainMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uOpacity: { value: 0 },
        uColor: { value: new THREE.Color('#dfe6ee') },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying float vDepthFade;
        void main() {
          vUv = uv;
          vec4 worldPos = modelMatrix * instanceMatrix * vec4(position, 1.0);
          float dist = length(cameraPosition - worldPos.xyz);
          // Fade rain very close to lens and gently in far fog
          vDepthFade = smoothstep(2.2, 5.0, dist) * (1.0 - smoothstep(14.0, 26.0, dist));
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        uniform vec3 uColor;
        varying vec2 vUv;
        varying float vDepthFade;
        void main() {
          // Soft horizontal core + tapered teardrop head at bottom fading smoothly into misty tail
          float horiz = 1.0 - smoothstep(0.0, 0.5, abs(vUv.x - 0.5));
          float head = smoothstep(0.0, 0.14, vUv.y);
          float tail = pow(clamp(1.0 - vUv.y, 0.0, 1.0), 1.85);
          float alpha = horiz * head * tail * uOpacity * vDepthFade;
          if (alpha < 0.004) discard;
          gl_FragColor = vec4(uColor, alpha);
        }
      `,
    });

    this.rainMesh = new THREE.InstancedMesh(streakGeo, this.rainMat, this.rainCount);
    this.rainMesh.visible = false;
    this.rainMesh.frustumCulled = false;
    this.rainSeeds = new Float32Array(this.rainCount * 4);
    for (let i = 0; i < this.rainCount; i++) {
      this.rainSeeds[i * 4] = (hash2D(i, 1.3) - 0.5) * 20;
      this.rainSeeds[i * 4 + 1] = hash2D(i, 4.7) * 9.5;
      this.rainSeeds[i * 4 + 2] = (hash2D(i, 8.2) - 0.5) * 16 - 0.5;
      this.rainSeeds[i * 4 + 3] = 8.2 + hash2D(i, 12.6) * 3.6;
    }
    this.group.add(this.rainMesh);

    // 2. Delicate pond-surface micro-splash crowns where raindrops impact
    const splashGeo = new THREE.PlaneGeometry(0.11, 0.075);
    splashGeo.translate(0, 0.036, 0);
    this.splashMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uOpacity: { value: 0 },
        uColor: { value: new THREE.Color('#e6edf5') },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        uniform vec3 uColor;
        varying vec2 vUv;
        void main() {
          // Delicate crown splash arc + tiny lifted center droplet mist (strictly NaN-safe)
          vec2 p = vec2((vUv.x - 0.5) * 2.0, vUv.y);
          float dArc = length(vec2(p.x, p.y - 0.25)) - 0.45;
          float arc = exp(-(dArc * dArc) * 28.0) * smoothstep(0.0, 0.25, p.y);
          vec2 dp = p - vec2(0.0, 0.42);
          float core = exp(-dot(dp, dp) * 24.0);
          float a = clamp(arc * 0.65 + core * 0.55, 0.0, 1.0) * uOpacity;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor, a);
        }
      `,
    });

    this.splashMesh = new THREE.InstancedMesh(splashGeo, this.splashMat, this.splashCount);
    this.splashMesh.visible = false;
    this.splashMesh.frustumCulled = false;
    this.splashData = new Float32Array(this.splashCount * 4);
    for (let i = 0; i < this.splashCount; i++) {
      this.respawnSplash(i, i * 1.3);
      this.splashData[i * 4 + 2] = hash2D(i, 9.1); // staggered phase
      this.splashData[i * 4 + 3] = 3.2 + hash2D(i, 15.7) * 2.4;
    }
    this.group.add(this.splashMesh);
  }

  private respawnSplash(idx: number, seed: number): void {
    for (let tries = 0; tries < 10; tries++) {
      const rx = (hash2D(idx + tries * 13, seed + 2.1) - 0.5) * 13.0;
      const rz = (hash2D(idx + tries * 17, seed + 6.4) - 0.5) * 8.4;
      if (this.sdf.isNavigable(rx, rz, 0.55)) {
        this.splashData[idx * 4] = rx;
        this.splashData[idx * 4 + 1] = rz;
        return;
      }
    }
    this.splashData[idx * 4] = 0;
    this.splashData[idx * 4 + 1] = 0;
  }

  private buildDragonflies(): void {
    const bodyColors = ['#267d84', '#9c6c34'];
    const wingMat = new THREE.MeshBasicMaterial({
      color: '#d8e8f0',
      transparent: true,
      opacity: 0.38,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    for (let i = 0; i < 2; i++) {
      const root = new THREE.Group();
      const bodyMat = new THREE.MeshStandardMaterial({
        color: bodyColors[i],
        roughness: 0.25,
        metalness: 0.55,
      });

      const abdomen = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.007, 0.14, 6), bodyMat);
      abdomen.rotation.x = Math.PI / 2;
      abdomen.position.z = -0.05;
      root.add(abdomen);

      const thorax = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 6), bodyMat);
      thorax.scale.set(0.85, 0.9, 1.35);
      thorax.position.z = 0.025;
      root.add(thorax);

      const head = new THREE.Mesh(new THREE.SphereGeometry(0.011, 8, 6), bodyMat);
      head.position.set(0, 0.002, 0.048);
      root.add(head);

      const leftWings: THREE.Mesh[] = [];
      const rightWings: THREE.Mesh[] = [];
      const wingGeo = new THREE.PlaneGeometry(0.088, 0.02);
      wingGeo.translate(0.044, 0, 0);

      for (const wz of [0.032, 0.016]) {
        const lw = new THREE.Mesh(wingGeo, wingMat);
        lw.position.set(0.006, 0.008, wz);
        lw.rotation.y = wz > 0.02 ? 0.08 : -0.14;
        root.add(lw);
        leftWings.push(lw);

        const rw = new THREE.Mesh(wingGeo, wingMat);
        rw.position.set(-0.006, 0.008, wz);
        rw.scale.x = -1;
        rw.rotation.y = wz > 0.02 ? -0.08 : 0.14;
        root.add(rw);
        rightWings.push(rw);
      }

      const startPos = new THREE.Vector3(i === 0 ? -2.2 : 2.1, 0.85, i === 0 ? -1.4 : -0.8);
      root.position.copy(startPos);
      this.group.add(root);

      this.dragonflies.push({
        root,
        leftWings,
        rightWings,
        pos: startPos,
        vel: new THREE.Vector3(),
        target: startPos.clone().add(new THREE.Vector3(0.6, 0.1, 0.4)),
        state: 'HOVER',
        timer: 2.0 + i * 2.5,
        skimFired: false,
        phase: i * 3.1,
      });
    }
  }

  private buildForegroundWillows(): void {
    // Grounded lakeside weeping willow rooted solidly on the near-right bank (never floating when orbiting!)
    const barkMat = new THREE.MeshStandardMaterial({ color: '#5c4e41', roughness: 0.94 });
    const twigMat = new THREE.MeshStandardMaterial({ color: '#4f5a38', roughness: 0.92 });
    const leafMat = new THREE.MeshStandardMaterial({
      color: '#5a7344',
      roughness: 0.9,
      side: THREE.DoubleSide,
    });

    const wx = 7.8;
    const wz = 5.2;
    const wy = this.sdf.terrainHeight(wx, wz);

    const willowTree = new THREE.Group();
    willowTree.name = 'GroundedLakesideWillow';
    willowTree.position.set(wx, wy - 0.12, wz);

    // Gently leaning gnarled willow trunk rooted firmly into the bank
    const trunkCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, -0.2, 0),
      new THREE.Vector3(-0.35, 1.35, -0.15),
      new THREE.Vector3(-0.85, 2.75, -0.35),
      new THREE.Vector3(-1.35, 3.65, -0.5),
    ]);
    const trunkMesh = new THREE.Mesh(new THREE.TubeGeometry(trunkCurve, 12, 0.2, 8, false), barkMat);
    trunkMesh.castShadow = true;
    trunkMesh.receiveShadow = true;
    willowTree.add(trunkMesh);

    // Tapered slender willow leaf geometry
    const leafGeo = new THREE.PlaneGeometry(0.028, 0.18, 1, 2);
    const lPos = leafGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < lPos.count; i++) {
      const y = lPos.getY(i);
      const pinch = Math.abs(y) > 0.065 ? 0.14 : 1.0;
      lPos.setX(i, lPos.getX(i) * pinch);
    }
    leafGeo.computeVertexNormals();

    // 3 overarching real curved willow boughs extending toward the pond edge, with fronds hanging directly from them
    const boughSpecs = [
      [
        new THREE.Vector3(-0.85, 2.75, -0.35),
        new THREE.Vector3(-2.1, 3.65, -0.65),
        new THREE.Vector3(-3.35, 3.48, -0.85),
      ],
      [
        new THREE.Vector3(-1.15, 3.3, -0.45),
        new THREE.Vector3(-2.45, 4.15, -0.2),
        new THREE.Vector3(-3.65, 3.92, 0.15),
      ],
      [
        new THREE.Vector3(-1.05, 3.1, -0.4),
        new THREE.Vector3(-1.95, 3.85, -1.45),
        new THREE.Vector3(-2.85, 3.55, -2.25),
      ],
    ];

    let strandIdx = 0;
    for (const pts of boughSpecs) {
      const bCurve = new THREE.CatmullRomCurve3(pts);
      const bMesh = new THREE.Mesh(new THREE.TubeGeometry(bCurve, 10, 0.075, 6, false), barkMat);
      bMesh.castShadow = true;
      willowTree.add(bMesh);

      // Attach drooping willow fronds directly onto actual points along each curved bough
      for (let k = 0; k < 5; k++) {
        const t = 0.34 + (k / 4) * 0.64;
        const anchor = bCurve.getPoint(t);
        const len = 1.25 + ((strandIdx * 37) % 10) * 0.08;

        const pivot = new THREE.Group();
        pivot.position.copy(anchor);

        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.009, len, 5), twigMat);
        stem.position.y = -len * 0.5;
        pivot.add(stem);

        const leafPairs = Math.floor(len * 8.5);
        for (let lp = 0; lp < leafPairs; lp++) {
          const lt = (lp + 0.5) / leafPairs;
          const ly = -lt * len;
          for (const side of [-1, 1]) {
            const leaf = new THREE.Mesh(leafGeo, leafMat);
            leaf.position.set(side * 0.036, ly, (lp % 2 ? 1 : -1) * 0.014);
            leaf.rotation.set(0.2, side * 0.52 + lp * 0.38, side * 0.38);
            pivot.add(leaf);
          }
        }

        willowTree.add(pivot);
        this.willowStrands.push({
          pivot,
          baseRotZ: 0,
          baseRotX: 0,
          phase: strandIdx * 1.25,
          flex: 0.72 + (strandIdx % 3) * 0.22,
        });
        strandIdx++;
      }
    }

    this.group.add(willowTree);
  }

  public update(
    dt: number,
    time: number,
    dayPhase: number,
    windStrength: number,
    rainIntensity: number,
    water: WaterSystem
  ): void {
    this.updateWillows(time, windStrength);
    this.updateDragonflies(dt, time, dayPhase, rainIntensity, water);
    this.updateRain(dt, time, dayPhase, windStrength, rainIntensity);
  }

  private updateWillows(time: number, windStrength: number): void {
    const swayAmp = 0.045 + windStrength * 0.24;
    const speed = 1.15 + windStrength * 1.35;
    for (const s of this.willowStrands) {
      const gust =
        Math.sin(time * speed + s.phase) * 0.7 +
        Math.sin(time * speed * 1.85 + s.phase * 1.7) * 0.3;
      s.pivot.rotation.z = s.baseRotZ + (gust + windStrength * 0.55) * swayAmp * s.flex;
      s.pivot.rotation.x = s.baseRotX + Math.cos(time * speed * 0.8 + s.phase) * swayAmp * 0.4;
    }
  }

  private updateDragonflies(
    dt: number,
    time: number,
    dayPhase: number,
    rainIntensity: number,
    water: WaterSystem
  ): void {
    const active = dayPhase < 0.62 && rainIntensity < 0.42;

    for (const d of this.dragonflies) {
      d.timer -= dt;
      if (!active) {
        d.target.set(d.pos.x, 4.8, -6.5);
      } else if (d.timer <= 0) {
        const roll = Math.random();
        if (roll < 0.34) {
          const rx = (Math.random() - 0.5) * 6.8;
          const rz = -2.8 + Math.random() * 4.4;
          if (this.sdf.isNavigable(rx, rz, 1.0)) {
            d.state = 'SKIM';
            d.target.set(rx, this.sdf.waterLevel + 0.07, rz);
            d.timer = 2.4;
            d.skimFired = false;
          } else {
            d.state = 'HOVER';
            d.timer = organicDuration(1.5, 3.2);
          }
        } else if (roll < 0.68) {
          d.state = 'DART';
          d.target.set(
            (Math.random() - 0.5) * 7.6,
            0.48 + Math.random() * 0.95,
            -3.4 + Math.random() * 5.2
          );
          d.timer = organicDuration(1.8, 3.8);
        } else {
          d.state = 'HOVER';
          d.target.copy(d.pos);
          d.target.y = clamp(d.target.y, 0.45, 1.25);
          d.timer = organicDuration(1.6, 4.2);
        }
      }

      const toTarget = d.target.clone().sub(d.pos);
      const dist = toTarget.length();
      const maxSpeed = d.state === 'DART' ? 2.6 : d.state === 'SKIM' ? 1.9 : 0.45;

      if (dist > 0.04) {
        const desiredVel = toTarget.normalize().multiplyScalar(Math.min(maxSpeed, dist * 2.8));
        d.vel.lerp(desiredVel, 1 - Math.exp(-dt * 4.2));
      } else {
        d.vel.multiplyScalar(Math.exp(-dt * 5.0));
      }

      d.pos.addScaledVector(d.vel, dt);
      const hoverJitterY = Math.sin(time * 4.6 + d.phase) * 0.025;
      d.root.position.set(d.pos.x, d.pos.y + hoverJitterY, d.pos.z);

      if (active && d.state === 'SKIM' && !d.skimFired && d.pos.y < this.sdf.waterLevel + 0.14) {
        d.skimFired = true;
        water.injectDisturbance(d.pos.x, d.pos.z, 0.19, 0.25);
        d.state = 'DART';
        d.target.set(
          d.pos.x + (Math.random() - 0.5) * 2.2,
          0.85,
          d.pos.z + (Math.random() - 0.5) * 1.8
        );
        d.timer = 1.6;
      }

      const horizSpeed = Math.hypot(d.vel.x, d.vel.z);
      if (horizSpeed > 0.08) {
        d.root.rotation.y = Math.atan2(d.vel.x, d.vel.z);
      }

      const beat = Math.sin(time * 68 + d.phase) * 0.48;
      for (const lw of d.leftWings) lw.rotation.z = beat;
      for (const rw of d.rightWings) rw.rotation.z = -beat;

      d.root.visible = d.pos.y < 4.2;
    }
  }

  private updateRain(
    dt: number,
    time: number,
    dayPhase: number,
    windStrength: number,
    rainIntensity: number
  ): void {
    const active = rainIntensity > 0.015;
    this.rainMesh.visible = active;
    this.splashMesh.visible = active;
    if (!active) return;

    this.rainMat.uniforms.uOpacity.value = rainIntensity * 0.26;
    this.rainMat.uniforms.uColor.value.set('#ecdcd4').lerp(new THREE.Color('#a4bdd6'), dayPhase);

    this.splashMat.uniforms.uOpacity.value = rainIntensity * 0.34;
    this.splashMat.uniforms.uColor.value.set('#f0e2da').lerp(new THREE.Color('#b4cce4'), dayPhase);

    const windSlantAngle = -(0.06 + windStrength * 0.24);
    const windDriftX = (0.35 + windStrength * 1.65) * dt;

    for (let i = 0; i < this.rainCount; i++) {
      const sIdx = i * 4;
      let x = this.rainSeeds[sIdx];
      let y = this.rainSeeds[sIdx + 1];
      let z = this.rainSeeds[sIdx + 2];
      const speed = this.rainSeeds[sIdx + 3];

      y -= speed * dt;
      x += windDriftX * speed * 0.14;

      if (y < -0.1) {
        y = 8.4 + (i % 6) * 0.32;
        x = (hash2D(i, Math.floor(time * 2) + 1.3) - 0.5) * 20;
        z = (hash2D(i, Math.floor(time * 2) + 8.2) - 0.5) * 16 - 0.5;
      }

      this.rainSeeds[sIdx] = x;
      this.rainSeeds[sIdx + 1] = y;
      this.rainSeeds[sIdx + 2] = z;

      this.dummy.position.set(x, y, z);
      this.dummy.rotation.set(0, 0, windSlantAngle);
      this.dummy.scale.set(1, 0.75 + (speed / 12) * 0.65, 1);
      this.dummy.updateMatrix();
      this.rainMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.rainMesh.instanceMatrix.needsUpdate = true;

    // Update delicate pond-surface raindrop splash crowns
    for (let i = 0; i < this.splashCount; i++) {
      const idx = i * 4;
      let phase = this.splashData[idx + 2] + dt * this.splashData[idx + 3];
      if (phase >= 1.0) {
        phase -= 1.0;
        this.respawnSplash(i, time + i * 0.7);
      }
      this.splashData[idx + 2] = phase;

      const pop = Math.sin(phase * Math.PI); // quick rise & fade
      const sx = 0.55 + phase * 0.95;
      const sy = pop * 1.15;
      this.dummy.position.set(
        this.splashData[idx],
        this.sdf.waterLevel + 0.008,
        this.splashData[idx + 1]
      );
      this.dummy.rotation.set(0, (i % 5) * 0.35 - 0.7, 0);
      this.dummy.scale.set(sx, Math.max(0.001, sy), 1);
      this.dummy.updateMatrix();
      this.splashMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.splashMesh.instanceMatrix.needsUpdate = true;
  }
}
