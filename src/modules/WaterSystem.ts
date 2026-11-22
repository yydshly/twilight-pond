import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../core/noise';
import type { PondShapeSDF } from './PondShapeSDF';

export interface WaterSample {
  height: number;
  nx: number;
  ny: number;
  nz: number;
  shoreDist: number;
  depth: number;
  rippleEnergy: number;
}

/**
 * Reusable Module 2: WaterSystem & Sampler (水面与采样)
 * - Decoupled from pond silhouette via PondShapeSDF
 * - 144x144 damped 2D wave-equation solver for unified click ripples & duck V-wakes
 * - Synchronized CPU WaterSampler so the duck floats, pitches, rolls, and feels incoming ripples
 * - Real-time Planar Reflection pass capturing twilight sky, forest trees, glowing cabin, and duck
 */
export class WaterSystem {
  public readonly mesh: THREE.Mesh;
  public readonly sdf: PondShapeSDF;

  private readonly gridSize = 144;
  private readonly simExtent: number;
  private readonly cellSize: number;

  private prevH: Float32Array;
  private currH: Float32Array;
  private nextH: Float32Array;
  private readonly shoreDampingMask: Float32Array;
  private readonly packedPixels: Uint8Array<ArrayBuffer>;
  private readonly waveTexture: THREE.DataTexture;

  private readonly reflectionTarget: THREE.WebGLRenderTarget;
  private readonly reflectionCamera = new THREE.PerspectiveCamera();
  private readonly clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.025);

  private readonly material: THREE.ShaderMaterial;
  private simAccumulator = 0;
  private lastWakeEnergy = 0;
  private ambientRippleTimer = 2.8;

  constructor(sdf: PondShapeSDF, waterNormalMap: THREE.Texture) {
    this.sdf = sdf;
    this.simExtent = sdf.worldHalfExtent;
    this.cellSize = (this.simExtent * 2) / (this.gridSize - 1);

    const total = this.gridSize * this.gridSize;
    this.prevH = new Float32Array(total);
    this.currH = new Float32Array(total);
    this.nextH = new Float32Array(total);
    this.shoreDampingMask = new Float32Array(total);
    this.packedPixels = new Uint8Array(total * 4);

    // Precompute shoreline damping mask so ripples absorb softly against wet mud shores
    for (let j = 0; j < this.gridSize; j++) {
      const wz = -this.simExtent + j * this.cellSize;
      for (let i = 0; i < this.gridSize; i++) {
        const wx = -this.simExtent + i * this.cellSize;
        const sd = sdf.signedDistance(wx, wz);
        // 1.0 in open water, fades smoothly to 0.0 slightly past the shore
        const open = smoothstep(0.45, -0.75, sd);
        this.shoreDampingMask[j * this.gridSize + i] = open;
      }
    }

    this.waveTexture = new THREE.DataTexture(
      this.packedPixels,
      this.gridSize,
      this.gridSize,
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    );
    this.waveTexture.magFilter = THREE.LinearFilter;
    this.waveTexture.minFilter = THREE.LinearFilter;
    this.waveTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.waveTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.waveTexture.needsUpdate = true;

    this.reflectionTarget = new THREE.WebGLRenderTarget(640, 360, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType,
      depthBuffer: true,
    });

    // Bake pond depth + shoreline distance into water mesh vertex attributes for clean shore feathering
    const geo = new THREE.PlaneGeometry(this.simExtent * 2, this.simExtent * 2, 128, 128);
    geo.rotateX(-Math.PI / 2);
    const posAttr = geo.attributes.position as THREE.BufferAttribute;
    const depthArray = new Float32Array(posAttr.count);
    const shoreArray = new Float32Array(posAttr.count);

    for (let k = 0; k < posAttr.count; k++) {
      const wx = posAttr.getX(k);
      const wz = posAttr.getZ(k);
      depthArray[k] = sdf.waterDepth(wx, wz);
      shoreArray[k] = sdf.signedDistance(wx, wz);
    }
    geo.setAttribute('aDepth', new THREE.BufferAttribute(depthArray, 1));
    geo.setAttribute('aShoreDist', new THREE.BufferAttribute(shoreArray, 1));

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: true,
      uniforms: {
        uTime: { value: 0 },
        uWindStrength: { value: 0.28 },
        uDayPhase: { value: 0.12 },
        uRainIntensity: { value: 0.0 },
        uSimExtent: { value: this.simExtent },
        uWaveMap: { value: this.waveTexture },
        uWaterNormalMap: { value: waterNormalMap },
        uReflectionMap: { value: this.reflectionTarget.texture },
        uResolution: { value: new THREE.Vector2(1280, 720) },
        uSunDir: { value: new THREE.Vector3(-0.55, 0.24, -0.8).normalize() },
        uSunColor: { value: new THREE.Color('#ffb87a') },
        uShallowColor: { value: new THREE.Color('#27322a') },
        uDeepColor: { value: new THREE.Color('#0e1c24') },
        uSkyTint: { value: new THREE.Color('#7a6875') },
        uFogColor: { value: new THREE.Color('#2c2d3a') },
        uFogDensity: { value: 0.022 },
      },
      vertexShader: /* glsl */ `
        attribute float aDepth;
        attribute float aShoreDist;

        uniform float uTime;
        uniform float uWindStrength;
        uniform float uSimExtent;
        uniform sampler2D uWaveMap;

        varying vec3 vWorldPos;
        varying float vDepth;
        varying float vShoreDist;
        varying vec2 vSimUv;

        float ambientWaveHeight(vec2 p, float t, float wind) {
          float amp = mix(0.005, 0.024, wind);
          float speed = mix(0.75, 1.55, wind);
          float w1 = sin(p.x * 1.15 + p.y * 0.72 + t * 1.10 * speed) * 0.45;
          float w2 = sin(p.x * -0.85 + p.y * 1.48 - t * 0.92 * speed) * 0.35;
          float w3 = sin(p.x * 2.15 - p.y * 1.75 + t * 1.65 * speed) * 0.20;
          return (w1 + w2 + w3) * amp;
        }

        void main() {
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vec2 simUv = (worldPos.xz / (uSimExtent * 2.0)) + 0.5;
          vSimUv = simUv;

          float waveSample = (texture2D(uWaveMap, clamp(simUv, 0.001, 0.999)).r - 0.5) * 0.24;
          float shoreAtten = smoothstep(0.05, -0.8, aShoreDist);
          float h = (ambientWaveHeight(worldPos.xz, uTime, uWindStrength) + waveSample) * shoreAtten;

          worldPos.y += h;
          vWorldPos = worldPos.xyz;
          vDepth = aDepth;
          vShoreDist = aShoreDist;

          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uWindStrength;
        uniform float uDayPhase;
        uniform float uRainIntensity;
        uniform sampler2D uWaveMap;
        uniform sampler2D uWaterNormalMap;
        uniform sampler2D uReflectionMap;
        uniform vec2 uResolution;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uShallowColor;
        uniform vec3 uDeepColor;
        uniform vec3 uSkyTint;
        uniform vec3 uFogColor;
        uniform float uFogDensity;

        varying vec3 vWorldPos;
        varying float vDepth;
        varying float vShoreDist;
        varying vec2 vSimUv;

        // Dual counter-drifting tileable organic normal maps (zero artificial sine stripes!)
        vec2 organicRippleSlope(vec2 p, float t, float wind) {
          float speed = mix(0.018, 0.058, wind);
          float strength = mix(0.035, 0.145, wind);

          vec2 uvA = p * 0.19 + vec2(t * speed, t * speed * 0.62);
          vec2 uvB = p * 0.34 + vec2(-t * speed * 0.85, t * speed * 1.15);
          vec2 uvC = p * 0.68 + vec2(t * speed * 1.35, -t * speed * 0.95);

          vec2 nA = (texture2D(uWaterNormalMap, uvA).rg - 0.5) * 2.0;
          vec2 nB = (texture2D(uWaterNormalMap, uvB).rg - 0.5) * 2.0;
          vec2 nC = (texture2D(uWaterNormalMap, uvC).rg - 0.5) * 2.0;

          return (nA * 0.52 + nB * 0.34 + nC * (0.14 + 0.18 * wind)) * strength;
        }

        vec2 hash22(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.xx + p3.yz) * p3.zy);
        }

        // AAA-grade crisp per-pixel expanding concentric raindrop ring normals + impact sparkle
        vec3 rainRippleLayer(vec2 p, float t, float scale) {
          vec2 uv = p * scale;
          vec2 cell = floor(uv);
          vec2 local = fract(uv);
          vec2 slope = vec2(0.0);
          float crest = 0.0;

          for (int j = -1; j <= 1; j++) {
            for (int i = -1; i <= 1; i++) {
              vec2 neighbor = vec2(float(i), float(j));
              vec2 id = cell + neighbor;
              vec2 rnd = hash22(id);
              float life = fract(t * (0.58 + rnd.x * 0.45) + rnd.y * 6.2831);
              vec2 center = neighbor + 0.18 + 0.64 * rnd;
              vec2 diff = local - center;
              float dist = length(diff) + 1e-4;

              float radius = life * 0.46;
              float band = dist - radius;
              float env = exp(-band * band * 260.0) * (1.0 - life) * smoothstep(0.0, 0.06, life);
              float wave = sin(band * 56.0);
              float dWave = cos(band * 56.0);
              slope += (diff / dist) * dWave * env;
              crest += max(0.0, wave) * env;
            }
          }
          return vec3(slope, crest);
        }

        void main() {
          if (vShoreDist > 0.35) discard;

          vec4 sim = texture2D(uWaveMap, clamp(vSimUv, 0.001, 0.999));
          vec2 wakeSlope = (sim.gb - 0.5) * 2.0 * 1.15;
          float wakeFoam = sim.a;

          vec2 windSlope = organicRippleSlope(vWorldPos.xz, uTime, uWindStrength);
          float shoreDamp = smoothstep(0.12, -0.55, vShoreDist);

          vec2 rainSlope = vec2(0.0);
          float rainCrest = 0.0;
          if (uRainIntensity > 0.01) {
            vec3 r1 = rainRippleLayer(vWorldPos.xz, uTime, 1.55);
            vec3 r2 = rainRippleLayer(vWorldPos.xz + vec2(4.7, 2.3), uTime * 1.18 + 1.9, 2.65);
            float rainFade = uRainIntensity * (1.0 - smoothstep(10.0, 22.0, length(cameraPosition - vWorldPos)));
            rainSlope = (r1.xy * 0.62 + r2.xy * 0.46) * 0.24 * rainFade;
            rainCrest = (r1.z * 0.65 + r2.z * 0.5) * rainFade;
          }

          vec2 totalSlope = (windSlope + wakeSlope + rainSlope) * (0.32 + 0.68 * shoreDamp);

          vec3 N = normalize(vec3(-totalSlope.x, 1.0, -totalSlope.y));
          vec3 V = normalize(cameraPosition - vWorldPos);

          // Planar reflection lookup with organic ripple distortion
          vec2 screenUv = gl_FragCoord.xy / max(uResolution, vec2(1.0));
          float distortScale = mix(0.042, 0.088, uWindStrength);
          vec2 reflUv = vec2(screenUv.x, 1.0 - screenUv.y) + vec2(N.x * distortScale, N.z * distortScale * 1.45);
          reflUv = clamp(reflUv, vec2(0.004), vec2(0.996));

          float blurOff = mix(0.001, 0.0045, uWindStrength);
          vec3 refl = texture2D(uReflectionMap, reflUv).rgb * 0.5
            + texture2D(uReflectionMap, clamp(reflUv + vec2(blurOff, blurOff * 0.6), 0.004, 0.996)).rgb * 0.25
            + texture2D(uReflectionMap, clamp(reflUv - vec2(blurOff, -blurOff * 0.6), 0.004, 0.996)).rgb * 0.25;

          // Beer-Lambert depth absorption: shallow shoreline reveals warm silty olive, deeper pond shifts to slate-teal
          float depthT = 1.0 - exp(-vDepth * 1.35);
          vec3 waterBody = mix(uShallowColor, uDeepColor, clamp(depthT, 0.0, 1.0));

          // Physical Schlick Fresnel (F0 = 0.02 for water) boosted gently for atmospheric sky bounce
          float cosTheta = clamp(dot(N, V), 0.0, 1.0);
          float oneMinusCos = max(0.0, 1.0 - cosTheta);
          float schlick = 0.02 + 0.98 * pow(oneMinusCos, 5.0);
          float fresnel = clamp(schlick * 1.15 + 0.16, 0.18, 0.96);

          // True linear pond absorption colors (OutputPass handles ACESFilmic + sRGB)
          vec3 reflColor = refl * 0.86 + uSkyTint * 0.025;
          vec3 color = mix(waterBody, reflColor, fresnel);

          // Soft sun / moon glitter path across wave facets (smoothly faded near shallow bank)
          float sparkleShoreFade = smoothstep(0.0, -1.15, vShoreDist);
          vec3 L = normalize(uSunDir);
          vec3 H = normalize(L + V);
          float specBroad = pow(max(dot(N, H), 0.0), mix(64.0, 28.0, uWindStrength)) * 0.22;
          float specSparkle = pow(max(dot(N, H), 0.0), mix(340.0, 130.0, uWindStrength)) * mix(1.02, 0.72, uDayPhase);
          color += uSunColor * (specBroad + specSparkle) * sparkleShoreFade;

          // Delicate translucent highlight along duck V-wake, click ripples, and crisp raindrop rings
          float rippleCrest = smoothstep(0.09, 0.68, wakeFoam) * shoreDamp;
          vec3 wakeHighlightColor = mix(vec3(0.98, 0.91, 0.84), vec3(0.72, 0.84, 0.96), uDayPhase);
          color = mix(color, wakeHighlightColor, rippleCrest * 0.24);
          color += mix(vec3(0.32, 0.30, 0.32), vec3(0.18, 0.25, 0.34), uDayPhase) * rainCrest * 0.28 * shoreDamp;

          // True shallow-water shoreline transparency with smooth feathering (no faceted edge stepping)
          float shoreAlpha = smoothstep(0.0, -0.42, vShoreDist);
          float depthAlpha = 1.0 - exp(-vDepth * 3.4);
          float alpha = clamp(shoreAlpha * mix(0.45, 0.97, depthAlpha), 0.0, 0.97);

          float dist = length(cameraPosition - vWorldPos);
          float fogDist = dist * uFogDensity;
          float fogFactor = 1.0 - exp(-(fogDist * fogDist));
          color = mix(color, uFogColor, clamp(fogFactor, 0.0, 1.0));

          gl_FragColor = vec4(color, alpha);
        }
      `,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.y = sdf.waterLevel;
    this.mesh.name = 'TwilightPondWater';
    this.mesh.renderOrder = 2;
  }

  public setSize(width: number, height: number, dpr: number): void {
    this.material.uniforms.uResolution.value.set(width * dpr, height * dpr);
    const rw = clamp(Math.round(width * 0.5), 320, 800);
    const rh = clamp(Math.round(height * 0.5), 180, 480);
    this.reflectionTarget.setSize(rw, rh);
  }

  /**
   * Injects a localized disturbance into the pond's 2D wave solver.
   * Shared by user water clicks AND duck swimming/turning wakes so visual language is unified.
   */
  public injectDisturbance(
    worldX: number,
    worldZ: number,
    strength: number,
    radiusMeters = 0.45
  ): void {
    const u = (worldX + this.simExtent) / (this.simExtent * 2);
    const v = (worldZ + this.simExtent) / (this.simExtent * 2);
    if (u < 0.02 || u > 0.98 || v < 0.02 || v > 0.98) return;

    const cx = Math.round(u * (this.gridSize - 1));
    const cz = Math.round(v * (this.gridSize - 1));
    const rCells = Math.max(1, Math.ceil(radiusMeters / this.cellSize));

    for (let dz = -rCells; dz <= rCells; dz++) {
      const gz = cz + dz;
      if (gz <= 1 || gz >= this.gridSize - 2) continue;
      for (let dx = -rCells; dx <= rCells; dx++) {
        const gx = cx + dx;
        if (gx <= 1 || gx >= this.gridSize - 2) continue;
        const dist = Math.hypot(dx * this.cellSize, dz * this.cellSize);
        if (dist > radiusMeters) continue;
        const falloff = Math.cos((dist / radiusMeters) * Math.PI * 0.5);
        const idx = gz * this.gridSize + gx;
        const mask = this.shoreDampingMask[idx];
        this.currH[idx] = clamp(
          this.currH[idx] + strength * falloff * falloff * mask,
          -1.0,
          1.0
        );
      }
    }
  }

  /**
   * Duck -> Water coupling: injects a natural bow wave + twin Kelvin V-wake impulses
   * when moving, or a soft circular breathing ring when idling/turning.
   */
  public injectDuckWake(
    x: number,
    z: number,
    heading: number,
    speed: number,
    angularVelocity: number,
    time: number
  ): void {
    const fwdX = Math.sin(heading);
    const fwdZ = Math.cos(heading);
    const rightX = Math.cos(heading);
    const rightZ = -Math.sin(heading);

    const turnEnergy = Math.min(1, Math.abs(angularVelocity) * 0.7);
    const moveEnergy = clamp(speed / 1.15, 0, 1);
    this.lastWakeEnergy = Math.max(moveEnergy, turnEnergy * 0.55);

    if (speed > 0.06) {
      // Gentle bow push ahead of chest
      this.injectDisturbance(
        x + fwdX * 0.24,
        z + fwdZ * 0.24,
        0.095 * moveEnergy,
        0.3
      );
      // Crisp trailing V-wake behind stern
      this.injectDisturbance(
        x - fwdX * 0.26,
        z - fwdZ * 0.26,
        -0.115 * moveEnergy,
        0.36
      );
      const sideOffset = 0.22;
      this.injectDisturbance(
        x - fwdX * 0.14 + rightX * sideOffset,
        z - fwdZ * 0.14 + rightZ * sideOffset,
        0.055 * moveEnergy,
        0.28
      );
      this.injectDisturbance(
        x - fwdX * 0.14 - rightX * sideOffset,
        z - fwdZ * 0.14 - rightZ * sideOffset,
        0.055 * moveEnergy,
        0.28
      );
    } else {
      // Ultra-delicate living ring around idling duck (never a heavy grey halo)
      const idlePulse = Math.sin(time * 1.9) * 0.007 + turnEnergy * 0.032;
      this.injectDisturbance(x, z, idlePulse, 0.34);
    }
  }

  public getLastWakeEnergy(): number {
    return this.lastWakeEnergy;
  }

  /**
   * Water -> Duck sampling (CPU-synchronized with GPU shader + live 2D ripple/wake field).
   */
  public sample(x: number, z: number, time: number, windStrength: number): WaterSample {
    const shoreDist = this.sdf.signedDistance(x, z);
    const depth = this.sdf.waterDepth(x, z);
    const shoreAtten = smoothstep(0.05, -0.8, shoreDist);

    const amp = lerp(0.005, 0.024, windStrength);
    const speed = lerp(0.75, 1.55, windStrength);

    const p1 = x * 1.15 + z * 0.72 + time * 1.10 * speed;
    const p2 = x * -0.85 + z * 1.48 - time * 0.92 * speed;
    const p3 = x * 2.15 - z * 1.75 + time * 1.65 * speed;

    const ambH = (Math.sin(p1) * 0.45 + Math.sin(p2) * 0.35 + Math.sin(p3) * 0.20) * amp;
    const ambDx =
      (Math.cos(p1) * 1.15 * 0.45 + Math.cos(p2) * -0.85 * 0.35 + Math.cos(p3) * 2.15 * 0.20) * amp;
    const ambDz =
      (Math.cos(p1) * 0.72 * 0.45 + Math.cos(p2) * 1.48 * 0.35 + Math.cos(p3) * -1.75 * 0.20) * amp;

    // Sample live 2D wavefield so click ripples physically bob & tilt the duck
    const gridWave = this.sampleWaveGrid(x, z);
    const totalH = this.sdf.waterLevel + (ambH + gridWave.h * 0.14) * shoreAtten;
    const slopeX = (ambDx + gridWave.dx * 0.32) * shoreAtten;
    const slopeZ = (ambDz + gridWave.dz * 0.32) * shoreAtten;

    const invLen = 1 / Math.sqrt(slopeX * slopeX + 1 + slopeZ * slopeZ);
    return {
      height: totalH,
      nx: -slopeX * invLen,
      ny: invLen,
      nz: -slopeZ * invLen,
      shoreDist,
      depth,
      rippleEnergy: Math.abs(gridWave.h),
    };
  }

  public update(
    dt: number,
    time: number,
    dayPhase: number,
    windStrength: number,
    envLighting: {
      sunDir: THREE.Vector3;
      sunColor: THREE.Color;
      fogColor: THREE.Color;
      fogDensity: number;
      skyTint: THREE.Color;
    },
    rainIntensity = 0
  ): void {
    // Fixed 60Hz sub-step for rock-solid wave propagation stability
    const fixedStep = 1 / 60;
    this.simAccumulator = Math.min(this.simAccumulator + dt, 0.08);
    let stepped = false;
    while (this.simAccumulator >= fixedStep) {
      this.stepWaveSimulation(windStrength);
      this.simAccumulator -= fixedStep;
      stepped = true;
    }
    if (stepped) {
      this.uploadWaveTexture();
    }

    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uWindStrength.value = windStrength;
    u.uDayPhase.value = dayPhase;
    u.uRainIntensity.value = rainIntensity;
    u.uSunDir.value.copy(envLighting.sunDir);
    u.uSunColor.value.copy(envLighting.sunColor);
    u.uFogColor.value.copy(envLighting.fogColor);
    u.uFogDensity.value = envLighting.fogDensity;
    u.uSkyTint.value.copy(envLighting.skyTint);

    // Occasional delicate natural micro-ripples (falling leaf / water strider dimple)
    this.ambientRippleTimer -= dt;
    if (this.ambientRippleTimer <= 0) {
      this.ambientRippleTimer = 2.6 + Math.random() * 4.5;
      const rx = (Math.random() - 0.5) * 11.5;
      const rz = (Math.random() - 0.5) * 7.5;
      if (this.sdf.isNavigable(rx, rz, 0.85)) {
        this.injectDisturbance(rx, rz, 0.14 + Math.random() * 0.08, 0.32);
      }
    }

    // True linear pond absorption colors (for HDR EffectComposer + OutputPass sRGB encoding)
    u.uShallowColor.value.setRGB(
      lerp(0.048, 0.014, dayPhase),
      lerp(0.062, 0.024, dayPhase),
      lerp(0.042, 0.034, dayPhase)
    );
    u.uDeepColor.value.setRGB(
      lerp(0.008, 0.004, dayPhase),
      lerp(0.024, 0.011, dayPhase),
      lerp(0.036, 0.022, dayPhase)
    );
  }

  /**
   * Renders real-time planar reflection into the offscreen target before the main camera render.
   */
  public renderReflection(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    mainCamera: THREE.PerspectiveCamera
  ): void {
    const cam = this.reflectionCamera;
    cam.fov = mainCamera.fov;
    cam.aspect = mainCamera.aspect;
    cam.near = mainCamera.near;
    cam.far = mainCamera.far;
    cam.updateProjectionMatrix();

    // Mirror camera position & look direction across y = waterLevel while preserving up = (0, 1, 0)
    const waterY = this.sdf.waterLevel;
    cam.position.set(
      mainCamera.position.x,
      2 * waterY - mainCamera.position.y,
      mainCamera.position.z
    );

    const lookDir = new THREE.Vector3(0, 0, -1).applyQuaternion(mainCamera.quaternion);
    const target = mainCamera.position.clone().add(lookDir);
    const mirroredTarget = new THREE.Vector3(target.x, 2 * waterY - target.y, target.z);
    cam.up.set(0, 1, 0);
    cam.lookAt(mirroredTarget);
    cam.updateMatrixWorld();

    const prevTarget = renderer.getRenderTarget();
    const prevClipPlanes = renderer.clippingPlanes;
    this.mesh.visible = false;

    renderer.clippingPlanes = [this.clipPlane];
    renderer.setRenderTarget(this.reflectionTarget);
    renderer.clear();
    renderer.render(scene, cam);

    renderer.clippingPlanes = prevClipPlanes;
    renderer.setRenderTarget(prevTarget);
    this.mesh.visible = true;
  }

  private stepWaveSimulation(windStrength: number): void {
    const N = this.gridSize;
    const prev = this.prevH;
    const curr = this.currH;
    const next = this.nextH;
    const mask = this.shoreDampingMask;

    // Slightly faster dissipation when wind chops the surface
    const baseDamping = lerp(0.986, 0.978, windStrength);
    const c2 = 0.21; // Courant-stable wave speed squared (< 0.25)

    for (let j = 1; j < N - 1; j++) {
      const row = j * N;
      for (let i = 1; i < N - 1; i++) {
        const idx = row + i;
        const m = mask[idx];
        if (m < 0.002) {
          next[idx] = 0;
          continue;
        }
        const lap =
          curr[idx - 1] + curr[idx + 1] + curr[idx - N] + curr[idx + N] - 4 * curr[idx];
        const damp = baseDamping * (0.86 + 0.14 * m);
        next[idx] = clamp((2 * curr[idx] - prev[idx] + c2 * lap) * damp, -1.0, 1.0);
      }
    }

    // Rotate buffers without allocations
    this.prevH = curr;
    this.currH = next;
    this.nextH = prev;
  }

  private uploadWaveTexture(): void {
    const N = this.gridSize;
    const h = this.currH;
    const px = this.packedPixels;

    for (let j = 0; j < N; j++) {
      const jm = Math.max(0, j - 1);
      const jp = Math.min(N - 1, j + 1);
      for (let i = 0; i < N; i++) {
        const im = Math.max(0, i - 1);
        const ip = Math.min(N - 1, i + 1);
        const idx = j * N + i;

        const val = h[idx];
        const dHdx = (h[j * N + ip] - h[j * N + im]) * 2.4;
        const dHdz = (h[jp * N + i] - h[jm * N + i]) * 2.4;
        const energy = clamp(Math.abs(val) * 2.6 + Math.hypot(dHdx, dHdz) * 0.9, 0, 1);

        const p = idx * 4;
        px[p] = Math.round(clamp(val * 0.5 + 0.5, 0, 1) * 255);
        px[p + 1] = Math.round(clamp(dHdx * 0.5 + 0.5, 0, 1) * 255);
        px[p + 2] = Math.round(clamp(dHdz * 0.5 + 0.5, 0, 1) * 255);
        px[p + 3] = Math.round(energy * 255);
      }
    }
    this.waveTexture.needsUpdate = true;
  }

  private sampleWaveGrid(worldX: number, worldZ: number): { h: number; dx: number; dz: number } {
    const u = (worldX + this.simExtent) / (this.simExtent * 2);
    const v = (worldZ + this.simExtent) / (this.simExtent * 2);
    if (u <= 0.01 || u >= 0.99 || v <= 0.01 || v >= 0.99) {
      return { h: 0, dx: 0, dz: 0 };
    }

    const gx = u * (this.gridSize - 1);
    const gz = v * (this.gridSize - 1);
    const i0 = Math.floor(gx);
    const j0 = Math.floor(gz);
    const fx = gx - i0;
    const fz = gz - j0;

    const N = this.gridSize;
    const h00 = this.currH[j0 * N + i0];
    const h10 = this.currH[j0 * N + i0 + 1];
    const h01 = this.currH[(j0 + 1) * N + i0];
    const h11 = this.currH[(j0 + 1) * N + i0 + 1];

    const h = lerp(lerp(h00, h10, fx), lerp(h01, h11, fx), fz);
    const dx = ((h10 - h00) * (1 - fz) + (h11 - h01) * fz) / this.cellSize;
    const dz = ((h01 - h00) * (1 - fx) + (h11 - h10) * fx) / this.cellSize;
    return { h, dx, dz };
  }

  public dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.waveTexture.dispose();
    this.reflectionTarget.dispose();
  }
}
