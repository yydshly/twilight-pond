import * as THREE from 'three';
import { hash2D, smoothstep } from '../core/noise';
import type { PBRTextureCache } from '../modules/PBRTextureCache';
import type { PondShapeSDF } from '../modules/PondShapeSDF';
import type { WaterSystem } from '../modules/WaterSystem';
import { buildFarShoreCabin, type CabinRig } from './CabinBuilder';
import {
  buildForestAndShoreFoliage,
  type FoliageRig,
  type WindUniformRef,
} from './FoliageBuilder';

/**
 * Main Environment orchestrator:
 * - Sculpted wet mud shoreline & mossy forest banks driven by PondShapeSDF
 * - Smooth river pebbles
 * - Forest trees, curved reeds with cattails, and floating lily pads (FoliageBuilder)
 * - Far-shore detailed lakeside cabin with dock & glowing windows (CabinBuilder)
 * - Sparse soft night fireflies
 */
export class ShoreAndForest {
  public readonly group = new THREE.Group();

  private readonly windUniforms: WindUniformRef = {
    uTime: { value: 0 },
    uWindStrength: { value: 0.28 },
  };

  private readonly cabinRig: CabinRig;
  private readonly foliageRig: FoliageRig;
  private fireflies!: THREE.Points;
  private fireflyMat!: THREE.PointsMaterial;
  private fireflySeeds!: Float32Array;
  private mistGroup!: THREE.Group;
  private mistSprites: Array<{ sprite: THREE.Sprite; baseX: number; phase: number }> = [];

  constructor(sdf: PondShapeSDF, textureCache: PBRTextureCache) {
    this.buildTerrain(sdf, textureCache);
    this.buildShoreStones(sdf, textureCache);

    this.foliageRig = buildForestAndShoreFoliage(sdf, textureCache, this.windUniforms);
    this.foliageRig.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });
    this.group.add(this.foliageRig.group);

    this.cabinRig = buildFarShoreCabin(sdf, textureCache);
    this.cabinRig.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });
    this.group.add(this.cabinRig.group);

    this.buildWaterMist(textureCache);
    this.buildFireflies(sdf, textureCache);
  }

  private buildTerrain(sdf: PondShapeSDF, textureCache: PBRTextureCache): void {
    const size = 58;
    const segments = 140;
    const geo = new THREE.PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const wetnessAttr = new Float32Array(pos.count);

    const siltColor = new THREE.Color('#3b4238');
    const wetMudColor = new THREE.Color('#635446');
    const mossyBankColor = new THREE.Color('#6e8259');
    const forestFloorColor = new THREE.Color('#5a6b4b');
    const tmp = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = sdf.terrainHeight(x, z);
      pos.setY(i, y);

      const sd = sdf.signedDistance(x, z);
      const wetFactor =
        (1 - smoothstep(0.02, 0.52, sd)) *
        smoothstep(-1.1, -0.05, sd) *
        (1 - smoothstep(0.06, 0.24, y));
      wetnessAttr[i] = wetFactor;

      if (sd < -0.15) {
        tmp.copy(siltColor).lerp(wetMudColor, smoothstep(-1.2, -0.15, sd));
      } else if (sd < 1.05) {
        tmp.copy(wetMudColor).lerp(mossyBankColor, smoothstep(0.16, 1.05, sd));
      } else {
        tmp.copy(mossyBankColor).lerp(forestFloorColor, smoothstep(1.2, 6.5, sd));
      }

      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aWetness', new THREE.BufferAttribute(wetnessAttr, 1));
    geo.computeVertexNormals();

    const mudPBR = textureCache.getProceduralPBR('wetMud', 18, 18);
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: mudPBR.map,
      roughnessMap: mudPBR.roughnessMap,
      normalMap: mudPBR.normalMap,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughness: 0.98,
      metalness: 0.0,
      envMapIntensity: 0.25,
    });

    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float aWetness;\nvarying float vWetness;'
        )
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWetness = aWetness;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vWetness;')
        .replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.96, 0.38, clamp(vWetness, 0.0, 1.0));'
        )
        .replace(
          '#include <color_fragment>',
          '#include <color_fragment>\ndiffuseColor.rgb *= mix(1.0, 0.52, clamp(vWetness, 0.0, 1.0));'
        );
    };

    const terrainMesh = new THREE.Mesh(geo, mat);
    terrainMesh.name = 'WetMudTerrain';
    terrainMesh.receiveShadow = true;
    this.group.add(terrainMesh);
  }

  private buildWaterMist(textureCache: PBRTextureCache): void {
    this.mistGroup = new THREE.Group();
    const mistTex = textureCache.getSoftGlowTexture();

    // Soft translucent low-lying evening pond mist wisps hovering over the far cove & shoreline
    for (let i = 0; i < 10; i++) {
      const mat = new THREE.SpriteMaterial({
        map: mistTex,
        color: '#d8c8cc',
        transparent: true,
        opacity: 0.09,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      const bx = -7.5 + (i / 9) * 15.0 + (hash2D(i, 3.3) - 0.5) * 1.4;
      const bz = -4.2 - hash2D(i, 7.1) * 4.2;
      sprite.position.set(bx, 0.72 + hash2D(i, 9.2) * 0.55, bz);
      const w = 5.4 + hash2D(i, 5.5) * 3.6;
      sprite.scale.set(w, 1.55 + hash2D(i, 2.8) * 0.7, 1);
      this.mistGroup.add(sprite);
      this.mistSprites.push({ sprite, baseX: bx, phase: i * 1.7 });
    }
    this.group.add(this.mistGroup);
  }

  private buildShoreStones(sdf: PondShapeSDF, textureCache: PBRTextureCache): void {
    const stoneGeo = new THREE.DodecahedronGeometry(0.22, 2);
    const rockPBR = textureCache.getProceduralPBR('wetMud', 2, 2);
    const stoneMat = new THREE.MeshStandardMaterial({
      color: '#6b6c67',
      normalMap: rockPBR.normalMap,
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughness: 0.84,
      metalness: 0.02,
      envMapIntensity: 0.25,
    });

    // Darken wet waterline base & softly tint top faces with olive river moss
    stoneMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldP;\nvarying vec3 vWorldN;')
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
           vec4 wp = vec4(transformed, 1.0);
           #ifdef USE_INSTANCING
             wp = instanceMatrix * wp;
           #endif
           wp = modelMatrix * wp;
           vWorldP = wp.xyz;
           vec3 wn = objectNormal;
           #ifdef USE_INSTANCING
             wn = mat3(instanceMatrix) * wn;
           #endif
           vWorldN = normalize(mat3(modelMatrix) * wn);`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldP;\nvarying vec3 vWorldN;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           float wetBand = 1.0 - smoothstep(-0.02, 0.14, vWorldP.y);
           float mossTop = smoothstep(0.45, 0.82, vWorldN.y) * smoothstep(0.08, 0.22, vWorldP.y);
           diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.32, 0.42, 0.24), mossTop * 0.55);
           diffuseColor.rgb *= mix(1.0, 0.48, wetBand);`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           float wetR = 1.0 - smoothstep(-0.02, 0.14, vWorldP.y);
           roughnessFactor = mix(roughnessFactor, 0.30, wetR);`
        );
    };

    const matrices: THREE.Matrix4[] = [];
    const dummy = new THREE.Object3D();

    for (let i = 0; i < 110; i++) {
      const a = hash2D(i, 1.7) * Math.PI * 2;
      const r = 4.5 + hash2D(i, 3.1) * 7.8;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r * 0.8;
      const sd = sdf.signedDistance(x, z);
      if (sd < -0.25 || sd > 0.85) continue;
      // Keep bottom-center camera foreground clear behind the minimal pill bar
      if (z > 4.6 && Math.abs(x) < 3.6) continue;

      const y = sdf.terrainHeight(x, z);
      const sx = 0.55 + hash2D(i, 5.2) * 1.35;
      const sy = 0.32 + hash2D(i, 7.9) * 0.52;
      const sz = 0.55 + hash2D(i, 9.4) * 1.25;
      dummy.position.set(x, y + sy * 0.05, z);
      dummy.rotation.set(
        hash2D(i, 2.2) * 0.4,
        hash2D(i, 4.4) * Math.PI * 2,
        hash2D(i, 6.6) * 0.4
      );
      dummy.scale.set(sx, sy, sz);
      dummy.updateMatrix();
      matrices.push(dummy.matrix.clone());
    }

    const inst = new THREE.InstancedMesh(stoneGeo, stoneMat, matrices.length);
    matrices.forEach((m, idx) => inst.setMatrixAt(idx, m));
    inst.instanceMatrix.needsUpdate = true;
    this.group.add(inst);
  }

  private buildFireflies(sdf: PondShapeSDF, textureCache: PBRTextureCache): void {
    const count = 24;
    const positions = new Float32Array(count * 3);
    this.fireflySeeds = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const ang = (hash2D(i, 41.2) - 0.5) * Math.PI * 1.4 - Math.PI * 0.5;
      const r = 6.0 + hash2D(i, 52.8) * 5.2;
      const x = Math.cos(ang) * r;
      const z = Math.sin(ang) * r * 0.8;
      const y = Math.max(0.35, sdf.terrainHeight(x, z) + 0.55) + hash2D(i, 61.1) * 1.4;
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      this.fireflySeeds[i * 3] = x;
      this.fireflySeeds[i * 3 + 1] = y;
      this.fireflySeeds[i * 3 + 2] = z;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.fireflyMat = new THREE.PointsMaterial({
      color: '#ffe38f',
      map: textureCache.getSoftGlowTexture(),
      size: 0.26,
      transparent: true,
      opacity: 0.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.fireflies = new THREE.Points(geo, this.fireflyMat);
    this.group.add(this.fireflies);
  }

  public update(
    dt: number,
    time: number,
    dayPhase: number,
    windStrength: number,
    water: WaterSystem
  ): void {
    this.windUniforms.uTime.value = time;
    this.windUniforms.uWindStrength.value = windStrength;

    this.cabinRig.update(time, dayPhase, windStrength, water);
    this.foliageRig.updateDynamic(time, dt, windStrength);

    // Drift subtle low-lying pond mist gently across the far cove
    const mistColor = new THREE.Color('#e8cfc5').lerp(new THREE.Color('#7ca0c2'), dayPhase);
    for (const m of this.mistSprites) {
      m.sprite.position.x = m.baseX + Math.sin(time * (0.09 + windStrength * 0.14) + m.phase) * 1.15;
      const mat = m.sprite.material as THREE.SpriteMaterial;
      mat.color.copy(mistColor);
      mat.opacity = 0.065 + 0.03 * Math.sin(time * 0.25 + m.phase);
    }

    this.fireflyMat.opacity = smoothstep(0.28, 0.85, dayPhase) * 0.78;
    if (this.fireflyMat.opacity > 0.01) {
      const ffAttr = this.fireflies.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < ffAttr.count; i++) {
        const bx = this.fireflySeeds[i * 3];
        const by = this.fireflySeeds[i * 3 + 1];
        const bz = this.fireflySeeds[i * 3 + 2];
        ffAttr.setXYZ(
          i,
          bx + Math.sin(time * 0.55 + i * 2.1) * 0.48,
          by + Math.sin(time * 0.82 + i * 1.7) * 0.24,
          bz + Math.cos(time * 0.48 + i * 2.6) * 0.48
        );
      }
      ffAttr.needsUpdate = true;
    }
  }
}
