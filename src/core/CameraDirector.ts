import * as THREE from 'three';
import { clamp } from './noise';
import type { PondShapeSDF } from '../modules/PondShapeSDF';

export type CameraPresetId = 'shore' | 'jetty' | 'duck' | 'overview';

interface CameraPresetSpec {
  id: CameraPresetId;
  label: string;
  lookAt: THREE.Vector3;
  yaw: number;
  pitch: number;
  distance: number;
}

const PRESETS: Record<CameraPresetId, CameraPresetSpec> = {
  shore: {
    id: 'shore',
    label: '岸边',
    lookAt: new THREE.Vector3(0.35, 1.02, -2.1),
    yaw: 0.03,
    pitch: 0.092,
    distance: 11.2,
  },
  jetty: {
    id: 'jetty',
    label: '栈桥',
    lookAt: new THREE.Vector3(-0.6, 0.55, 0.2),
    yaw: 2.38,
    pitch: 0.11,
    distance: 7.4,
  },
  duck: {
    id: 'duck',
    label: '追鸭',
    lookAt: new THREE.Vector3(0, 0.22, 0),
    yaw: 0.55,
    pitch: 0.2,
    distance: 4.8,
  },
  overview: {
    id: 'overview',
    label: '俯瞰',
    lookAt: new THREE.Vector3(0.75, 0.2, -0.8),
    yaw: -0.22,
    pitch: 0.5,
    distance: 17.0,
  },
};

export const CAMERA_PRESET_ORDER: CameraPresetId[] = ['shore', 'jetty', 'duck', 'overview'];

/**
 * Full 360-degree unconstrained orbit camera with silky cinematic vantage presets,
 * gentle duck-follow mode, and automatic terrain/water clearance clamping.
 */
export class CameraDirector {
  public readonly camera: THREE.PerspectiveCamera;
  private preset: CameraPresetId = 'shore';

  private lookAt = PRESETS.shore.lookAt.clone();
  private targetLookAt = PRESETS.shore.lookAt.clone();
  private yaw = PRESETS.shore.yaw;
  private targetYaw = PRESETS.shore.yaw;
  private pitch = PRESETS.shore.pitch;
  private targetPitch = PRESETS.shore.pitch;
  private distance = PRESETS.shore.distance;
  private targetDistance = PRESETS.shore.distance;

  // Ambient screen-saver micro-drift when user sits back and watches peacefully
  private idleSeconds = 0;
  private driftBlend = 0;
  private driftPhase = 0;

  constructor(aspect: number, initialPreset: CameraPresetId = 'shore') {
    this.camera = new THREE.PerspectiveCamera(48, aspect, 0.15, 175);
    this.applyPresetImmediate(initialPreset);
  }

  public getPreset(): CameraPresetId {
    return this.preset;
  }

  public getPresetLabel(id: CameraPresetId = this.preset): string {
    return PRESETS[id].label;
  }

  public cyclePreset(): CameraPresetId {
    const idx = CAMERA_PRESET_ORDER.indexOf(this.preset);
    const next = CAMERA_PRESET_ORDER[(idx + 1) % CAMERA_PRESET_ORDER.length];
    this.setPreset(next);
    return next;
  }

  public setPreset(id: CameraPresetId): void {
    this.preset = id;
    this.idleSeconds = 0;
    const spec = PRESETS[id];
    // Find shortest angular turn so 360-degree preset transitions never spin wildly
    const diff = this.wrapAngle(spec.yaw - this.yaw);
    this.targetYaw = this.yaw + diff;
    this.targetPitch = spec.pitch;
    this.targetDistance = spec.distance;
    if (id !== 'duck') {
      this.targetLookAt.copy(spec.lookAt);
    }
  }

  private applyPresetImmediate(id: CameraPresetId): void {
    this.preset = id;
    const spec = PRESETS[id];
    this.lookAt.copy(spec.lookAt);
    this.targetLookAt.copy(spec.lookAt);
    this.yaw = spec.yaw;
    this.targetYaw = spec.yaw;
    this.pitch = spec.pitch;
    this.targetPitch = spec.pitch;
    this.distance = spec.distance;
    this.targetDistance = spec.distance;
  }

  /**
   * Unconstrained 360-degree drag orbit + safe vertical pitch range.
   */
  public orbitBy(dxPixels: number, dyPixels: number): void {
    this.idleSeconds = 0;
    this.targetYaw -= dxPixels * 0.0042;
    this.targetPitch = clamp(this.targetPitch + dyPixels * 0.0028, 0.045, 0.78);
  }

  public zoomBy(wheelDeltaY: number): void {
    this.idleSeconds = 0;
    const minD = this.preset === 'duck' ? 3.2 : 5.4;
    const maxD = 18.2;
    this.targetDistance = clamp(this.targetDistance + wheelDeltaY * 0.0048, minD, maxD);
  }

  public setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  public update(
    dt: number,
    time: number,
    duckPos: { x: number; z: number },
    sdf: PondShapeSDF
  ): void {
    if (this.preset === 'duck') {
      this.targetLookAt.set(duckPos.x, 0.28, duckPos.z);
    }

    const alpha = 1 - Math.exp(-dt * 3.4);
    this.lookAt.lerp(this.targetLookAt, alpha);
    this.yaw += (this.targetYaw - this.yaw) * alpha;
    this.pitch += (this.targetPitch - this.pitch) * alpha;
    this.distance += (this.targetDistance - this.distance) * alpha;

    // Barely-perceptible slow cinema drift after 8s of stillness (perfect for secondary monitor!)
    this.idleSeconds += dt;
    const wantDrift = this.idleSeconds > 8.0 ? 1.0 : 0.0;
    this.driftBlend += (wantDrift - this.driftBlend) * (1 - Math.exp(-dt * 0.45));
    this.driftPhase += dt * 0.075 * this.driftBlend;

    const driftYaw = Math.sin(this.driftPhase) * 0.085 * this.driftBlend;
    const driftPitch = Math.sin(this.driftPhase * 1.45) * 0.014 * this.driftBlend;
    const effectiveYaw = this.yaw + driftYaw;
    const effectivePitch = clamp(this.pitch + driftPitch, 0.045, 0.78);

    const breathe = Math.sin(time * 0.34) * 0.032;
    const horiz = Math.cos(effectivePitch) * this.distance;
    const camX = this.lookAt.x + Math.sin(effectiveYaw) * horiz;
    const camZ = this.lookAt.z + Math.cos(effectiveYaw) * horiz;
    let camY = this.lookAt.y + Math.sin(effectivePitch) * this.distance + breathe;

    // Terrain & waterline clearance so full 360-degree orbiting never clips underground or underwater
    const groundAtCam = sdf.terrainHeight(camX, camZ);
    const minSafeY = Math.max(sdf.waterLevel + 0.55, groundAtCam + 0.65);
    if (camY < minSafeY) {
      camY = minSafeY;
    }

    this.camera.position.set(camX, camY, camZ);
    this.camera.lookAt(this.lookAt.x, this.lookAt.y + 0.06, this.lookAt.z);
  }

  private wrapAngle(a: number): number {
    let r = a;
    while (r > Math.PI) r -= Math.PI * 2;
    while (r < -Math.PI) r += Math.PI * 2;
    return r;
  }
}
