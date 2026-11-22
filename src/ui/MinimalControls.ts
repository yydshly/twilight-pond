import { CAMERA_PRESET_ORDER, type CameraPresetId } from '../core/CameraDirector';
import type { AudioMixLevels, WorldState } from '../core/WorldState';
import type { AttributionLedger } from '../modules/AttributionLedger';

export interface ControlHandlers {
  onCallDuck: () => void;
  onCycleCamera: () => void;
  onSelectCamera: (id: CameraPresetId) => void;
  onCycleDayMode: () => void;
  onToggleRain: () => void;
  onWindChange: (wind: number) => void;
  onVolumeChange: (volume: number) => void;
  onToggleMute: () => void;
  onAudioMixChange: (channel: keyof AudioMixLevels, value: number) => void;
  onAudioMixReset: () => void;
  onCycleTimer: () => void;
  onToggleFullscreen: () => void;
  onAnyUserGesture: () => void;
  getCameraPresetLabel: () => string;
}

/**
 * Restrained, auto-fading companion product control bar:
 * 呼唤 / 视角(岸边·栈桥·追鸭·俯瞰) / 暮色·入夜 / 细雨 / 微风 / 音量·静音 / 静歇计时 / 全屏 / 账本
 * Supports H key for pure-zen hide-UI mode, 1-4 for instant vantage switching, and D for debug HUD.
 */
export class MinimalControls {
  private readonly barEl: HTMLElement;
  private readonly whisperEl: HTMLElement;
  private readonly whisperTitleEl: HTMLElement;
  private readonly whisperSubEl: HTMLElement;
  private readonly timerBadgeEl: HTMLElement;
  private readonly mixerEl: HTMLElement;
  private readonly modalEl: HTMLElement;
  private readonly hudEl: HTMLElement;

  private camBtn!: HTMLButtonElement;
  private dayBtn!: HTMLButtonElement;
  private rainBtn!: HTMLButtonElement;
  private muteBtn!: HTMLButtonElement;
  private mixerBtn!: HTMLButtonElement;
  private timerBtn!: HTMLButtonElement;
  private fsBtn!: HTMLButtonElement;
  private windInput!: HTMLInputElement;
  private volumeInput!: HTMLInputElement;
  private mixerInputs: Partial<Record<keyof AudioMixLevels, HTMLInputElement>> = {};

  private quietTimer = 0;
  private whisperFadeTimer = 0;
  private whisperDismissed = false;
  private mixerOpen = false;
  private zenHidden = false;
  private hudVisible = false;

  constructor(
    private readonly state: WorldState,
    private readonly ledger: AttributionLedger,
    private readonly handlers: ControlHandlers
  ) {
    this.barEl = document.getElementById('controls-bar')!;
    this.whisperEl = document.getElementById('whisper-overlay')!;
    this.whisperTitleEl = this.whisperEl.querySelector('.whisper-title')!;
    this.whisperSubEl = this.whisperEl.querySelector('.whisper-sub')!;
    this.timerBadgeEl = document.getElementById('timer-badge')!;
    this.mixerEl = document.getElementById('mixer-popover')!;
    this.modalEl = document.getElementById('ledger-modal')!;
    this.hudEl = document.getElementById('debug-hud')!;

    this.renderControls();
    this.renderMixerPopover();
    this.bindGlobalEvents();
    this.syncFromState();
    this.resetQuietTimer();
  }

  private renderControls(): void {
    this.barEl.innerHTML = `
      <button type="button" class="ctrl-btn" data-action="call">呼唤</button>
      <button type="button" class="ctrl-btn" data-action="camera" title="点击切换视角（快捷键 1-4），拖拽画面可 360° 自由环看">视角 · 岸边</button>
      <button type="button" class="ctrl-btn" data-action="daynight" title="切换 暮色 / 入夜 / 12 分钟天时慢流转">暮色</button>
      <button type="button" class="ctrl-btn" data-action="rain">细雨</button>
      <span class="ctrl-sep" aria-hidden="true"></span>
      <label class="ctrl-slider">
        <span>微风</span>
        <input type="range" min="0" max="1" step="0.01" data-input="wind" aria-label="风力调节" />
      </label>
      <label class="ctrl-slider">
        <span>音量</span>
        <input type="range" min="0" max="1" step="0.01" data-input="volume" aria-label="音量调节" />
      </label>
      <button type="button" class="ctrl-btn" data-action="mute">有声</button>
      <button type="button" class="ctrl-btn" data-action="mixer" title="展开四轨自然音景独立混音">调音</button>
      <span class="ctrl-sep" aria-hidden="true"></span>
      <button type="button" class="ctrl-btn" data-action="timer" title="切换静歇 / 专注计时（5/15/25 分钟）">静歇</button>
      <button type="button" class="ctrl-btn" data-action="fullscreen" title="全屏或按 H 隐藏控制条">全屏</button>
      <button type="button" class="ctrl-btn" data-action="ledger">账本</button>
    `;

    const callBtn = this.barEl.querySelector<HTMLButtonElement>('[data-action="call"]')!;
    this.camBtn = this.barEl.querySelector<HTMLButtonElement>('[data-action="camera"]')!;
    this.dayBtn = this.barEl.querySelector<HTMLButtonElement>('[data-action="daynight"]')!;
    this.rainBtn = this.barEl.querySelector<HTMLButtonElement>('[data-action="rain"]')!;
    this.muteBtn = this.barEl.querySelector<HTMLButtonElement>('[data-action="mute"]')!;
    this.mixerBtn = this.barEl.querySelector<HTMLButtonElement>('[data-action="mixer"]')!;
    this.timerBtn = this.barEl.querySelector<HTMLButtonElement>('[data-action="timer"]')!;
    this.fsBtn = this.barEl.querySelector<HTMLButtonElement>('[data-action="fullscreen"]')!;
    const ledgerBtn = this.barEl.querySelector<HTMLButtonElement>('[data-action="ledger"]')!;
    this.windInput = this.barEl.querySelector<HTMLInputElement>('[data-input="wind"]')!;
    this.volumeInput = this.barEl.querySelector<HTMLInputElement>('[data-input="volume"]')!;

    callBtn.addEventListener('click', () => {
      this.noteActivity();
      this.handlers.onCallDuck();
    });

    this.camBtn.addEventListener('click', () => {
      this.noteActivity();
      this.handlers.onCycleCamera();
      this.syncFromState();
    });

    this.dayBtn.addEventListener('click', () => {
      this.noteActivity();
      this.handlers.onCycleDayMode();
      this.syncFromState();
    });

    this.rainBtn.addEventListener('click', () => {
      this.noteActivity();
      this.handlers.onToggleRain();
      this.syncFromState();
    });

    this.windInput.addEventListener('input', () => {
      this.noteActivity();
      this.handlers.onWindChange(parseFloat(this.windInput.value));
    });

    this.volumeInput.addEventListener('input', () => {
      this.noteActivity();
      this.handlers.onVolumeChange(parseFloat(this.volumeInput.value));
      this.syncFromState();
    });

    this.muteBtn.addEventListener('click', () => {
      this.noteActivity();
      this.handlers.onToggleMute();
      this.syncFromState();
    });

    this.mixerBtn.addEventListener('click', () => {
      this.noteActivity();
      this.setMixerOpen(!this.mixerOpen);
    });

    this.timerBtn.addEventListener('click', () => {
      this.noteActivity();
      this.handlers.onCycleTimer();
      this.syncFromState();
    });

    this.fsBtn.addEventListener('click', () => {
      this.noteActivity();
      this.handlers.onToggleFullscreen();
    });

    ledgerBtn.addEventListener('click', () => {
      this.noteActivity();
      this.openLedgerModal();
    });

    this.modalEl.addEventListener('click', (e) => {
      if (e.target === this.modalEl) {
        this.closeLedgerModal();
      }
    });
  }

  private renderMixerPopover(): void {
    const channels: Array<{ key: keyof AudioMixLevels; label: string }> = [
      { key: 'stream', label: '溪流' },
      { key: 'rain', label: '细雨' },
      { key: 'night', label: '蛙虫' },
      { key: 'duck', label: '鸭叫' },
    ];

    this.mixerEl.innerHTML = `
      <div class="mixer-head">
        <span>音景独立微调</span>
        <button type="button" class="mixer-reset" data-action="reset-mix">恢复默认</button>
      </div>
      ${channels
        .map(
          (ch) => `
        <label class="mixer-row">
          <span>${ch.label}</span>
          <input type="range" min="0" max="1.5" step="0.05" data-mix="${ch.key}" aria-label="${ch.label}音量比例" />
        </label>`
        )
        .join('')}
    `;

    for (const ch of channels) {
      const inp = this.mixerEl.querySelector<HTMLInputElement>(`[data-mix="${ch.key}"]`)!;
      this.mixerInputs[ch.key] = inp;
      inp.addEventListener('input', () => {
        this.noteActivity();
        this.handlers.onAudioMixChange(ch.key, parseFloat(inp.value));
      });
    }

    const resetBtn = this.mixerEl.querySelector<HTMLButtonElement>('[data-action="reset-mix"]')!;
    resetBtn.addEventListener('click', () => {
      this.noteActivity();
      this.handlers.onAudioMixReset();
      this.syncFromState();
    });
  }

  private setMixerOpen(open: boolean): void {
    this.mixerOpen = open;
    this.mixerEl.classList.toggle('hidden', !open);
    this.mixerBtn.classList.toggle('active', open);
  }

  private bindGlobalEvents(): void {
    window.addEventListener('pointermove', () => this.resetQuietTimer(), { passive: true });
    document.addEventListener('fullscreenchange', () => this.syncFromState());

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeLedgerModal();
        this.setMixerOpen(false);
        if (this.zenHidden) {
          this.setZenHidden(false);
        }
      } else if (e.key === 'd' || e.key === 'D') {
        this.hudVisible = !this.hudVisible;
        this.hudEl.classList.toggle('hidden', !this.hudVisible);
      } else if (e.key === 'h' || e.key === 'H') {
        this.setZenHidden(!this.zenHidden);
      } else if (e.key >= '1' && e.key <= '4') {
        const preset = CAMERA_PRESET_ORDER[parseInt(e.key, 10) - 1];
        if (preset) {
          this.noteActivity();
          this.handlers.onSelectCamera(preset);
          this.syncFromState();
        }
      }
    });
  }

  private setZenHidden(hidden: boolean): void {
    this.zenHidden = hidden;
    this.barEl.classList.toggle('zen-hidden', hidden);
    if (hidden) {
      this.setMixerOpen(false);
      this.showTransientWhisper('纯粹模式', '按 H 或 Esc 恢复底部控制条', 2400);
    } else {
      this.dismissWhisper();
      this.resetQuietTimer();
    }
  }

  public showTransientWhisper(title: string, subtitle: string, durationMs = 4200): void {
    window.clearTimeout(this.whisperFadeTimer);
    this.whisperTitleEl.textContent = title;
    this.whisperSubEl.textContent = subtitle;
    this.whisperEl.classList.remove('faded');
    this.whisperDismissed = false;
    this.whisperFadeTimer = window.setTimeout(() => {
      this.dismissWhisper();
    }, durationMs);
  }

  public dismissWhisper(): void {
    if (this.whisperDismissed) return;
    this.whisperDismissed = true;
    this.whisperEl.classList.add('faded');
  }

  public syncFromState(): void {
    this.camBtn.textContent = `视角 · ${this.handlers.getCameraPresetLabel()}`;

    const mode = this.state.dayMode;
    this.dayBtn.textContent = mode === 'night' ? '入夜' : mode === 'flow' ? '流转' : '暮色';
    this.dayBtn.classList.toggle('active', mode !== 'dusk');

    const isRaining = this.state.isTargetRaining();
    this.rainBtn.textContent = isRaining ? '细雨中' : '细雨';
    this.rainBtn.classList.toggle('active', isRaining);

    this.windInput.value = this.state.targetWindStrength.toFixed(2);
    this.volumeInput.value = this.state.volume.toFixed(2);

    this.muteBtn.textContent = this.state.muted ? '静音' : '有声';
    this.muteBtn.classList.toggle('active', this.state.muted);

    (Object.keys(this.state.audioMix) as Array<keyof AudioMixLevels>).forEach((k) => {
      const inp = this.mixerInputs[k];
      if (inp) inp.value = this.state.audioMix[k].toFixed(2);
    });

    if (this.state.timerActive) {
      const mins = Math.round(this.state.timerDurationSec / 60);
      this.timerBtn.textContent = `静歇 ${mins}m`;
      this.timerBtn.classList.add('active');
    } else {
      this.timerBtn.textContent = '静歇';
      this.timerBtn.classList.remove('active');
    }

    const isFs = Boolean(document.fullscreenElement);
    this.fsBtn.textContent = isFs ? '退出' : '全屏';
    this.fsBtn.classList.toggle('active', isFs);
  }

  public updateLiveOverlays(info: {
    fps: number;
    wakeEnergy: number;
    audioReady: boolean;
  }): void {
    // Update subtle top-right countdown badge when rest timer is active
    if (this.state.timerActive) {
      const total = Math.ceil(this.state.timerRemainingSec);
      const mm = String(Math.floor(total / 60)).padStart(2, '0');
      const ss = String(total % 60).padStart(2, '0');
      this.timerBadgeEl.textContent = `静歇 ${mm}:${ss}`;
      this.timerBadgeEl.classList.remove('hidden');
    } else {
      this.timerBadgeEl.classList.add('hidden');
    }

    if (!this.hudVisible) return;
    const d = this.state.duck;
    this.hudEl.textContent = [
      `Twilight Pond Companion [D 隐藏 / H 纯粹 / 1-4 视角]`,
      `FPS: ${info.fps.toFixed(0)} | Audio: ${info.audioReady ? 'running' : 'waiting-gesture'} | Cam: ${this.state.cameraPreset}`,
      `Day: ${this.state.dayPhase.toFixed(2)} | Wind: ${this.state.windStrength.toFixed(2)} | Rain: ${this.state.rainIntensity.toFixed(2)}`,
      `Duck: ${d.activity} | Pos: (${d.x.toFixed(2)}, ${d.z.toFixed(2)}) | Speed: ${d.speed.toFixed(2)} m/s`,
    ].join('\n');
  }

  private openLedgerModal(): void {
    this.ledger.renderIntoModal(this.modalEl, () => this.closeLedgerModal());
    this.modalEl.classList.remove('hidden');
  }

  private closeLedgerModal(): void {
    this.modalEl.classList.add('hidden');
  }

  private noteActivity(): void {
    this.dismissWhisper();
    this.handlers.onAnyUserGesture();
    this.resetQuietTimer();
  }

  private resetQuietTimer(): void {
    this.barEl.classList.remove('quiet');
    window.clearTimeout(this.quietTimer);
    this.quietTimer = window.setTimeout(() => {
      this.barEl.classList.add('quiet');
    }, 6200);
  }
}
