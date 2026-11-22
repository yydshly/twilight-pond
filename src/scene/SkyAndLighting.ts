import * as THREE from 'three';
import { lerp } from '../core/noise';

export interface EnvironmentLightingSnapshot {
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  fogColor: THREE.Color;
  fogDensity: number;
  skyTint: THREE.Color;
  recommendedExposure: number;
}

/**
 * Physically-grounded atmospheric sky (golden twilight <-> luminous full-moon night),
 * soft Rayleigh/Mie horizon haze, layered sunlit clouds, real PCF soft directional shadows,
 * and dual Dusk/Night PMREM environment reflections.
 */
export class SkyAndLighting {
  public readonly group = new THREE.Group();
  public readonly fog = new THREE.FogExp2('#7c6e76', 0.013);

  private readonly scene: THREE.Scene;
  private readonly skyMaterial: THREE.ShaderMaterial;
  private readonly keyLight: THREE.DirectionalLight;
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly fillLight: THREE.DirectionalLight;
  private readonly duskEnvRT: THREE.WebGLRenderTarget;
  private readonly nightEnvRT: THREE.WebGLRenderTarget;
  private activeEnvIsNight = false;

  private readonly snapshot: EnvironmentLightingSnapshot = {
    sunDir: new THREE.Vector3(-0.54, 0.24, -0.81).normalize(),
    sunColor: new THREE.Color('#ffd39e'),
    fogColor: new THREE.Color('#7c6e76'),
    fogDensity: 0.013,
    skyTint: new THREE.Color('#d2a494'),
    recommendedExposure: 1.38,
  };

  // Physically calibrated 3-stage sky palette: Golden Twilight -> Velvety Blue Hour -> Moonlit Night
  private readonly duskZenith = new THREE.Color('#1d3358');
  private readonly duskMid = new THREE.Color('#6a4e66');
  private readonly duskHorizon = new THREE.Color('#eb833c');
  private readonly duskFog = new THREE.Color('#5a4b52');

  private readonly blueZenith = new THREE.Color('#122242');
  private readonly blueMid = new THREE.Color('#343c64');
  private readonly blueHorizon = new THREE.Color('#8e6478');
  private readonly blueFog = new THREE.Color('#323a52');

  private readonly nightZenith = new THREE.Color('#0c172b');
  private readonly nightMid = new THREE.Color('#1a2e4a');
  private readonly nightHorizon = new THREE.Color('#2c4768');
  private readonly nightFog = new THREE.Color('#1c2d42');

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.scene = scene;
    scene.fog = this.fog;

    this.skyMaterial = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uDayPhase: { value: 0.12 },
        uZenithColor: { value: this.duskZenith.clone() },
        uMidColor: { value: this.duskMid.clone() },
        uHorizonColor: { value: this.duskHorizon.clone() },
        uSunDir: { value: this.snapshot.sunDir.clone() },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uDayPhase;
        uniform vec3 uZenithColor;
        uniform vec3 uMidColor;
        uniform vec3 uHorizonColor;
        uniform vec3 uSunDir;
        varying vec3 vDir;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        float noise2(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }

        float fbm(vec2 p) {
          float v = 0.0;
          float a = 0.5;
          for (int i = 0; i < 4; i++) {
            v += a * noise2(p);
            p *= 2.04;
            a *= 0.5;
          }
          return v;
        }

        float hash31(vec3 p) {
          p = fract(p * 0.1031);
          p += dot(p, p.yzx + 33.33);
          return fract((p.x + p.y) * p.z);
        }

        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, 0.0, 1.0);

          // Rayleigh vertical atmospheric gradient
          vec3 col = mix(uHorizonColor, uMidColor, smoothstep(0.0, 0.24, h));
          col = mix(col, uZenithColor, smoothstep(0.18, 0.72, h));

          // Mie forward-scattering rich amber solar aureole / silver moon halo
          float sunAlign = max(dot(d, normalize(uSunDir)), 0.0);
          vec3 duskGlow = vec3(1.0, 0.56, 0.24) * (pow(sunAlign, 5.5) * 0.44)
                        + vec3(1.0, 0.72, 0.38) * (pow(sunAlign, 42.0) * 0.62);
          vec3 moonGlow = vec3(0.84, 0.92, 1.0) * (pow(sunAlign, 12.0) * 0.26 + smoothstep(0.9986, 0.9994, sunAlign) * 1.2);
          col += mix(duskGlow, moonGlow, smoothstep(0.25, 0.82, uDayPhase));

          // Soft natural stratocumulus evening clouds lit warm underneath
          if (h > 0.03) {
            vec2 cloudUv = d.xz / (h + 0.24) * 0.8 + vec2(uTime * 0.0038, uTime * 0.0016);
            float c1 = fbm(cloudUv * 1.35);
            float c2 = fbm(cloudUv * 2.8 - vec2(uTime * 0.0028, 0.0));
            float cloudMask = smoothstep(0.45, 0.78, c1 * 0.72 + c2 * 0.28)
              * smoothstep(0.03, 0.17, h)
              * (1.0 - smoothstep(0.55, 0.92, h));

            vec3 duskCloudCol = mix(vec3(0.68, 0.58, 0.68), vec3(1.0, 0.84, 0.66), pow(sunAlign, 1.4));
            vec3 nightCloudCol = mix(vec3(0.22, 0.32, 0.46), vec3(0.52, 0.66, 0.82), pow(sunAlign, 1.8));
            col = mix(col, mix(duskCloudCol, nightCloudCol, uDayPhase), cloudMask * 0.62);
          }

          // Soft circular stars fading in smoothly at night
          if (uDayPhase > 0.32 && h > 0.1) {
            vec3 grid = d * 185.0;
            vec3 cell = floor(grid);
            vec3 local = fract(grid) - 0.5;
            float starSeed = hash31(cell);
            if (starSeed > 0.993) {
              float dotShape = smoothstep(0.27, 0.04, length(local));
              float twinkle = 0.65 + 0.35 * sin(uTime * (1.1 + starSeed * 2.6) + starSeed * 42.0);
              float starMask = smoothstep(0.32, 0.9, uDayPhase) * smoothstep(0.1, 0.34, h);
              col += vec3(0.88, 0.94, 1.0) * dotShape * twinkle * starMask * 0.9;
            }
          }

          // Aerial-perspective distant misty treeline ridge blended softly into horizon haze
          float az = atan(d.z, d.x);
          float hillH = 0.038 + fbm(vec2(cos(az) * 1.9 + 3.2, sin(az) * 1.9 + 1.4)) * 0.078;
          float hillMask = 1.0 - smoothstep(hillH - 0.014, hillH + 0.008, h);
          vec3 hillCol = mix(vec3(0.32, 0.31, 0.36), vec3(0.14, 0.21, 0.30), uDayPhase);
          col = mix(col, mix(hillCol, uHorizonColor, 0.48), hillMask * smoothstep(-0.02, 0.02, h + 0.02));

          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });

    const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(95, 32, 20), this.skyMaterial);
    skyMesh.name = 'TwilightSkyDome';
    this.group.add(skyMesh);

    // Pre-bake both Dusk & Night PMREM environment maps so PBR specular/diffuse bounce stays accurate
    const pmrem = new THREE.PMREMGenerator(renderer);
    const bakeEnv = (phase: number): THREE.WebGLRenderTarget => {
      const envScene = new THREE.Scene();
      const mat = this.skyMaterial.clone();
      mat.uniforms.uDayPhase.value = phase;
      mat.uniforms.uZenithColor.value.copy(this.duskZenith).lerp(this.nightZenith, phase);
      mat.uniforms.uMidColor.value.copy(this.duskMid).lerp(this.nightMid, phase);
      mat.uniforms.uHorizonColor.value.copy(this.duskHorizon).lerp(this.nightHorizon, phase);
      envScene.add(new THREE.Mesh(new THREE.SphereGeometry(20, 16, 12), mat));
      const rt = pmrem.fromScene(envScene, 0.04);
      mat.dispose();
      return rt;
    };
    this.duskEnvRT = bakeEnv(0.12);
    this.nightEnvRT = bakeEnv(1.0);
    pmrem.dispose();

    scene.environment = this.duskEnvRT.texture;
    scene.environmentIntensity = 0.48;

    // Luminous natural sky-to-moss hemisphere bounce light
    this.hemiLight = new THREE.HemisphereLight('#b8c6e0', '#4d5d44', 1.45);
    this.group.add(this.hemiLight);

    // Primary low golden dusk sun / full moon casting real soft shadows across the pond banks
    this.keyLight = new THREE.DirectionalLight('#ffd39e', 2.65);
    this.keyLight.position.set(-18, 8.5, -26);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.camera.near = 4;
    this.keyLight.shadow.camera.far = 68;
    const d = 22;
    this.keyLight.shadow.camera.left = -d;
    this.keyLight.shadow.camera.right = d;
    this.keyLight.shadow.camera.top = d;
    this.keyLight.shadow.camera.bottom = -d;
    this.keyLight.shadow.bias = -0.0005;
    this.keyLight.shadow.normalBias = 0.03;
    this.group.add(this.keyLight);

    // Soft open-sky front fill so the mallard duck & near wet mud shore retain gentle natural detail
    this.fillLight = new THREE.DirectionalLight('#a8c2e2', 0.72);
    this.fillLight.position.set(12, 9, 16);
    this.group.add(this.fillLight);

    scene.add(this.group);
  }

  public update(time: number, dayPhase: number, rainIntensity = 0): EnvironmentLightingSnapshot {
    const u = this.skyMaterial.uniforms;
    u.uTime.value = time;
    u.uDayPhase.value = dayPhase;

    // Smooth 3-stage palette interpolation: Golden Dusk (0) -> Velvety Blue Hour (0.5) -> Moonlit Night (1)
    if (dayPhase < 0.5) {
      const t = dayPhase * 2.0;
      u.uZenithColor.value.copy(this.duskZenith).lerp(this.blueZenith, t);
      u.uMidColor.value.copy(this.duskMid).lerp(this.blueMid, t);
      u.uHorizonColor.value.copy(this.duskHorizon).lerp(this.blueHorizon, t);
      this.snapshot.fogColor.copy(this.duskFog).lerp(this.blueFog, t);
    } else {
      const t = (dayPhase - 0.5) * 2.0;
      u.uZenithColor.value.copy(this.blueZenith).lerp(this.nightZenith, t);
      u.uMidColor.value.copy(this.blueMid).lerp(this.nightMid, t);
      u.uHorizonColor.value.copy(this.blueHorizon).lerp(this.nightHorizon, t);
      this.snapshot.fogColor.copy(this.blueFog).lerp(this.nightFog, t);
    }

    // Soft overcast mist shift when evening drizzle falls
    if (rainIntensity > 0.005) {
      const rainSkyTint = new THREE.Color('#42505d').lerp(new THREE.Color('#1a2838'), dayPhase);
      u.uZenithColor.value.lerp(rainSkyTint, rainIntensity * 0.45);
      u.uMidColor.value.lerp(rainSkyTint, rainIntensity * 0.42);
      u.uHorizonColor.value.lerp(rainSkyTint, rainIntensity * 0.35);
    }

    // Swap baked PMREM smoothly across the dusk/night midpoint
    const wantNightEnv = dayPhase > 0.55;
    if (wantNightEnv !== this.activeEnvIsNight) {
      this.activeEnvIsNight = wantNightEnv;
      this.scene.environment = wantNightEnv ? this.nightEnvRT.texture : this.duskEnvRT.texture;
    }
    this.scene.environmentIntensity = lerp(0.52, 0.36, dayPhase);

    this.snapshot.sunDir
      .set(lerp(-0.52, 0.32, dayPhase), lerp(0.22, 0.42, dayPhase), lerp(-0.82, -0.85, dayPhase))
      .normalize();
    u.uSunDir.value.copy(this.snapshot.sunDir);

    this.keyLight.position.copy(this.snapshot.sunDir).multiplyScalar(32);
    this.snapshot.sunColor.setRGB(
      lerp(1.0, 0.72, dayPhase),
      lerp(0.83, 0.84, dayPhase),
      lerp(0.62, 0.98, dayPhase)
    );
    this.keyLight.color.copy(this.snapshot.sunColor);
    this.keyLight.intensity = lerp(2.65, 1.55, dayPhase) * lerp(1.0, 0.62, rainIntensity);

    this.hemiLight.color.setRGB(
      lerp(0.76, 0.39, dayPhase),
      lerp(0.74, 0.52, dayPhase),
      lerp(0.84, 0.72, dayPhase)
    );
    this.hemiLight.groundColor.setRGB(
      lerp(0.32, 0.16, dayPhase),
      lerp(0.38, 0.23, dayPhase),
      lerp(0.28, 0.25, dayPhase)
    );
    this.hemiLight.intensity = lerp(1.48, 1.05, dayPhase) * lerp(1.0, 0.92, rainIntensity);
    this.fillLight.intensity = lerp(0.74, 0.58, dayPhase);

    this.snapshot.fogDensity = lerp(0.0125, 0.016, dayPhase) + rainIntensity * 0.0045;
    this.fog.color.copy(this.snapshot.fogColor);
    this.fog.density = this.snapshot.fogDensity;

    this.snapshot.skyTint.copy(u.uHorizonColor.value).lerp(u.uMidColor.value, 0.42);
    this.snapshot.recommendedExposure = lerp(1.16, 1.06, dayPhase);
    return this.snapshot;
  }

  public dispose(): void {
    this.skyMaterial.dispose();
    this.duskEnvRT.dispose();
    this.nightEnvRT.dispose();
  }
}
