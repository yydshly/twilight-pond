import { clamp } from './noise';
import type { CameraPresetId } from './CameraDirector';

const PREFS_STORAGE_KEY = 'twilight-pond:prefs:v1';

export type DayMode = 'dusk' | 'night' | 'flow';

export interface AudioMixLevels {
  stream: number;
  rain: number;
  night: number;
  duck: number;
}

export interface SavedPreferences {
  isNight: boolean;
  dayMode: DayMode;
  isRaining: boolean;
  windStrength: number;
  volume: number;
  muted: boolean;
  cameraPreset: CameraPresetId;
  audioMix: AudioMixLevels;
}

export type DuckActivity = 'DRIFT_IDLE' | 'CRUISE' | 'PAUSE_LOOK' | 'INVESTIGATE' | 'DOZE';

export interface DuckMotionSnapshot {
  x: number;
  z: number;
  vx: number;
  vz: number;
  speed: number;
  heading: number;
  angularVelocity: number;
  activity: DuckActivity;
}

export interface WorldStateSnapshot {
  time: number;
  /** 0 = warm twilight dusk, 1 = quiet forest night */
  dayPhase: number;
  targetDayPhase: number;
  /** 0 = mirror-calm, 1 = breezy gusting wind */
  windStrength: number;
  targetWindStrength: number;
  /** 0 = clear, 1 = soft evening rain */
  rainIntensity: number;
  targetRainIntensity: number;
  volume: number;
  muted: boolean;
  duck: DuckMotionSnapshot;
}

/**
 * Shared WorldState (共同状态)
 * Single source of truth connecting time, day/night phase, wind strength, audio settings,
 * and duck motion telemetry that feeds back into the water wake system.
 */
export class WorldState {
  public time = 0;
  public dayMode: DayMode = 'dusk';
  public dayPhase = 0.12; // Begin in soft late twilight
  public targetDayPhase = 0.12;
  private flowClock = 0;
  public windStrength = 0.28; // Gentle evening breeze by default
  public targetWindStrength = 0.28;
  public rainIntensity = 0.0;
  public targetRainIntensity = 0.0;
  public volume = 0.72;
  public muted = false;
  public cameraPreset: CameraPresetId = 'shore';
  public audioMix: AudioMixLevels = {
    stream: 1.0,
    rain: 1.0,
    night: 1.0,
    duck: 1.0,
  };

  /** Restful break / focus timer (0 = off) */
  public timerDurationSec = 0;
  public timerRemainingSec = 0;
  public timerActive = false;

  private onTimerComplete?: () => void;

  public duck: DuckMotionSnapshot = {
    x: -0.8,
    z: 0.4,
    vx: 0,
    vz: 0,
    speed: 0,
    heading: 0.4,
    angularVelocity: 0,
    activity: 'DRIFT_IDLE',
  };

  constructor() {
    this.restorePreferences();
  }

  public setTimerCompleteHandler(cb: () => void): void {
    this.onTimerComplete = cb;
  }

  public cycleRestTimer(): number {
    // Cycles: Off -> 5m -> 15m -> 25m -> Off
    const steps = [0, 5 * 60, 15 * 60, 25 * 60];
    const currIdx = steps.indexOf(this.timerDurationSec);
    const nextSec = steps[(currIdx + 1) % steps.length];
    this.timerDurationSec = nextSec;
    this.timerRemainingSec = nextSec;
    this.timerActive = nextSec > 0;
    return nextSec;
  }

  public setCameraPreset(preset: CameraPresetId): void {
    this.cameraPreset = preset;
    this.savePreferences();
  }

  public savePreferences(): void {
    try {
      const prefs: SavedPreferences = {
        isNight: this.isTargetNight(),
        dayMode: this.dayMode,
        isRaining: this.isTargetRaining(),
        windStrength: this.targetWindStrength,
        volume: this.volume,
        muted: this.muted,
        cameraPreset: this.cameraPreset,
        audioMix: { ...this.audioMix },
      };
      window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // Ignore storage quota / private mode restrictions
    }
  }

  private restorePreferences(): void {
    try {
      const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as Partial<SavedPreferences>;
      if (p.dayMode && ['dusk', 'night', 'flow'].includes(p.dayMode)) {
        this.dayMode = p.dayMode;
        this.dayPhase = p.dayMode === 'night' ? 1.0 : p.dayMode === 'flow' ? 0.25 : 0.12;
        this.targetDayPhase = this.dayPhase;
      } else if (typeof p.isNight === 'boolean') {
        this.dayMode = p.isNight ? 'night' : 'dusk';
        this.dayPhase = p.isNight ? 1.0 : 0.12;
        this.targetDayPhase = this.dayPhase;
      }
      if (typeof p.isRaining === 'boolean') {
        this.rainIntensity = p.isRaining ? 1.0 : 0.0;
        this.targetRainIntensity = this.rainIntensity;
      }
      if (typeof p.windStrength === 'number') {
        this.windStrength = clamp(p.windStrength, 0, 1);
        this.targetWindStrength = this.windStrength;
      }
      if (typeof p.volume === 'number') {
        this.volume = clamp(p.volume, 0, 1);
      }
      if (typeof p.muted === 'boolean') {
        this.muted = p.muted;
      }
      if (p.cameraPreset && ['shore', 'jetty', 'duck', 'overview'].includes(p.cameraPreset)) {
        this.cameraPreset = p.cameraPreset;
      }
      if (p.audioMix) {
        this.audioMix = {
          stream: clamp(p.audioMix.stream ?? 1.0, 0, 1.5),
          rain: clamp(p.audioMix.rain ?? 1.0, 0, 1.5),
          night: clamp(p.audioMix.night ?? 1.0, 0, 1.5),
          duck: clamp(p.audioMix.duck ?? 1.0, 0, 1.5),
        };
      }
    } catch {
      // Ignore corrupted prefs
    }
  }

  public cycleDayMode(): DayMode {
    const order: DayMode[] = ['dusk', 'night', 'flow'];
    const next = order[(order.indexOf(this.dayMode) + 1) % order.length];
    this.dayMode = next;
    if (next === 'dusk') {
      this.targetDayPhase = 0.12;
    } else if (next === 'night') {
      this.targetDayPhase = 1.0;
    } else {
      // Seed gentle flow clock from current dayPhase so transition is completely seamless
      const norm = clamp((this.dayPhase - 0.08) / 0.92, 0, 1);
      this.flowClock = Math.acos(1 - 2 * norm);
    }
    this.savePreferences();
    return next;
  }

  public setAudioMixChannel(channel: keyof AudioMixLevels, value: number): void {
    this.audioMix[channel] = clamp(value, 0, 1.5);
    this.savePreferences();
  }

  public resetAudioMix(): void {
    this.audioMix = { stream: 1.0, rain: 1.0, night: 1.0, duck: 1.0 };
    this.savePreferences();
  }

  public setDayNight(isNight: boolean): void {
    this.targetDayPhase = isNight ? 1.0 : 0.12;
    this.savePreferences();
  }

  public setTargetDayPhase(phase: number): void {
    this.targetDayPhase = clamp(phase, 0, 1);
  }

  public isTargetNight(): boolean {
    return this.targetDayPhase >= 0.55;
  }

  public setWindStrength(value: number): void {
    this.targetWindStrength = clamp(value, 0, 1);
    this.savePreferences();
  }

  public setRainEnabled(enabled: boolean): void {
    this.targetRainIntensity = enabled ? 1.0 : 0.0;
    this.savePreferences();
  }

  public isTargetRaining(): boolean {
    return this.targetRainIntensity >= 0.5;
  }

  public setVolume(value: number): void {
    this.volume = clamp(value, 0, 1);
    if (this.volume > 0.001 && this.muted) {
      this.muted = false;
    }
    this.savePreferences();
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    this.savePreferences();
  }

  public update(dt: number): void {
    this.time += dt;

    // Gentle ~12-minute slow twilight -> blue hour -> moonlit night -> dusk flow cycle
    if (this.dayMode === 'flow') {
      this.flowClock += dt * ((Math.PI * 2) / 720);
      this.targetDayPhase = 0.08 + 0.92 * (0.5 - 0.5 * Math.cos(this.flowClock));
    }

    // Smooth, unhurried transitions (~3.2s for dusk/night, ~1.8s for wind)
    const dayAlpha = 1 - Math.exp(-dt * 0.95);
    const windAlpha = 1 - Math.exp(-dt * 1.8);
    const rainAlpha = 1 - Math.exp(-dt * 1.15);
    this.dayPhase += (this.targetDayPhase - this.dayPhase) * dayAlpha;
    this.windStrength += (this.targetWindStrength - this.windStrength) * windAlpha;
    this.rainIntensity += (this.targetRainIntensity - this.rainIntensity) * rainAlpha;

    if (this.timerActive && this.timerRemainingSec > 0) {
      this.timerRemainingSec = Math.max(0, this.timerRemainingSec - dt);
      if (this.timerRemainingSec === 0) {
        this.timerActive = false;
        this.timerDurationSec = 0;
        this.onTimerComplete?.();
      }
    }
  }

  public getEffectiveVolume(): number {
    return this.muted ? 0 : this.volume;
  }
}
