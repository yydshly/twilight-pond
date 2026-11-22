import { clamp, lerp } from '../core/noise';
import type { AudioMixLevels } from '../core/WorldState';

export interface AudioAssetCallbacks {
  onAssetStatus?: (entryId: string, status: 'loaded-external' | 'active-procedural') => void;
}

/**
 * Reusable Module 3: AudioLifecycleManager (声音生命周期)
 * - Safe first-gesture AudioContext unlock with 1.5s gentle fade-in
 * - Automatic visibilitychange fade-out & suspend when tab is hidden, smooth fade-in on return
 * - Click-free 200ms gain ramping for volume & mute controls
 * - Hybrid playback: automatically loads external recordings from /assets/audio/* if present,
 *   otherwise runs warm, EQ-restrained procedural Web Audio soundscapes that never steal focus
 * - Enforces duck quack cooldown (6.5~10s), ±5% pitch variation, and distance low-pass softening
 */
export class AudioLifecycleManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private streamGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private nightGain: GainNode | null = null;
  private rainGain: GainNode | null = null;
  private eventGain: GainNode | null = null;
  private reverbSend: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private shortNoiseBuf: AudioBuffer | null = null;
  private nextRainDropTimer = 0.12;

  private isUnlocked = false;
  private isDisposed = false;
  private targetVolume = 0.72;
  private isMuted = false;
  private duckMixScale = 1.0;

  private externalStreamBuffer: AudioBuffer | null = null;
  private externalNightBuffer: AudioBuffer | null = null;
  private externalQuackBuffer: AudioBuffer | null = null;

  private usingExternalNight = false;
  private nextFrogTimer = 3.2;
  private nextCricketTimer = 1.4;
  private lastQuackTime = -20;
  private currentQuackCooldown = 7.0;

  private readonly callbacks: AudioAssetCallbacks;
  private readonly boundVisibilityHandler: () => void;

  constructor(callbacks: AudioAssetCallbacks = {}) {
    this.callbacks = callbacks;
    this.boundVisibilityHandler = () => this.handleVisibilityChange();
    document.addEventListener('visibilitychange', this.boundVisibilityHandler);
  }

  public isReady(): boolean {
    return this.isUnlocked && this.ctx !== null && this.ctx.state === 'running';
  }

  public async unlock(): Promise<void> {
    if (this.isDisposed) return;

    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;

      this.ctx = new AudioCtx();
      this.buildMixBuses(this.ctx);
      await this.tryLoadExternalBuffers(this.ctx);
      this.startAmbienceBeds(this.ctx);
    }

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    if (!this.isUnlocked && this.masterGain && this.ctx) {
      this.isUnlocked = true;
      const now = this.ctx.currentTime;
      const desired = this.isMuted ? 0 : this.targetVolume;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(0.0001, now);
      this.masterGain.gain.linearRampToValueAtTime(desired, now + 1.5);
    }
  }

  public setVolume(volume: number): void {
    this.targetVolume = clamp(volume, 0, 1);
    this.applyMasterGain(0.2);
  }

  public setMuted(muted: boolean): void {
    this.isMuted = muted;
    this.applyMasterGain(0.2);
  }

  public updateEnvironment(
    dayPhase: number,
    windStrength: number,
    dt: number,
    rainIntensity = 0,
    mix: AudioMixLevels = { stream: 1, rain: 1, night: 1, duck: 1 }
  ): void {
    this.duckMixScale = mix.duck;
    if (!this.ctx || !this.isUnlocked || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;

    if (this.streamGain) {
      const targetStream = lerp(0.22, 0.16, dayPhase) * mix.stream;
      this.streamGain.gain.setTargetAtTime(targetStream, now, 0.35);
    }

    if (this.windGain && this.windFilter) {
      const targetWind = lerp(0.015, 0.19, windStrength * windStrength * 0.7 + windStrength * 0.3);
      const targetFreq = lerp(240, 680, windStrength);
      this.windGain.gain.setTargetAtTime(targetWind, now, 0.4);
      this.windFilter.frequency.setTargetAtTime(targetFreq, now, 0.45);
    }

    if (this.nightGain) {
      const nightPresence = clamp((dayPhase - 0.15) / 0.85, 0, 1);
      const targetNight = lerp(0.03, 0.18, nightPresence) * lerp(1.0, 0.48, rainIntensity) * mix.night;
      this.nightGain.gain.setTargetAtTime(targetNight, now, 0.45);
    }

    if (this.rainGain) {
      const targetRain = rainIntensity * 0.24 * mix.rain;
      this.rainGain.gain.setTargetAtTime(targetRain, now, 0.4);
    }

    // Subtle natural noise-impulse raindrop patters on water & leaves (zero sine bloops)
    if (rainIntensity > 0.08) {
      this.nextRainDropTimer -= dt;
      if (this.nextRainDropTimer <= 0) {
        this.scheduleSoftRainDrop(rainIntensity);
        this.nextRainDropTimer = lerp(0.28, 0.055, rainIntensity) * (0.55 + Math.random() * 0.9);
      }
    }

    if (!this.usingExternalNight && dayPhase > 0.22) {
      const nightWeight = clamp((dayPhase - 0.22) / 0.78, 0, 1);

      this.nextFrogTimer -= dt;
      if (this.nextFrogTimer <= 0) {
        this.scheduleProceduralFrog(nightWeight);
        this.nextFrogTimer = lerp(5.5, 2.8, nightWeight) + Math.random() * 6.5;
      }

      this.nextCricketTimer -= dt;
      if (this.nextCricketTimer <= 0) {
        this.scheduleProceduralCricket(nightWeight);
        this.nextCricketTimer = lerp(3.4, 1.4, nightWeight) + Math.random() * 2.8;
      }
    }
  }

  public playWaterRipple(panX = 0, weight01 = 0.2): void {
    if (!this.ctx || !this.eventGain || !this.isUnlocked || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const w = clamp(weight01, 0, 1);

    const panner = this.ctx.createStereoPanner();
    panner.pan.setValueAtTime(clamp(panX, -0.75, 0.75), now);
    panner.connect(this.eventGain);

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    // Long-press feels deeper and fuller than a quick light tap
    const baseFreq = lerp(290, 185, w) + Math.random() * 85;
    const dur = lerp(0.14, 0.22, w);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(baseFreq, now);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * lerp(2.15, 1.85, w), now + dur * 0.65);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(lerp(0.08, 0.135, w), now + 0.014);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.connect(gain);
    gain.connect(panner);
    osc.start(now);
    osc.stop(now + dur + 0.02);

    const noiseBuf = this.createNoiseBuffer(this.ctx, 0.18, 'pink');
    const noise = this.ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(920 + Math.random() * 260, now);
    bp.Q.setValueAtTime(1.8, now);

    const nGain = this.ctx.createGain();
    nGain.gain.setValueAtTime(0.0001, now);
    nGain.gain.linearRampToValueAtTime(0.04, now + 0.02);
    nGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.17);

    noise.connect(bp);
    bp.connect(nGain);
    nGain.connect(panner);
    noise.start(now);
    noise.stop(now + 0.18);
  }

  public playDuckQuack(panX = 0, distance01 = 0.4, bypassMinorCooldown = false): boolean {
    if (!this.ctx || !this.eventGain || !this.isUnlocked || this.ctx.state !== 'running') {
      return false;
    }

    const now = this.ctx.currentTime;
    const minWait = bypassMinorCooldown ? 3.2 : this.currentQuackCooldown;
    if (now - this.lastQuackTime < minWait) {
      return false;
    }
    this.lastQuackTime = now;
    this.currentQuackCooldown = 6.5 + Math.random() * 3.5;

    const panner = this.ctx.createStereoPanner();
    panner.pan.setValueAtTime(clamp(panX, -0.75, 0.75), now);

    const distLP = this.ctx.createBiquadFilter();
    distLP.type = 'lowpass';
    distLP.frequency.setValueAtTime(lerp(2200, 1150, clamp(distance01, 0, 1)), now);
    distLP.connect(panner);
    panner.connect(this.eventGain);

    if (this.duckMixScale <= 0.01) return false;
    const level = lerp(0.14, 0.065, clamp(distance01, 0, 1)) * this.duckMixScale;
    const pitchJitter = 0.95 + Math.random() * 0.1;

    if (this.externalQuackBuffer) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.externalQuackBuffer;
      src.playbackRate.setValueAtTime(pitchJitter, now);
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(level * 1.4, now);
      src.connect(gain);
      gain.connect(distLP);
      src.start(now);
      return true;
    }

    // Natural wild mallard cadence: descending 2-to-3 syllable call ("QUAAK-quak-quk") or soft single chuckle
    const roll = Math.random();
    const syllables = roll < 0.35 ? 1 : roll < 0.8 ? 2 : 3;
    let cursor = now;
    for (let i = 0; i < syllables; i++) {
      const dur = i === 0 ? 0.175 + Math.random() * 0.035 : i === 1 ? 0.135 : 0.105;
      const amp = level * (i === 0 ? 1.05 : i === 1 ? 0.78 : 0.56);
      const pitchStep = pitchJitter * (1.0 - i * 0.065);
      this.synthesizeQuackSyllable(this.ctx, distLP, cursor, dur, amp, pitchStep);
      cursor += dur + 0.065 + Math.random() * 0.045;
    }

    return true;
  }

  /**
   * Biologically-modeled wild Mallard vocal tract:
   * Raspy low glottal source + 34Hz throat roughness AM + breathy airflow turbulence
   * shaped through 3 moving vocal-tract formants (eliminates synthetic kazoo sound).
   */
  private synthesizeQuackSyllable(
    ctx: AudioContext,
    dest: AudioNode,
    t0: number,
    dur: number,
    amp: number,
    pitchScale: number
  ): void {
    const syrinxMix = ctx.createGain();
    syrinxMix.gain.setValueAtTime(1.0, t0);

    // 1. Low gravelly glottal fundamental (wild mallard syrinx sits ~135..175Hz)
    const glottal = ctx.createOscillator();
    glottal.type = 'sawtooth';
    const fStart = (162 + Math.random() * 16) * pitchScale;
    glottal.frequency.setValueAtTime(fStart * 0.94, t0);
    glottal.frequency.linearRampToValueAtTime(fStart * 1.04, t0 + dur * 0.18);
    glottal.frequency.exponentialRampToValueAtTime(fStart * 0.72, t0 + dur);

    // Subtle secondary sub-harmonic body adds natural duck throat warmth
    const sub = ctx.createOscillator();
    sub.type = 'triangle';
    sub.frequency.setValueAtTime(fStart * 0.5, t0);
    sub.frequency.exponentialRampToValueAtTime(fStart * 0.38, t0 + dur);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.35, t0);

    // Fast ~34Hz amplitude roughness modulation gives authentic raspy "waaak" rattle
    const rattleLfo = ctx.createOscillator();
    rattleLfo.type = 'sine';
    rattleLfo.frequency.setValueAtTime(31 + Math.random() * 7, t0);
    const rattleDepth = ctx.createGain();
    rattleDepth.gain.setValueAtTime(0.28, t0);
    const rattleGate = ctx.createGain();
    rattleGate.gain.setValueAtTime(0.76, t0);
    rattleLfo.connect(rattleDepth);
    rattleDepth.connect(rattleGate.gain);

    glottal.connect(rattleGate);
    sub.connect(subGain);
    subGain.connect(rattleGate);
    rattleGate.connect(syrinxMix);

    // 2. Breathy turbulent airflow noise mixed into the vocal tract
    const breath = ctx.createBufferSource();
    breath.buffer = this.shortNoiseBuf ?? this.createNoiseBuffer(ctx, 0.4, 'pink');
    const breathGain = ctx.createGain();
    breathGain.gain.setValueAtTime(0.52, t0);
    breath.connect(breathGain);
    breathGain.connect(syrinxMix);

    // 3. Three moving mallard vocal-tract formants (nasal open -> closed vowel sweep)
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.setValueAtTime(740 * pitchScale, t0);
    f1.frequency.exponentialRampToValueAtTime(490 * pitchScale, t0 + dur);
    f1.Q.setValueAtTime(3.2, t0);

    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.setValueAtTime(1480 * pitchScale, t0);
    f2.frequency.exponentialRampToValueAtTime(1060 * pitchScale, t0 + dur);
    f2.Q.setValueAtTime(3.8, t0);

    const f3 = ctx.createBiquadFilter();
    f3.type = 'bandpass';
    f3.frequency.setValueAtTime(2480 * pitchScale, t0);
    f3.frequency.exponentialRampToValueAtTime(1920 * pitchScale, t0 + dur);
    f3.Q.setValueAtTime(3.0, t0);

    const f1G = ctx.createGain();
    f1G.gain.value = 1.15;
    const f2G = ctx.createGain();
    f2G.gain.value = 0.88;
    const f3G = ctx.createGain();
    f3G.gain.value = 0.34;

    // Natural organic breathy amplitude envelope (crisp onset, resonant peak, soft taper)
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(amp * 1.15, t0 + 0.018);
    env.gain.exponentialRampToValueAtTime(amp * 0.68, t0 + dur * 0.55);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    syrinxMix.connect(f1);
    syrinxMix.connect(f2);
    syrinxMix.connect(f3);
    f1.connect(f1G);
    f2.connect(f2G);
    f3.connect(f3G);
    f1G.connect(env);
    f2G.connect(env);
    f3G.connect(env);
    env.connect(dest);

    glottal.start(t0);
    sub.start(t0);
    rattleLfo.start(t0);
    breath.start(t0);

    const stopAt = t0 + dur + 0.035;
    glottal.stop(stopAt);
    sub.stop(stopAt);
    rattleLfo.stop(stopAt);
    breath.stop(stopAt);
  }

  private buildMixBuses(ctx: AudioContext): void {
    const masterWarmth = ctx.createBiquadFilter();
    masterWarmth.type = 'lowpass';
    masterWarmth.frequency.value = 5400;

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0.0001;
    this.masterGain.connect(masterWarmth);
    masterWarmth.connect(ctx.destination);

    this.streamGain = ctx.createGain();
    this.streamGain.gain.value = 0.2;
    this.streamGain.connect(this.masterGain);

    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.04;
    this.windGain.connect(this.masterGain);

    this.nightGain = ctx.createGain();
    this.nightGain.gain.value = 0.05;
    this.nightGain.connect(this.masterGain);

    this.shortNoiseBuf = this.createNoiseBuffer(ctx, 0.6, 'pink');

    // Outdoor lakeside stereo reflection reverb (gives duck calls, ripples & rain genuine open-air depth)
    const convolver = ctx.createConvolver();
    convolver.buffer = this.createLakesideReverbIR(ctx, 1.35);
    const reverbLP = ctx.createBiquadFilter();
    reverbLP.type = 'lowpass';
    reverbLP.frequency.value = 2400;
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.24;
    this.reverbSend.connect(convolver);
    convolver.connect(reverbLP);
    reverbLP.connect(this.masterGain);

    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0.0001;
    this.rainGain.connect(this.masterGain);
    this.rainGain.connect(this.reverbSend);

    this.eventGain = ctx.createGain();
    this.eventGain.gain.value = 0.85;
    this.eventGain.connect(this.masterGain);
    this.eventGain.connect(this.reverbSend);
  }

  private createLakesideReverbIR(ctx: AudioContext, durationSec: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * durationSec);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // Soft open-air tree-line reflection decay with slight pre-delay
        const preDelay = i < ctx.sampleRate * 0.018 ? 0.15 : 1.0;
        const env = Math.pow(1 - t, 2.8) * preDelay;
        data[i] = (Math.random() * 2 - 1) * env * 0.55;
      }
    }
    return buf;
  }

  private async tryLoadExternalBuffers(ctx: AudioContext): Promise<void> {
    const load = async (url: string): Promise<AudioBuffer | null> => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('text/html')) return null;
        const arr = await res.arrayBuffer();
        return await ctx.decodeAudioData(arr);
      } catch {
        return null;
      }
    };

    const [streamBuf, nightBuf, quackBuf] = await Promise.all([
      load('./assets/audio/stream.mp3'),
      load('./assets/audio/frogs_insects.mp3'),
      load('./assets/audio/duck_quack.mp3'),
    ]);

    this.externalStreamBuffer = streamBuf;
    this.externalNightBuffer = nightBuf;
    this.externalQuackBuffer = quackBuf;
    this.usingExternalNight = nightBuf !== null;

    this.callbacks.onAssetStatus?.(
      'stream-ambience',
      streamBuf ? 'loaded-external' : 'active-procedural'
    );
    this.callbacks.onAssetStatus?.(
      'frog-insect-ambience',
      nightBuf ? 'loaded-external' : 'active-procedural'
    );
    this.callbacks.onAssetStatus?.(
      'short-duck-quack',
      quackBuf ? 'loaded-external' : 'active-procedural'
    );
  }

  private startAmbienceBeds(ctx: AudioContext): void {
    if (this.streamGain) {
      if (this.externalStreamBuffer) {
        const src = ctx.createBufferSource();
        src.buffer = this.externalStreamBuffer;
        src.loop = true;
        src.connect(this.streamGain);
        src.start();
      } else {
        const brownNoise = this.createNoiseBuffer(ctx, 8, 'brown');
        const bodySrc = ctx.createBufferSource();
        bodySrc.buffer = brownNoise;
        bodySrc.loop = true;

        const bodyLP = ctx.createBiquadFilter();
        bodyLP.type = 'lowpass';
        bodyLP.frequency.value = 420;

        bodySrc.connect(bodyLP);
        bodyLP.connect(this.streamGain);
        bodySrc.start();

        const pinkNoise = this.createNoiseBuffer(ctx, 7, 'pink');
        const babbleSrc = ctx.createBufferSource();
        babbleSrc.buffer = pinkNoise;
        babbleSrc.loop = true;

        const babbleBP = ctx.createBiquadFilter();
        babbleBP.type = 'bandpass';
        babbleBP.frequency.value = 1050;
        babbleBP.Q.value = 0.85;

        const babbleGain = ctx.createGain();
        babbleGain.gain.value = 0.24;

        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.13;
        const lfoDepth = ctx.createGain();
        lfoDepth.gain.value = 210;
        lfo.connect(lfoDepth);
        lfoDepth.connect(babbleBP.frequency);
        lfo.start();

        babbleSrc.connect(babbleBP);
        babbleBP.connect(babbleGain);
        babbleGain.connect(this.streamGain);
        babbleSrc.start();
      }
    }

    if (this.windGain) {
      const pink = this.createNoiseBuffer(ctx, 9, 'pink');
      const windSrc = ctx.createBufferSource();
      windSrc.buffer = pink;
      windSrc.loop = true;

      this.windFilter = ctx.createBiquadFilter();
      this.windFilter.type = 'bandpass';
      this.windFilter.frequency.value = 340;
      this.windFilter.Q.value = 1.2;

      const gustLfo = ctx.createOscillator();
      gustLfo.frequency.value = 0.085;
      const gustDepth = ctx.createGain();
      gustDepth.gain.value = 110;
      gustLfo.connect(gustDepth);
      gustDepth.connect(this.windFilter.frequency);
      gustLfo.start();

      windSrc.connect(this.windFilter);
      this.windFilter.connect(this.windGain);
      windSrc.start();
    }

    if (this.nightGain && this.externalNightBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = this.externalNightBuffer;
      src.loop = true;
      const soften = ctx.createBiquadFilter();
      soften.type = 'lowpass';
      soften.frequency.value = 3200;
      src.connect(soften);
      soften.connect(this.nightGain);
      src.start();
    }

    // 4. Layered natural evening drizzle (stereo canopy rain sheet + delicate liquid water shimmer)
    if (this.rainGain) {
      const canopyNoise = this.createNoiseBuffer(ctx, 8, 'pink');
      const canopySrc = ctx.createBufferSource();
      canopySrc.buffer = canopyNoise;
      canopySrc.loop = true;

      const canopyHP = ctx.createBiquadFilter();
      canopyHP.type = 'highpass';
      canopyHP.frequency.value = 340;
      const canopyLP = ctx.createBiquadFilter();
      canopyLP.type = 'lowpass';
      canopyLP.frequency.value = 1850;
      const canopyGain = ctx.createGain();
      canopyGain.gain.value = 0.82;

      canopySrc.connect(canopyHP);
      canopyHP.connect(canopyLP);
      canopyLP.connect(canopyGain);
      canopyGain.connect(this.rainGain);
      canopySrc.start();

      // Airy near-water raindrop sizzle layer
      const pondNoise = this.createNoiseBuffer(ctx, 7, 'pink');
      const pondSrc = ctx.createBufferSource();
      pondSrc.buffer = pondNoise;
      pondSrc.loop = true;
      const pondBP = ctx.createBiquadFilter();
      pondBP.type = 'bandpass';
      pondBP.frequency.value = 2800;
      pondBP.Q.value = 0.65;
      const pondGain = ctx.createGain();
      pondGain.gain.value = 0.24;

      pondSrc.connect(pondBP);
      pondBP.connect(pondGain);
      pondGain.connect(this.rainGain);
      pondSrc.start();
    }
  }

  /**
   * Natural acoustic raindrop patter: ultra-short filtered noise impulse (zero electronic sine chirps!).
   */
  private scheduleSoftRainDrop(rainIntensity: number): void {
    if (!this.ctx || !this.rainGain) return;
    const now = this.ctx.currentTime;
    const pan = this.ctx.createStereoPanner();
    pan.pan.setValueAtTime((Math.random() - 0.5) * 1.6, now);
    pan.connect(this.rainGain);

    const src = this.ctx.createBufferSource();
    src.buffer = this.shortNoiseBuf ?? this.createNoiseBuffer(this.ctx, 0.3, 'pink');

    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1150 + Math.random() * 2100, now);
    bp.Q.setValueAtTime(2.6 + Math.random() * 2.4, now);

    const dur = 0.014 + Math.random() * 0.018;
    const env = this.ctx.createGain();
    const peak = (0.12 + Math.random() * 0.14) * rainIntensity;
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(peak, now + 0.0025);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(bp);
    bp.connect(env);
    env.connect(pan);
    src.start(now, Math.random() * 0.25, dur + 0.01);
  }

  private scheduleProceduralFrog(nightWeight: number): void {
    if (!this.ctx || !this.nightGain) return;
    const now = this.ctx.currentTime;
    const pan = this.ctx.createStereoPanner();
    pan.pan.setValueAtTime((Math.random() - 0.5) * 1.4, now);
    pan.connect(this.nightGain);

    const pulses = Math.random() < 0.65 ? 2 : 1;
    const basePitch = 135 + Math.random() * 55;
    for (let i = 0; i < pulses; i++) {
      const t0 = now + i * (0.28 + Math.random() * 0.06);
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(basePitch, t0);
      osc.frequency.exponentialRampToValueAtTime(basePitch * 1.28, t0 + 0.07);
      osc.frequency.exponentialRampToValueAtTime(basePitch * 0.88, t0 + 0.19);

      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(520, t0);

      const env = this.ctx.createGain();
      const peak = (0.14 + Math.random() * 0.08) * nightWeight;
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.linearRampToValueAtTime(peak, t0 + 0.03);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.21);

      osc.connect(lp);
      lp.connect(env);
      env.connect(pan);
      osc.start(t0);
      osc.stop(t0 + 0.24);
    }
  }

  private scheduleProceduralCricket(nightWeight: number): void {
    if (!this.ctx || !this.nightGain) return;
    const now = this.ctx.currentTime;
    const pan = this.ctx.createStereoPanner();
    pan.pan.setValueAtTime((Math.random() - 0.5) * 1.5, now);
    pan.connect(this.nightGain);

    const freq = 3150 + Math.random() * 480;
    const chirps = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < chirps; i++) {
      const t0 = now + i * 0.085;
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t0);

      const env = this.ctx.createGain();
      const peak = (0.022 + Math.random() * 0.012) * nightWeight;
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.linearRampToValueAtTime(peak, t0 + 0.015);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.062);

      osc.connect(env);
      env.connect(pan);
      osc.start(t0);
      osc.stop(t0 + 0.07);
    }
  }

  private createNoiseBuffer(
    ctx: AudioContext,
    durationSec: number,
    color: 'pink' | 'brown'
  ): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * durationSec);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    if (color === 'brown') {
      let lastOut = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        lastOut = (lastOut + 0.02 * white) / 1.02;
        data[i] = lastOut * 3.0;
      }
    } else {
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      let b3 = 0;
      let b4 = 0;
      let b5 = 0;
      let b6 = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.08;
        b6 = white * 0.115926;
      }
    }

    const fadeSamples = Math.min(Math.floor(ctx.sampleRate * 0.15), Math.floor(length * 0.1));
    for (let i = 0; i < fadeSamples; i++) {
      const t = i / fadeSamples;
      data[length - fadeSamples + i] = lerp(data[length - fadeSamples + i], data[i], t);
    }

    return buffer;
  }

  private applyMasterGain(rampSec: number): void {
    if (!this.ctx || !this.masterGain || !this.isUnlocked) return;
    const now = this.ctx.currentTime;
    const desired = this.isMuted ? 0 : this.targetVolume;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
    this.masterGain.gain.linearRampToValueAtTime(desired, now + rampSec);
  }

  private handleVisibilityChange(): void {
    if (!this.ctx || !this.masterGain || !this.isUnlocked) return;
    const now = this.ctx.currentTime;
    if (document.hidden) {
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
      this.masterGain.gain.linearRampToValueAtTime(0.0001, now + 0.35);
      window.setTimeout(() => {
        if (document.hidden && this.ctx?.state === 'running') {
          void this.ctx.suspend();
        }
      }, 400);
    } else {
      void this.ctx.resume().then(() => {
        if (!this.ctx || !this.masterGain) return;
        const t = this.ctx.currentTime;
        const desired = this.isMuted ? 0 : this.targetVolume;
        this.masterGain.gain.cancelScheduledValues(t);
        this.masterGain.gain.setValueAtTime(0.0001, t);
        this.masterGain.gain.linearRampToValueAtTime(desired, t + 0.9);
      });
    }
  }

  public dispose(): void {
    this.isDisposed = true;
    document.removeEventListener('visibilitychange', this.boundVisibilityHandler);
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
