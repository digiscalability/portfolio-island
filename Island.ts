import * as THREE from 'three';
import type { GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { Materials } from './Materials';
import { NPC } from './NPC';
import TextureGenerator from './TextureGenerator';

type IslandMeshUserData = {
  _debug?: boolean;
  _debugHelpers?: THREE.Group;
};


type RoadRingUserData = {
  pathRadius: number;
  tex: THREE.Texture;
  normalTex: THREE.Texture;
  roughnessTex: THREE.Texture;
  width: number;
  segments: number;
};

type RoadPlaneUserData = {
  isRoadPlane: true;
};

type ORMSplitResult = {
  aoMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  metalnessMap: THREE.Texture;
};

type ModelOverride = {
  envMapIntensity?: number;
  roughnessScale?: number;
  scale?: number;
  ormPacking?: string;
  fitHeight?: number;
  yOffset?: number;
  randomYaw?: boolean;
};

type MaterialWithTextureProps = THREE.Material & {
  map?: THREE.Texture;
  normalMap?: THREE.Texture;
  roughnessMap?: THREE.Texture;
  metalnessMap?: THREE.Texture;
  aoMap?: THREE.Texture;
  emissiveMap?: THREE.Texture;
  bumpMap?: THREE.Texture;
  displacementMap?: THREE.Texture;
  alphaMap?: THREE.Texture;
  envMap?: THREE.Texture;
  emissive?: THREE.Color;
  roughness?: number;
  metalness?: number;
  shininess?: number;
  envMapIntensity?: number;
  userData?: {
    map?: THREE.Texture;
    [key: string]: unknown;
  };
};

const ormTextureCache = new WeakMap<object, ORMSplitResult | null>();
const ormTextureProcessing = new WeakSet<object>();

const getTextureIdentifier = (texture?: THREE.Texture): string =>
  texture?.name && texture.name.length ? texture.name : (texture?.uuid ?? '<unknown>');

const getDiagnostics = () => {
  if (!window.__ormDiagnostics) {
    window.__ormDiagnostics = [];
  }
  return window.__ormDiagnostics;
};

const extractTexture = (material: MaterialWithTextureProps): THREE.Texture | undefined => {
  if (material.map instanceof THREE.Texture) {
    return material.map;
  }
  const userDataMap = material.userData?.map;
  return userDataMap instanceof THREE.Texture ? userDataMap : undefined;
};

type GLTFLoaderConstructor = new () => GLTFLoader;

export class Island {
  public mesh: THREE.Mesh;
  public radius: number;
  private center: THREE.Vector3;
  private surfaceMesh?: THREE.Mesh;
  private animationMixers: THREE.AnimationMixer[] = [];
  private npcInstances: NPC[] = [];

  constructor(radius: number = 18) {
    this.radius = radius;
    this.center = new THREE.Vector3(0, 0, 0);
    this.mesh = this.createIsland();
    // debug flag (enable via window.__ISLAND_DEBUG = true in console)
    if (typeof window !== 'undefined') {
      const debugFlag = (window as typeof window & { __ISLAND_DEBUG?: boolean }).__ISLAND_DEBUG;
      if (debugFlag) {
        const data = this.mesh.userData as IslandMeshUserData;
        data._debug = true;
      }
    }
  }

  private createIsland(): THREE.Mesh {
    // Use a sphere geometry for the island surface so objects placed on the sphere align correctly.
    const seg = 128;
    const geometry = new THREE.SphereGeometry(this.radius, seg, seg);
    // Displace vertices along their normals to create varied hills and valleys on the sphere surface.
    const vertices = geometry.attributes.position.array as Float32Array;
    const v = new THREE.Vector3();

    // Simple Perlin-like noise function for more organic terrain
    const noise3D = (x: number, y: number, z: number, scale: number) => {
      const sx = Math.sin(x * scale) * Math.cos(z * scale);
      const sy = Math.sin(y * scale) * Math.cos(x * scale);
      const sz = Math.sin(z * scale) * Math.cos(y * scale);
      return (sx + sy + sz) / 3;
    };

    // Enhanced multi-octave noise for more natural terrain
    const multiOctaveNoise = (x: number, y: number, z: number) => {
      let total = 0;
      let frequency = 1.0;
      let amplitude = 1.0;
      let maxValue = 0;

      // 4 octaves for rich detail
      for (let i = 0; i < 4; i++) {
        total += noise3D(x, y, z, 0.08 * frequency) * amplitude;
        maxValue += amplitude;
        amplitude *= 0.5; // each octave half as strong
        frequency *= 2.0; // each octave double frequency
      }

      return total / maxValue;
    };

    for (let i = 0; i < vertices.length; i += 3) {
      v.set(vertices[i], vertices[i + 1], vertices[i + 2]);
      const normal = v.clone().normalize();

      // Enhanced terrain generation with better geographic features
      // Large-scale continents/mountains using multi-octave noise
      const largeTerrain = multiOctaveNoise(v.x, v.y, v.z) * 3.2;

      // Medium-scale hills and valleys with variation
      const mediumTerrain = noise3D(v.x, v.y, v.z, 0.15) * 1.5;

      // Small-scale rolling hills (halved: was crinkling the surface)
      const smallDetail = noise3D(v.x, v.y, v.z, 0.35) * 0.35;

      // No per-vertex random micro noise: it rendered as crumpled-paper
      // wrinkles across the whole planet from any distance.
      const microNoise = 0;

      // Height-based biomes: create flatter areas at lower elevations (beaches/plateaus)
      const baseHeight = largeTerrain + mediumTerrain;
      const heightFactor = Math.max(0, Math.min(1, (baseHeight + 2) / 4));
      const plateauFactor = 1.0 - Math.pow(Math.abs(heightFactor - 0.3) * 3, 2) * 0.3;

      // Combine layers for natural variation with plateau effect
      const displacement =
        (largeTerrain + mediumTerrain * plateauFactor + smallDetail) * 0.95 + microNoise;

      // Clamp radius to prevent terrain from going inside the sphere
      const rawRadius = this.radius + displacement;
      const minRadius = this.radius * 0.96; // slightly increased minimum for smoother terrain
      const maxRadius = this.radius + 4.2; // slightly higher peaks
      const finalRadius = THREE.MathUtils.clamp(rawRadius, minRadius, maxRadius);
      const newPos = normal.multiplyScalar(finalRadius);
      vertices[i] = newPos.x;
      vertices[i + 1] = newPos.y;
      vertices[i + 2] = newPos.z;
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere(); // Ensure proper bounding sphere for raycasting

    // Elevation-tinted vertex colors: valleys richer/darker, meadows mid,
    // ridges drier/lighter — the flat monotone read as plastic. A small
    // deterministic per-vertex jitter breaks banding without wrinkle noise.
    {
      const posA = geometry.attributes.position;
      const colors = new Float32Array(posA.count * 3);
      const valley = new THREE.Color(0x6f9c58);
      const meadow = new THREE.Color(0x8cc06e);
      const ridge = new THREE.Color(0xaacb7b);
      const tmp = new THREE.Color();
      let minR = Infinity, maxR = -Infinity;
      for (let i = 0; i < posA.count; i++) {
        const r = Math.hypot(posA.getX(i), posA.getY(i), posA.getZ(i));
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
      }
      const span = Math.max(1e-6, maxR - minR);
      for (let i = 0; i < posA.count; i++) {
        const r = Math.hypot(posA.getX(i), posA.getY(i), posA.getZ(i));
        const t = (r - minR) / span;
        if (t < 0.5) tmp.copy(valley).lerp(meadow, t * 2);
        else tmp.copy(meadow).lerp(ridge, (t - 0.5) * 2);
        // deterministic jitter from vertex index (no Math.random -> stable)
        const j = 1 + (((i * 2654435761) % 1000) / 1000 - 0.5) * 0.07;
        colors[i * 3] = tmp.r * j;
        colors[i * 3 + 1] = tmp.g * j;
        colors[i * 3 + 2] = tmp.b * j;
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    // Use authored grass textures from the Stylized Nature kit to ground the island in the intended art direction
    // No tiling texture: Grass.png repeated 6x around the sphere and its dark
    // tile edges rendered as six meridian stripes converging in ugly pinwheels
    // at BOTH poles. Clean flat color suits the low-poly look and kills the
    // artifact entirely.
    const material = Materials.createPBRMaterial({
      color: 0xffffff, // tint comes from elevation vertex colors
      roughness: 0.85,
      metalness: 0.0,
      envMapIntensity: 0.5,
    });
    material.vertexColors = true;

    const mesh = new THREE.Mesh(geometry, material);
    // keep a direct reference to the terrain mesh for raycasting / accurate placement
    this.surfaceMesh = mesh;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.position.copy(this.center);

    // Create a conforming 'road' ring made of many small segments that sit on the sphere surface.
    // keep the main roadway closer to the crown of the island so structures can sit around it naturally
    const roadRadius = this.radius * 0.6;
    const pathGroup = this.createRoadRing(roadRadius, 0.7, 96);

    // Add a few low-poly buildings aligned to the surface (placeholders). We'll attempt to replace them with GLTF models if present.
    const buildings = new THREE.Group();
    // generate procedural building textures and use them for PBR-like facades
    const buildingTex = TextureGenerator.createBuildingTextures(512, 512);
    const buildingMat = Materials.createPBRMaterial({
      color: 0xd9c6b3,
      map: buildingTex.albedo,
      normalMap: buildingTex.normal,
      roughnessMap: buildingTex.roughness,
      aoMap: buildingTex.ao,
      roughness: 0.65,
      metalness: 0.02,
    });
    const buildingPlaceholders: THREE.Mesh[] = [];
    const buildingSamples: { position: THREE.Vector3; normal: THREE.Vector3 }[] = [];
    // MARKET district [zone2..zone3]: two rows of shops facing Main Street
    const BUILDING_SITES: Array<[number, number]> = [
      [2.72, 0.17], [2.97, 0.17], [3.22, 0.17], [3.47, 0.17],
      [2.85, -0.17], [3.1, -0.17], [3.35, -0.17], [3.6, -0.17],
    ];
    for (let i = 0; i < BUILDING_SITES.length; i++) {
      const [lon, lat] = BUILDING_SITES[i];
      const dir = this.claimDir(this.dirAt(lon, lat), 0.1);

      // Sample actual terrain surface along this direction
      const sampled = this.sampleSurfaceByDirection(dir, 0.0);
      buildingSamples.push({ position: sampled.position.clone(), normal: sampled.normal.clone() });

      const bGeom = new THREE.BoxGeometry(1.4, 2.4, 1.4);
      const b = new THREE.Mesh(bGeom, buildingMat);

      // FIX: Building geometry is centered, so we need to offset it upward by half its height
      // Position building with base ON surface, not center IN surface
      const buildingHeight = 2.4;
      const offsetPos = sampled.position
        .clone()
        .add(sampled.normal.clone().multiplyScalar(buildingHeight * 0.5));
      b.position.copy(offsetPos);

      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        sampled.normal,
      );
      b.quaternion.copy(q);
      // spin around the surface normal so later GLTF replacements feel organic
      // Face Main Street (the equator road) instead of a random spin
      this.faceObjectToward(b, sampled.normal, this.dirAt(lon, 0).multiplyScalar(this.radius));
      b.castShadow = true;
      b.receiveShadow = true;
      b.name = `building_placeholder_${i}`;
      buildings.add(b);
      buildingPlaceholders.push(b);
    }

    // Procedural houses: add a few more detailed block houses with roofs/windows to make the island feel inhabited
    const houses = new THREE.Group();
    const houseSamples: { position: THREE.Vector3; normal: THREE.Vector3 }[] = [];
    // VILLAGE district [zone0..zone1]: cottages lining both sides of the road
    const HOUSE_SITES: Array<[number, number]> = [
      [0.2, 0.15], [0.42, 0.15], [0.64, 0.15], [0.86, 0.15], [1.08, 0.15],
      [0.31, -0.15], [0.53, -0.15], [0.75, -0.15], [0.97, -0.15],
      [0.42, 0.31], [0.75, 0.3],
    ];
    const houseCount = HOUSE_SITES.length;
    for (let i = 0; i < houseCount; i++) {
      const [lon, lat] = HOUSE_SITES[i];
      const dir = this.claimDir(this.dirAt(lon, lat), 0.09);

      // Sample actual terrain surface along this direction
      const sampled = this.sampleSurfaceByDirection(dir, 0.0);
      houseSamples.push({ position: sampled.position.clone(), normal: sampled.normal.clone() });

      // main body
      const w = 0.9 + Math.random() * 0.8;
      const h = 0.9 + Math.random() * 1.4;
      const d = 0.8 + Math.random() * 0.6;
      const bodyGeom = new THREE.BoxGeometry(w, h, d);
      const bodyMat = Materials.createHouseMaterial(
        0xa8c3a8 + Math.floor(Math.random() * 0x003333),
      );
      const body = new THREE.Mesh(bodyGeom, bodyMat);
      body.castShadow = true;
      body.receiveShadow = true;

      // roof
      const roofGeom = new THREE.ConeGeometry(Math.max(w, d) * 0.9, 0.5, 4);
      const roofMat = Materials.createTrimMaterial(0x8b5a2b);
      const roof = new THREE.Mesh(roofGeom, roofMat);
      roof.castShadow = true;
      roof.receiveShadow = true;
      roof.rotation.y = Math.PI / 4;

      const house = new THREE.Group();
      // FIX: Body geometry is centered at origin, so position.y = h/2 makes BOTTOM at y=0 (on ground)
      body.position.set(0, h * 0.5, 0);
      roof.position.set(0, h + 0.12, 0);
      house.add(body);
      house.add(roof);

      // Windows as emissive planes
      const winMat = new THREE.MeshStandardMaterial({
        color: 0xffffcc,
        emissive: 0xffe6b3,
        emissiveIntensity: 0.6,
      });
      const winGeom = new THREE.PlaneGeometry(0.16, 0.18);
      const win1 = new THREE.Mesh(winGeom, winMat);
      win1.position.set(w * 0.22, h * 0.45, d * 0.51);
      house.add(win1);
      const win2 = new THREE.Mesh(winGeom, winMat);
      win2.position.set(-w * 0.22, h * 0.45, d * 0.51);
      house.add(win2);
      // Door
      const doorMat = new THREE.MeshStandardMaterial({ color: 0x5a3d2b, roughness: 0.7 });
      const door = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.35), doorMat);
      door.position.set(0, h * 0.22, d * 0.51);
      house.add(door);
      // Doorknob
      const knob = new THREE.Mesh(
        new THREE.SphereGeometry(0.02, 6, 6),
        new THREE.MeshStandardMaterial({ color: 0xccaa44, metalness: 0.6 }),
      );
      knob.position.set(0.06, h * 0.22, d * 0.52);
      house.add(knob);
      // Chimney (every other house)
      if (i % 2 === 0) {
        const chimney = new THREE.Mesh(
          new THREE.BoxGeometry(0.15, 0.35, 0.15),
          Materials.createTrimMaterial(0x884433),
        );
        chimney.position.set(w * 0.25, h + 0.3, -d * 0.15);
        chimney.castShadow = true;
        house.add(chimney);
      }

      // align to surface
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        sampled.normal,
      );
      house.quaternion.copy(q);
      // Face the road
      this.faceObjectToward(house, sampled.normal, this.dirAt(lon, 0).multiplyScalar(this.radius));
      house.position.copy(sampled.position);
      // Houses are already positioned by sampleSurfacePosition - no additional offset needed
      house.name = `house_${i}`;
      houses.add(house);
      // Add a small warm point light near the house to simulate local ambient warmth / light-probe
      const warmColor = 0xffd6a5;
      const light = new THREE.PointLight(warmColor, 0.55, 2.0, 2);
      // place the light slightly above the door/windows so it softly lights nearby surfaces
      light.position.set(0, h * 0.6, d * 0.35);
      // don't cast shadows by default (expensive); user can toggle in renderer settings if desired
      light.castShadow = false;
      // tag so the renderer or debug UI can find and tweak these
      const lightData = light.userData as Record<string, unknown>;
      lightData.isHouseWarmLight = true;
      // attach to house so it follows rotation/position on the sphere
      house.add(light);
    }

    // Trees: multi-tier toon trees with varied foliage colors
    const trees = new THREE.Group();
    const treeCount = 48;
    const trunkMat = Materials.createStandardMaterial({ color: 0x6b4a2a, roughness: 0.8 });
    const FOLIAGE_COLORS = [0x3a8c3a, 0x4a9e3e, 0x2d7a3a, 0x55a644, 0x3b8e50];

    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < treeCount; i++) {
      const treeGroup = new THREE.Group();
      const y = 1 - (i / (treeCount - 1)) * 2;
      const radiusAtY = Math.sqrt(1 - y * y);
      const theta = goldenAngle * i;
      const x = Math.cos(theta) * radiusAtY;
      const z = Math.sin(theta) * radiusAtY;
      const dir = new THREE.Vector3(x, y, z).normalize();
      const sampled = this.sampleSurfaceByDirection(dir, 0.0);
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        sampled.normal,
      );

      const scale = 0.9 + Math.random() * 0.4;
      // Trunk
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.05 * scale, 0.07 * scale, 0.5 * scale, 6), trunkMat);
      trunk.position.y = 0.25 * scale;
      trunk.castShadow = true;
      treeGroup.add(trunk);
      // Foliage tiers (2-3 stacked cones)
      const tierCount = 2 + (i % 3 === 0 ? 1 : 0);
      const fColor = FOLIAGE_COLORS[i % FOLIAGE_COLORS.length];
      const fMat = new THREE.MeshStandardMaterial({ color: fColor, roughness: 0.8 });
      for (let t = 0; t < tierCount; t++) {
        const tierScale = 1 - t * 0.25;
        const cone = new THREE.Mesh(
          new THREE.ConeGeometry(0.3 * scale * tierScale, 0.35 * scale, 7),
          fMat,
        );
        cone.position.y = (0.5 + t * 0.25) * scale;
        cone.castShadow = true;
        treeGroup.add(cone);
      }

      treeGroup.position.copy(sampled.position);
      treeGroup.quaternion.copy(q);
      treeGroup.name = `tree_${i}`;
      const treeData = treeGroup.userData as Record<string, unknown>;
      treeData.ignoreOcclusion = true;
      trees.add(treeGroup);
    }

    // Mailboxes: seed around homes/structures instead of a perfect orbit
    const mailboxes = new THREE.Group();
    const mailboxSources = houseSamples.length ? houseSamples : buildingSamples;
    const mailboxIndices = mailboxSources.map((_, idx) => idx);
    for (let i = mailboxIndices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [mailboxIndices[i], mailboxIndices[j]] = [mailboxIndices[j], mailboxIndices[i]];
    }
    const mailboxCount = Math.min(6, mailboxIndices.length);
    for (let i = 0; i < mailboxCount; i++) {
      const sampled = mailboxSources[mailboxIndices[i]];
      if (!sampled) continue;
      const tangentSeed = new THREE.Vector3().crossVectors(
        sampled.normal,
        new THREE.Vector3(0, 1, 0),
      );
      if (tangentSeed.lengthSq() < 1e-6) tangentSeed.set(1, 0, 0);
      tangentSeed.normalize();
      const spinAngle = Math.random() * Math.PI * 2;
      const tangent = tangentSeed.applyAxisAngle(sampled.normal, spinAngle).normalize();
      const approx = sampled.position
        .clone()
        .add(tangent.multiplyScalar(0.8 + Math.random() * 0.4));
      const placement = this.sampleSurfacePosition(approx, 0.03); // NPC feet on the ground (0.25 floated them)

      const mb = new THREE.Group();
      // Post
      const postMat = new THREE.MeshStandardMaterial({ color: 0x5a3d2b, roughness: 0.8 });
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.5, 6), postMat);
      post.position.y = 0.25;
      mb.add(post);
      // Box body
      const boxMat = Materials.createMailboxMaterial();
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.16, 0.12), boxMat);
      box.position.y = 0.56;
      mb.add(box);
      // Rounded top (half-cylinder look via a squashed sphere)
      const top = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), boxMat);
      top.scale.set(1, 0.5, 0.67);
      top.position.y = 0.64;
      mb.add(top);
      // Flag
      const flag = new THREE.Mesh(
        new THREE.BoxGeometry(0.02, 0.08, 0.06),
        new THREE.MeshStandardMaterial({ color: 0xcc3333 }),
      );
      flag.position.set(0.1, 0.6, 0);
      mb.add(flag);
      mb.position.copy(placement.position);
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        placement.normal,
      );
      mb.quaternion.copy(q);
      mb.quaternion.premultiply(
        new THREE.Quaternion().setFromAxisAngle(placement.normal, Math.random() * Math.PI * 2),
      );
      mb.name = `mailbox_${i}`;
      mb.castShadow = true;
      mb.receiveShadow = true;
      mailboxes.add(mb);
    }

    // (Removed stripes/road centerline boxes to eliminate boundaries)

    // Add stairs near some houses for access to "higher" ground
    const stairs = new THREE.Group();
    const STAIR_SITES: Array<[number, number]> = [[1.38, 0.1], [3.9, -0.1]];
    for (let i = 0; i < STAIR_SITES.length; i++) {
      const pos = this.claimDir(this.dirAt(STAIR_SITES[i][0], STAIR_SITES[i][1]), 0.08).multiplyScalar(this.radius);
      const stair = this.createStairs();
      try {
        this.placeObjectOnSurface(stair, pos, -0.06, true);
      } catch {
        /* ignore placement issues */
      }
      stair.castShadow = true;
      stair.receiveShadow = true;
      stair.name = `stairs_${i}`;
      stairs.add(stair);
    }

    // Add street lamps for evening ambiance
    const lamps = new THREE.Group();
    const lampPositions: THREE.Vector3[] = [];
    const LAMP_LONS = [0.55, 1.6, 2.51, 3.15, 4.4, 5.55];
    for (let i = 0; i < 6; i++) {
      const pos = this.claimDir(this.dirAt(LAMP_LONS[i], i % 2 === 0 ? 0.06 : -0.06), 0.05).multiplyScalar(this.radius);
      const sampled = this.sampleSurfacePosition(pos, 0.6);
      const lampGroup = new THREE.Group();
      lampGroup.name = `lamp_${i}`;
      const poleMat = Materials.createTrimMaterial(0x3a3a3a);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 1.6, 8), poleMat);
      pole.position.y = 0.8;
      pole.castShadow = true;
      lampGroup.add(pole);
      // Curved arm
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.5, 6), poleMat);
      arm.position.set(0.2, 1.55, 0);
      arm.rotation.z = -Math.PI / 4;
      lampGroup.add(arm);
      // Lamp shade (cone)
      const shade = new THREE.Mesh(
        new THREE.ConeGeometry(0.2, 0.15, 8),
        Materials.createTrimMaterial(0x2a2a2a),
      );
      shade.position.set(0.35, 1.55, 0);
      shade.rotation.z = Math.PI;
      shade.castShadow = true;
      lampGroup.add(shade);
      // Glowing bulb
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.1, 8, 8),
        new THREE.MeshStandardMaterial({ color: 0xfff4cc, emissive: 0xffe8a0, emissiveIntensity: 0.8 }),
      );
      bulb.position.set(0.35, 1.48, 0);
      lampGroup.add(bulb);

      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        sampled.normal,
      );
      lampGroup.position.copy(sampled.position);
      lampGroup.quaternion.copy(q);
      const lampLight = new THREE.PointLight(0xffeeaa, 0.8, 3, 2);
      lampLight.position.set(0.35, 1.48, 0);
      lampLight.userData = { isLampLight: true };
      lampGroup.add(lampLight);
      lamps.add(lampGroup);
      lampPositions.push(sampled.position.clone().add(new THREE.Vector3(0, 1.48, 0)));
    }
    // (Electric wires removed: straight chord lines between lamps cut through
    // the planet and pierced props — they were designed for a flat town.)

    // Tiny NPC placeholders (spheres) near buildings to imply life
    const npcs = new THREE.Group();
    const npcPlaceholders: THREE.Mesh[] = [];
    const NPC_SITES: Array<[number, number]> = [
      // villagers on the village street
      [0.28, 0.06], [0.5, -0.06], [0.72, 0.07], [0.94, -0.05], [1.02, 0.08],
      // market crowd around zone2 + stalls
      [2.42, 0.06], [2.51, -0.08], [2.6, 0.05], [2.45, -0.05], [2.58, 0.09], [2.68, -0.06],
      // plaza visitors at zones 1, 3, 4
      [1.2, 0.05], [1.31, -0.06], [3.71, 0.06], [3.83, -0.05], [4.97, 0.06], [5.09, -0.06],
      // wanderers
      [1.7, 0.2], [4.3, 0.12], [5.6, -0.12],
    ];
    const NPC_SHIRT_COLORS = [0x4488bb, 0xcc5544, 0x55aa55, 0xddaa33, 0x8866aa, 0xbb6644];
    const headMat = new THREE.MeshStandardMaterial({ color: 0xf5c6a0, roughness: 0.7 });
    for (let i = 0; i < NPC_SITES.length; i++) {
      const dir = this.claimDir(this.dirAt(NPC_SITES[i][0], NPC_SITES[i][1]), 0.03);
      const npcGroup = new THREE.Group();
      // Body (capsule-like: cylinder + hemisphere top)
      const shirtMat = new THREE.MeshStandardMaterial({ color: NPC_SHIRT_COLORS[i % NPC_SHIRT_COLORS.length], roughness: 0.6 });
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.1, 0.35, 8), shirtMat);
      body.position.y = 0.175;
      body.castShadow = true;
      npcGroup.add(body);
      // Head
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), headMat);
      head.position.y = 0.43;
      head.castShadow = true;
      npcGroup.add(head);

      const sampled = this.sampleSurfaceByDirection(dir, 0.02);
      npcGroup.position.copy(sampled.position);
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        sampled.normal,
      );
      npcGroup.quaternion.copy(q);
      npcGroup.name = `npc_placeholder_${i}`;
      npcs.add(npcGroup);
      npcPlaceholders.push(npcGroup as unknown as THREE.Mesh);
    }

    // Floating sparkles around the planet surface
    const particles = new THREE.Group();
    const sparkleMat = new THREE.MeshBasicMaterial({
      color: 0xffffee,
      transparent: true,
      opacity: 0.55,
    });
    for (let i = 0; i < 30; i++) {
      const sparkle = new THREE.Mesh(new THREE.SphereGeometry(0.04, 4, 4), sparkleMat);
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 2 - 1);
      const r = this.radius + 0.3 + Math.random() * 2;
      sparkle.position.set(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi),
      );
      sparkle.userData = { baseY: sparkle.position.y, phase: Math.random() * Math.PI * 2 };
      particles.add(sparkle);
    }

    // Tiered fountain for the town square
    const fountain = new THREE.Group();
    const stoneMat = Materials.createTrimMaterial(0x888888);
    // Outer basin
    const outerBasin = new THREE.Mesh(new THREE.CylinderGeometry(2, 2.2, 0.5, 16), stoneMat);
    outerBasin.position.y = 0.25;
    fountain.add(outerBasin);
    // Inner rim
    const innerRim = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.1, 8, 16), stoneMat);
    innerRim.rotation.x = Math.PI / 2;
    innerRim.position.y = 0.52;
    fountain.add(innerRim);
    // Water surface
    const fWaterMat = new THREE.MeshStandardMaterial({
      color: 0x3399dd, transparent: true, opacity: 0.7,
      roughness: 0.05, metalness: 0.3, emissive: 0x1155aa, emissiveIntensity: 0.1,
    });
    const water = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 0.08, 16), fWaterMat);
    water.position.y = 0.5;
    fountain.add(water);
    // Central pillar
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, 1.2, 10), stoneMat);
    pillar.position.y = 1.0;
    fountain.add(pillar);
    // Upper basin
    const upperBasin = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.8, 0.25, 12), stoneMat);
    upperBasin.position.y = 1.65;
    fountain.add(upperBasin);
    // Upper water
    const upperWater = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.06, 12), fWaterMat);
    upperWater.position.y = 1.78;
    fountain.add(upperWater);
    // Spout cap
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 8), stoneMat);
    cap.position.y = 2.0;
    fountain.add(cap);
    fountain.castShadow = true;
    this.placeObjectOnSurface(fountain, new THREE.Vector3(6, this.radius, 2.5), 0.02, true);

    // Stylized human statue
    const statue = new THREE.Group();
    const bronzeMat = Materials.createPBRMaterial({ color: 0x8b6914, roughness: 0.5, metalness: 0.6 });
    const marbleMat = Materials.createTrimMaterial(0xd4cfc4);
    // Two-tier pedestal
    const pedestalBase = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.3, 1.0), marbleMat);
    pedestalBase.position.y = 0.15;
    statue.add(pedestalBase);
    const pedestalTop = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.45, 0.7, 10), marbleMat);
    pedestalTop.position.y = 0.65;
    statue.add(pedestalTop);
    // Figure: torso + head + outstretched arm
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.8, 8, 12), bronzeMat);
    torso.position.y = 1.5;
    statue.add(torso);
    const sHead = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 10), bronzeMat);
    sHead.position.y = 2.1;
    statue.add(sHead);
    // Outstretched arm
    const sArm = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.5, 6), bronzeMat);
    sArm.position.set(0.35, 1.7, 0);
    sArm.rotation.z = -Math.PI / 3;
    statue.add(sArm);
    this.placeObjectOnSurface(statue, new THREE.Vector3(7.5, this.radius, -1.5), 0.02, true);
    statue.castShadow = true;
    statue.receiveShadow = true;
    statue.name = 'central_statue';

    // Add parked cars along the road
    const cars = new THREE.Group();
    for (let i = 0; i < 8; i++) {
      // Increased from 4 to 8
      const carGeom = new THREE.BoxGeometry(1.5, 0.8, 3);
      const CAR_COLORS = [0xc44040, 0x4488bb, 0x55aa55, 0xddcc44, 0xbb6633, 0x8866aa, 0xdd7744, 0x557788];
      const carMat = Materials.createTrimMaterial(CAR_COLORS[i % CAR_COLORS.length]);
      const car = new THREE.Mesh(carGeom, carMat);
      // Parked along Main Street near the districts
      const CAR_LONS = [0.32, 0.7, 1.35, 2.3, 3.68, 4.1, 4.5, 5.85];
      const pos = this.claimDir(this.dirAt(CAR_LONS[i % CAR_LONS.length], i % 2 === 0 ? 0.08 : -0.08), 0.06).multiplyScalar(this.radius);
      const sampled = this.sampleSurfacePosition(pos, 0.33);
      car.position.copy(sampled.position);
      car.quaternion.copy(
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal),
      );
      car.castShadow = true;
      car.receiveShadow = true;
      car.name = `car_${i}`;
      cars.add(car);
    }

    // Add market stalls near houses
    const stalls = new THREE.Group();
    // Market stalls ring the zone2 plaza (the market district centerpiece)
    const STALL_SITES: Array<[number, number]> = [
      [2.35, 0.12], [2.35, -0.12], [2.51, 0.17], [2.51, -0.17], [2.67, 0.12], [2.67, -0.12],
    ];
    for (let i = 0; i < STALL_SITES.length; i++) {
      const stall = this.createStall();
      const [sLon, sLat] = STALL_SITES[i];
      const pos = this.claimDir(this.dirAt(sLon, sLat), 0.07).multiplyScalar(this.radius);
      const sampled = this.sampleSurfacePosition(pos, -0.08); // sunk slightly: bury-not-float
      stall.position.copy(sampled.position);
      stall.quaternion.copy(
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal),
      );
      stall.castShadow = true;
      stall.receiveShadow = true;
      stall.name = `stall_${i}`;
      stalls.add(stall);
    }

    // Signboards removed: unsupported flat planes floating at 0.8u read as
    // glitches (assets hovering in the air), not decor.
    const signboards = new THREE.Group();

    // Add rivers
    const rivers = new THREE.Group();
    const RIVER_SITES: Array<[number, number]> = [[4.62, 0.4], [0.6, -0.38]];
    for (let i = 0; i < RIVER_SITES.length; i++) {
      const river = this.createRiver();
      const pos = this.claimDir(this.dirAt(RIVER_SITES[i][0], RIVER_SITES[i][1]), 0.2).multiplyScalar(this.radius);
      const sampled = this.sampleSurfacePosition(pos, 0.1);
      river.position.copy(sampled.position);
      river.quaternion.copy(
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal),
      );
      river.name = `river_${i}`;
      rivers.add(river);
      // Conform the flat plane to the curved terrain: a 10-unit chord floats at
      // its ends on an r=18 sphere, so project every vertex onto the surface.
      rivers.updateMatrixWorld(true);
      river.updateMatrixWorld(true);
      river.traverse((n) => {
        if (!(n instanceof THREE.Mesh)) return;
        const posAttr = n.geometry.attributes.position as THREE.BufferAttribute;
        const v = new THREE.Vector3();
        for (let vi = 0; vi < posAttr.count; vi++) {
          v.fromBufferAttribute(posAttr, vi).applyMatrix4(n.matrixWorld);
          const s = this.sampleSurfacePosition(v, 0.06);
          v.copy(s.position);
          n.worldToLocal(v);
          posAttr.setXYZ(vi, v.x, v.y, v.z);
        }
        posAttr.needsUpdate = true;
        n.geometry.computeVertexNormals();
      });
    }

    // Add mountains
    const mountains = new THREE.Group();
    const MOUNTAIN_SITES: Array<[number, number]> = [[3.9, 0.95], [5.1, 1.02], [1.9, -0.98]];
    for (let i = 0; i < MOUNTAIN_SITES.length; i++) {
      const mountain = this.createMountain();
      const [mLon, mLat] = MOUNTAIN_SITES[i];
      const pos = this.claimDir(this.dirAt(mLon, mLat), 0.3).multiplyScalar(this.radius);
      const sampled = this.sampleSurfacePosition(pos, -0.35); // bedded into terrain
      mountain.position.copy(sampled.position);
      mountain.quaternion.copy(
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal),
      );
      mountain.castShadow = true;
      mountain.receiveShadow = true;
      mountain.name = `mountain_${i}`;
      mountains.add(mountain);
    }

    // Add construction blocks
    const constructions = new THREE.Group();
    const WORK_SITES: Array<[number, number]> = [[4.15, 0.22], [4.55, -0.24]];
    for (let i = 0; i < WORK_SITES.length; i++) {
      const block = this.createConstructionBlock();
      const pos = this.claimDir(this.dirAt(WORK_SITES[i][0], WORK_SITES[i][1]), 0.12).multiplyScalar(this.radius);
      const sampled = this.sampleSurfacePosition(pos, -0.1); // block base sunk slightly
      block.position.copy(sampled.position);
      block.quaternion.copy(
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal),
      );
      block.castShadow = true;
      block.receiveShadow = true;
      block.name = `construction_${i}`;
      constructions.add(block);
    }

    // Add flowers for color and life — each is a stem + petal ring + center
    const flowers = new THREE.Group();
    const FLOWER_COLORS = [0xff69b4, 0xf4a940, 0xffffff, 0xb46bd8, 0xff8866];
    const stemMat = Materials.createStandardMaterial({ color: 0x3d7a3d });
    for (let i = 0; i < 50; i++) {
      const flowerGroup = new THREE.Group();
      // Stem
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.25, 5), stemMat);
      stem.position.y = 0.125;
      flowerGroup.add(stem);
      // Petals — 5 small spheres in a ring
      const petalColor = FLOWER_COLORS[i % FLOWER_COLORS.length];
      const petalMat = new THREE.MeshStandardMaterial({
        color: petalColor, emissive: petalColor, emissiveIntensity: 0.15,
      });
      for (let p = 0; p < 5; p++) {
        const pa = (p / 5) * Math.PI * 2;
        const petal = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 6), petalMat);
        petal.position.set(Math.cos(pa) * 0.06, 0.27, Math.sin(pa) * 0.06);
        petal.scale.set(1.2, 0.6, 1.2);
        flowerGroup.add(petal);
      }
      // Center
      const center = new THREE.Mesh(
        new THREE.SphereGeometry(0.04, 6, 6),
        new THREE.MeshStandardMaterial({ color: 0xffdd44, emissive: 0xffdd44, emissiveIntensity: 0.3 }),
      );
      center.position.y = 0.27;
      flowerGroup.add(center);
      // Position on island surface
      const zoneLon = [0, 1.2566, 2.5133, 3.7699, 5.0265][Math.floor(i / 10)];
      const ringA = ((i % 10) / 10) * Math.PI * 2;
      const fDir = this.dirAt(zoneLon + Math.cos(ringA) * 0.14, Math.sin(ringA) * 0.14);
      const pos = this.claimDir(fDir, 0.015).multiplyScalar(this.radius);
      const sampled = this.sampleSurfacePosition(pos, 0.1);
      flowerGroup.position.copy(sampled.position);
      flowerGroup.quaternion.copy(
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal),
      );
      flowerGroup.name = `flower_${i}`;
      flowers.add(flowerGroup);
    }

    // Add signs for shops/buildings
    const signs = new THREE.Group();
    // (small floating sign planes removed for the same reason)

    // Add dust/pollen particles for ambiance
    const dustParticles = new THREE.Group();
    const dustMat = new THREE.MeshBasicMaterial({
      color: 0xeeddaa,
      transparent: true,
      opacity: 0.35,
    });
    for (let i = 0; i < 80; i++) {
      const dust = new THREE.Mesh(new THREE.SphereGeometry(0.03, 4, 4), dustMat);
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 2 - 1);
      const r = this.radius + 0.5 + Math.random() * 4;
      dust.position.set(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi),
      );
      dust.userData = { baseY: dust.position.y, phase: Math.random() * Math.PI * 2 };
      dust.name = 'dust';
      dustParticles.add(dust);
    }

    // Park benches near zone plazas
    const benches = new THREE.Group();
    const BENCH_SITES: Array<[number, number]> = [
      [0.1, 0.08], [0.6, -0.1], [1.15, 0.1], [2.3, 0.08], [2.7, -0.08],
      [3.6, 0.07], [4.0, -0.06], [5.0, 0.08], [5.5, -0.07],
    ];
    const benchWoodMat = new THREE.MeshStandardMaterial({ color: 0x8b6b42, roughness: 0.7 });
    const benchLegMat = Materials.createTrimMaterial(0x444444);
    for (let i = 0; i < BENCH_SITES.length; i++) {
      const bDir = this.claimDir(this.dirAt(BENCH_SITES[i][0], BENCH_SITES[i][1]), 0.02);
      const bSampled = this.sampleSurfaceByDirection(bDir, 0.0);
      const bench = new THREE.Group();
      // Seat plank
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.04, 0.18), benchWoodMat);
      seat.position.y = 0.2;
      bench.add(seat);
      // Back rest
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.2, 0.03), benchWoodMat);
      back.position.set(0, 0.35, -0.08);
      bench.add(back);
      // Two legs
      for (const lx of [-0.2, 0.2]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.2, 0.16), benchLegMat);
        leg.position.set(lx, 0.1, 0);
        bench.add(leg);
      }
      bench.position.copy(bSampled.position);
      const bq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), bSampled.normal);
      bench.quaternion.copy(bq);
      bench.quaternion.premultiply(
        new THREE.Quaternion().setFromAxisAngle(bSampled.normal, Math.random() * Math.PI * 2),
      );
      bench.name = `bench_${i}`;
      bench.castShadow = true;
      benches.add(bench);
    }

    // Group everything and attach to the main mesh as children so the island remains dominant
    const root = new THREE.Group();
    root.add(mesh);
    root.add(pathGroup);
    root.add(buildings);
    root.add(houses);
    root.add(trees);
    root.add(mailboxes);
    root.add(lamps);
    root.add(npcs);
    root.add(particles);
    root.add(fountain);
    root.add(statue);
    root.add(cars);
    root.add(flowers);
    root.add(signs);
    root.add(dustParticles);
    root.add(stairs);
    root.add(stalls);
    root.add(signboards);
    root.add(constructions);
    root.add(rivers);
    root.add(mountains);
    root.add(benches);
    this.tryLoadModels(buildings, npcs, buildingPlaceholders, npcPlaceholders).catch(() => {
      /* swallow errors */
    });

    // Try to convert the segmented road to decal-projected meshes for crisper inlays (async)
    // non-blocking; will fall back to segmented planes if DecalGeometry isn't available
    this.tryConvertRoadToDecals(pathGroup, mesh).catch(() => {
      /* ignore */
    });

    // Return the group as a Mesh-typed value to keep compatibility with existing code
    return root as unknown as THREE.Mesh;
  }

  /**
   * Sample the actual displaced island surface near an approximate position.
   * It performs a short raycast from slightly outside the expected surface inward
   * to find the real displaced geometry point and normal. Falls back to radial math
   * if the raycast fails.
   *
   * @param approxPos - an approximate position (usually a vector on the base radius circle)
   * @param desiredOffset - how far above the base radius the caller expects the object to sit (used as a small bias)
   */
  /** Unit direction from (longitude, latitude) in radians. */
  private dirAt(lon: number, lat: number): THREE.Vector3 {
    return new THREE.Vector3(
      Math.cos(lon) * Math.cos(lat),
      Math.sin(lat),
      Math.sin(lon) * Math.cos(lat),
    ).normalize();
  }

  /**
   * Yaw an already surface-aligned object so its local +Z faces a target
   * point (projected onto the tangent plane). Used to face houses/stalls
   * toward the road/plaza instead of random spins.
   */
  private faceObjectToward(obj: THREE.Object3D, normal: THREE.Vector3, target: THREE.Vector3): void {
    const proj = (v: THREE.Vector3) =>
      v.clone().sub(normal.clone().multiplyScalar(v.dot(normal)));
    const current = proj(new THREE.Vector3(0, 0, 1).applyQuaternion(obj.quaternion));
    const desired = proj(target.clone().sub(obj.position));
    if (current.lengthSq() < 1e-8 || desired.lengthSq() < 1e-8) return;
    current.normalize();
    desired.normalize();
    const angle = Math.atan2(
      new THREE.Vector3().crossVectors(current, desired).dot(normal),
      current.dot(desired),
    );
    obj.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(normal, angle));
  }

  // Global placement registry: every claimed direction with its clearance,
  // shared across all prop categories (and used by GameScene) so independent
  // scatter passes stop clustering on top of each other.
  private occupiedDirs: Array<{ dir: THREE.Vector3; arc: number }> = [];

  /**
   * Claim a surface direction with a minimum angular clearance. If the
   * candidate is too close to something already placed, jitter around it
   * (up to 10 tries) before accepting the least-bad candidate.
   */
  public claimDir(candidate: THREE.Vector3, minArc: number, maxSlopeRad?: number): THREE.Vector3 {
    let best = candidate.clone().normalize();
    let bestClearance = -1;
    for (let attempt = 0; attempt < 10; attempt++) {
      const dir =
        attempt === 0
          ? candidate.clone().normalize()
          : candidate
              .clone()
              .normalize()
              .add(
                new THREE.Vector3(
                  (Math.random() - 0.5) * 0.5,
                  (Math.random() - 0.5) * 0.35,
                  (Math.random() - 0.5) * 0.5,
                ),
              )
              .normalize();
      let clearance = Infinity;
      for (const o of this.occupiedDirs) {
        clearance = Math.min(clearance, dir.angleTo(o.dir) - o.arc);
      }
      // Slope check: structures on steep sites bury their uphill corner and
      // float the downhill one - reject steep candidates so buildings settle
      // on flat-ish ground.
      let slopeOk = true;
      if (typeof maxSlopeRad === 'number') {
        try {
          const s = this.sampleSurfacePosition(dir.clone().multiplyScalar(this.radius), 0);
          const n = (s as { rawNormal?: THREE.Vector3 }).rawNormal ?? s.normal;
          slopeOk = n.angleTo(dir) <= maxSlopeRad;
        } catch {
          slopeOk = true;
        }
      }
      if (clearance >= minArc && slopeOk) {
        this.occupiedDirs.push({ dir, arc: minArc });
        return dir;
      }
      if (clearance > bestClearance) {
        bestClearance = clearance;
        best = dir;
      }
    }
    this.occupiedDirs.push({ dir: best, arc: minArc });
    return best;
  }

  private sampleSurfacePosition(
    approxPos: THREE.Vector3,
    desiredOffset: number = 0,
  ): { position: THREE.Vector3; normal: THREE.Vector3; rawNormal?: THREE.Vector3 } {
    // Enhanced fallback: use nearest point on terrain mesh if available
    const fallbackNormal = approxPos.clone().normalize();
    const fallbackPos = this.center
      .clone()
      .add(fallbackNormal.clone().multiplyScalar(this.radius + desiredOffset));

    try {
      if (!this.surfaceMesh) return { position: fallbackPos, normal: fallbackNormal };

      // direction from center to approx position
      const dir = approxPos.clone().normalize();
      // guess the maximum displacement we might find on the terrain (mountains/hills)
      const maxExpectedDisplacement = 4.5; // Increased from 3.0 to account for higher peaks

      // Try multiple raycast strategies to robustly hit displaced geometry
      const strategies = [] as { start: THREE.Vector3; dir: THREE.Vector3; far: number }[];

      // primary: cast from slightly outside the max displacement inward along center
      const primaryStart = this.center
        .clone()
        .add(dir.clone().multiplyScalar(this.radius + maxExpectedDisplacement + 1.0));
      strategies.push({
        start: primaryStart,
        dir: this.center.clone().sub(primaryStart).normalize(),
        far: maxExpectedDisplacement + 3.0 + this.radius + 15,
      });

      // secondary: cast a short ray outward from a point on the base radius toward the sky (handles cases with overhangs)
      const basePoint = this.center.clone().add(dir.clone().multiplyScalar(this.radius + 0.02));
      const outStart = basePoint.clone().add(dir.clone().multiplyScalar(-1.0)); // slightly inside
      strategies.push({ start: outStart, dir: dir.clone().normalize(), far: 8.0 });

      // tertiary: jittered inward rays to catch nearby displaced peaks (helps when sampling on very bumpy areas)
      const jitterAngles = [0.0, 0.15, -0.15, 0.3, -0.3, 0.45, -0.45];
      for (const a of jitterAngles) {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
        const jDir = dir.clone().applyQuaternion(q).normalize();
        const s = this.center
          .clone()
          .add(jDir.clone().multiplyScalar(this.radius + maxExpectedDisplacement + 1.0));
        strategies.push({
          start: s,
          dir: this.center.clone().sub(s).normalize(),
          far: maxExpectedDisplacement + 3.0 + this.radius + 15,
        });
      }

      // make sure the mesh matrices are up-to-date
      this.surfaceMesh.updateMatrixWorld(true);

      let hit: THREE.Intersection | null = null;
      let usedStrategyStart: THREE.Vector3 | null = null;
      for (const strat of strategies) {
        try {
          const raycaster = new THREE.Raycaster(strat.start, strat.dir, 0, strat.far);
          const intersects = raycaster.intersectObject(this.surfaceMesh, true);
          if (intersects && intersects.length) {
            hit = intersects[0];
            usedStrategyStart = strat.start;
            break;
          }
        } catch {
          // ignore and try next
        }
      }

      if (hit) {
        const point = hit.point.clone();
        // remember the strat.start used for debug line (approximate)
        // find the first strategy whose ray would have hit roughly this point (best-effort)
        for (const strat of strategies) {
          const toP = point.clone().sub(strat.start);
          const proj = toP.dot(strat.dir);
          if (proj > 0 && proj < strat.far + 1e-3) {
            usedStrategyStart = strat.start;
            break;
          }
        }
        // compute a world-space normal from the hit face
        let normal = new THREE.Vector3(0, 1, 0);
        if (hit.face) {
          const nm = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
          normal = hit.face.normal.clone().applyMatrix3(nm).normalize();
        } else {
          normal = point.clone().sub(this.center).normalize();
        }
        const rawNormal = normal.clone(); // unclamped - used for slope tests
        // Clamp tilt: raw face normals on bumpy terrain deviate wildly from "up",
        // laying large props (stalls, mountains, cars) on their sides. Keep the
        // terrain-sampled position but cap orientation at a slight lean.
        {
          const radial = point.clone().sub(this.center).normalize();
          if (normal.dot(radial) < 0) normal.negate();
          const MAX_TILT = 0.21; // ~12 degrees
          const tilt = radial.angleTo(normal);
          if (tilt > MAX_TILT) {
            const axis = new THREE.Vector3().crossVectors(radial, normal);
            normal =
              axis.lengthSq() > 1e-10
                ? radial.clone().applyAxisAngle(axis.normalize(), MAX_TILT).normalize()
                : radial;
          }
        }
        // apply a tiny outward epsilon so placed objects don't z-fight
        // Small epsilon to prevent z-fighting, actual object offsets handled separately
        const epsilon = 0.02;
        const outPos = point.clone().add(normal.clone().multiplyScalar(epsilon + desiredOffset));
        // debug: draw helper sphere + ray
        const meshData = this.mesh.userData as IslandMeshUserData;
        if (meshData._debug) {
          const helpers = meshData._debugHelpers ?? new THREE.Group();
          if (!meshData._debugHelpers) {
            meshData._debugHelpers = helpers;
          }
          // small sphere at hit point
          const sph = new THREE.Mesh(
            new THREE.SphereGeometry(0.03, 6, 6),
            new THREE.MeshBasicMaterial({ color: 0xff00ff }),
          );
          sph.position.copy(point);
          // line from ray start to hit
          const from = usedStrategyStart ? usedStrategyStart.clone() : primaryStart.clone();
          const lineGeom = new THREE.BufferGeometry().setFromPoints([from.clone(), point.clone()]);
          const line = new THREE.Line(lineGeom, new THREE.LineBasicMaterial({ color: 0x00ffff }));
          helpers.add(sph);
          helpers.add(line);
          // attach helpers if not attached
          if (!helpers.parent) this.mesh.add(helpers);
          // remove helpers shortly to avoid memory growth
          setTimeout(() => {
            helpers.remove(sph);
            helpers.remove(line);
          }, 2000);
        }
        return { position: outPos, normal, rawNormal };
      }
      return { position: fallbackPos, normal: fallbackNormal };
    } catch {
      return { position: fallbackPos, normal: fallbackNormal };
    }
  }

  // Build a ring of small segment meshes that sit on the sphere surface to emulate a road/decals.
  private createRoadRing(radius: number, width: number, segments: number = 64): THREE.Group {
    const group = new THREE.Group();
    // generate PBR-style road textures (albedo, normal, roughness) via TextureGenerator
    const roadTex = TextureGenerator.createRoadTextures(512, 64);
    const tex = roadTex.albedo;
    const normalTex = roadTex.normal;
    const roughnessTex = roadTex.roughness;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(segments / 8, 1);
    roughnessTex.wrapS = THREE.RepeatWrapping;
    roughnessTex.wrapT = THREE.RepeatWrapping;
    roughnessTex.repeat.set(segments / 8, 1);

    const segAngle = (Math.PI * 2) / segments;
    const segLength = (2 * Math.PI * radius) / segments;
    for (let i = 0; i < segments; i++) {
      const angle = i * segAngle;
      // central point on sphere surface
      const approxCenter = new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      const center = this.center.clone().add(
        approxCenter
          .clone()
          .normalize()
          .multiplyScalar(this.radius + 0.01),
      );
      // tangent direction along ring
      const approxNext = new THREE.Vector3(
        Math.cos(angle + segAngle) * radius,
        0,
        Math.sin(angle + segAngle) * radius,
      );
      const next = this.center.clone().add(
        approxNext
          .clone()
          .normalize()
          .multiplyScalar(this.radius + 0.01),
      );
      const dir = next.clone().sub(center).normalize();

      const planeGeom = new THREE.PlaneGeometry(segLength * 1.05, width, 1, 1);
      // prefer a PBR trim/road material and attach generated maps
      const mat = Materials.createTrimMaterial(0xc9cf9a); // sandy-green worn path
      // Material is guaranteed to be MeshStandardMaterial from createTrimMaterial return type
      if (mat) {
        mat.map = tex;
        mat.normalMap = normalTex;
        mat.roughnessMap = roughnessTex;
        mat.normalScale = new THREE.Vector2(0.6, 0.6);
        tex.needsUpdate = true;
        normalTex.needsUpdate = true;
        roughnessTex.needsUpdate = true;
      }
      const mesh = new THREE.Mesh(planeGeom, mat);
      // mark as temporary plane so we can remove when decals are projected
      const planeUserData: RoadPlaneUserData = { isRoadPlane: true };
      mesh.userData = planeUserData;
      // position at midpoint between center and next, then project to surface normal
      const mid = center.clone().add(next).multiplyScalar(0.5);
      const sampled = this.sampleSurfacePosition(mid, 0.02);
      const normal = sampled.normal;
      const surfacePos = sampled.position;
      mesh.position.copy(surfacePos);
      // align plane so its up is surface normal and rotation follows dir
      const up = new THREE.Vector3(0, 1, 0);
      const q = new THREE.Quaternion().setFromUnitVectors(up, normal);
      mesh.quaternion.copy(q);
      // rotate around local Y so plane faces along tangent
      const qInv = q.clone().invert();
      const localDir = dir.clone().applyQuaternion(qInv);
      const yaw = Math.atan2(localDir.z, localDir.x);
      mesh.rotateOnAxis(new THREE.Vector3(0, 1, 0), yaw);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    // store texture references for potential decal conversion
    const roadUserData: RoadRingUserData = {
      pathRadius: radius,
      tex,
      normalTex,
      roughnessTex,
      width,
      segments,
    };
    group.userData = roadUserData;
    return group;
  }

  private createStairs(): THREE.Group {
    const group = new THREE.Group();
    const stepHeight = 0.15;
    const stepDepth = 0.3;
    const stepWidth = 1.5;
    const numSteps = 5;
    const stepMat = Materials.createTrimMaterial(0x888888);
    for (let i = 0; i < numSteps; i++) {
      const stepGeom = new THREE.BoxGeometry(stepWidth, stepHeight, stepDepth);
      const step = new THREE.Mesh(stepGeom, stepMat);
      step.position.set(0, i * stepHeight, i * stepDepth);
      step.castShadow = true;
      step.receiveShadow = true;
      group.add(step);
    }
    // Add railings
    const railMat = Materials.createTrimMaterial(0x444444);
    const railGeom = new THREE.CylinderGeometry(0.05, 0.05, numSteps * stepDepth);
    const leftRail = new THREE.Mesh(railGeom, railMat);
    leftRail.position.set(-stepWidth / 2, (numSteps * stepHeight) / 2, (numSteps * stepDepth) / 2);
    leftRail.rotation.z = Math.PI / 2;
    group.add(leftRail);
    const rightRail = leftRail.clone();
    rightRail.position.x = stepWidth / 2;
    group.add(rightRail);
    return group;
  }

  private createStall(): THREE.Group {
    const group = new THREE.Group();
    // ground skirt so slope gaps under the stall read as a wooden deck
    const skirtGeom = new THREE.BoxGeometry(1.35, 0.5, 0.95);
    const skirtMat = Materials.createTrimMaterial(0x8a7355);
    const skirt = new THREE.Mesh(skirtGeom, skirtMat);
    skirt.position.set(0, -0.2, 0);
    group.add(skirt);
    // Base table
    const tableGeom = new THREE.BoxGeometry(1.2, 0.3, 0.8);
    const tableMat = Materials.createTrimMaterial(0x8b4513);
    const table = new THREE.Mesh(tableGeom, tableMat);
    table.position.set(0, 0.15, 0);
    table.castShadow = true;
    table.receiveShadow = true;
    group.add(table);
    // Four support posts
    const postMat = Materials.createTrimMaterial(0x6b4226);
    for (const sx of [-0.5, 0.5]) {
      for (const sz of [-0.3, 0.3]) {
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.6, 5), postMat);
        p.position.set(sx, 0.6, sz);
        group.add(p);
      }
    }
    // Roof
    const roofGeom = new THREE.ConeGeometry(0.8, 0.4, 4);
    const STALL_COLORS = [0xd44e3c, 0xc47a2e, 0x3e8e6d, 0x4478a8];
    const roofMat = Materials.createTrimMaterial(STALL_COLORS[Math.floor(Math.random() * STALL_COLORS.length)]);
    const roof = new THREE.Mesh(roofGeom, roofMat);
    roof.position.set(0, 1.05, 0);
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    group.add(roof);
    // Small goods on the table
    const goodColors = [0xff8844, 0x44aa44, 0xddcc33, 0xaa4488];
    for (let g = 0; g < 3; g++) {
      const good = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.1, 0.12),
        new THREE.MeshStandardMaterial({ color: goodColors[g % goodColors.length], roughness: 0.6 }),
      );
      good.position.set(-0.3 + g * 0.3, 0.35, 0);
      group.add(good);
    }
    return group;
  }

  private createConstructionBlock(): THREE.Group {
    const group = new THREE.Group();
    // Main building block
    const buildingGeom = new THREE.BoxGeometry(2, 3, 2);
    const buildingMat = Materials.createPBRMaterial({ color: 0xcccccc, roughness: 0.9 });
    const building = new THREE.Mesh(buildingGeom, buildingMat);
    building.position.set(0, 1.5, 0);
    building.castShadow = true;
    building.receiveShadow = true;
    group.add(building);
    // Scaffolding poles
    const poleMat = Materials.createTrimMaterial(0x666666);
    const poleGeom = new THREE.CylinderGeometry(0.05, 0.05, 4, 8);
    for (let i = 0; i < 4; i++) {
      const pole = new THREE.Mesh(poleGeom, poleMat);
      const x = (i % 2) * 1.8 - 0.9;
      const z = Math.floor(i / 2) * 1.8 - 0.9;
      pole.position.set(x, 2, z);
      pole.castShadow = true;
      pole.receiveShadow = true;
      group.add(pole);
    }
    return group;
  }

  private createRiver(): THREE.Group {
    const group = new THREE.Group();
    const riverGeom = new THREE.PlaneGeometry(8, 1.6, 32, 6);
    const pos = riverGeom.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      pos.setZ(i, Math.sin(x * 0.8) * 0.35);
      const edgeFade = 1 - Math.abs(pos.getY(i)) / 0.8;
      pos.setY(i, pos.getY(i) * (0.6 + edgeFade * 0.4));
    }
    riverGeom.computeVertexNormals();
    const riverMat = new THREE.MeshStandardMaterial({
      color: 0x3399dd,
      transparent: true,
      opacity: 0.7,
      roughness: 0.05,
      metalness: 0.3,
      emissive: 0x1155aa,
      emissiveIntensity: 0.15,
    });
    const river = new THREE.Mesh(riverGeom, riverMat);
    river.rotation.x = -Math.PI / 2;
    river.receiveShadow = true;
    group.add(river);
    return group;
  }

  private createMountain(): THREE.Group {
    // Redesigned: a single granite peak with a snow cap, half the old size.
    // The old 11u cone + wide base cylinder covered a third of the visible
    // hemisphere from orbit and read as a grey octagon landing pad with a
    // brown ring from above.
    const group = new THREE.Group();
    const peakGeom = new THREE.ConeGeometry(2.6, 5.2, 7);
    const peakMat = Materials.createPBRMaterial({ color: 0x9aa0a8, roughness: 0.95 });
    const peak = new THREE.Mesh(peakGeom, peakMat);
    peak.position.set(0, 2.6, 0);
    peak.castShadow = true;
    peak.receiveShadow = true;
    group.add(peak);
    const snowGeom = new THREE.ConeGeometry(0.95, 1.6, 7);
    const snowMat = Materials.createPBRMaterial({ color: 0xf4f6f8, roughness: 0.6 });
    const snow = new THREE.Mesh(snowGeom, snowMat);
    snow.position.set(0, 4.5, 0);
    group.add(snow);
    return group;
  }

  // Attempt to replace the segmented road planes with DecalGeometry projected decals for sharper results.
  private async tryConvertRoadToDecals(pathGroup: THREE.Group, targetMesh: THREE.Mesh) {
    try {
      const mod = await import('three/addons/geometries/DecalGeometry.js');
      const { DecalGeometry } = mod as {
        DecalGeometry: new (
          mesh: THREE.Mesh,
          position: THREE.Vector3,
          orientation: THREE.Euler,
          size: THREE.Vector3,
        ) => THREE.BufferGeometry;
      };
      const ud = pathGroup.userData as Partial<RoadRingUserData>;
      const segments = ud.segments ?? 128;
      const width = ud.width ?? 0.8;
      const pathRadius = ud.pathRadius ?? this.radius * 0.9;
      const tex = ud.tex;
      const normalTex = ud.normalTex;

      const segAngle = (Math.PI * 2) / segments;
      const segLength = (2 * Math.PI * pathRadius) / segments;

      // create decal material
      const decalMat = new THREE.MeshStandardMaterial({
        map: tex || undefined,
        normalMap: normalTex || undefined,
        color: 0xc9cf9a, // sandy-green worn path — blends with grass instead of reading as dark shards
        transparent: true,
        opacity: 0.45,
        depthTest: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        side: THREE.DoubleSide,
      });

      // For each segment, project a decal onto the target mesh
      for (let i = 0; i < segments; i++) {
        const angle = i * segAngle;
        const approxCenterLocal = new THREE.Vector3(
          Math.cos(angle) * pathRadius,
          0,
          Math.sin(angle) * pathRadius,
        );
        const centerLocal = this.center.clone().add(
          approxCenterLocal
            .clone()
            .normalize()
            .multiplyScalar(this.radius + 0.02),
        );
        // midpoint toward next segment for stable placement
        const approxNextLocal = new THREE.Vector3(
          Math.cos(angle + segAngle) * pathRadius,
          0,
          Math.sin(angle + segAngle) * pathRadius,
        );
        const nextLocal = this.center.clone().add(
          approxNextLocal
            .clone()
            .normalize()
            .multiplyScalar(this.radius + 0.02),
        );
        const mid = centerLocal.clone().add(nextLocal).multiplyScalar(0.5);
        const normal = mid.clone().sub(this.center).normalize();

        // decal size: width across ring, length along ring, depth small
        const size = new THREE.Vector3(segLength * 1.4, width * 1.2, 0.6);

        // orientation: make decal face outward along surface normal
        const up = new THREE.Vector3(0, 1, 0);
        const q = new THREE.Quaternion().setFromUnitVectors(up, normal);
        // DecalGeometry wants an Euler orientation; build from quaternion
        const euler = new THREE.Euler().setFromQuaternion(q, 'XYZ');

        const decalGeom = new DecalGeometry(targetMesh, mid, euler, size);
        const decalMesh = new THREE.Mesh(decalGeom, decalMat);
        decalMesh.castShadow = false;
        decalMesh.receiveShadow = true;
        pathGroup.add(decalMesh);
      }

      // remove previous plane segments
      const toRemove: THREE.Object3D[] = [];
      pathGroup.children.forEach((child) => {
        const data = child.userData as RoadPlaneUserData | undefined;
        if (data?.isRoadPlane) toRemove.push(child);
      });
      toRemove.forEach((child) => {
        pathGroup.remove(child);
      });
    } catch {
      // DecalGeometry not available or failed — leave plane segments in place
      return;
    }
  }

  private async tryLoadModels(
    _buildings: THREE.Group,
    _npcs: THREE.Group,
    _buildingPlaceholders: THREE.Mesh[],
    _npcPlaceholders: THREE.Mesh[],
  ) {
    try {
      const loaderModule = await import('three/addons/loaders/GLTFLoader.js');
      const { GLTFLoader: GLTFLoaderClass } = loaderModule as { GLTFLoader: GLTFLoaderConstructor };
      const loader = new GLTFLoaderClass();
      const basePath = '/assets/models/';

      // helper to find procedural placeholders by name prefix across island root
      const findPlaceholders = (prefix: string): THREE.Object3D[] => {
        const out: THREE.Object3D[] = [];
        this.mesh.traverse((obj) => {
          if (obj.name.startsWith(prefix)) {
            out.push(obj);
          }
        });
        return out;
      };

      // per-model override table (basename -> tweaks)
      let modelOverrides: Record<string, ModelOverride> = {
        // Intended toon set (Blender-authored, public/assets/models/*.glb)
        'bench.glb': { envMapIntensity: 0.8, randomYaw: true },
        'mailbox.glb': { envMapIntensity: 0.8 },
        'car.glb': { envMapIntensity: 0.9, randomYaw: true },
        'npc.glb': { envMapIntensity: 0.7, scale: 1.0 },
        'tree.glb': { envMapIntensity: 0.5 },
        'lamp.glb': { envMapIntensity: 0.6 },
        'house.glb': { envMapIntensity: 0.8, randomYaw: true },
        // Legacy kit fallbacks
        'bench.gltf': { envMapIntensity: 0.8 },
        'Bench.gltf': { envMapIntensity: 0.85, fitHeight: 1.15, randomYaw: true },
        'Chair_1.gltf': { envMapIntensity: 0.85, fitHeight: 1.4, randomYaw: true },
        'Lantern_Wall.gltf': { envMapIntensity: 0.9, fitHeight: 2.4 },
        'car.gltf': { envMapIntensity: 0.9 },
        'npc.gltf': { envMapIntensity: 0.7, roughnessScale: 1.0, scale: 0.6 },
        'tree.gltf': { envMapIntensity: 0.5 },
        'lamp.gltf': { envMapIntensity: 0.6 },
        'Stall_Empty.gltf': { envMapIntensity: 0.85, fitHeight: 3.8, randomYaw: true },
        'Stall_Cart_Empty.gltf': { envMapIntensity: 0.85, fitHeight: 3.2, randomYaw: true },
        'Workbench.gltf': { envMapIntensity: 0.75, fitHeight: 2.0, randomYaw: true },
        'Workbench_Drawers.gltf': { envMapIntensity: 0.75, fitHeight: 2.0, randomYaw: true },
        'Cabinet.gltf': { envMapIntensity: 0.8, fitHeight: 2.4, randomYaw: true },
        'Barrel.gltf': { envMapIntensity: 0.7, fitHeight: 1.2, randomYaw: true },
        'Crate_Wooden.gltf': { envMapIntensity: 0.7, fitHeight: 1.1, randomYaw: true },
      };

      // Attempt to read optional overrides manifest next to models (assets/models/overrides.json)
      try {
        const manifestResp = await fetch('assets/models/overrides.json');
        if (manifestResp.ok) {
          const userOverrides = await manifestResp.json();
          if (userOverrides && typeof userOverrides === 'object') {
            modelOverrides = Object.assign({}, modelOverrides, userOverrides);
            console.log('Island: applied model overrides manifest');
          }
        }
      } catch {
        /* ignore missing manifest */
      }

      // helper to split a packed ORM texture into separate textures
      // packingHint examples: 'rga' (R=AO,G=Rough,B=Metal), 'rgb' (R=red->ao, G=green->rough, B=blue->metal)
      const splitORMTexture = (
        texture: THREE.Texture,
        packingHint: string = 'rga',
      ): ORMSplitResult | null => {
        const textureKey: object = texture;
        const imageKey =
          typeof texture.image === 'object' && texture.image !== null
            ? (texture.image as object)
            : undefined;

        const cachedTexture = ormTextureCache.get(textureKey);
        if (cachedTexture !== undefined) {
          return cachedTexture;
        }
        if (imageKey) {
          const cachedImage = ormTextureCache.get(imageKey);
          if (cachedImage !== undefined) {
            ormTextureCache.set(textureKey, cachedImage);
            return cachedImage;
          }
        }

        if (
          ormTextureProcessing.has(textureKey) ||
          (imageKey && ormTextureProcessing.has(imageKey))
        ) {
          return null;
        }

        ormTextureProcessing.add(textureKey);
        if (imageKey) {
          ormTextureProcessing.add(imageKey);
        }

        const recordResult = (result: ORMSplitResult | null) => {
          ormTextureCache.set(textureKey, result);
          if (imageKey) {
            ormTextureCache.set(imageKey, result);
          }
        };

        const textureName = getTextureIdentifier(texture);

        try {
          const image = texture.image as
            | (HTMLImageElement & object)
            | (HTMLCanvasElement & object)
            | (ImageBitmap & object)
            | undefined;
          const width =
            image && typeof (image as { width?: number }).width === 'number'
              ? (image as { width: number }).width
              : ((image as HTMLImageElement | undefined)?.naturalWidth ?? 0);
          const height =
            image && typeof (image as { height?: number }).height === 'number'
              ? (image as { height: number }).height
              : ((image as HTMLImageElement | undefined)?.naturalHeight ?? 0);
          if (!width || !height || !image) {
            recordResult(null);
            return null;
          }

          const sourceCanvas = document.createElement('canvas');
          sourceCanvas.width = width;
          sourceCanvas.height = height;
          const sourceContext = sourceCanvas.getContext('2d');
          if (!sourceContext) {
            recordResult(null);
            return null;
          }

          try {
            sourceContext.drawImage(image as CanvasImageSource, 0, 0, width, height);
          } catch (error) {
            console.warn(
              'splitORMTexture: canvas drawImage failed (possible CORS taint), skipping split',
              error,
            );
            getDiagnostics().push({
              map: textureName,
              result: 'tainted',
              reason: 'drawImage failed (CORS/taint)',
            });
            recordResult(null);
            return null;
          }

          let imageData: ImageData;
          try {
            imageData = sourceContext.getImageData(0, 0, width, height);
          } catch (error) {
            console.warn(
              'splitORMTexture: getImageData failed (tainted canvas), skipping split',
              error,
            );
            getDiagnostics().push({
              map: textureName,
              result: 'tainted',
              reason: 'getImageData failed (CORS/taint)',
            });
            recordResult(null);
            return null;
          }

          const createCanvas = () => {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            return canvas;
          };

          const aoCanvas = createCanvas();
          const roughCanvas = createCanvas();
          const metalCanvas = createCanvas();

          const aoCtx = aoCanvas.getContext('2d');
          const roughCtx = roughCanvas.getContext('2d');
          const metalCtx = metalCanvas.getContext('2d');
          if (!aoCtx || !roughCtx || !metalCtx) {
            recordResult(null);
            return null;
          }

          const aoData = aoCtx.createImageData(width, height);
          const roughData = roughCtx.createImageData(width, height);
          const metalData = metalCtx.createImageData(width, height);

          const hint = (packingHint || 'rga').toLowerCase();
          const channelIndex = (token: string): number => {
            if (token === 'r' || token === 'red') return 0;
            if (token === 'g' || token === 'green') return 1;
            if (token === 'b' || token === 'blue') return 2;
            return 0;
          };
          const aoSource = channelIndex(hint[0] ?? 'r');
          const roughSource = channelIndex(hint[1] ?? 'g');
          const metalSource = channelIndex(hint[2] ?? 'b');

          const srcData = imageData.data;
          for (let i = 0; i < srcData.length; i += 4) {
            const channels: [number, number, number] = [srcData[i], srcData[i + 1], srcData[i + 2]];
            const ao = channels[aoSource] ?? 0;
            const rough = channels[roughSource] ?? 0;
            const metal = channels[metalSource] ?? 0;

            aoData.data[i] = aoData.data[i + 1] = aoData.data[i + 2] = ao;
            aoData.data[i + 3] = 255;

            roughData.data[i] = roughData.data[i + 1] = roughData.data[i + 2] = rough;
            roughData.data[i + 3] = 255;

            metalData.data[i] = metalData.data[i + 1] = metalData.data[i + 2] = metal;
            metalData.data[i + 3] = 255;
          }

          aoCtx.putImageData(aoData, 0, 0);
          roughCtx.putImageData(roughData, 0, 0);
          metalCtx.putImageData(metalData, 0, 0);

          const aoTexture = new THREE.CanvasTexture(aoCanvas);
          const roughTexture = new THREE.CanvasTexture(roughCanvas);
          const metalTexture = new THREE.CanvasTexture(metalCanvas);

          aoTexture.needsUpdate = true;
          roughTexture.needsUpdate = true;
          metalTexture.needsUpdate = true;

          const result: ORMSplitResult = {
            aoMap: aoTexture,
            roughnessMap: roughTexture,
            metalnessMap: metalTexture,
          };

          recordResult(result);
          getDiagnostics().push({ map: textureName, result: 'ok' });
          return result;
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'unknown';
          console.warn('splitORMTexture generic failure', error);
          getDiagnostics().push({ map: textureName, result: 'error', reason });
          recordResult(null);
          return null;
        } finally {
          ormTextureProcessing.delete(textureKey);
          if (imageKey) {
            ormTextureProcessing.delete(imageKey);
          }
        }
      };

      // helper to prepare a model clone for fade-in while preserving GLTF materials and applying overrides (including ORM splitting)
      const prepareClone = (
        model: THREE.Object3D,
        /*position: THREE.Vector3, quaternion: THREE.Quaternion,*/
        scale = 1,
        overrides?: {
          envMapIntensity?: number;
          roughnessScale?: number;
          ormPacking?: string;
          fitHeight?: number;
          yOffset?: number;
          randomYaw?: boolean;
        },
      ) => {
        // clone model, apply local scale; caller should position the returned copy using placeObjectOnSurface
        const copy = model.clone(true) as THREE.Object3D;
        copy.position.set(0, 0, 0);
        copy.quaternion.identity();
        copy.scale.setScalar(scale);
        if (typeof overrides?.fitHeight === 'number') {
          try {
            const bbox = new THREE.Box3().setFromObject(copy);
            const size = new THREE.Vector3();
            bbox.getSize(size);
            if (size.y > 1e-4) {
              const desired = overrides.fitHeight;
              const adjust = desired / size.y;
              copy.scale.multiplyScalar(adjust);
            }
          } catch {
            /* ignore fit scaling issues */
          }
        }
        copy.traverse((node) => {
          if (!(node instanceof THREE.Mesh)) {
            return;
          }

          node.castShadow = true;
          node.receiveShadow = true;

          try {
            Materials.fixMaterialTextures(node.material as THREE.Material | THREE.Material[]);
          } catch {
            /* ignore texture fix issues */
          }

          const attemptSplit = (
            packedTexture: THREE.Texture | undefined,
            onSuccess: (result: ORMSplitResult) => void,
            contextLabel: string,
          ) => {
            if (!packedTexture) {
              return;
            }
            const overrideHint = overrides?.ormPacking;
            const textureLabel = getTextureIdentifier(packedTexture);
            const nameHint = packedTexture.name || '';
            const looksPacked =
              /orm|metalroughness|occlusion|mro|packed/i.test(nameHint) || Boolean(overrideHint);
            if (!looksPacked && !overrideHint) {
              return;
            }
            try {
              const split = splitORMTexture(packedTexture, overrideHint ?? 'rga');
              if (split) {
                onSuccess(split);
                console.info('[Island] splitORMTexture succeeded for', contextLabel, textureLabel);
              } else {
                console.info('[Island] splitORMTexture skipped for', contextLabel, textureLabel);
              }
            } catch (error) {
              console.warn(
                '[Island] splitORMTexture threw when processing',
                contextLabel,
                textureLabel,
                error,
              );
            }
          };

          const materials = Array.isArray(node.material) ? node.material : [node.material];

          materials.forEach((material, materialIndex) => {
            if (!material) {
              return;
            }

            const typedMaterial = material as MaterialWithTextureProps;

            if (
              typedMaterial instanceof THREE.MeshStandardMaterial ||
              typedMaterial instanceof THREE.MeshPhysicalMaterial
            ) {
              if (typeof overrides?.envMapIntensity === 'number') {
                typedMaterial.envMapIntensity = overrides.envMapIntensity;
              } else if (typeof typedMaterial.envMapIntensity === 'number') {
                typedMaterial.envMapIntensity = Math.max(typedMaterial.envMapIntensity || 0, 0.6);
              }
              if (
                typeof overrides?.roughnessScale === 'number' &&
                typeof typedMaterial.roughness === 'number'
              ) {
                typedMaterial.roughness = Math.min(
                  1,
                  typedMaterial.roughness * overrides.roughnessScale,
                );
              }

              const packedTexture = extractTexture(typedMaterial);
              attemptSplit(
                packedTexture,
                (split) => {
                  if (!typedMaterial.aoMap) {
                    typedMaterial.aoMap = split.aoMap;
                  }
                  if (!typedMaterial.roughnessMap) {
                    typedMaterial.roughnessMap = split.roughnessMap;
                  }
                  if ('metalnessMap' in typedMaterial) {
                    const metalMaterial = typedMaterial as THREE.MeshStandardMaterial;
                    if (!metalMaterial.metalnessMap) {
                      metalMaterial.metalnessMap = split.metalnessMap;
                    }
                  }
                },
                'material map',
              );

              if ('opacity' in typedMaterial) {
                typedMaterial.transparent = true;
                (typedMaterial as { opacity?: number }).opacity = 0;
              }
              return;
            }

            try {
              const sourceMaterial = typedMaterial;
              const standardMaterial = new THREE.MeshStandardMaterial();

              if ('color' in sourceMaterial && sourceMaterial.color instanceof THREE.Color) {
                standardMaterial.color = sourceMaterial.color.clone();
              }
              if (sourceMaterial.map instanceof THREE.Texture) {
                standardMaterial.map = sourceMaterial.map;
              }
              if (sourceMaterial.normalMap instanceof THREE.Texture) {
                standardMaterial.normalMap = sourceMaterial.normalMap;
              }

              if (typeof sourceMaterial.shininess === 'number') {
                standardMaterial.roughness = Math.min(1, 1 - sourceMaterial.shininess / 300);
              } else if (typeof sourceMaterial.roughness === 'number') {
                standardMaterial.roughness = Math.max(0, Math.min(1, sourceMaterial.roughness));
              } else {
                standardMaterial.roughness = 0.7;
              }

              if (typeof sourceMaterial.metalness === 'number') {
                standardMaterial.metalness = sourceMaterial.metalness;
              }
              if (sourceMaterial.emissive instanceof THREE.Color) {
                standardMaterial.emissive = sourceMaterial.emissive.clone();
              }
              if (sourceMaterial.roughnessMap instanceof THREE.Texture) {
                standardMaterial.roughnessMap = sourceMaterial.roughnessMap;
              }
              if (sourceMaterial.aoMap instanceof THREE.Texture) {
                standardMaterial.aoMap = sourceMaterial.aoMap;
              }

              const packedTexture = extractTexture(sourceMaterial);
              attemptSplit(
                packedTexture,
                (split) => {
                  standardMaterial.aoMap = split.aoMap;
                  standardMaterial.roughnessMap = split.roughnessMap;
                  standardMaterial.metalnessMap = split.metalnessMap;
                },
                'converted material map',
              );

              standardMaterial.envMapIntensity =
                typeof overrides?.envMapIntensity === 'number' ? overrides.envMapIntensity : 0.6;
              standardMaterial.transparent = true;
              standardMaterial.opacity = 0;

              if (Array.isArray(node.material)) {
                const updatedMaterials = node.material.slice();
                updatedMaterials[materialIndex] = standardMaterial;
                node.material = updatedMaterials;
              } else {
                node.material = standardMaterial;
              }
            } catch {
              /* swallow conversion issues */
            }
          });
        });
        return copy as THREE.Object3D;
      };

      type ReplaceOptions = {
        scale?: number;
        fitHeight?: number;
        heightOffset?: number;
        randomYaw?: boolean;
        scaleJitter?: number;
        candidates?: string[];
      };

      // Generic loader & replacer: load url and replace placeholders (by name prefix)
      const loadAndReplace = (primaryUrl: string, prefix: string, options: ReplaceOptions = {}) => {
        try {
          const tryList = [primaryUrl].concat((options.candidates || []).filter(Boolean));
          const tryLoadAt = (idx: number) => {
            if (idx >= tryList.length) return; // nothing left
            const url = tryList[idx];
            loader.load(
              url,
              (gltf: GLTF) => {
                const model = gltf.scene || gltf.scenes?.[0];
                const animations = gltf.animations || [];
                if (!model) return;
                const placeholders = findPlaceholders(prefix);
                const base = url.replace(/^.*[\\/]/, '');
                const overridesFromManifest = modelOverrides[base] || {};
                placeholders.forEach((ph) => {
                  const parent = ph.parent || this.mesh;
                  const baseScale = typeof options.scale === 'number' ? options.scale : 1;
                  const appliedOverrides = { ...overridesFromManifest } as {
                    envMapIntensity?: number;
                    roughnessScale?: number;
                    ormPacking?: string;
                    fitHeight?: number;
                    yOffset?: number;
                    randomYaw?: boolean;
                    scale?: number;
                  };
                  if (
                    typeof options.fitHeight === 'number' &&
                    typeof appliedOverrides.fitHeight !== 'number'
                  )
                    appliedOverrides.fitHeight = options.fitHeight;
                  if (
                    typeof options.randomYaw === 'boolean' &&
                    typeof appliedOverrides.randomYaw !== 'boolean'
                  )
                    appliedOverrides.randomYaw = options.randomYaw;
                  if (
                    typeof options.heightOffset === 'number' &&
                    typeof appliedOverrides.yOffset !== 'number'
                  )
                    appliedOverrides.yOffset = options.heightOffset;
                  const usedScale =
                    typeof appliedOverrides.scale === 'number' ? appliedOverrides.scale : baseScale;
                  const clone = prepareClone(model, usedScale, appliedOverrides);
                  // position clone on the displaced surface where the placeholder was
                  let placement: { position: THREE.Vector3; normal: THREE.Vector3 } | null = null;
                  try {
                    placement = this.placeObjectOnSurface(clone, ph.position.clone(), 0.0, true);
                  } catch {
                    placement = null;
                  }
                  if (placement) {
                    const normal = placement.normal.clone();
                    // Inherit the placeholder's yaw about the normal (layout
                    // facing, e.g. houses toward the road) unless randomYaw.
                    {
                      const proj = (v: THREE.Vector3) =>
                        v.clone().sub(normal.clone().multiplyScalar(v.dot(normal)));
                      const phF = proj(new THREE.Vector3(0, 0, 1).applyQuaternion(ph.quaternion));
                      const clF = proj(new THREE.Vector3(0, 0, 1).applyQuaternion(clone.quaternion));
                      if (phF.lengthSq() > 1e-8 && clF.lengthSq() > 1e-8) {
                        phF.normalize();
                        clF.normalize();
                        const yawAng = Math.atan2(
                          new THREE.Vector3().crossVectors(clF, phF).dot(normal),
                          clF.dot(phF),
                        );
                        clone.quaternion.premultiply(
                          new THREE.Quaternion().setFromAxisAngle(normal, yawAng),
                        );
                      }
                    }
                    if (typeof appliedOverrides.yOffset === 'number') {
                      clone.position.add(normal.clone().multiplyScalar(appliedOverrides.yOffset));
                    }
                    if (
                      typeof options.heightOffset === 'number' &&
                      typeof appliedOverrides.yOffset !== 'number'
                    ) {
                      clone.position.add(normal.clone().multiplyScalar(options.heightOffset));
                    }
                    const allowRandomYaw =
                      (typeof appliedOverrides.randomYaw === 'boolean'
                        ? appliedOverrides.randomYaw
                        : false) || options.randomYaw === true;
                    if (allowRandomYaw) {
                      const yaw = Math.random() * Math.PI * 2;
                      const spin = new THREE.Quaternion().setFromAxisAngle(normal, yaw);
                      // premultiply: world-space spin about the normal
                      clone.quaternion.premultiply(spin);
                    }
                  }
                  if (typeof options.scaleJitter === 'number' && options.scaleJitter > 0) {
                    const jitter = 1 + (Math.random() * 2 - 1) * options.scaleJitter;
                    clone.scale.multiplyScalar(jitter);
                  }
                  parent.add(clone);

                  // If the GLTF contains animations, create mixer for this clone and play a sensible default (Idle/first)
                  try {
                    if (animations && animations.length) {
                      const mixer = new THREE.AnimationMixer(clone);
                      // try to find Idle/Walk/Run by name, prefer Idle
                      let clip = animations.find((candidate) => /idle/i.test(candidate.name));
                      if (!clip)
                        clip = animations.find((candidate) => /walk/i.test(candidate.name));
                      if (!clip) clip = animations[0];
                      if (clip) {
                        const action = mixer.clipAction(clip);
                        action.reset();
                        action.play();
                      }
                      this.animationMixers.push(mixer);
                    }
                  } catch {
                    /* ignore animation setup errors */
                  }

                  // fade in/out
                  const duration = 600;
                  const start = performance.now();
                  const step = () => {
                    const now = performance.now();
                    const t = Math.min(1, (now - start) / duration);
                    clone.traverse((object) => {
                      if (object instanceof THREE.Mesh) {
                        const materials = Array.isArray(object.material)
                          ? object.material
                          : [object.material];
                        materials.forEach((material) => {
                          if (!material) return;
                          material.opacity = t;
                          if (t < 1) {
                            material.transparent = true;
                          }
                          material.needsUpdate = true;
                        });
                      }
                    });
                    if (ph instanceof THREE.Mesh) {
                      const placeholderMaterials = Array.isArray(ph.material)
                        ? ph.material
                        : [ph.material];
                      placeholderMaterials.forEach((material) => {
                        material.opacity = 1 - t;
                        material.needsUpdate = true;
                      });
                    }
                    if (t < 1) requestAnimationFrame(step);
                    else {
                      try {
                        ph.visible = false;
                      } catch {
                        /* ignore */
                      }
                    }
                  };
                  requestAnimationFrame(step);
                });
              },
              undefined,
              () => {
                // on error, try next candidate
                const next = idx + 1;
                if (next < tryList.length) tryLoadAt(next);
              },
            );
          };
          tryLoadAt(0);
        } catch {
          /* loader not available */
        }
      };

      // Replace benches, mailboxes, signs, cars, lamps
      // Provide fallback candidate paths under assetKits folders so models shipped inside assetKits are discoverable
      const ak = '/assetKits';
      loadAndReplace(basePath + 'bench.glb', 'bench_', {
        scale: 1,
        candidates: [
          ak + '/Fantasy Props MegaKit[Standard]/Exports/glTF/Bench.gltf',
          ak + '/Fantasy Props MegaKit[Standard]/Exports/glTF/Chair_1.gltf',
        ],
        randomYaw: true,
        heightOffset: -0.03,
        scaleJitter: 0.2,
      });
      loadAndReplace(basePath + 'mailbox.glb', 'mailbox_', {
        scale: 1,
        randomYaw: true,
        heightOffset: -0.02,
      });
      loadAndReplace(basePath + 'car.glb', 'car_', {
        scale: 1,
        randomYaw: true,
        scaleJitter: 0.1,
      });
      loadAndReplace(basePath + 'lamp.glb', 'lamp', {
        scale: 1,
        candidates: [ak + '/Fantasy Props MegaKit[Standard]/Exports/glTF/Lantern_Wall.gltf'],
        heightOffset: -0.04,
        randomYaw: true,
      });
      // Buildings/houses use the intended toon house model (previously these
      // were "replaced" with market-stall kit models, which looked broken)
      loadAndReplace(basePath + 'house.glb', 'building_placeholder_', {
        fitHeight: 3.8,
        heightOffset: -0.18,
        randomYaw: false,
        scaleJitter: 0.25,
        candidates: [ak + '/Fantasy Props MegaKit[Standard]/Exports/glTF/Stall_Empty.gltf'],
      });
      loadAndReplace(basePath + 'house.glb', 'house_', {
        fitHeight: 3.4,
        heightOffset: -0.15,
        randomYaw: false,
        scaleJitter: 0.3,
        candidates: [ak + '/Fantasy Props MegaKit[Standard]/Exports/glTF/Stall_Empty.gltf'],
      });

      // For NPCs we want an NPC wrapper that handles mixer and simple AI. Use a specialized loader callback.
      try {
        const npcCandidates = [
          basePath + 'npc.glb',
          '/assetKits/Universal Base Characters[Standard]/glTF/npc.gltf',
          '/assetKits/Fantasy Props MegaKit[Standard]/Exports/glTF/npc.gltf',
        ];
        const tryNpc = (idx = 0) => {
          if (idx >= npcCandidates.length) return;
          loader.load(
            npcCandidates[idx],
            (gltf: GLTF) => {
              const model = gltf.scene || gltf.scenes?.[0];
              const animations = gltf.animations || [];
              if (!model) {
                // try next candidate
                tryNpc(idx + 1);
                return;
              }
              const placeholders = findPlaceholders('npc_placeholder_');
              placeholders.forEach((ph) => {
                try {
                  const pos = ph.position.clone();
                  const quat = ph.quaternion.clone();
                  const baseScale = 0.6;
                  // allow manifest override scale
                  const overrides = modelOverrides['npc.glb'] ?? modelOverrides['npc.gltf'];
                  const scale = typeof overrides?.scale === 'number' ? overrides.scale : baseScale;
                  // create an NPC instance which clones the provided model internally
                  const npc = new NPC(
                    model,
                    animations,
                    pos,
                    quat,
                    scale,
                    this.center,
                    this.radius,
                    (d: THREE.Vector3) => this.sampleSurfaceByDirection(d, 0).position.length(),
                  );
                  this.npcInstances.push(npc);
                  // add NPC group to the same parent as placeholder
                  const parent = ph.parent || this.mesh;
                  parent.add(npc.group);
                  // fade placeholder out and leave NPC visible
                  try {
                    ph.visible = false;
                  } catch {
                    /* ignore */
                  }
                  // 30% of NPCs patrol between two nearby points
                  try {
                    if (Math.random() < 0.35) {
                      const dir = ph.position.clone().sub(this.center).normalize();
                      const right = new THREE.Vector3()
                        .crossVectors(new THREE.Vector3(0, 1, 0), dir)
                        .normalize();
                      const p1 = ph.position.clone().add(right.clone().multiplyScalar(0.8));
                      const p2 = ph.position.clone().add(right.clone().multiplyScalar(-0.8));
                      // ensure projected to surface
                      try {
                        // sample patrol points to account for displacement
                        const s1 = this.sampleSurfacePosition(p1, 0.58);
                        const s2 = this.sampleSurfacePosition(p2, 0.58);
                        npc.startPatrol([s1.position, s2.position]);
                      } catch {
                        /* ignore patrol placement issues */
                      }
                    }
                  } catch {
                    /* ignore patrol setup issues */
                  }
                  // attach simple dialogue/bubble text
                  try {
                    npc.group.name = 'villager';
                    npc.group.userData = npc.group.userData || {};
                    npc.group.userData.bubbleText = 'Hello there!';
                    npc.group.userData.dialogue = 'Nice to meet you.';
                  } catch {
                    /* ignore userData attachment issues */
                  }
                } catch {
                  /* ignore placeholder replacement issues */
                }
              });
            },
            undefined,
            () => {
              tryNpc(idx + 1);
            },
          );
        };
        tryNpc(0);
      } catch {
        /* NPC assets missing */
      }

      // Trees: replace instanced trunks/foliage with model clones if tree model exists
      try {
        const treeCandidates = [
          basePath + 'tree.glb',
          '/assetKits/Stylized Nature MegaKit[Standard]/glTF/CommonTree_1.gltf',
          '/assetKits/Stylized Nature MegaKit[Standard]/glTF/CommonTree_2.gltf',
          '/assetKits/Stylized Nature MegaKit[Standard]/glTF/CommonTree_3.gltf',
        ];
        const tryTree = (idx = 0) => {
          if (idx >= treeCandidates.length) return;
          loader.load(
            treeCandidates[idx],
            (gltf: GLTF) => {
              const model = gltf.scene || gltf.scenes?.[0];
              if (!model) {
                tryTree(idx + 1);
                return;
              }
              const overrides = modelOverrides['tree.glb'] ?? modelOverrides['tree.gltf'];
              // remove instanced meshes (if present)
              const toRemove: THREE.Object3D[] = [];
              this.mesh.traverse((object) => {
                if (
                  object.name &&
                  /trees_trunk_instanced|trees_foliage_instanced/.test(object.name)
                ) {
                  toRemove.push(object);
                }
              });
              toRemove.forEach((object) => {
                if (object.parent) object.parent.remove(object);
              });
              // Trees: even golden-spiral spread through the shared spacing
              // registry, grounded with sunk roots. The old code put 48 trees
              // on a flat equatorial ring (y=0, unregistered -> giant merged
              // groves) floating 0.55-1.25u above the terrain.
              // ORCHARD [z1..z2] north grove, FOREST [z4..z0] both sides,
              // SOUTH WOOD off-belt, plus singles
              const TREE_SITES: Array<[number, number]> = [
                // orchard rows (north of road)
                [1.45, 0.3], [1.62, 0.3], [1.79, 0.3], [1.96, 0.3],
                [1.53, 0.44], [1.7, 0.44], [1.87, 0.44],
                // forest segment (both sides of road)
                [5.25, 0.18], [5.45, 0.3], [5.65, 0.16], [5.85, 0.28],
                [5.35, -0.18], [5.55, -0.3], [5.75, -0.16], [5.95, -0.26],
                [6.1, 0.1],
                // south wood
                [2.0, -0.48], [2.2, -0.58], [2.4, -0.46], [2.15, -0.35],
                // scattered singles
                [0.5, 0.55], [1.3, -0.4], [3.3, 0.42], [4.3, -0.45], [4.75, 0.35], [0.05, -0.5],
              ];
              const treeCount = TREE_SITES.length;
              for (let i = 0; i < treeCount; i++) {
                const [tLon, tLat] = TREE_SITES[i];
                const dir = this.claimDir(this.dirAt(tLon, tLat), 0.07);
                const p = dir.clone().multiplyScalar(this.radius);
                const usedScale = 0.6 + Math.random() * 0.22; // 3.4-4.6u tall — planet-scale trees
                const copy = prepareClone(model, usedScale, overrides);
                try {
                  this.placeObjectOnSurface(copy, p.clone(), -0.07, true);
                } catch {
                  /* ignore placement */
                }
                this.mesh.add(copy);
                // If tree model contains animations (rare), add mixer
                try {
                  const animations = gltf.animations || [];
                  if (animations && animations.length) {
                    const mixer = new THREE.AnimationMixer(copy);
                    const clip = animations[0];
                    const action = mixer.clipAction(clip);
                    action.reset();
                    action.play();
                    this.animationMixers.push(mixer);
                  }
                } catch {}
                // quick fade-in
                const duration = 800;
                const start = performance.now();
                const step = () => {
                  const now = performance.now();
                  const t = Math.min(1, (now - start) / duration);
                  copy.traverse((object) => {
                    if (object instanceof THREE.Mesh) {
                      const materials = Array.isArray(object.material)
                        ? object.material
                        : [object.material];
                      materials.forEach((material) => {
                        if (!material) return;
                        material.opacity = t;
                        if (t < 1) {
                          material.transparent = true;
                        }
                        material.needsUpdate = true;
                      });
                    }
                  });
                  if (t < 1) requestAnimationFrame(step);
                };
                requestAnimationFrame(step);
              }
            },
            undefined,
            () => {
              tryTree(idx + 1);
            },
          );
        };
        tryTree(0);
      } catch {
        /* tree assets missing */
      }
    } catch {
      // GLTFLoader not available or model loading failed; leave placeholders
      return;
    }
  }

  public getCenter(): THREE.Vector3 {
    return this.center.clone();
  }

  public getSurfaceNormal(position: THREE.Vector3): THREE.Vector3 {
    return position.clone().sub(this.center).normalize();
  }

  public getSurfacePosition(direction: THREE.Vector3): THREE.Vector3 {
    return this.center.clone().add(direction.clone().normalize().multiplyScalar(this.radius));
  }

  public getRadius(): number {
    return this.radius;
  }

  /**
   * The displaced terrain mesh (for external raycasts, e.g. camera collision).
   */
  public getSurfaceMesh(): THREE.Mesh | undefined {
    return this.surfaceMesh;
  }

  /**
   * Public wrapper to sample the displaced surface given a direction vector (world-space).
   * Returns an object with { position, normal } so callers can place markers accurately.
   */
  public sampleSurfaceByDirection(
    direction: THREE.Vector3,
    desiredOffset: number = 0,
  ): { position: THREE.Vector3; normal: THREE.Vector3 } {
    // Cast from center outward along the given direction to find actual terrain surface
    const dir = direction.clone().normalize();
    const startPos = this.center.clone();
    const raycaster = new THREE.Raycaster(startPos, dir, 0, this.radius * 3);

    // If we have the mesh, use it - otherwise approximate
    if (this.surfaceMesh) {
      try {
        this.surfaceMesh.updateMatrixWorld(true);
        const hits = raycaster.intersectObject(this.surfaceMesh, false);

        if (hits && hits.length > 0) {
          const hit = hits[0];
          const hitPoint = hit.point.clone();

          // Use face normal from THREE.js Raycaster - this is already in world space
          let normal = hit.face ? hit.face.normal.clone() : dir.clone();

          // If we got a face, transform its normal to world space
          if (hit.face && hit.object && hit.object.matrixWorld) {
            const m = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
            normal = hit.face.normal.clone().applyMatrix3(m).normalize();
          }

          // Ensure normal points outward from center
          const toHit = hitPoint.clone().sub(this.center);
          if (normal.dot(toHit) < 0) {
            normal.negate();
          }
          normal.normalize();

          // Clamp tilt away from radial "up" (see sampleSurfacePosition)
          {
            const radial = toHit.clone().normalize();
            const MAX_TILT = 0.21; // ~12 degrees
            const tilt = radial.angleTo(normal);
            if (tilt > MAX_TILT) {
              const axis = new THREE.Vector3().crossVectors(radial, normal);
              normal =
                axis.lengthSq() > 1e-10
                  ? radial.clone().applyAxisAngle(axis.normalize(), MAX_TILT).normalize()
                  : radial;
            }
          }

          // Apply offset along normal
          const finalPos = hitPoint.clone().add(normal.clone().multiplyScalar(desiredOffset));
          return { position: finalPos, normal };
        }
      } catch {
        // Silently fail and use fallback
      }
    }

    // Fallback: simple sphere approximation with offset
    const spherePoint = this.center.clone().add(dir.clone().multiplyScalar(this.radius));
    return {
      position: spherePoint.clone().add(dir.clone().multiplyScalar(desiredOffset)),
      normal: dir,
    };
  }

  /**
   * Place an object on the island surface near an approximate position.
   * This will sample the displaced terrain, set object.position and optionally
   * align object.up to the surface normal (by setting quaternion). Returns the sampled info.
   */
  private placeObjectOnSurface(
    obj: THREE.Object3D,
    approxPos: THREE.Vector3,
    desiredOffset: number = 0,
    alignToNormal: boolean = true,
  ): { position: THREE.Vector3; normal: THREE.Vector3 } {
    try {
      const sampled = this.sampleSurfacePosition(approxPos, desiredOffset);
      obj.position.copy(sampled.position);
      if (alignToNormal) {
        const q = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          sampled.normal,
        );
        obj.quaternion.copy(q);
      }
      return sampled;
    } catch {
      // fallback radial math
      const normal = approxPos.clone().normalize();
      const pos = this.center.clone().add(normal.multiplyScalar(this.radius + desiredOffset));
      obj.position.copy(pos);
      if (alignToNormal)
        obj.quaternion.copy(
          new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal),
        );
      return { position: pos, normal };
    }
  }

  // Expose NPC instances so other systems (Engine, InteractionSystem) can register or query them
  public getNPCInstances(): NPC[] {
    return this.npcInstances.slice();
  }

  public addToScene(scene: THREE.Scene): void {
    scene.add(this.mesh);
  }

  // Update animations for whimsical feel
  public update(deltaTime: number): void {
    const time = performance.now() * 0.001; // seconds

    // Sway trees gently
    this.mesh.traverse((object) => {
      if (
        object instanceof THREE.InstancedMesh &&
        typeof object.name === 'string' &&
        object.name.startsWith('trees_foliage_instanced')
      ) {
        const matrix = new THREE.Matrix4();
        for (let i = 0; i < object.count; i++) {
          object.getMatrixAt(i, matrix);
          const position = new THREE.Vector3().setFromMatrixPosition(matrix);
          const sway = Math.sin(time * 2 + i * 0.5) * 0.02;
          position.x += sway;
          matrix.setPosition(position);
          object.setMatrixAt(i, matrix);
        }
        object.instanceMatrix.needsUpdate = true;
      }
    });

    // Blink lamp lights at night (simulate time-based)
    const timeOfDay = time % 24;
    const isNight = timeOfDay > 18 || timeOfDay < 6;
    this.mesh.traverse((object) => {
      const data = object.userData as { isLampLight?: boolean };
      if (data?.isLampLight) {
        object.visible = isNight && Math.sin(time * 3) > -0.5;
      }
    });

    // Idle NPC animations (subtle bobbing)
    this.mesh.traverse((object) => {
      if (typeof object.name === 'string' && object.name.startsWith('npc_placeholder_')) {
        const parts = object.name.split('_');
        const idx = Number.parseInt(parts[2] ?? '0', 10);
        const placeholderOccupied = this.npcInstances.some(
          (npcInstance) => npcInstance.group.position.distanceTo(object.position) < 0.01,
        );
        if (!placeholderOccupied) {
          object.position.y += Math.sin(time * 2 + idx) * 0.005;
        }
      }
    });

    // Animate ambient particles (floating sparkles)
    this.mesh.traverse((object) => {
      const data = object.userData as { baseY?: number; phase?: number };
      if (typeof data?.baseY === 'number' && typeof data.phase === 'number') {
        object.position.y = data.baseY + Math.sin(time * 1.5 + data.phase) * 0.1;
        object.rotation.y += deltaTime * 0.5;
      }
    });

    // Animate dust particles
    this.mesh.traverse((object) => {
      const data = object.userData as { baseY?: number; phase?: number };
      if (
        object.name === 'dust' &&
        typeof data?.baseY === 'number' &&
        typeof data.phase === 'number'
      ) {
        object.position.y = data.baseY + Math.sin(time * 0.5 + data.phase) * 0.5;
        object.position.x += Math.sin(time * 0.3 + data.phase) * 0.01;
        object.position.z += Math.cos(time * 0.3 + data.phase) * 0.01;
      }
    });

    // Advance any animation mixers created for loaded GLTF clones (NPCs, props, trees)
    this.animationMixers.forEach((mixer) => {
      try {
        mixer.update(deltaTime);
      } catch {
        /* ignore animation update issues */
      }
    });

    // Update NPC instances (state machines)
    this.npcInstances.forEach((npcInstance) => {
      try {
        npcInstance.update(deltaTime);
      } catch {
        /* ignore NPC update issues */
      }
    });
  }

  /**
   * Cleanup method to dispose all Three.js resources (geometries, materials, textures).
   * Call this when tearing down the island or on hot reload to prevent memory leaks.
   */
  public dispose(): void {
    // Dispose all geometries, materials, and textures in the mesh hierarchy
    this.mesh.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        if (obj.geometry) {
          obj.geometry.dispose();
        }

        const material = obj.material;
        if (Array.isArray(material)) {
          material.forEach((mat) => this.disposeMaterial(mat));
        } else if (material) {
          this.disposeMaterial(material);
        }
      }
    });

    // Stop all animation mixers
    this.animationMixers.forEach((mixer) => {
      try {
        mixer.stopAllAction();
      } catch {
        /* ignore mixer cleanup issues */
      }
    });
    this.animationMixers = [];

    // Dispose NPC instances
    this.npcInstances.forEach((npc) => {
      try {
        const maybeDisposable = npc as { dispose?: () => void };
        maybeDisposable.dispose?.();
      } catch {
        /* ignore NPC cleanup issues */
      }
    });
    this.npcInstances = [];

    // Remove mesh from parent if attached
    if (this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }

    // Clear surface mesh reference
    this.surfaceMesh = undefined;
  }

  /**
   * Helper method to dispose a material and its textures
   */
  private disposeMaterial(material: THREE.Material): void {
    // Dispose all textures in the material
    const materialWithMaps = material as MaterialWithTextureProps;
    materialWithMaps.map?.dispose();
    materialWithMaps.normalMap?.dispose();
    materialWithMaps.roughnessMap?.dispose();
    materialWithMaps.metalnessMap?.dispose();
    materialWithMaps.aoMap?.dispose();
    materialWithMaps.emissiveMap?.dispose();
    materialWithMaps.bumpMap?.dispose();
    materialWithMaps.displacementMap?.dispose();
    materialWithMaps.alphaMap?.dispose();
    materialWithMaps.envMap?.dispose();

    // Dispose the material itself
    material.dispose();
  }
}
