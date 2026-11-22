export interface LedgerEntry {
  id: string;
  name: string;
  category: 'model' | 'audio' | 'texture' | 'hdri' | string;
  localPath: string;
  status: string;
  license: string;
  author: string;
  sourceUrl: string;
  modifications: string;
}

export interface LedgerDocument {
  schemaVersion: string;
  project: string;
  notes: string;
  entries: LedgerEntry[];
}

/**
 * Reusable Module 4: AttributionLedger (来源账本)
 * Loads, validates, and renders license & modification records (e.g. CC BY 4.0 duck, CC BY 3.0 frogs/insects).
 */
export class AttributionLedger {
  private doc: LedgerDocument | null = null;
  private readonly runtimeStatusOverrides = new Map<string, string>();

  public async load(url = './assets/ledger.json'): Promise<LedgerDocument> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const parsed = (await response.json()) as LedgerDocument;
      this.doc = parsed;
      return parsed;
    } catch {
      this.doc = {
        schemaVersion: '1.0.0',
        project: '暮色池塘',
        notes: '未读取到外部 ledger.json，当前使用内置默认账本记录。',
        entries: [
          {
            id: 'mallard-duck-model',
            name: '绿头鸭主体',
            category: 'model',
            localPath: '/assets/models/mallard.glb',
            status: 'active-procedural',
            license: 'CC BY 4.0（预留外部署名槽位）',
            author: '程序化绿头鸭兜底',
            sourceUrl: 'local://procedural-mallard',
            modifications: '无原生骨骼动画，运行时采用顶点微变形与水面浮力耦合。',
          },
          {
            id: 'frog-insect-ambience',
            name: '蛙虫环境录音',
            category: 'audio',
            localPath: '/assets/audio/frogs_insects.mp3',
            status: 'active-procedural',
            license: 'CC BY 3.0（预留外部署名槽位）',
            author: 'Web Audio 程序化夜声兜底',
            sourceUrl: 'local://procedural-nightlife',
            modifications: '低通柔化与日夜平滑混音。',
          },
        ],
      };
      return this.doc;
    }
  }

  public setRuntimeStatus(entryId: string, status: string): void {
    this.runtimeStatusOverrides.set(entryId, status);
  }

  public renderIntoModal(container: HTMLElement, onClose: () => void): void {
    const doc = this.doc;
    if (!doc) return;

    const rowsHtml = doc.entries
      .map((entry) => {
        const liveStatus = this.runtimeStatusOverrides.get(entry.id) ?? entry.status;
        const statusLabel =
          liveStatus === 'loaded-external'
            ? '外部素材已加载'
            : liveStatus === 'active-procedural' || liveStatus === 'procedural-fallback-ready'
              ? '程序化兜底运行中'
              : liveStatus;

        const safeUrl =
          entry.sourceUrl.startsWith('http://') || entry.sourceUrl.startsWith('https://')
            ? `<a href="${this.escapeHtml(entry.sourceUrl)}" target="_blank" rel="noreferrer">${this.escapeHtml(entry.sourceUrl)}</a>`
            : `<span>${this.escapeHtml(entry.sourceUrl)}</span>`;

        return `
          <article class="ledger-card">
            <div class="ledger-card-head">
              <strong>${this.escapeHtml(entry.name)}</strong>
              <span class="ledger-badge">${this.escapeHtml(entry.license)}</span>
            </div>
            <div class="ledger-meta">
              <span><b>状态：</b>${this.escapeHtml(statusLabel)}</span>
              <span><b>路径：</b><code>${this.escapeHtml(entry.localPath)}</code></span>
              <span><b>署名：</b>${this.escapeHtml(entry.author)}</span>
              <span><b>来源：</b>${safeUrl}</span>
            </div>
            <p class="ledger-mod"><b>修改说明：</b>${this.escapeHtml(entry.modifications)}</p>
          </article>
        `;
      })
      .join('');

    container.innerHTML = `
      <div class="ledger-panel">
        <header class="ledger-header">
          <div>
            <h2 id="ledger-title">来源与署名账本</h2>
            <p class="ledger-note">${this.escapeHtml(doc.notes)}</p>
          </div>
          <button type="button" class="ledger-close" aria-label="关闭来源账本">关闭</button>
        </header>
        <div class="ledger-list">${rowsHtml}</div>
      </div>
    `;

    const closeBtn = container.querySelector<HTMLButtonElement>('.ledger-close');
    closeBtn?.addEventListener('click', onClose);
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
