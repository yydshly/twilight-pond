import * as THREE from 'three';
import { clamp, fbm2D, lerp } from '../core/noise';

export interface PBRTextureSet {
  map: THREE.Texture;
  roughnessMap: THREE.Texture;
  normalMap: THREE.Texture;
}

type ProceduralPreset = 'wetMud' | 'bark' | 'cabinWood';

/**
 * Reusable Module 1: PBRTextureCache (PBR 纹理缓存)
 * - Deduplicates texture creation & external image loading
 * - Enforces correct sRGB vs Linear color spaces
 * - Generates seamless procedural PBR triplets (albedo / roughness / normal) as zero-dependency baseline
 * - Tracks and disposes GPU textures cleanly
 */
export class PBRTextureCache {
  private readonly singleTextures = new Map<string, THREE.Texture>();
  private readonly pbrSets = new Map<string, PBRTextureSet>();
  private readonly loader = new THREE.TextureLoader();
  private maxAnisotropy = 4;

  public getWaterNormalMap(repeat = 6): THREE.Texture {
    const key = `proc:waterNormal:${repeat}`;
    const existing = this.singleTextures.get(key);
    if (existing) return existing;

    const size = 256;
    const hField = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        // Multi-scale organic capillary & ripple heightfield (zero straight line artifacts)
        const n1 = this.tileableFbm(u, v, 5, 3);
        const n2 = this.tileableFbm(u + 0.37, v + 0.61, 11, 3);
        const n3 = this.tileableFbm(u + 0.73, v + 0.19, 21, 2);
        hField[y * size + x] = n1 * 0.55 + n2 * 0.32 + n3 * 0.13;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(size, size);
    const strength = 4.5;

    for (let y = 0; y < size; y++) {
      const ym = (y - 1 + size) % size;
      const yp = (y + 1) % size;
      for (let x = 0; x < size; x++) {
        const xm = (x - 1 + size) % size;
        const xp = (x + 1) % size;
        const dx = (hField[y * size + xp] - hField[y * size + xm]) * strength;
        const dy = (hField[yp * size + x] - hField[ym * size + x]) * strength;
        const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
        const p = (y * size + x) * 4;
        img.data[p] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
        img.data[p + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
        img.data[p + 2] = Math.round((inv * 0.5 + 0.5) * 255);
        img.data[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    const tex = this.configureCanvasTexture(canvas, false, repeat, repeat);
    this.singleTextures.set(key, tex);
    return tex;
  }

  public getFoliageTexture(kind: 'pine' | 'leaf'): THREE.Texture {
    const key = `proc:foliage:${kind}`;
    const existing = this.singleTextures.get(key);
    if (existing) return existing;

    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);

    if (kind === 'pine') {
      // Physically-calibrated pine needle sprays (natural forest green albedo, lit by scene sun & sky)
      for (let b = 0; b < 56; b++) {
        const ang = (b / 56) * Math.PI * 2 + Math.sin(b * 3.7) * 0.22;
        const dist = 12 + ((b * 37) % 88);
        const cx = 128 + Math.cos(ang) * dist * 0.72;
        const cy = 128 + Math.sin(ang) * dist * 0.72;
        const base = 78 + ((b * 19) % 48);
        ctx.strokeStyle = `rgba(${Math.round(base * 0.76)}, ${Math.round(base * 1.12)}, ${Math.round(base * 0.78)}, 0.96)`;
        ctx.lineWidth = 2.8;
        for (let n = -4; n <= 4; n++) {
          const na = ang + n * 0.22;
          const len = 18 + ((b + Math.abs(n) * 7) % 20);
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(na) * len, cy + Math.sin(na) * len);
          ctx.stroke();
        }
      }
    } else {
      // Physically-calibrated deciduous woodland leaves (mid-tone olive/sage green albedo)
      for (let i = 0; i < 120; i++) {
        const a = i * 2.39996;
        const r = Math.sqrt(i / 120) * 98;
        const cx = 128 + Math.cos(a) * r;
        const cy = 128 + Math.sin(a) * r;
        const rx = 11 + ((i * 13) % 12);
        const ry = 7 + ((i * 7) % 8);
        const g = 112 + ((i * 17) % 58);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(a + (i % 5) * 0.3);
        ctx.fillStyle = `rgba(${Math.round(g * 0.78)}, ${g}, ${Math.round(g * 0.64)}, 0.96)`;
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.maxAnisotropy;
    tex.needsUpdate = true;
    this.singleTextures.set(key, tex);
    return tex;
  }

  public getSoftGlowTexture(): THREE.Texture {
    const key = 'proc:softGlow';
    const existing = this.singleTextures.get(key);
    if (existing) return existing;

    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d')!;
    const grad = ctx.createRadialGradient(32, 32, 1, 32, 32, 31);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.52)');
    grad.addColorStop(0.7, 'rgba(255,255,255,0.14)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);

    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    this.singleTextures.set(key, tex);
    return tex;
  }

  public setMaxAnisotropy(anisotropy: number): void {
    this.maxAnisotropy = Math.max(1, Math.min(8, anisotropy));
    for (const tex of this.singleTextures.values()) {
      tex.anisotropy = this.maxAnisotropy;
    }
    for (const set of this.pbrSets.values()) {
      set.map.anisotropy = this.maxAnisotropy;
      set.roughnessMap.anisotropy = this.maxAnisotropy;
      set.normalMap.anisotropy = this.maxAnisotropy;
    }
  }

  public loadExternalTexture(
    url: string,
    options: { isColor?: boolean; repeatX?: number; repeatY?: number } = {}
  ): THREE.Texture {
    const key = `${url}|${options.isColor ?? true}|${options.repeatX ?? 1}|${options.repeatY ?? 1}`;
    const existing = this.singleTextures.get(key);
    if (existing) return existing;

    const tex = this.loader.load(url);
    tex.colorSpace = options.isColor === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(options.repeatX ?? 1, options.repeatY ?? 1);
    tex.anisotropy = this.maxAnisotropy;
    this.singleTextures.set(key, tex);
    return tex;
  }

  public getProceduralPBR(
    preset: ProceduralPreset,
    repeatX = 4,
    repeatY = 4
  ): PBRTextureSet {
    const key = `proc:${preset}:${repeatX}x${repeatY}`;
    const existing = this.pbrSets.get(key);
    if (existing) return existing;

    const size = 256;
    const heightField = new Float32Array(size * size);

    const albedoCanvas = document.createElement('canvas');
    albedoCanvas.width = size;
    albedoCanvas.height = size;
    const albedoCtx = albedoCanvas.getContext('2d')!;
    const albedoImg = albedoCtx.createImageData(size, size);

    const roughCanvas = document.createElement('canvas');
    roughCanvas.width = size;
    roughCanvas.height = size;
    const roughCtx = roughCanvas.getContext('2d')!;
    const roughImg = roughCtx.createImageData(size, size);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        const idx = y * size + x;
        const p = idx * 4;

        let r = 90;
        let g = 80;
        let b = 70;
        let rough = 0.7;
        let h = 0.5;

        if (preset === 'wetMud') {
          const macro = this.tileableFbm(u, v, 4, 4);
          const grain = this.tileableFbm(u + 3.1, v + 1.7, 14, 3);
          const pebble = Math.pow(this.tileableFbm(u + 7.4, v + 5.2, 22, 2), 3);
          h = clamp(macro * 0.65 + grain * 0.25 + pebble * 0.25, 0, 1);

          // Physically accurate damp woodland soil/peat albedo (vertex colors tint mud vs moss)
          r = Math.round(lerp(98, 146, macro) + grain * 18);
          g = Math.round(lerp(94, 138, macro) + grain * 16);
          b = Math.round(lerp(82, 118, macro) + grain * 12);
          rough = clamp(lerp(0.68, 0.96, h), 0.55, 0.98);
        } else if (preset === 'bark') {
          const ridge = this.tileableFbm(u * 2.5, v * 0.45, 8, 4);
          const fine = this.tileableFbm(u * 4.0, v * 1.2, 16, 3);
          h = clamp(ridge * 0.78 + fine * 0.22, 0, 1);

          r = Math.round(lerp(76, 134, h));
          g = Math.round(lerp(66, 114, h));
          b = Math.round(lerp(56, 96, h));
          rough = clamp(lerp(0.82, 0.98, 1 - h * 0.4), 0.75, 0.98);
        } else {
          // Weathered warm lakeside cedar planks
          const plankBand = Math.floor(v * 8) / 8;
          const seamDist = Math.abs(((v * 8) % 1) - 0.5) * 2;
          const seam = seamDist > 0.93 ? 0.38 : 1.0;
          const grain = this.tileableFbm(u * 0.6 + plankBand * 5.1, v * 6.5, 10, 3);
          h = clamp((grain * 0.7 + 0.3) * seam, 0, 1);

          const tone = 0.88 + 0.24 * fbm2D(plankBand * 11.3, 2.7, 2);
          r = Math.round(clamp(lerp(116, 174, grain) * tone * seam, 42, 210));
          g = Math.round(clamp(lerp(86, 134, grain) * tone * seam, 32, 170));
          b = Math.round(clamp(lerp(64, 102, grain) * tone * seam, 24, 135));
          rough = clamp(lerp(0.74, 0.94, 1 - grain * 0.35), 0.68, 0.96);
        }

        heightField[idx] = h;
        albedoImg.data[p] = r;
        albedoImg.data[p + 1] = g;
        albedoImg.data[p + 2] = b;
        albedoImg.data[p + 3] = 255;

        const rByte = Math.round(rough * 255);
        roughImg.data[p] = rByte;
        roughImg.data[p + 1] = rByte;
        roughImg.data[p + 2] = rByte;
        roughImg.data[p + 3] = 255;
      }
    }

    albedoCtx.putImageData(albedoImg, 0, 0);
    roughCtx.putImageData(roughImg, 0, 0);

    // Derive tangent-space normal map from heightField
    const normalCanvas = document.createElement('canvas');
    normalCanvas.width = size;
    normalCanvas.height = size;
    const normalCtx = normalCanvas.getContext('2d')!;
    const normalImg = normalCtx.createImageData(size, size);
    const strength = preset === 'bark' ? 3.2 : 2.1;

    for (let y = 0; y < size; y++) {
      const ym = (y - 1 + size) % size;
      const yp = (y + 1) % size;
      for (let x = 0; x < size; x++) {
        const xm = (x - 1 + size) % size;
        const xp = (x + 1) % size;
        const dx = (heightField[y * size + xp] - heightField[y * size + xm]) * strength;
        const dy = (heightField[yp * size + x] - heightField[ym * size + x]) * strength;
        const nz = 1.0;
        const invLen = 1 / Math.sqrt(dx * dx + dy * dy + nz * nz);
        const p = (y * size + x) * 4;
        normalImg.data[p] = Math.round((-dx * invLen * 0.5 + 0.5) * 255);
        normalImg.data[p + 1] = Math.round((-dy * invLen * 0.5 + 0.5) * 255);
        normalImg.data[p + 2] = Math.round((nz * invLen * 0.5 + 0.5) * 255);
        normalImg.data[p + 3] = 255;
      }
    }
    normalCtx.putImageData(normalImg, 0, 0);

    const map = this.configureCanvasTexture(albedoCanvas, true, repeatX, repeatY);
    const roughnessMap = this.configureCanvasTexture(roughCanvas, false, repeatX, repeatY);
    const normalMap = this.configureCanvasTexture(normalCanvas, false, repeatX, repeatY);

    const set: PBRTextureSet = { map, roughnessMap, normalMap };
    this.pbrSets.set(key, set);
    return set;
  }

  /**
   * Seamless 2D fBm by blending across periodic domain wrap.
   */
  private tileableFbm(u: number, v: number, freq: number, octaves: number): number {
    const x = ((u % 1) + 1) % 1;
    const y = ((v % 1) + 1) % 1;
    const a = fbm2D(x * freq, y * freq, octaves);
    const b = fbm2D((x - 1) * freq, y * freq, octaves);
    const c = fbm2D(x * freq, (y - 1) * freq, octaves);
    const d = fbm2D((x - 1) * freq, (y - 1) * freq, octaves);
    const tx = x * x * (3 - 2 * x);
    const ty = y * y * (3 - 2 * y);
    return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
  }

  private configureCanvasTexture(
    canvas: HTMLCanvasElement,
    isColor: boolean,
    repeatX: number,
    repeatY: number
  ): THREE.CanvasTexture {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeatX, repeatY);
    tex.anisotropy = this.maxAnisotropy;
    tex.needsUpdate = true;
    return tex;
  }

  public disposeAll(): void {
    for (const tex of this.singleTextures.values()) {
      tex.dispose();
    }
    this.singleTextures.clear();

    for (const set of this.pbrSets.values()) {
      set.map.dispose();
      set.roughnessMap.dispose();
      set.normalMap.dispose();
    }
    this.pbrSets.clear();
  }
}
