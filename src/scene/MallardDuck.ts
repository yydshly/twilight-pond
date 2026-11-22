import * as THREE from 'three';
import { clamp, lerp, organicDuration, valueNoise2D } from '../core/noise';
import type { DuckActivity, DuckMotionSnapshot } from '../core/WorldState';
import type { WaterSystem } from '../modules/WaterSystem';
import {
  createProceduralMallardRig,
  tryLoadExternalMallardGLB,
  type DuckDeformUniforms,
  type MallardVisualRig,
} from './MallardMeshBuilder';

export interface DuckCallbacks {
  onQuack?: (worldX: number, worldZ: number, fromCall: boolean) => void;
  onModelStatus?: (status: 'loaded-external' | 'active-procedural') => void;
}

/**
 * Subject: MallardDuck (无骨骼绿头鸭主体)
 * - Water-coupled buoyancy, pitch/roll wave response, turn banking, and subtle webbed-foot paddle surge
 * - Non-repetitive organic state machine (no rigid loops or robotic turns)
 * - Delayed, unhurried responses to water clicks and user calls
 * - Feeds live position/velocity/turn back into WaterSystem for continuous V-wakes
 */
export class MallardDuck {
  public readonly group = new THREE.Group();

  private readonly uniforms: DuckDeformUniforms = {
    uHeadYaw: { value: 0 },
    uHeadPitch: { value: 0 },
    uTailWag: { value: 0 },
    uBreath: { value: 0 },
  };
  private rig: MallardVisualRig;
  private readonly callbacks: DuckCallbacks;

  private x = -1.1;
  private z = 0.5;
  private vx = 0;
  private vz = 0;
  private heading = 0.55;
  private angularVelocity = 0;

  private smoothY = -0.02;
  private smoothPitch = 0;
  private smoothRoll = 0;

  private activity: DuckActivity = 'DRIFT_IDLE';
  private stateTimer = 3.8;
  private targetX = 1.4;
  private targetZ = -0.6;
  private stopRadius = 1.2;

  // Pending delayed reaction so the duck feels alive & unhurried
  private pendingInterest: {
    x: number;
    z: number;
    delay: number;
    fromCall: boolean;
    willApproach: boolean;
  } | null = null;

  // Organic head/tail micro-motion & lifelike dabble/preen actions
  private headYaw = 0;
  private targetHeadYaw = 0;
  private headPitch = 0;
  private targetHeadPitch = 0;
  private nextGlanceTimer = 2.2;
  private tailWagEnergy = 0;
  private nextTailWagTimer = 6.5;
  private paddlePhase = 0;
  private noiseSeed = Math.random() * 50;

  private microAction: 'NONE' | 'DABBLE' | 'PREEN' = 'NONE';
  private microActionTimer = 0;
  private microActionRippleFired = false;
  private nextMicroActionTimer = 7.5;
  private preenSide = 1;

  // Companion personality: tracks stillness for peaceful DOZE napping + over-tapping independence
  private quietSinceStimulus = 0;
  private recentStimuliHeat = 0;
  private dozeSide = 1;

  constructor(callbacks: DuckCallbacks = {}) {
    this.callbacks = callbacks;
    this.rig = createProceduralMallardRig(this.uniforms);
    this.group.add(this.rig.root);
    this.group.position.set(this.x, this.smoothY, this.z);
    this.group.rotation.y = this.heading;

    void this.tryUpgradeExternalModel();
  }

  private async tryUpgradeExternalModel(): Promise<void> {
    const ext = await tryLoadExternalMallardGLB(this.uniforms);
    if (ext) {
      this.group.remove(this.rig.root);
      this.rig = {
        root: ext,
        headPivot: null,
        tailPivot: null,
        uniforms: this.uniforms,
        usingExternalGLB: true,
      };
      this.group.add(ext);
      this.callbacks.onModelStatus?.('loaded-external');
    } else {
      this.callbacks.onModelStatus?.('active-procedural');
    }
  }

  public getPosition(): { x: number; z: number } {
    return { x: this.x, z: this.z };
  }

  /**
   * User clicked (or long-pressed) the water: duck pauses briefly, glances at the ripple,
   * and organically decides whether to glide closer or merely watch (with playful independence if over-tapped).
   */
  public notifyWaterClick(worldX: number, worldZ: number, weight01 = 0.2): void {
    const dist = Math.hypot(worldX - this.x, worldZ - this.z);
    this.quietSinceStimulus = 0;
    this.recentStimuliHeat = Math.min(6, this.recentStimuliHeat + 1.0);

    const wasDozing = this.activity === 'DOZE';
    // Sleepy extra beat when waking from a quiet nap
    const delay = (wasDozing ? 0.95 : 0.32) + Math.random() * 0.65;

    // Playful independence: if tapped rapidly 4+ times in a few seconds, occasionally just glance calmly
    const fatiguePenalty = this.recentStimuliHeat > 3.4 ? 0.45 : 0.0;
    const baseCuriosity = clamp(0.72 + weight01 * 0.18 - fatiguePenalty, 0.2, 0.9);
    const willApproach = dist > 1.45 && dist < 11.5 && Math.random() < baseCuriosity;

    this.pendingInterest = {
      x: worldX,
      z: worldZ,
      delay,
      fromCall: false,
      willApproach,
    };
  }

  /**
   * User pressed "呼唤": gentle delayed response with head turn, soft quack, and leisurely swim toward near shore.
   */
  public notifyCall(viewerTargetX: number, viewerTargetZ: number): void {
    this.quietSinceStimulus = 0;
    const wasDozing = this.activity === 'DOZE';
    this.pendingInterest = {
      x: clamp(viewerTargetX + (Math.random() - 0.5) * 1.8, -2.2, 2.4),
      z: clamp(viewerTargetZ + (Math.random() - 0.5) * 0.9, 0.2, 2.1),
      delay: (wasDozing ? 0.85 : 0.3) + Math.random() * 0.45,
      fromCall: true,
      willApproach: true,
    };
  }

  public update(
    dt: number,
    time: number,
    windStrength: number,
    water: WaterSystem,
    snapshotOut: DuckMotionSnapshot
  ): void {
    this.processPendingInterest(dt);
    this.updateBehavior(dt, time, water);
    this.updatePhysicsAndCoupling(dt, time, windStrength, water);
    this.updateMicroAnimations(dt, time, water);

    snapshotOut.x = this.x;
    snapshotOut.z = this.z;
    snapshotOut.vx = this.vx;
    snapshotOut.vz = this.vz;
    snapshotOut.speed = Math.hypot(this.vx, this.vz);
    snapshotOut.heading = this.heading;
    snapshotOut.angularVelocity = this.angularVelocity;
    snapshotOut.activity = this.activity;
  }

  private processPendingInterest(dt: number): void {
    if (!this.pendingInterest) return;
    this.pendingInterest.delay -= dt;
    if (this.pendingInterest.delay > 0) return;

    const ev = this.pendingInterest;
    this.pendingInterest = null;

    // Immediately glance toward the stimulus
    const angToEv = Math.atan2(ev.x - this.x, ev.z - this.z);
    const relAng = this.wrapAngle(angToEv - this.heading);
    this.targetHeadYaw = clamp(relAng, -0.78, 0.78);
    this.targetHeadPitch = -0.06;
    this.nextGlanceTimer = organicDuration(1.8, 3.6);

    if (ev.fromCall) {
      this.callbacks.onQuack?.(this.x, this.z, true);
      this.tailWagEnergy = 0.85;
    }

    if (ev.willApproach) {
      this.activity = 'INVESTIGATE';
      this.targetX = ev.x;
      this.targetZ = ev.z;
      this.stopRadius = ev.fromCall ? 1.4 : 1.7 + Math.random() * 0.9;
      this.stateTimer = organicDuration(7.0, 13.0);
    } else {
      // Curious pause without rushing over — reinforces natural, un-gamey companion feel
      this.activity = 'PAUSE_LOOK';
      this.stateTimer = organicDuration(2.8, 5.8);
    }
  }

  private updateBehavior(dt: number, time: number, water: WaterSystem): void {
    this.stateTimer -= dt;
    this.quietSinceStimulus += dt;
    this.recentStimuliHeat = Math.max(0, this.recentStimuliHeat - dt * 0.22);

    if (this.activity === 'INVESTIGATE' || this.activity === 'CRUISE') {
      const dist = Math.hypot(this.targetX - this.x, this.targetZ - this.z);
      if (dist <= this.stopRadius || this.stateTimer <= 0) {
        // After calm cruising during quiet stretches, duck may tuck in for a peaceful DOZE
        if (this.quietSinceStimulus > 32 && Math.random() < 0.38) {
          this.activity = 'DOZE';
          this.dozeSide = Math.random() < 0.5 ? -1 : 1;
          this.stateTimer = organicDuration(14.0, 28.0);
        } else {
          this.activity = Math.random() < 0.62 ? 'PAUSE_LOOK' : 'DRIFT_IDLE';
          this.stateTimer = organicDuration(3.6, 11.5);
        }
        if (Math.random() < 0.28) {
          this.tailWagEnergy = 0.65;
        }
      }
      return;
    }

    if (this.stateTimer <= 0) {
      // Non-periodic transitions between peaceful dozing, quiet drifting, observing, and slow meandering cruise
      const roll = Math.random();
      if (this.quietSinceStimulus > 36 && this.activity !== 'DOZE' && roll < 0.3) {
        this.activity = 'DOZE';
        this.dozeSide = Math.random() < 0.5 ? -1 : 1;
        this.stateTimer = organicDuration(14.0, 28.0);
      } else if (roll < 0.58) {
        this.pickNavigableWaypoint(water, time);
        this.activity = 'CRUISE';
        this.stopRadius = 1.0;
        this.stateTimer = organicDuration(8.0, 16.0);
      } else if (roll < 0.82) {
        this.activity = 'DRIFT_IDLE';
        this.stateTimer = organicDuration(4.5, 12.0);
      } else {
        this.activity = 'PAUSE_LOOK';
        this.stateTimer = organicDuration(3.2, 8.5);
        if (Math.random() < 0.16) {
          this.callbacks.onQuack?.(this.x, this.z, false);
        }
      }
    }
  }

  private pickNavigableWaypoint(water: WaterSystem, time: number): void {
    for (let tries = 0; tries < 24; tries++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = 2.0 + Math.random() * 4.8;
      const nx = clamp(this.x + Math.cos(ang) * dist, -4.1, 4.2);
      const nz = clamp(this.z + Math.sin(ang) * dist, -3.4, 2.6);
      if (water.sdf.isNavigable(nx, nz, 1.55)) {
        this.targetX = nx + (valueNoise2D(time * 0.1, tries) - 0.5) * 0.6;
        this.targetZ = nz;
        return;
      }
    }
    this.targetX = -0.3;
    this.targetZ = 0.2;
  }

  private updatePhysicsAndCoupling(
    dt: number,
    time: number,
    windStrength: number,
    water: WaterSystem
  ): void {
    const isMovingState = this.activity === 'CRUISE' || this.activity === 'INVESTIGATE';
    const baseSpeed = this.activity === 'INVESTIGATE' ? 0.88 : 0.58;

    // Gentle organic wander angle noise so cruise paths softly curve rather than ruler-straight lines
    const wanderOffset = (valueNoise2D(time * 0.18 + this.noiseSeed, 2.3) - 0.5) * 0.42;

    let desiredHeading = this.heading;
    let desiredSpeed = 0;

    if (isMovingState) {
      const dx = this.targetX - this.x;
      const dz = this.targetZ - this.z;
      const dist = Math.hypot(dx, dz);
      const slowDown = clamp((dist - this.stopRadius * 0.7) / 2.2, 0, 1);
      desiredHeading = Math.atan2(dx, dz) + wanderOffset * slowDown;
      desiredSpeed = baseSpeed * slowDown;
    }

    // Soft shoreline repulsion from PondShapeSDF gradient so duck gracefully curves along wet banks
    const sd = water.sdf.signedDistance(this.x, this.z);
    if (sd > -1.75) {
      const { gx, gz } = water.sdf.gradient(this.x, this.z);
      const inwardAngle = Math.atan2(-gx, -gz);
      const urgency = clamp((sd + 1.75) / 1.1, 0, 1);
      desiredHeading = this.lerpAngle(desiredHeading, inwardAngle, urgency * 0.85);
      desiredSpeed = Math.max(desiredSpeed, 0.32 * urgency);
    }

    // Critically-damped turning inertia
    const headingError = this.wrapAngle(desiredHeading - this.heading);
    const maxTurnRate = isMovingState ? 1.05 : 0.35;
    const targetAngVel = clamp(headingError * 1.4, -maxTurnRate, maxTurnRate);
    const angAlpha = 1 - Math.exp(-dt * 3.2);
    this.angularVelocity += (targetAngVel - this.angularVelocity) * angAlpha;
    this.heading = this.wrapAngle(this.heading + this.angularVelocity * dt);

    // Subtle webbed-foot paddling cadence surge when moving forward
    if (desiredSpeed > 0.08) {
      this.paddlePhase += dt * (4.2 + desiredSpeed * 2.1);
    }
    const paddleSurge = desiredSpeed > 0.08 ? 1.0 + Math.sin(this.paddlePhase) * 0.14 : 1.0;

    // Slight gentle wind drift on open water
    const windDriftX = windStrength * 0.055;
    const windDriftZ = windStrength * 0.025;

    const targetVx = Math.sin(this.heading) * desiredSpeed * paddleSurge + windDriftX;
    const targetVz = Math.cos(this.heading) * desiredSpeed * paddleSurge + windDriftZ;
    const velAlpha = 1 - Math.exp(-dt * 1.85);
    this.vx += (targetVx - this.vx) * velAlpha;
    this.vz += (targetVz - this.vz) * velAlpha;

    const nextX = this.x + this.vx * dt;
    const nextZ = this.z + this.vz * dt;
    if (water.sdf.signedDistance(nextX, nextZ) < -0.7) {
      this.x = nextX;
      this.z = nextZ;
    } else {
      // Softly absorb momentum if ever touching shallow edge
      this.vx *= 0.4;
      this.vz *= 0.4;
    }

    // Water -> Duck coupling: sample real wave height & slope (including incoming click ripples!)
    const sample = water.sample(this.x, this.z, time, windStrength);
    const speed = Math.hypot(this.vx, this.vz);
    const fwdX = Math.sin(this.heading);
    const fwdZ = Math.cos(this.heading);
    const rightX = Math.cos(this.heading);
    const rightZ = -Math.sin(this.heading);

    const wavePitch = (sample.nx * fwdX + sample.nz * fwdZ) * 1.08;
    const waveRoll = (sample.nx * rightX + sample.nz * rightZ) * 1.08;
    const paddlePitch = desiredSpeed > 0.08 ? Math.sin(this.paddlePhase) * 0.022 : 0;
    const turnBank = clamp(-this.angularVelocity * speed * 0.16, -0.11, 0.11);

    const waterlineOffset = -0.042;
    const buoyAlpha = 1 - Math.exp(-dt * 7.5);
    this.smoothY += (sample.height + waterlineOffset - this.smoothY) * buoyAlpha;
    this.smoothPitch += (wavePitch + paddlePitch - this.smoothPitch) * (1 - Math.exp(-dt * 5.2));
    this.smoothRoll += (waveRoll + turnBank - this.smoothRoll) * (1 - Math.exp(-dt * 5.2));

    this.group.position.set(this.x, this.smoothY, this.z);
    this.group.rotation.order = 'YXZ';
    this.group.rotation.y = this.heading;
    this.group.rotation.x = this.smoothPitch;
    this.group.rotation.z = this.smoothRoll;

    // Duck -> Water coupling: return duck motion into the pond's wave solver for continuous V-wake
    water.injectDuckWake(this.x, this.z, this.heading, speed, this.angularVelocity, time);
  }

  private updateMicroAnimations(dt: number, time: number, water: WaterSystem): void {
    const isDozing = this.activity === 'DOZE';
    const isCalm = this.activity === 'PAUSE_LOOK' || this.activity === 'DRIFT_IDLE';

    if (isDozing) {
      // Peaceful resting posture: tuck head softly back toward shoulder wing & slow deep breathing
      this.microAction = 'NONE';
      this.targetHeadYaw = this.dozeSide * 0.88;
      this.targetHeadPitch = 0.25 + Math.sin(time * 0.85) * 0.025;
    } else if (this.microAction === 'NONE') {
      if (isCalm) {
        this.nextMicroActionTimer -= dt;
        if (this.nextMicroActionTimer <= 0) {
          this.nextMicroActionTimer = organicDuration(9.5, 22.0);
          if (Math.random() < 0.62) {
            this.microAction = 'DABBLE';
            this.microActionTimer = 1.65;
            this.microActionRippleFired = false;
          } else {
            this.microAction = 'PREEN';
            this.microActionTimer = 2.1;
            this.preenSide = Math.random() < 0.5 ? -1 : 1;
          }
        }
      }
    } else {
      this.microActionTimer -= dt;
      if (!isCalm || this.microActionTimer <= 0) {
        this.microAction = 'NONE';
        this.targetHeadPitch = -0.04;
      } else if (this.microAction === 'DABBLE') {
        // Dip bill down to touch pond surface -> trigger delicate ripple -> lift head & gently sip
        if (this.microActionTimer > 0.85) {
          this.targetHeadYaw = 0.08 * Math.sin(time * 2.0);
          this.targetHeadPitch = 0.54;
        } else {
          if (!this.microActionRippleFired) {
            this.microActionRippleFired = true;
            const billX = this.x + Math.sin(this.heading) * 0.42;
            const billZ = this.z + Math.cos(this.heading) * 0.42;
            water.injectDisturbance(billX, billZ, 0.2, 0.28);
          }
          // Gentle lifted sip/swallow nod
          this.targetHeadPitch = -0.16;
        }
      } else if (this.microAction === 'PREEN') {
        // Tuck head back toward shoulder feathers with subtle organic grooming nibble
        this.targetHeadYaw = this.preenSide * 1.05 + Math.sin(time * 11.0) * 0.07;
        this.targetHeadPitch = 0.28 + Math.cos(time * 9.5) * 0.06;
      }
    }

    this.nextGlanceTimer -= dt;
    if (this.microAction === 'NONE' && this.nextGlanceTimer <= 0) {
      this.nextGlanceTimer = organicDuration(1.8, 5.8);
      if (isCalm) {
        this.targetHeadYaw = (Math.random() - 0.5) * 1.05;
        this.targetHeadPitch = (Math.random() - 0.5) * 0.14;
      } else {
        this.targetHeadYaw = (Math.random() - 0.5) * 0.42;
        this.targetHeadPitch = -0.04;
      }
    }

    this.nextTailWagTimer -= dt;
    if (this.nextTailWagTimer <= 0) {
      this.nextTailWagTimer = organicDuration(6.0, 15.0);
      this.tailWagEnergy = 0.75 + Math.random() * 0.25;
    }

    const headSpeed = isDozing ? 1.8 : this.microAction !== 'NONE' ? 5.2 : 3.4;
    this.headYaw = lerp(this.headYaw, this.targetHeadYaw, 1 - Math.exp(-dt * headSpeed));
    this.headPitch = lerp(this.headPitch, this.targetHeadPitch, 1 - Math.exp(-dt * headSpeed));
    this.tailWagEnergy = Math.max(0, this.tailWagEnergy - dt * 1.15);

    const wag = Math.sin(time * 24.0) * this.tailWagEnergy * 0.28;
    const breathFreq = isDozing ? 0.95 : 1.85;
    const breath = Math.sin(time * breathFreq) * 0.5 + 0.5;

    this.uniforms.uHeadYaw.value = this.headYaw;
    this.uniforms.uHeadPitch.value = this.headPitch;
    this.uniforms.uTailWag.value = wag;
    this.uniforms.uBreath.value = breath;

    if (this.rig.headPivot) {
      this.rig.headPivot.rotation.order = 'YXZ';
      this.rig.headPivot.rotation.y = this.headYaw;
      this.rig.headPivot.rotation.x = this.headPitch;
    }
    if (this.rig.tailPivot) {
      this.rig.tailPivot.rotation.y = wag;
    }
  }

  private wrapAngle(a: number): number {
    let r = a;
    while (r > Math.PI) r -= Math.PI * 2;
    while (r < -Math.PI) r += Math.PI * 2;
    return r;
  }

  private lerpAngle(a: number, b: number, t: number): number {
    return this.wrapAngle(a + this.wrapAngle(b - a) * t);
  }
}
