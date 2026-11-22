import * as THREE from 'three';
import { clamp, fbm2D, lerp, smoothstep } from '../core/noise';

export interface MallardPlumageMaps {
  map: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
}

/**
 * Generates anatomically-mapped 512x512 Mallard Drake (绿头鸭) feather PBR textures
 * matching the continuous lofted duck body UV:
 *   u in [0..1]: azimuth around body (0.0/1.0 = top spine, 0.25 = right flank, 0.5 = belly, 0.75 = left flank)
 *   v in [0..1]: longitudinal from tail tip (0.0) -> rump -> torso/wings -> chest -> collar -> head -> bill tip (1.0)
 */
export function createMallardPlumageMaps(): MallardPlumageMaps {
  const W = 512;
  const H = 512;

  const albedoCanvas = document.createElement('canvas');
  albedoCanvas.width = W;
  albedoCanvas.height = H;
  const aCtx = albedoCanvas.getContext('2d')!;
  const aImg = aCtx.createImageData(W, H);

  const roughCanvas = document.createElement('canvas');
  roughCanvas.width = W;
  roughCanvas.height = H;
  const rCtx = roughCanvas.getContext('2d')!;
  const rImg = rCtx.createImageData(W, H);

  const heightBuf = new Float32Array(W * H);

  for (let py = 0; py < H; py++) {
    // v = 0 at tail, v = 1 at bill tip
    const v = 1 - py / (H - 1);
    for (let px = 0; px < W; px++) {
      const u = px / (W - 1);
      // Symmetry around dorsal spine: top = 1 at u=0/1, belly = -1 at u=0.5, flank = 0 at u=0.25/0.75
      const dorsal = Math.cos(u * Math.PI * 2); // +1 top, 0 flank, -1 belly
      const flank = Math.abs(Math.sin(u * Math.PI * 2)); // 1 on side flank, 0 on top/belly

      // Feather micro-structure: layered overlapping scallop pattern + fine barbs
      const featherRow = v * 46;
      const rowIdx = Math.floor(featherRow);
      const rowFrac = featherRow - rowIdx;
      const colCoord = u * 26 + (rowIdx % 2) * 0.5;
      const colFrac = colCoord - Math.floor(colCoord);
      const scallop = Math.sin(colFrac * Math.PI) * (1 - rowFrac * 0.75);
      const barb = Math.sin(u * 280 + v * 40) * 0.5 + 0.5;
      const organic = fbm2D(u * 14 + 2.3, v * 28 + 1.1, 3);

      // Default pale silver-grey vermiculated flank plumage (authentic mallard side waving lines)
      const vermic = Math.sin(v * 320 + organic * 14) * 0.5 + 0.5;
      let r = lerp(142, 198, vermic * 0.65 + scallop * 0.35);
      let g = lerp(138, 192, vermic * 0.65 + scallop * 0.35);
      let b = lerp(132, 184, vermic * 0.65 + scallop * 0.35);
      let rough = 0.72;
      let bump = scallop * 0.6 + barb * 0.25;

      // Dark brown mottled back / folded wing saddle along top (dorsal > 0.15)
      if (v > 0.13 && v < 0.62) {
        const backMask = smoothstep(0.12, 0.55, dorsal) * smoothstep(0.62, 0.52, v) * smoothstep(0.13, 0.22, v);
        const mottle = 0.65 + 0.35 * scallop + (organic - 0.5) * 0.25;
        r = lerp(r, 86 * mottle, backMask);
        g = lerp(g, 74 * mottle, backMask);
        b = lerp(b, 62 * mottle, backMask);
        rough = lerp(rough, 0.78, backMask);

        // Iconic Mallard blue-violet wing speculum patch with crisp black + white border bars
        const specV = smoothstep(0.26, 0.29, v) * (1 - smoothstep(0.41, 0.44, v));
        const specSide = smoothstep(0.72, 0.86, flank) * smoothstep(-0.08, 0.22, dorsal) * (1 - smoothstep(0.32, 0.48, dorsal));
        const specMask = specV * specSide;
        if (specMask > 0.01) {
          // Thin white trailing & leading bars bordering iridescent cobalt-violet speculum
          if (v < 0.282 || v > 0.418) {
            r = lerp(r, 232, specMask);
            g = lerp(g, 229, specMask);
            b = lerp(b, 222, specMask);
          } else if (v < 0.295 || v > 0.405) {
            r = lerp(r, 24, specMask);
            g = lerp(g, 26, specMask);
            b = lerp(b, 30, specMask);
          } else {
            r = lerp(r, 34, specMask);
            g = lerp(g, 78, specMask);
            b = lerp(b, 158, specMask);
            rough = lerp(rough, 0.28, specMask);
          }
        }
      }

      // Tail & rump (v < 0.17): crisp white outer tail edge + velvety black rump coverts
      if (v < 0.18) {
        const tailMask = smoothstep(0.18, 0.12, v);
        const isBlackRump = smoothstep(-0.2, 0.45, dorsal) * smoothstep(0.05, 0.12, v);
        const tailR = lerp(222, 26, isBlackRump);
        const tailG = lerp(218, 28, isBlackRump);
        const tailB = lerp(210, 32, isBlackRump);
        r = lerp(r, tailR, tailMask);
        g = lerp(g, tailG, tailMask);
        b = lerp(b, tailB, tailMask);
        rough = lerp(rough, 0.62, tailMask);
      }

      // Warm chestnut-maroon breast (v ~ 0.56 .. 0.72) with feathered transition
      const breastEdge = 0.56 + (organic - 0.5) * 0.03 + dorsal * 0.04;
      const breastMask = smoothstep(breastEdge - 0.03, breastEdge + 0.03, v) * (1 - smoothstep(0.70, 0.735, v));
      if (breastMask > 0.01) {
        const chestShade = 0.78 + 0.28 * scallop + (organic - 0.5) * 0.16;
        r = lerp(r, 128 * chestShade, breastMask);
        g = lerp(g, 64 * chestShade, breastMask);
        b = lerp(b, 44 * chestShade, breastMask);
        rough = lerp(rough, 0.66, breastMask);
      }

      // Crisp flush white drake neck ring (v ~ 0.715 .. 0.752, softly narrowing at back nape)
      const collarBackBreak = 1 - smoothstep(0.72, 0.94, dorsal) * 0.55;
      const collarMask =
        smoothstep(0.712, 0.724, v) * (1 - smoothstep(0.742, 0.756, v)) * collarBackBreak;
      if (collarMask > 0.01) {
        r = lerp(r, 236, collarMask);
        g = lerp(g, 233, collarMask);
        b = lerp(b, 224, collarMask);
        rough = lerp(rough, 0.64, collarMask);
      }

      // Velvety iridescent emerald-green drake head (v ~ 0.745 .. 0.90)
      const headMask = smoothstep(0.742, 0.758, v) * (1 - smoothstep(0.892, 0.912, v));
      if (headMask > 0.01) {
        const sheen = 0.78 + 0.34 * barb + (dorsal * 0.18);
        // Slightly darker velvety crown & cheek contour
        r = lerp(r, clamp(22 * sheen, 10, 68), headMask);
        g = lerp(g, clamp(104 * sheen, 42, 165), headMask);
        b = lerp(b, clamp(74 * sheen, 30, 125), headMask);
        rough = lerp(rough, 0.32, headMask);
        bump *= 0.45;
      }

      // Scooped yellow-ochre mallard bill (v >= 0.895) with darker top ridge & black nail tip
      if (v > 0.89) {
        const billMask = smoothstep(0.892, 0.91, v);
        const culmenDark = smoothstep(0.6, 0.95, dorsal) * 0.25;
        const tipNail = smoothstep(0.972, 0.988, v);
        // Subtle nostril darkening around v ~ 0.935, side-top
        const nostril =
          smoothstep(0.018, 0.005, Math.hypot(v - 0.932, Math.abs(flank - 0.58) * 0.18)) *
          smoothstep(0.2, 0.6, dorsal);

        let br = lerp(224, 152, culmenDark);
        let bg = lerp(188, 134, culmenDark);
        let bb = lerp(76, 54, culmenDark);
        br = lerp(br, 32, Math.max(tipNail, nostril * 0.75));
        bg = lerp(bg, 30, Math.max(tipNail, nostril * 0.75));
        bb = lerp(bb, 28, Math.max(tipNail, nostril * 0.75));

        r = lerp(r, br, billMask);
        g = lerp(g, bg, billMask);
        b = lerp(b, bb, billMask);
        rough = lerp(rough, 0.36, billMask);
        bump = lerp(bump, 0.15 - nostril * 0.3, billMask);
      }

      const idx = py * W + px;
      const p = idx * 4;
      aImg.data[p] = Math.round(clamp(r, 0, 255));
      aImg.data[p + 1] = Math.round(clamp(g, 0, 255));
      aImg.data[p + 2] = Math.round(clamp(b, 0, 255));
      aImg.data[p + 3] = 255;

      const rByte = Math.round(clamp(rough, 0.15, 0.96) * 255);
      rImg.data[p] = rByte;
      rImg.data[p + 1] = rByte;
      rImg.data[p + 2] = rByte;
      rImg.data[p + 3] = 255;

      heightBuf[idx] = bump;
    }
  }

  aCtx.putImageData(aImg, 0, 0);
  rCtx.putImageData(rImg, 0, 0);

  // Derive feather-barb normal map
  const nCanvas = document.createElement('canvas');
  nCanvas.width = W;
  nCanvas.height = H;
  const nCtx = nCanvas.getContext('2d')!;
  const nImg = nCtx.createImageData(W, H);
  const strength = 2.6;

  for (let y = 0; y < H; y++) {
    const ym = Math.max(0, y - 1);
    const yp = Math.min(H - 1, y + 1);
    for (let x = 0; x < W; x++) {
      const xm = (x - 1 + W) % W;
      const xp = (x + 1) % W;
      const dx = (heightBuf[y * W + xp] - heightBuf[y * W + xm]) * strength;
      const dy = (heightBuf[yp * W + x] - heightBuf[ym * W + x]) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const p = (y * W + x) * 4;
      nImg.data[p] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      nImg.data[p + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
      nImg.data[p + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      nImg.data[p + 3] = 255;
    }
  }
  nCtx.putImageData(nImg, 0, 0);

  const map = new THREE.CanvasTexture(albedoCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.anisotropy = 4;

  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  roughnessMap.wrapS = THREE.RepeatWrapping;
  roughnessMap.wrapT = THREE.ClampToEdgeWrapping;

  const normalMap = new THREE.CanvasTexture(nCanvas);
  normalMap.wrapS = THREE.RepeatWrapping;
  normalMap.wrapT = THREE.ClampToEdgeWrapping;

  return { map, roughnessMap, normalMap };
}
