import { clamp, fbm2D, smoothstep } from '../core/noise';

/**
 * Decoupled Pond Shape SDF interface (可适配的新池形与岸线抽象).
 * Swap this implementation to adapt the WaterSystem, wet mud shore terrain,
 * and duck shoreline avoidance to any new pond silhouette.
 */
export interface PondShapeSDF {
  readonly waterLevel: number;
  readonly worldHalfExtent: number;
  /** Signed distance to shoreline: negative = inside pond water, 0 = shoreline, positive = on land */
  signedDistance(x: number, z: number): number;
  /** Outward gradient (points from water toward land) */
  gradient(x: number, z: number): { gx: number; gz: number };
  /** Terrain elevation relative to waterLevel (negative under water, positive on bank) */
  terrainHeight(x: number, z: number): number;
  /** Water depth (>= 0 inside pond, 0 on land) */
  waterDepth(x: number, z: number): number;
  /** Safe swimming margin test */
  isNavigable(x: number, z: number, margin?: number): boolean;
}

/**
 * Natural organic multi-lobe twilight pond shape.
 * Wider along X (~18m), tucked coves along Z (~13m), with a gentle far-shore point for the cabin.
 */
export class OrganicTwilightPondSDF implements PondShapeSDF {
  public readonly waterLevel = 0.0;
  public readonly worldHalfExtent = 13.5;

  public signedDistance(x: number, z: number): number {
    const dMain = this.ellipseSDF(x + 0.4, z + 0.2, 8.6, 5.9);
    const dCoveA = this.ellipseSDF(x - 4.4, z - 2.3, 4.3, 3.1);
    const dCoveB = this.ellipseSDF(x + 5.2, z + 1.1, 3.9, 3.2);

    let d = this.smoothMin(dMain, dCoveA, 2.2);
    d = this.smoothMin(d, dCoveB, 2.0);

    // Subtle far-shore point where the cabin sits nearby
    const cabinPeninsula = Math.hypot((x - 3.6) * 0.72, (z + 6.4) * 0.95) - 2.6;
    d = this.smoothMax(d, -cabinPeninsula, 1.5);

    const edgeNoise = (fbm2D(x * 0.22 + 4.1, z * 0.22 - 2.7, 3) - 0.5) * 1.45;
    return d + edgeNoise;
  }

  public gradient(x: number, z: number): { gx: number; gz: number } {
    const eps = 0.08;
    const dx = this.signedDistance(x + eps, z) - this.signedDistance(x - eps, z);
    const dz = this.signedDistance(x, z + eps) - this.signedDistance(x, z - eps);
    const len = Math.hypot(dx, dz) || 1;
    return { gx: dx / len, gz: dz / len };
  }

  public terrainHeight(x: number, z: number): number {
    const sd = this.signedDistance(x, z);
    const micro = (fbm2D(x * 0.35 + 11.2, z * 0.35 + 7.8, 3) - 0.5) * 0.22;
    const rolling = (fbm2D(x * 0.08 - 3.4, z * 0.08 + 5.1, 3) - 0.5) * 1.35;

    if (sd < 0) {
      const depthFactor = smoothstep(0, -4.2, sd);
      return -1.45 * depthFactor + micro * 0.25;
    }

    const wetSlope = smoothstep(0, 1.4, sd) * 0.38;
    const bankRise = smoothstep(1.1, 10.5, sd) * 2.4;
    const frontClearance = smoothstep(4.5, 11.0, z) * -0.55;
    const distToCabin = Math.hypot(x - 5.2, z + 9.8);
    const cabinPad = 1.0 - smoothstep(1.8, 4.4, distToCabin);

    const rawHeight = wetSlope + bankRise + rolling * smoothstep(0.5, 4.0, sd) + micro + frontClearance;
    return rawHeight * (1 - cabinPad * 0.72) + 0.62 * (cabinPad * 0.72);
  }

  public waterDepth(x: number, z: number): number {
    const h = this.terrainHeight(x, z);
    return Math.max(0, this.waterLevel - h);
  }

  public isNavigable(x: number, z: number, margin = 1.15): boolean {
    return this.signedDistance(x, z) < -margin;
  }

  private ellipseSDF(x: number, z: number, rx: number, rz: number): number {
    const nx = x / rx;
    const nz = z / rz;
    const len = Math.hypot(nx, nz);
    return (len - 1.0) * Math.min(rx, rz);
  }

  private smoothMin(a: number, b: number, k: number): number {
    const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
    return b * (1 - h) + a * h - k * h * (1 - h);
  }

  private smoothMax(a: number, b: number, k: number): number {
    return -this.smoothMin(-a, -b, k);
  }
}
