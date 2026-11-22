import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import './style.css';
import { CameraDirector } from './core/CameraDirector';
import { clamp, lerp } from './core/noise';
import { WorldState } from './core/WorldState';
import { AttributionLedger } from './modules/AttributionLedger';
import { AudioLifecycleManager } from './modules/AudioLifecycleManager';
import { PBRTextureCache } from './modules/PBRTextureCache';
import { OrganicTwilightPondSDF } from './modules/PondShapeSDF';
import { WaterSystem } from './modules/WaterSystem';
import { MallardDuck } from './scene/MallardDuck';
import { PondLandmarks } from './scene/PondLandmarks';
import { PondMicroLife } from './scene/PondMicroLife';
import { ShoreAndForest } from './scene/ShoreAndForest';
import { SkyAndLighting } from './scene/SkyAndLighting';
import { MinimalControls } from './ui/MinimalControls';

async function bootstrap(): Promise<void> {
  const canvas = document.getElementById('pond-canvas') as HTMLCanvasElement;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.16;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();

  // Shared world state (with localStorage preference persistence & rest timer)
  const worldState = new WorldState();
  const cameraDirector = new CameraDirector(
    window.innerWidth / window.innerHeight,
    worldState.cameraPreset
  );
  const camera = cameraDirector.camera;

  // True HDR HalfFloat EffectComposer so ACESFilmic + subtle Bloom keep rich sunset contrast
  const hdrTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
    type: THREE.HalfFloatType,
    samples: 4,
  });
  const composer = new EffectComposer(renderer, hdrTarget);
  composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  composer.setSize(window.innerWidth, window.innerHeight);
  composer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.22,
    0.42,
    1.08
  );
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  const ledger = new AttributionLedger();
  await ledger.load('./assets/ledger.json');

  const textureCache = new PBRTextureCache();
  textureCache.setMaxAnisotropy(renderer.capabilities.getMaxAnisotropy());

  const pondSDF = new OrganicTwilightPondSDF();
  const water = new WaterSystem(pondSDF, textureCache.getWaterNormalMap(6));
  water.setSize(window.innerWidth, window.innerHeight, renderer.getPixelRatio());
  scene.add(water.mesh);

  const skyAndLighting = new SkyAndLighting(scene, renderer);
  const shoreAndForest = new ShoreAndForest(pondSDF, textureCache);
  scene.add(shoreAndForest.group);

  const landmarks = new PondLandmarks(pondSDF, textureCache);
  scene.add(landmarks.group);

  const microLife = new PondMicroLife(pondSDF);
  scene.add(microLife.group);

  const audio = new AudioLifecycleManager({
    onAssetStatus: (id, status) => ledger.setRuntimeStatus(id, status),
  });

  const duck = new MallardDuck({
    onModelStatus: (status) => ledger.setRuntimeStatus('mallard-duck-model', status),
    onQuack: (dx, dz, fromCall) => {
      const dist = Math.hypot(dx - camera.position.x, dz - camera.position.z);
      const dist01 = clamp((dist - 4) / 16, 0, 1);
      const panX = clamp(dx / 7.5, -0.75, 0.75);
      audio.playDuckQuack(panX, dist01, fromCall);
    },
  });
  scene.add(duck.group);

  const unlockAudioOnce = (): void => {
    void audio.unlock().then(() => {
      audio.setVolume(worldState.volume);
      audio.setMuted(worldState.muted);
    });
  };

  const controls = new MinimalControls(worldState, ledger, {
    onCallDuck: () => {
      unlockAudioOnce();
      duck.notifyCall(0.15, 1.4);
    },
    onCycleCamera: () => {
      const next = cameraDirector.cyclePreset();
      worldState.setCameraPreset(next);
    },
    onSelectCamera: (id) => {
      cameraDirector.setPreset(id);
      worldState.setCameraPreset(id);
    },
    onCycleDayMode: () => {
      const mode = worldState.cycleDayMode();
      if (mode === 'flow') {
        controls.showTransientWhisper('天时慢流转', '金暮 → 蓝调时刻 → 月夜将悄然交替', 3200);
      }
    },
    onToggleRain: () => {
      worldState.setRainEnabled(!worldState.isTargetRaining());
    },
    onWindChange: (wind) => {
      worldState.setWindStrength(wind);
    },
    onVolumeChange: (vol) => {
      worldState.setVolume(vol);
      audio.setVolume(worldState.volume);
      audio.setMuted(worldState.muted);
    },
    onToggleMute: () => {
      worldState.setMuted(!worldState.muted);
      audio.setMuted(worldState.muted);
    },
    onAudioMixChange: (channel, val) => {
      worldState.setAudioMixChannel(channel, val);
    },
    onAudioMixReset: () => {
      worldState.resetAudioMix();
    },
    onCycleTimer: () => {
      worldState.cycleRestTimer();
    },
    onToggleFullscreen: () => {
      if (!document.fullscreenElement) {
        void document.documentElement.requestFullscreen?.();
      } else {
        void document.exitFullscreen?.();
      }
    },
    onAnyUserGesture: () => {
      unlockAudioOnce();
    },
    getCameraPresetLabel: () => cameraDirector.getPresetLabel(),
  });

  // Gentle non-startling completion cue when rest/focus timer finishes
  worldState.setTimerCompleteHandler(() => {
    controls.syncFromState();
    controls.showTransientWhisper('静歇时间到了', '可以回到手头的事，也可以再看一会儿', 5500);
    const dPos = duck.getPosition();
    audio.playDuckQuack(clamp(dPos.x / 7.5, -0.7, 0.7), 0.35, true);
  });

  // Full 360-degree free orbit + gentle water tap ripple raycasting
  const raycaster = new THREE.Raycaster();
  const waterPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -pondSDF.waterLevel);
  const hitPoint = new THREE.Vector3();

  let pointerDown = false;
  let pointerMoved = 0;
  let pointerDownAt = 0;
  let lastPointerX = 0;
  let lastPointerY = 0;

  canvas.addEventListener('pointerdown', (e) => {
    controls.dismissWhisper();
    unlockAudioOnce();
    pointerDown = true;
    pointerMoved = 0;
    pointerDownAt = performance.now();
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
  });

  window.addEventListener('pointermove', (e) => {
    if (!pointerDown) return;
    const dx = e.clientX - lastPointerX;
    const dy = e.clientY - lastPointerY;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    pointerMoved += Math.hypot(dx, dy);
    cameraDirector.orbitBy(dx, dy);
  });

  window.addEventListener('pointerup', (e) => {
    if (!pointerDown) return;
    pointerDown = false;

    if (pointerMoved < 7) {
      const holdMs = performance.now() - pointerDownAt;
      // Tactile light-tap vs gentle long-press water weight (0 = light tap, 1 = deep resonant press)
      const weight01 = clamp((holdMs - 140) / 700, 0, 1);
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      raycaster.setFromCamera(ndc, camera);
      if (raycaster.ray.intersectPlane(waterPlane, hitPoint)) {
        if (pondSDF.signedDistance(hitPoint.x, hitPoint.z) < -0.15) {
          const strength = lerp(0.42, 0.86, weight01);
          const radius = lerp(0.56, 1.02, weight01);
          water.injectDisturbance(hitPoint.x, hitPoint.z, strength, radius);
          audio.playWaterRipple(clamp(hitPoint.x / 7.5, -0.75, 0.75), weight01);
          duck.notifyWaterClick(hitPoint.x, hitPoint.z, weight01);
        }
      }
    }
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      cameraDirector.zoomBy(e.deltaY);
    },
    { passive: true }
  );

  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    cameraDirector.setAspect(w / h);
    const dpr = Math.min(window.devicePixelRatio, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h);
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
    bloomPass.setSize(w, h);
    water.setSize(w, h, dpr);
  });

  let prevTime = performance.now();
  let smoothFps = 60;

  const animate = (now: number): void => {
    requestAnimationFrame(animate);
    const dt = clamp((now - prevTime) / 1000, 0.001, 0.05);
    prevTime = now;
    smoothFps = lerp(smoothFps, 1 / dt, 0.08);

    worldState.update(dt);

    const envLighting = skyAndLighting.update(
      worldState.time,
      worldState.dayPhase,
      worldState.rainIntensity
    );
    renderer.toneMappingExposure = envLighting.recommendedExposure;

    shoreAndForest.update(dt, worldState.time, worldState.dayPhase, worldState.windStrength, water);
    landmarks.update(dt, worldState.time, worldState.dayPhase, water);
    microLife.update(
      dt,
      worldState.time,
      worldState.dayPhase,
      worldState.windStrength,
      worldState.rainIntensity,
      water
    );
    duck.update(dt, worldState.time, worldState.windStrength, water, worldState.duck);
    cameraDirector.update(dt, worldState.time, worldState.duck, pondSDF);

    water.update(
      dt,
      worldState.time,
      worldState.dayPhase,
      worldState.windStrength,
      envLighting,
      worldState.rainIntensity
    );
    audio.updateEnvironment(
      worldState.dayPhase,
      worldState.windStrength,
      dt,
      worldState.rainIntensity,
      worldState.audioMix
    );

    water.renderReflection(renderer, scene, camera);
    composer.render();

    controls.updateLiveOverlays({
      fps: smoothFps,
      wakeEnergy: water.getLastWakeEnergy(),
      audioReady: audio.isReady(),
    });
  };

  requestAnimationFrame(animate);
}

void bootstrap();
