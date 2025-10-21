import * as THREE from 'three';
import { Materials } from './Materials';
import { NPC } from './NPC';
import TextureGenerator from './TextureGenerator';

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
    try { if ((window as any).__ISLAND_DEBUG) (this.mesh as any).userData._debug = true; } catch (e) {}
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

      // Small-scale rolling hills
      const smallDetail = noise3D(v.x, v.y, v.z, 0.35) * 0.7;

      // Micro detail for surface roughness
      const microNoise = (Math.random() - 0.5) * 0.25;

      // Height-based biomes: create flatter areas at lower elevations (beaches/plateaus)
      const baseHeight = largeTerrain + mediumTerrain;
      const heightFactor = Math.max(0, Math.min(1, (baseHeight + 2) / 4));
      const plateauFactor = 1.0 - Math.pow(Math.abs(heightFactor - 0.3) * 3, 2) * 0.3;

      // Combine layers for natural variation with plateau effect
      const displacement = (largeTerrain + mediumTerrain * plateauFactor + smallDetail) * 0.95 + microNoise;

      // Clamp radius to prevent terrain from going inside the sphere
      const rawRadius = this.radius + displacement;
      const minRadius = this.radius * 0.96; // slightly increased minimum for smoother terrain
      const maxRadius = this.radius + 4.2; // slightly higher peaks
      const finalRadius = THREE.MathUtils.clamp(rawRadius, minRadius, maxRadius);
      const newPos = normal.multiplyScalar(finalRadius);
      vertices[i] = newPos.x; vertices[i + 1] = newPos.y; vertices[i + 2] = newPos.z;
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere(); // Ensure proper bounding sphere for raycasting
    // Use authored grass textures from the Stylized Nature kit to ground the island in the intended art direction
    const textureLoader = new THREE.TextureLoader();
    const grassMap = textureLoader.load('/assetKits/Stylized Nature MegaKit[Standard]/Textures/Grass.png');
    try {
      if ('colorSpace' in grassMap) {
        (grassMap as any).colorSpace = THREE.SRGBColorSpace;
      } else {
        (grassMap as any).encoding = 3001; // sRGBEncoding fallback
      }
    } catch (e) { /* ignore */ }
    grassMap.wrapS = grassMap.wrapT = THREE.RepeatWrapping;
    grassMap.repeat.set(6, 6);
    // Changed color from 0xffffff (pure white) to natural green tint
    const material = Materials.createPBRMaterial({ map: grassMap, color: 0x6b8f6b, roughness: 0.78, metalness: 0.02, envMapIntensity: 0.65 });

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
  const buildingMat = Materials.createPBRMaterial({ color: 0xd9c6b3, map: buildingTex.albedo, normalMap: buildingTex.normal, roughnessMap: buildingTex.roughness, aoMap: buildingTex.ao, roughness: 0.65, metalness: 0.02 });
    const buildingPlaceholders: THREE.Mesh[] = [];
    const buildingSamples: { position: THREE.Vector3; normal: THREE.Vector3 }[] = [];
    for (let i = 0; i < 12; i++) {
      // FIX: Use TRUE spherical distribution across entire surface
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1); // Uniform sphere distribution

      // Create unit direction vector
      const dir = new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta)
      ).normalize();

      // Sample actual terrain surface along this direction
      const sampled = this.sampleSurfaceByDirection(dir, 0.0);
      buildingSamples.push({ position: sampled.position.clone(), normal: sampled.normal.clone() });

      const bGeom = new THREE.BoxGeometry(1.4, 2.4, 1.4);
      const b = new THREE.Mesh(bGeom, buildingMat);

      // FIX: Building geometry is centered, so we need to offset it upward by half its height
      // Position building with base ON surface, not center IN surface
      const buildingHeight = 2.4;
      const offsetPos = sampled.position.clone().add(sampled.normal.clone().multiplyScalar(buildingHeight * 0.5));
      b.position.copy(offsetPos);

      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal);
      b.quaternion.copy(q);
      // spin around the surface normal so later GLTF replacements feel organic
      const spin = new THREE.Quaternion().setFromAxisAngle(sampled.normal, Math.random() * Math.PI * 2);
      b.quaternion.multiply(spin);
      b.castShadow = true;
      b.receiveShadow = true;
      b.name = `building_placeholder_${i}`;
      buildings.add(b);
      buildingPlaceholders.push(b);
    }

    // Procedural houses: add a few more detailed block houses with roofs/windows to make the island feel inhabited
    const houses = new THREE.Group();
    const houseSamples: { position: THREE.Vector3; normal: THREE.Vector3 }[] = [];
    const houseCount = 16;
    for (let i = 0; i < houseCount; i++) {
      // FIX: Use TRUE spherical distribution, not restricted radial bands
      // Distribute homes across entire sphere surface using spherical coordinates
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1); // Uniform sphere distribution

      // Create unit direction vector
      const dir = new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta)
      ).normalize();

      // Sample actual terrain surface along this direction
      const sampled = this.sampleSurfaceByDirection(dir, 0.0);
      houseSamples.push({ position: sampled.position.clone(), normal: sampled.normal.clone() });

      // main body
      const w = 0.9 + Math.random() * 0.8;
      const h = 0.9 + Math.random() * 1.4;
      const d = 0.8 + Math.random() * 0.6;
      const bodyGeom = new THREE.BoxGeometry(w, h, d);
      const bodyMat = Materials.createHouseMaterial(0xa8c3a8 + Math.floor(Math.random() * 0x003333));
      const body = new THREE.Mesh(bodyGeom, bodyMat);
      body.castShadow = true; body.receiveShadow = true;

      // roof
      const roofGeom = new THREE.ConeGeometry(Math.max(w, d) * 0.9, 0.5, 4);
      const roofMat = Materials.createTrimMaterial(0x8b5a2b);
      const roof = new THREE.Mesh(roofGeom, roofMat);
      roof.castShadow = true; roof.receiveShadow = true;
      roof.rotation.y = Math.PI / 4;

      const house = new THREE.Group();
      // FIX: Body geometry is centered at origin, so position.y = h/2 makes BOTTOM at y=0 (on ground)
      body.position.set(0, h * 0.5, 0);
      roof.position.set(0, h + 0.12, 0);
      house.add(body); house.add(roof);

      // tiny windows as emissive planes
      const winMat = new THREE.MeshStandardMaterial({ color: 0xffffcc, emissive: 0xffe6b3, emissiveIntensity: 0.6 });
      const winGeom = new THREE.PlaneGeometry(0.16, 0.18);
      const win = new THREE.Mesh(winGeom, winMat);
      win.position.set(w * 0.22, h * 0.45, d * 0.51);
      house.add(win.clone());
      const win2 = win.clone(); win2.position.set(-w * 0.22, h * 0.45, d * 0.51); house.add(win2);

      // align to surface
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal);
    house.quaternion.copy(q);
    const spin = new THREE.Quaternion().setFromAxisAngle(sampled.normal, Math.random() * Math.PI * 2);
    house.quaternion.multiply(spin);
    house.position.copy(sampled.position);
      // Houses are already positioned by sampleSurfacePosition - no additional offset needed
      house.name = `house_${i}`;
      houses.add(house);
      // Add a small warm point light near the house to simulate local ambient warmth / light-probe
      try {
        const warmColor = 0xffd6a5;
        const light = new THREE.PointLight(warmColor, 0.55, 2.0, 2);
        // place the light slightly above the door/windows so it softly lights nearby surfaces
        light.position.set(0, h * 0.6, d * 0.35);
        // don't cast shadows by default (expensive); user can toggle in renderer settings if desired
        light.castShadow = false;
        // tag so the renderer or debug UI can find and tweak these
        (light as any).userData = (light as any).userData || {};
        (light as any).userData.isHouseWarmLight = true;
        // attach to house so it follows rotation/position on the sphere
        house.add(light);
      } catch (e) {
        // ignore if lights can't be created in constrained environments
      }
    }

    // Trees: use InstancedMesh for performance with varied transforms; distribute naturally across sphere
    const trees = new THREE.Group();
    const treeCount = 48;
    // trunk as thin cylinder instances
    const trunkGeom = new THREE.CylinderGeometry(0.04, 0.05, 0.36, 6);
    const trunkMat = Materials.createStandardMaterial({ color: 0x6b4a2a, roughness: 0.8 });
    const trunkInst = new (THREE as any).InstancedMesh(trunkGeom, trunkMat, treeCount);
    // foliage as cone instances
    const foliageGeom = new THREE.ConeGeometry(0.26, 0.6, 6);
    const foliageMat = Materials.createTreeMaterial();
    const foliageInst = new (THREE as any).InstancedMesh(foliageGeom, foliageMat, treeCount);
    const dummy = new THREE.Object3D();

    // Use spherical coordinates to distribute trees naturally across the island like real geography
    // Fibonacci sphere for even distribution across ENTIRE surface, not just a ring
    const phi = Math.PI * (3 - Math.sqrt(5)); // Golden angle
    for (let i = 0; i < treeCount; i++) {
      // Fibonacci sphere algorithm for natural distribution
      const y = 1 - (i / (treeCount - 1)) * 2; // y from 1 to -1
      const radiusAtY = Math.sqrt(1 - y * y);
      const theta = phi * i;

      // Convert to 3D position on unit sphere
      const x = Math.cos(theta) * radiusAtY;
      const z = Math.sin(theta) * radiusAtY;

      // Create direction vector (on unit sphere)
      const dir = new THREE.Vector3(x, y, z).normalize();

      // FIX: Don't multiply by radius - let sampleSurfacePosition find the terrain
      // Pass direction vector directly so it samples the ACTUAL displaced terrain surface
      const sampled = this.sampleSurfaceByDirection(dir, 0.0);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal);

      // Position trunk ON surface (sampleSurfacePosition already includes epsilon offset)
      dummy.position.copy(sampled.position);
      dummy.quaternion.copy(q);
      dummy.scale.setScalar(1 + Math.random() * 0.2);
      dummy.updateMatrix();
      trunkInst.setMatrixAt(i, dummy.matrix);
      // Position foliage slightly above trunk along surface normal
      dummy.position.copy(sampled.position.clone().add(sampled.normal.clone().multiplyScalar(0.5 + Math.random() * 0.1)));
      dummy.scale.setScalar(1 + Math.random() * 0.4);
      dummy.updateMatrix();
      foliageInst.setMatrixAt(i, dummy.matrix);
    }
    trunkInst.instanceMatrix.needsUpdate = true;
    foliageInst.instanceMatrix.needsUpdate = true;
    (trunkInst as any).name = 'trees_trunk_instanced';
    (foliageInst as any).name = 'trees_foliage_instanced';
    // mark as foliage so occlusion ignores
    (trunkInst as any).userData = { ignoreOcclusion: true };
    (foliageInst as any).userData = { ignoreOcclusion: true };
    trees.add(trunkInst); trees.add(foliageInst);

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
      const tangentSeed = new THREE.Vector3().crossVectors(sampled.normal, new THREE.Vector3(0, 1, 0));
      if (tangentSeed.lengthSq() < 1e-6) tangentSeed.set(1, 0, 0);
      tangentSeed.normalize();
      const spinAngle = Math.random() * Math.PI * 2;
      const tangent = tangentSeed.applyAxisAngle(sampled.normal, spinAngle).normalize();
      const approx = sampled.position.clone().add(tangent.multiplyScalar(0.8 + Math.random() * 0.4));
      const placement = this.sampleSurfacePosition(approx, 0.25);

      const mb = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.24, 0.12), Materials.createMailboxMaterial());
      mb.position.copy(placement.position);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), placement.normal);
      mb.quaternion.copy(q);
      mb.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(placement.normal, Math.random() * Math.PI * 2));
      mb.name = `mailbox_${i}`;
      mb.castShadow = true;
      mb.receiveShadow = true;
      mailboxes.add(mb);
    }

    // (Removed stripes/road centerline boxes to eliminate boundaries)

    // Add stairs near some houses for access to "higher" ground
    const stairs = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const theta = ((i + 0.25) / 4) * Math.PI * 2;
      const r = (pathGroup.userData?.pathRadius || (this.radius * 0.9)) - 1.2;
    const pos = new THREE.Vector3(Math.cos(theta) * r, 0, Math.sin(theta) * r);
    const stair = this.createStairs();
      try { this.placeObjectOnSurface(stair, pos, 0.8, true); } catch (e) {}
      stair.castShadow = true; stair.receiveShadow = true;
      stair.name = `stairs_${i}`;
      stairs.add(stair);
    }

    // Add street lamps for evening ambiance
    const lamps = new THREE.Group();
    const lampPositions: THREE.Vector3[] = [];
    for (let i = 0; i < 6; i++) {
      const theta = (i / 6) * Math.PI * 2;
      const baseRoadRadius = pathGroup.userData?.pathRadius || roadRadius;
      const r = baseRoadRadius + 0.45 + Math.sin(theta * 2) * 0.12;
      const pos = new THREE.Vector3(Math.cos(theta) * r, 0, Math.sin(theta) * r);
  const sampled = this.sampleSurfacePosition(pos, 0.6);
  const lampPost = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.5, 8), Materials.createTrimMaterial(0x333333));
  const lampHead = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 8), Materials.createTrimMaterial(0x444444));
  lampPost.position.copy(sampled.position.clone().add(new THREE.Vector3(0, 0.75, 0)));
  lampHead.position.copy(sampled.position.clone().add(new THREE.Vector3(0, 1.35, 0)));
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal);
  lampPost.quaternion.copy(q);
  lampHead.quaternion.copy(q);
      lampPost.castShadow = true; lampPost.receiveShadow = true;
      lampHead.castShadow = true; lampHead.receiveShadow = true;
      // Add a small point light at the lamp head for night
      const lampLight = new THREE.PointLight(0xffeeaa, 0.8, 3, 2);
      lampLight.position.copy(lampHead.position);
      lampLight.userData = { isLampLight: true };
      lamps.add(lampPost); lamps.add(lampHead); lamps.add(lampLight);
      lampPositions.push(lampHead.position.clone());
    }
    // Add electric wires between lamps
    const wireMat = new THREE.LineBasicMaterial({ color: 0x333333 });
    for (let i = 0; i < lampPositions.length; i++) {
      const start = lampPositions[i];
      const end = lampPositions[(i + 1) % lampPositions.length];
      const wireGeom = new THREE.BufferGeometry().setFromPoints([start, end]);
      const wire = new THREE.Line(wireGeom, wireMat);
      lamps.add(wire);
    }

    // Tiny NPC placeholders (spheres) near buildings to imply life
    const npcs = new THREE.Group();
    const npcMat = Materials.createCharacterBodyMaterial();
    const npcPlaceholders: THREE.Mesh[] = [];
    for (let i = 0; i < 20; i++) {
      // FIX: Use TRUE spherical distribution
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);

      const dir = new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta)
      ).normalize();

      const nGeom = new THREE.SphereGeometry(0.22, 10, 10);
      const n = new THREE.Mesh(nGeom, npcMat);
      const sampled = this.sampleSurfaceByDirection(dir, 0.58 + Math.random() * 0.1);
      n.position.copy(sampled.position);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal);
      n.quaternion.copy(q);
      n.castShadow = true;
      n.receiveShadow = true;
      n.name = `npc_placeholder_${i}`;
      npcs.add(n);
      npcPlaceholders.push(n);
    }

    // Add subtle ambient particles (sparkles) for whimsy
    const particles = new THREE.Group();
    const sparkleMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 });
    for (let i = 0; i < 20; i++) {
      const sparkle = new THREE.Mesh(new THREE.SphereGeometry(0.02, 4, 4), sparkleMat);
      const angle = Math.random() * Math.PI * 2;
      const dist = this.radius * 0.8 + Math.random() * this.radius * 0.2;
      const pos = new THREE.Vector3(Math.cos(angle) * dist, Math.random() * 2 + 1, Math.sin(angle) * dist);
      sparkle.position.copy(pos);
      sparkle.userData = { baseY: pos.y, phase: Math.random() * Math.PI * 2 };
      particles.add(sparkle);
    }

    // Add a central fountain for the town square
    const fountain = new THREE.Group();
    const baseGeom = new THREE.CylinderGeometry(2, 2, 0.5, 16);
    const baseMat = Materials.createTrimMaterial(0x666666);
    const base = new THREE.Mesh(baseGeom, baseMat);
    base.position.set(0, 0.25, 0);
    fountain.add(base);
    const waterGeom = new THREE.CylinderGeometry(1.8, 1.8, 0.1, 16);
    const waterMat = new THREE.MeshStandardMaterial({ color: 0x0066cc, transparent: true, opacity: 0.8, roughness: 0.1, metalness: 0.1 });
    const water = new THREE.Mesh(waterGeom, waterMat);
    water.position.set(0, 0.55, 0);
    fountain.add(water);
    fountain.position.set(0, this.radius + 0.3, 0);
    const fountainQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0)); // flat
    fountain.quaternion.copy(fountainQ);

    // Add a central statue for glam
    const statue = new THREE.Group();
    const pedestalGeom = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
    const pedestalMat = Materials.createTrimMaterial(0xaaaaaa);
    const pedestal = new THREE.Mesh(pedestalGeom, pedestalMat);
    pedestal.position.set(0, 0.5, 0);
    statue.add(pedestal);
    const figureGeom = new THREE.CapsuleGeometry(0.3, 1.5, 8, 16);
    const figureMat = Materials.createPBRMaterial({ color: 0x8b4513, roughness: 0.7 });
    const figure = new THREE.Mesh(figureGeom, figureMat);
    figure.position.set(0, 1.25, 0);
    statue.add(figure);
    statue.position.set(0, this.radius + 1.5, 0);
    statue.castShadow = true; statue.receiveShadow = true;
    statue.name = 'central_statue';

    // Add parked cars along the road
    const cars = new THREE.Group();
    for (let i = 0; i < 8; i++) { // Increased from 4 to 8
      const carGeom = new THREE.BoxGeometry(1.5, 0.8, 3);
      const carMat = Materials.createTrimMaterial(0xff0000 + i * 0x222222);
      const car = new THREE.Mesh(carGeom, carMat);
      const theta = (i / 8) * Math.PI * 2; // Adjusted for more cars
      const r = (pathGroup.userData?.pathRadius || (this.radius * 0.9)) + 0.4;
      const pos = new THREE.Vector3(Math.cos(theta) * r, 0, Math.sin(theta) * r);
  const sampled = this.sampleSurfacePosition(pos, 0.4);
  car.position.copy(sampled.position);
  car.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal));
      car.castShadow = true; car.receiveShadow = true;
      car.name = `car_${i}`;
      cars.add(car);
    }

    // Add market stalls near houses
    const stalls = new THREE.Group();
    for (let i = 0; i < 6; i++) {
      const stall = this.createStall();
      const theta = ((i + 0.1) / 6) * Math.PI * 2;
      const r = (pathGroup.userData?.pathRadius || (this.radius * 0.9)) - 1.8;
      const pos = new THREE.Vector3(Math.cos(theta) * r, 0, Math.sin(theta) * r);
  const sampled = this.sampleSurfacePosition(pos, 0.5);
  stall.position.copy(sampled.position);
  stall.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal));
      stall.castShadow = true; stall.receiveShadow = true;
      stall.name = `stall_${i}`;
      stalls.add(stall);
    }

    // Add signboards on buildings
    const signboards = new THREE.Group();
    for (let i = 0; i < 12; i++) {
      const signGeom = new THREE.PlaneGeometry(1.2, 0.6);
      const signMat = Materials.createTrimMaterial(0xffffff);
      const sign = new THREE.Mesh(signGeom, signMat);
      const theta = (i / 6) * Math.PI * 2;
      const ringR = (pathGroup.userData?.pathRadius || (this.radius * 0.9)) + 1.4;
      const pos = new THREE.Vector3(Math.cos(theta) * ringR, 0, Math.sin(theta) * ringR);
  const sampled = this.sampleSurfacePosition(pos, 2.0);
  sign.position.copy(sampled.position);
  sign.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal));
      sign.name = `signboard_${i}`;
      signboards.add(sign);
    }

    // Add rivers
    const rivers = new THREE.Group();
    for (let i = 0; i < 2; i++) {
      const river = this.createRiver();
      const theta = (i * Math.PI) + Math.PI / 4;
      const r = this.radius * 0.6;
      const pos = new THREE.Vector3(Math.cos(theta) * r, 0, Math.sin(theta) * r);
  const sampled = this.sampleSurfacePosition(pos, 0.1);
  river.position.copy(sampled.position);
  river.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal));
      river.name = `river_${i}`;
      rivers.add(river);
    }

    // Add mountains
    const mountains = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const mountain = this.createMountain();
      const theta = (i / 4) * Math.PI * 2 + Math.PI / 8;
      const r = this.radius * 0.8;
      const pos = new THREE.Vector3(Math.cos(theta) * r, 0, Math.sin(theta) * r);
  const sampled = this.sampleSurfacePosition(pos, 2);
  mountain.position.copy(sampled.position);
  mountain.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal));
      mountain.castShadow = true; mountain.receiveShadow = true;
      mountain.name = `mountain_${i}`;
      mountains.add(mountain);
    }

    // Add construction blocks
    const constructions = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const block = this.createConstructionBlock();
      const theta = (i / 3) * Math.PI * 2;
      const r = this.radius * 0.7;
      const pos = new THREE.Vector3(Math.cos(theta) * r, 0, Math.sin(theta) * r);
  const sampled = this.sampleSurfacePosition(pos, 1.5);
  block.position.copy(sampled.position);
  block.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal));
      block.castShadow = true; block.receiveShadow = true;
      block.name = `construction_${i}`;
      constructions.add(block);
    }

    // Add flowers for color and life
    const flowers = new THREE.Group();
    for (let i = 0; i < 50; i++) {
      const flowerGeom = new THREE.ConeGeometry(0.1, 0.3, 6);
      const flowerMat = Materials.createStandardMaterial({ color: 0xff69b4 + Math.floor(Math.random() * 0x333333) });
      const flower = new THREE.Mesh(flowerGeom, flowerMat);
      const angle = Math.random() * Math.PI * 2;
      const dist = this.radius * 0.6 + Math.random() * this.radius * 0.3;
      const pos = new THREE.Vector3(Math.cos(angle) * dist, 0, Math.sin(angle) * dist);
  const sampled = this.sampleSurfacePosition(pos, 0.2);
  flower.position.copy(sampled.position);
  flower.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal));
      flower.name = `flower_${i}`;
      flowers.add(flower);
    }

    // Add signs for shops/buildings
    const signs = new THREE.Group();
    for (let i = 0; i < 6; i++) {
      const signGeom = new THREE.PlaneGeometry(0.8, 0.4);
      const signMat = Materials.createTrimMaterial(0xffffff);
      const sign = new THREE.Mesh(signGeom, signMat);
      const theta = ((i + 0.2) / 6) * Math.PI * 2;
      const r = (pathGroup.userData?.pathRadius || (this.radius * 0.9)) - 0.5;
      const pos = new THREE.Vector3(Math.cos(theta) * r, 0, Math.sin(theta) * r);
  const sampled = this.sampleSurfacePosition(pos, 1.5);
  sign.position.copy(sampled.position);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal);
  sign.quaternion.copy(q);
      sign.name = `sign_${i}`;
      signs.add(sign);
    }

    // Add dust particles for ambiance
    const dustParticles = new THREE.Group();
    for (let i = 0; i < 100; i++) {
      const dustGeom = new THREE.SphereGeometry(0.01, 4, 4);
      const dustMat = new THREE.MeshBasicMaterial({ color: 0xcccccc, transparent: true, opacity: 0.3 });
      const dust = new THREE.Mesh(dustGeom, dustMat);
      dust.position.set(
        (Math.random() - 0.5) * this.radius * 2,
        Math.random() * 10 + 2,
        (Math.random() - 0.5) * this.radius * 2
      );
      dust.userData = { baseY: dust.position.y, phase: Math.random() * Math.PI * 2 };
      dust.name = 'dust';
      dustParticles.add(dust);
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
  this.tryLoadModels(buildings, npcs, buildingPlaceholders, npcPlaceholders).catch(() => { /* swallow errors */ });

  // Try to convert the segmented road to decal-projected meshes for crisper inlays (async)
  // non-blocking; will fall back to segmented planes if DecalGeometry isn't available
  this.tryConvertRoadToDecals(pathGroup, mesh).catch(() => { /* ignore */ });

    // Return the group as a Mesh-typed value to keep compatibility with existing code
    return (root as unknown) as THREE.Mesh;
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
  private sampleSurfacePosition(approxPos: THREE.Vector3, desiredOffset: number = 0): { position: THREE.Vector3; normal: THREE.Vector3 } {
    // Enhanced fallback: use nearest point on terrain mesh if available
    const fallbackNormal = approxPos.clone().normalize();
    const fallbackPos = this.center.clone().add(fallbackNormal.clone().multiplyScalar(this.radius + desiredOffset));

    try {
      if (!this.surfaceMesh) return { position: fallbackPos, normal: fallbackNormal };

      // direction from center to approx position
      const dir = approxPos.clone().normalize();
      // guess the maximum displacement we might find on the terrain (mountains/hills)
      const maxExpectedDisplacement = 4.5; // Increased from 3.0 to account for higher peaks

      // Try multiple raycast strategies to robustly hit displaced geometry
      const strategies = [] as { start: THREE.Vector3; dir: THREE.Vector3; far: number }[];

      // primary: cast from slightly outside the max displacement inward along center
      const primaryStart = this.center.clone().add(dir.clone().multiplyScalar(this.radius + maxExpectedDisplacement + 1.0));
      strategies.push({ start: primaryStart, dir: this.center.clone().sub(primaryStart).normalize(), far: (maxExpectedDisplacement + 3.0) + this.radius + 15 });

      // secondary: cast a short ray outward from a point on the base radius toward the sky (handles cases with overhangs)
      const basePoint = this.center.clone().add(dir.clone().multiplyScalar(this.radius + 0.02));
      const outStart = basePoint.clone().add(dir.clone().multiplyScalar(-1.0)); // slightly inside
      strategies.push({ start: outStart, dir: dir.clone().normalize(), far: 8.0 });

      // tertiary: jittered inward rays to catch nearby displaced peaks (helps when sampling on very bumpy areas)
      const jitterAngles = [0.0, 0.15, -0.15, 0.3, -0.3, 0.45, -0.45];
      for (const a of jitterAngles) {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
        const jDir = dir.clone().applyQuaternion(q).normalize();
        const s = this.center.clone().add(jDir.clone().multiplyScalar(this.radius + maxExpectedDisplacement + 1.0));
        strategies.push({ start: s, dir: this.center.clone().sub(s).normalize(), far: (maxExpectedDisplacement + 3.0) + this.radius + 15 });
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
        } catch (e) {
          // ignore and try next
        }
      }

      if (hit) {
        const point = hit.point.clone();
        // remember the strat.start used for debug line (approximate)
        // find the first strategy whose ray would have hit roughly this point (best-effort)
        try {
          for (const strat of strategies) {
            const toP = point.clone().sub(strat.start);
            const proj = toP.dot(strat.dir);
            if (proj > 0 && proj < strat.far + 1e-3) { usedStrategyStart = strat.start; break; }
          }
        } catch (e) {}
        // compute a world-space normal from the hit face
        let normal = new THREE.Vector3(0, 1, 0);
        if (hit.face) {
          const nm = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
          normal = hit.face.normal.clone().applyMatrix3(nm).normalize();
        } else {
          normal = point.clone().sub(this.center).normalize();
        }
        // apply a tiny outward epsilon so placed objects don't z-fight
        // Small epsilon to prevent z-fighting, actual object offsets handled separately
        const epsilon = 0.02;
        const outPos = point.clone().add(normal.clone().multiplyScalar(epsilon + desiredOffset));
        // debug: draw helper sphere + ray
        try {
          if ((this.mesh as any).userData && (this.mesh as any).userData._debug) {
            const helpers = (this.mesh as any).userData._debugHelpers = (this.mesh as any).userData._debugHelpers || new THREE.Group();
            // small sphere at hit point
            const sph = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 6), new THREE.MeshBasicMaterial({ color: 0xff00ff }));
            sph.position.copy(point);
            // line from ray start to hit
            const from = usedStrategyStart ? usedStrategyStart.clone() : primaryStart.clone();
            const lineGeom = new THREE.BufferGeometry().setFromPoints([from.clone(), point.clone()]);
            const line = new THREE.Line(lineGeom, new THREE.LineBasicMaterial({ color: 0x00ffff }));
            helpers.add(sph); helpers.add(line);
            // attach helpers if not attached
            if (!helpers.parent) this.mesh.add(helpers);
            // remove helpers shortly to avoid memory growth
            setTimeout(() => { try { helpers.remove(sph); helpers.remove(line); } catch (e) {} }, 2000);
          }
        } catch (e) {}
        return { position: outPos, normal };
      }
      return { position: fallbackPos, normal: fallbackNormal };
    } catch (e) {
      return { position: fallbackPos, normal: fallbackNormal };
    }
  }

  // Build a ring of small segment meshes that sit on the sphere surface to emulate a road/decals.
  private createRoadRing(radius: number, width: number, segments: number = 64): THREE.Group {
    const g = new THREE.Group();
    g.userData = { pathRadius: radius };
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
  const center = this.center.clone().add(approxCenter.clone().normalize().multiplyScalar(this.radius + 0.01));
  // tangent direction along ring
  const approxNext = new THREE.Vector3(Math.cos(angle + segAngle) * radius, 0, Math.sin(angle + segAngle) * radius);
  const next = this.center.clone().add(approxNext.clone().normalize().multiplyScalar(this.radius + 0.01));
      const dir = next.clone().sub(center).normalize();

      const planeGeom = new THREE.PlaneGeometry(segLength * 1.05, width, 1, 1);
      // prefer a PBR trim/road material and attach generated maps
      const mat = Materials.createTrimMaterial(0x6b5f4f);
      try {
        (mat as any).map = tex;
        (mat as any).map.needsUpdate = true;
        (mat as any).normalMap = normalTex;
        (mat as any).normalMap.needsUpdate = true;
        (mat as any).roughnessMap = roughnessTex;
        (mat as any).roughnessMap.needsUpdate = true;
        (mat as any).normalScale = new THREE.Vector2(0.6, 0.6);
      } catch (e) { }
      const mesh = new THREE.Mesh(planeGeom, mat);
  // mark as temporary plane so we can remove when decals are projected
  (mesh as any).userData = (mesh as any).userData || {};
  (mesh as any).userData.isRoadPlane = true;
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
  const localDir = dir.clone().applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, normal).invert());
      const yaw = Math.atan2(localDir.z, localDir.x);
      mesh.rotateOnAxis(new THREE.Vector3(0, 1, 0), yaw);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.add(mesh);
    }
    // store texture references for potential decal conversion
    (g as any).userData = (g as any).userData || {};
    (g as any).userData.tex = tex;
    (g as any).userData.normalTex = normalTex;
    (g as any).userData.roughnessTex = roughnessTex;
    (g as any).userData.width = width;
    (g as any).userData.segments = segments;
    return g;
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
      step.castShadow = true; step.receiveShadow = true;
      group.add(step);
    }
    // Add railings
    const railMat = Materials.createTrimMaterial(0x444444);
    const railGeom = new THREE.CylinderGeometry(0.05, 0.05, numSteps * stepDepth);
    const leftRail = new THREE.Mesh(railGeom, railMat);
    leftRail.position.set(-stepWidth / 2, numSteps * stepHeight / 2, numSteps * stepDepth / 2);
    leftRail.rotation.z = Math.PI / 2;
    group.add(leftRail);
    const rightRail = leftRail.clone();
    rightRail.position.x = stepWidth / 2;
    group.add(rightRail);
    return group;
  }

  private createStall(): THREE.Group {
    const group = new THREE.Group();
    // Base table
    const tableGeom = new THREE.BoxGeometry(1.2, 0.3, 0.8);
    const tableMat = Materials.createTrimMaterial(0x8b4513);
    const table = new THREE.Mesh(tableGeom, tableMat);
    table.position.set(0, 0.15, 0);
    table.castShadow = true; table.receiveShadow = true;
    group.add(table);
    // Roof
    const roofGeom = new THREE.ConeGeometry(0.8, 0.4, 4);
    const roofMat = Materials.createTrimMaterial(0xff0000);
    const roof = new THREE.Mesh(roofGeom, roofMat);
    roof.position.set(0, 0.5, 0);
    roof.castShadow = true; roof.receiveShadow = true;
    group.add(roof);
    return group;
  }

  private createConstructionBlock(): THREE.Group {
    const group = new THREE.Group();
    // Main building block
    const buildingGeom = new THREE.BoxGeometry(2, 3, 2);
    const buildingMat = Materials.createPBRMaterial({ color: 0xcccccc, roughness: 0.9 });
    const building = new THREE.Mesh(buildingGeom, buildingMat);
    building.position.set(0, 1.5, 0);
    building.castShadow = true; building.receiveShadow = true;
    group.add(building);
    // Scaffolding poles
    const poleMat = Materials.createTrimMaterial(0x666666);
    const poleGeom = new THREE.CylinderGeometry(0.05, 0.05, 4, 8);
    for (let i = 0; i < 4; i++) {
      const pole = new THREE.Mesh(poleGeom, poleMat);
      const x = (i % 2) * 1.8 - 0.9;
      const z = Math.floor(i / 2) * 1.8 - 0.9;
      pole.position.set(x, 2, z);
      pole.castShadow = true; pole.receiveShadow = true;
      group.add(pole);
    }
    return group;
  }

  private createRiver(): THREE.Group {
    const group = new THREE.Group();
    // Winding water plane
    const riverGeom = new THREE.PlaneGeometry(10, 2, 20, 4);
    const riverMat = new THREE.MeshStandardMaterial({ color: 0x0066cc, transparent: true, opacity: 0.8, roughness: 0.1, metalness: 0.1 });
    const river = new THREE.Mesh(riverGeom, riverMat);
    river.rotation.x = -Math.PI / 2;
    river.receiveShadow = true;
    group.add(river);
    return group;
  }

  private createMountain(): THREE.Group {
    const group = new THREE.Group();
    // Cone for peak
    const peakGeom = new THREE.ConeGeometry(2, 4, 8);
    const peakMat = Materials.createPBRMaterial({ color: 0x8b8b8b, roughness: 0.9 });
    const peak = new THREE.Mesh(peakGeom, peakMat);
    peak.position.set(0, 2, 0);
    peak.castShadow = true; peak.receiveShadow = true;
    group.add(peak);
    // Base
    const baseGeom = new THREE.CylinderGeometry(2.5, 3, 1, 8);
    const baseMat = Materials.createPBRMaterial({ color: 0x654321, roughness: 0.8 });
    const base = new THREE.Mesh(baseGeom, baseMat);
    base.position.set(0, 0.5, 0);
    base.castShadow = true; base.receiveShadow = true;
    group.add(base);
    return group;
  }



  // Attempt to replace the segmented road planes with DecalGeometry projected decals for sharper results.
  private async tryConvertRoadToDecals(pathGroup: THREE.Group, targetMesh: THREE.Mesh) {
    try {
      const mod = await import('three/addons/geometries/DecalGeometry.js');
      const { DecalGeometry } = mod as any;
      const ud: any = (pathGroup as any).userData || {};
      const segments: number = ud.segments || 128;
      const width: number = ud.width || 0.8;
      const pathRadius: number = ud.pathRadius || (this.radius * 0.9);
      const tex: THREE.Texture | undefined = ud.tex;
      const normalTex: THREE.Texture | undefined = ud.normalTex;

      const segAngle = (Math.PI * 2) / segments;
      const segLength = (2 * Math.PI * pathRadius) / segments;

      // create decal material
      const decalMat = new THREE.MeshStandardMaterial({
        map: tex || undefined,
        normalMap: normalTex || undefined,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        side: THREE.DoubleSide,
      });

      // For each segment, project a decal onto the target mesh
      for (let i = 0; i < segments; i++) {
        const angle = i * segAngle;
  const approxCenterLocal = new THREE.Vector3(Math.cos(angle) * pathRadius, 0, Math.sin(angle) * pathRadius);
  const centerLocal = this.center.clone().add(approxCenterLocal.clone().normalize().multiplyScalar(this.radius + 0.02));
        // midpoint toward next segment for stable placement
  const approxNextLocal = new THREE.Vector3(Math.cos(angle + segAngle) * pathRadius, 0, Math.sin(angle + segAngle) * pathRadius);
  const nextLocal = this.center.clone().add(approxNextLocal.clone().normalize().multiplyScalar(this.radius + 0.02));
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
      pathGroup.children.forEach((c) => {
        if ((c as any).userData && (c as any).userData.isRoadPlane) toRemove.push(c);
      });
      toRemove.forEach((c) => { pathGroup.remove(c); });
    } catch (e) {
      // DecalGeometry not available or failed — leave plane segments in place
      return;
    }
  }

  private async tryLoadModels(_buildings: THREE.Group, _npcs: THREE.Group, _buildingPlaceholders: THREE.Mesh[], _npcPlaceholders: THREE.Mesh[]) {
    try {
      const mod = await import('three/addons/loaders/GLTFLoader.js');
      const { GLTFLoader } = mod as any;
      const loader = new GLTFLoader();
      const basePath = '/assets/models/';

      // helper to find procedural placeholders by name prefix across island root
      const findPlaceholders = (prefix: string): THREE.Object3D[] => {
        const out: THREE.Object3D[] = [];
        this.mesh.traverse((o: any) => { if (o && o.name && (o.name as string).startsWith(prefix)) out.push(o as THREE.Object3D); });
        return out;
      };

      // per-model override table (basename -> tweaks)
      let modelOverrides: Record<string, { envMapIntensity?: number; roughnessScale?: number; scale?: number; ormPacking?: string; fitHeight?: number; yOffset?: number; randomYaw?: boolean }> = {
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
        'Crate_Wooden.gltf': { envMapIntensity: 0.7, fitHeight: 1.1, randomYaw: true }
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
      } catch (e) { /* ignore missing manifest */ }

      // helper to split a packed ORM texture into separate textures
      // packingHint examples: 'rga' (R=AO,G=Rough,B=Metal), 'rgb' (R=red->ao, G=green->rough, B=blue->metal)
      const splitORMTexture = (tex: THREE.Texture, packingHint: string = 'rga') => {
        try {
          // If this texture or its underlying image was already processed, return cached result to avoid repeated work/log spam
          try {
            const imgKey = (tex as any).image || null;
            if ((tex as any).__ormSplitDone) return (tex as any).__ormSplitResult || null;
            if (imgKey && (imgKey as any).__ormSplitDone) return (imgKey as any).__ormSplitResult || null;
            // guard against re-entrant concurrent processing
            if (imgKey && (imgKey as any).__ormSplitProcessing) return null;
            if ((tex as any).__ormSplitProcessing) return null;
            if (imgKey) (imgKey as any).__ormSplitProcessing = true;
            (tex as any).__ormSplitProcessing = true;
          } catch (e) {}
          // Ensure global diagnostics array exists for dev UI
          try { (window as any).__ormDiagnostics = (window as any).__ormDiagnostics || []; } catch (e) { }
          const img: any = tex.image;
          const w = img?.width || img?.naturalWidth || 0;
          const h = img?.height || img?.naturalHeight || 0;
          if (!w || !h) return null;
          const src = document.createElement('canvas'); src.width = w; src.height = h; const sctx = src.getContext('2d')!;
          try {
            sctx.drawImage(img, 0, 0, w, h);
          } catch (err) {
            // Canvas is likely tainted by CORS; cannot read pixels. Abort splitting gracefully.
            console.warn('splitORMTexture: canvas drawImage failed (possible CORS taint), skipping split', err);
            try { (window as any).__ormDiagnostics.push({ map: (tex as any).name || (tex as any).uuid || '<unknown>', result: 'tainted', reason: 'drawImage failed (CORS/taint)' }); } catch (e) {}
            return null;
          }
          let imageData: ImageData;
          try {
            imageData = sctx.getImageData(0, 0, w, h);
          } catch (err) {
            // reading pixels failed (tainted canvas). Abort.
            console.warn('splitORMTexture: getImageData failed (tainted canvas), skipping split', err);
            try { (window as any).__ormDiagnostics.push({ map: (tex as any).name || (tex as any).uuid || '<unknown>', result: 'tainted', reason: 'getImageData failed (CORS/taint)' }); } catch (e) {}
            return null;
          }
          const data = imageData.data;
          const makeCanvas = () => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
          const ca = makeCanvas(), cr = makeCanvas(), cm = makeCanvas();
          const aCtx = ca.getContext('2d')!, rCtx = cr.getContext('2d')!, mCtx = cm.getContext('2d')!;
          const aData = aCtx.createImageData(w, h); const rData = rCtx.createImageData(w, h); const mData = mCtx.createImageData(w, h);

          // interpret packing hint (map channels to outputs)
          // default mapping: packingHint[0] -> AO source channel, [1] -> Roughness, [2] -> Metalness
          const chIndex = (ch: string) => {
            ch = (ch || '').toLowerCase();
            if (ch === 'r' || ch === 'red') return 0;
            if (ch === 'g' || ch === 'green') return 1;
            if (ch === 'b' || ch === 'blue') return 2;
            // fallback to red
            return 0;
          };
          const hint = String(packingHint || 'rga');
          const aoSrc = chIndex(hint[0] || 'r');
          const roughSrc = chIndex(hint[1] || 'g');
          const metalSrc = chIndex(hint[2] || 'b');

          for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const srcVals = [r, g, b];
            const ao = srcVals[aoSrc] || 0;
            const rough = srcVals[roughSrc] || 0;
            const metal = srcVals[metalSrc] || 0;
            aData.data[i] = aData.data[i + 1] = aData.data[i + 2] = ao; aData.data[i + 3] = 255;
            rData.data[i] = rData.data[i + 1] = rData.data[i + 2] = rough; rData.data[i + 3] = 255;
            mData.data[i] = mData.data[i + 1] = mData.data[i + 2] = metal; mData.data[i + 3] = 255;
          }
          aCtx.putImageData(aData, 0, 0); rCtx.putImageData(rData, 0, 0); mCtx.putImageData(mData, 0, 0);
          const tA = new THREE.CanvasTexture(ca); const tR = new THREE.CanvasTexture(cr); const tM = new THREE.CanvasTexture(cm);
          tA.needsUpdate = tR.needsUpdate = tM.needsUpdate = true;
          const result = { aoMap: tA, roughnessMap: tR, metalnessMap: tM };
          // cache the split result on the original texture and the underlying image so subsequent calls are instant/no-op
          try {
            (tex as any).__ormSplitDone = true;
            (tex as any).__ormSplitResult = result;
            const imgKey = (tex as any).image || null;
            if (imgKey) {
              (imgKey as any).__ormSplitDone = true;
              (imgKey as any).__ormSplitResult = result;
              (imgKey as any).__ormSplitProcessing = false;
            }
            (tex as any).__ormSplitProcessing = false;
          } catch (e) {}
          try { (window as any).__ormDiagnostics.push({ map: (tex as any).name || (tex as any).uuid || '<unknown>', result: 'ok' }); } catch (e) {}
          return result;
        } catch (e) { console.warn('splitORMTexture generic failure', e); return null; }
      };

      // helper to prepare a model clone for fade-in while preserving GLTF materials and applying overrides (including ORM splitting)
      const prepareClone = (
        model: THREE.Object3D,
        /*position: THREE.Vector3, quaternion: THREE.Quaternion,*/
        scale = 1,
        overrides?: { envMapIntensity?: number; roughnessScale?: number; ormPacking?: string; fitHeight?: number; yOffset?: number; randomYaw?: boolean }
      ) => {
        // clone model, apply local scale; caller should position the returned copy using placeObjectOnSurface
        const copy = model.clone(true) as THREE.Object3D;
        copy.position.set(0, 0, 0);
        copy.quaternion.identity();
        copy.scale.setScalar(scale);
        if (typeof overrides?.fitHeight === 'number') {
          try {
            const bbox = new THREE.Box3().setFromObject(copy as any);
            const size = new THREE.Vector3();
            bbox.getSize(size);
            if (size.y > 1e-4) {
              const desired = overrides.fitHeight;
              const adjust = desired / size.y;
              copy.scale.multiplyScalar(adjust);
            }
          } catch (e) { /* ignore fit scaling issues */ }
        }
        copy.traverse((o: any) => {
          if (o.isMesh) {
            try { o.castShadow = true; o.receiveShadow = true; } catch (e) {}
            try {
              if (o.material) {
                try { Materials.fixMaterialTextures(o.material); } catch (e) {}
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach((m: any, idx: number) => {
                  if (!m) return;
                  // If the material is already standard/physical, tune PBR params and detect ORM maps
                  if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) {
                    try {
                      if (typeof overrides?.envMapIntensity === 'number') m.envMapIntensity = overrides.envMapIntensity;
                      else if (typeof m.envMapIntensity === 'number') m.envMapIntensity = Math.max(m.envMapIntensity || 0, 0.6);
                      if (typeof overrides?.roughnessScale === 'number' && typeof m.roughness === 'number') m.roughness = Math.min(1, m.roughness * overrides.roughnessScale);
                    } catch (e) {}
                    // if material has a single packed map, attempt to split it (common pattern: R=AO, G=Roughness, B=Metalness)
                    try {
                      const map = m.map || (m.userData && m.userData.map) || null;
                      if (map) {
                        // determine packing hint: check overrides for this model if supplied via closure
                        const packingFromOverride = overrides && overrides.ormPacking ? overrides.ormPacking : undefined;
                        // if the map filename contains common hints or override provided, attempt split
                        const name = (map as any).name || '';
                        const lookLikePacked = /orm|metalroughness|occlusion|mro|packed/i.test(name) || !!packingFromOverride;
                                      if (lookLikePacked) {
                                        try {
                                          const split = splitORMTexture(map as THREE.Texture, packingFromOverride || 'rga');
                                          if (split) {
                                            if (!m.aoMap) m.aoMap = split.aoMap;
                                            if (!m.roughnessMap) m.roughnessMap = split.roughnessMap;
                                            if (!m.metalnessMap) m.metalnessMap = split.metalnessMap;
                                            console.info('[Island] splitORMTexture succeeded for map', (map as any).name || (map as any).uuid || '<unknown>');
                                          } else {
                                            console.info('[Island] splitORMTexture skipped for map (null result)', (map as any).name || (map as any).uuid || '<unknown>');
                                          }
                                        } catch (e) {
                                          console.warn('[Island] splitORMTexture threw when processing map', (map as any).name || (map as any).uuid || '<unknown>', e);
                                        }
                                      }
                      }
                    } catch (e) {}
                    if ('opacity' in m) { try { m.transparent = true; m.opacity = 0; } catch (e) {} }
                    return;
                  }

                  // For non-PBR materials, create a MeshStandardMaterial and copy available maps
                  try {
                    const std = new THREE.MeshStandardMaterial();
                    try { if (m.color) std.color = m.color.clone(); } catch (e) {}
                    try { if (m.map) std.map = m.map; } catch (e) {}
                    try { if (m.normalMap) std.normalMap = m.normalMap; } catch (e) {}
                    try {
                      if (typeof (m as any).shininess === 'number') std.roughness = Math.min(1, 1 - ((m as any).shininess / 300));
                      else std.roughness = typeof (m as any).roughness === 'number' ? (m as any).roughness : 0.7;
                    } catch (e) { std.roughness = 0.7; }
                    try { if ((m as any).metalness !== undefined) std.metalness = (m as any).metalness; } catch (e) {}
                    try { if ((m as any).emissive) std.emissive = (m as any).emissive.clone(); } catch (e) {}
                    try { if ((m as any).roughnessMap) std.roughnessMap = (m as any).roughnessMap; } catch (e) {}
                    try { if ((m as any).aoMap) std.aoMap = (m as any).aoMap; } catch (e) {}
                    // attempt to split original map if it looks packed
                      try {
                      const mm = (m as any).map || (m as any).userData?.map || null;
                      if (mm) {
                        const packingFromOverride = overrides && overrides.ormPacking ? overrides.ormPacking : undefined;
                        const name = (mm as any).name || '';
                        const lookLikePacked = /orm|metalroughness|occlusion|mro|packed/i.test(name) || !!packingFromOverride;
                        if (lookLikePacked) {
                          try {
                            const split = splitORMTexture(mm as THREE.Texture, packingFromOverride || 'rga');
                            if (split) {
                              std.aoMap = split.aoMap;
                              std.roughnessMap = split.roughnessMap;
                              std.metalnessMap = split.metalnessMap;
                              console.info('[Island] splitORMTexture succeeded for mm', (mm as any).name || (mm as any).uuid || '<unknown>');
                            } else {
                              console.info('[Island] splitORMTexture skipped for mm (null result)', (mm as any).name || (mm as any).uuid || '<unknown>');
                            }
                          } catch (e) {
                            console.warn('[Island] splitORMTexture threw when processing mm', (mm as any).name || (mm as any).uuid || '<unknown>', e);
                          }
                        }
                      }
                    } catch (e) {}
                    if (typeof overrides?.envMapIntensity === 'number') std.envMapIntensity = overrides.envMapIntensity; else std.envMapIntensity = 0.6;
                    std.transparent = true; std.opacity = 0;
                    if (Array.isArray(o.material)) { const arr = o.material.slice(); arr[idx] = std; o.material = arr; } else { o.material = std; }
                  } catch (e) { /* swallow */ }
                });
              }
            } catch (e) {}
          }
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
          let tried = 0;
          const tryLoadAt = (idx: number) => {
            if (idx >= tryList.length) return; // nothing left
            const url = tryList[idx];
            tried++;
            loader.load(url, (gltf: any) => {
              const model = gltf.scene || gltf.scenes?.[0];
              const animations = gltf.animations || [];
              if (!model) return;
              const placeholders = findPlaceholders(prefix);
              const base = url.replace(/^.*[\\/]/, '');
              const overridesFromManifest = modelOverrides[base] || {};
              placeholders.forEach((ph) => {
                const parent = ph.parent || this.mesh;
                const baseScale = typeof options.scale === 'number' ? options.scale : 1;
                const appliedOverrides = { ...overridesFromManifest } as { envMapIntensity?: number; roughnessScale?: number; ormPacking?: string; fitHeight?: number; yOffset?: number; randomYaw?: boolean; scale?: number };
                if (typeof options.fitHeight === 'number' && typeof appliedOverrides.fitHeight !== 'number') appliedOverrides.fitHeight = options.fitHeight;
                if (typeof options.randomYaw === 'boolean' && typeof appliedOverrides.randomYaw !== 'boolean') appliedOverrides.randomYaw = options.randomYaw;
                if (typeof options.heightOffset === 'number' && typeof appliedOverrides.yOffset !== 'number') appliedOverrides.yOffset = options.heightOffset;
                const usedScale = typeof appliedOverrides.scale === 'number' ? appliedOverrides.scale : baseScale;
                const clone = prepareClone(model, usedScale, appliedOverrides);
                // position clone on the displaced surface where the placeholder was
                let placement: { position: THREE.Vector3; normal: THREE.Vector3 } | null = null;
                try { placement = this.placeObjectOnSurface(clone, ph.position.clone(), 0.0, true); } catch (e) { placement = null; }
                if (placement) {
                  const normal = placement.normal.clone();
                  if (typeof appliedOverrides.yOffset === 'number') {
                    clone.position.add(normal.clone().multiplyScalar(appliedOverrides.yOffset));
                  }
                  if (typeof options.heightOffset === 'number' && typeof appliedOverrides.yOffset !== 'number') {
                    clone.position.add(normal.clone().multiplyScalar(options.heightOffset));
                  }
                  const allowRandomYaw = (typeof appliedOverrides.randomYaw === 'boolean' ? appliedOverrides.randomYaw : false) || options.randomYaw === true;
                  if (allowRandomYaw) {
                    const yaw = Math.random() * Math.PI * 2;
                    const spin = new THREE.Quaternion().setFromAxisAngle(normal, yaw);
                    clone.quaternion.multiply(spin);
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
                    let clip = animations.find((a: any) => /idle/i.test(a.name));
                    if (!clip) clip = animations.find((a: any) => /walk/i.test(a.name));
                    if (!clip) clip = animations[0];
                    if (clip) {
                      const action = mixer.clipAction(clip);
                      action.reset();
                      action.play();
                    }
                    this.animationMixers.push(mixer);
                  }
                } catch (e) { /* ignore animation setup errors */ }

                // fade in/out
                const duration = 600; const start = performance.now();
                const step = () => {
                  const now = performance.now(); const t = Math.min(1, (now - start) / duration);
                  clone.traverse((o: any) => { if (o.isMesh && o.material) { const mats = Array.isArray(o.material) ? o.material : [o.material]; mats.forEach((m: any) => { if (m && 'opacity' in m) m.opacity = t; }); } });
                  try {
                    const phMaterial = (ph as any).material;
                    if (phMaterial && 'opacity' in phMaterial) phMaterial.opacity = 1 - t;
                  } catch (e) {}
                  if (t < 1) requestAnimationFrame(step); else { try { ph.visible = false; } catch (e) {} }
                };
                requestAnimationFrame(step);
              });
            }, undefined, (_err: any) => {
              // on error, try next candidate
              const next = idx + 1;
              if (next < tryList.length) tryLoadAt(next);
            });
          };
          tryLoadAt(0);
        } catch (e) { /* loader not available */ }
      };

      // Replace benches, mailboxes, signs, cars, lamps
  // Provide fallback candidate paths under assetKits folders so models shipped inside assetKits are discoverable
  const ak = '/assetKits';
  loadAndReplace(basePath + 'bench.gltf', 'bench_', { scale: 1, candidates: [ak + '/Fantasy Props MegaKit[Standard]/Exports/glTF/Bench.gltf', ak + '/Fantasy Props MegaKit[Standard]/Exports/glTF/Chair_1.gltf'], randomYaw: true, heightOffset: 0.05, scaleJitter: 0.2 });
  loadAndReplace(basePath + 'mailbox.gltf', 'mailbox_', { scale: 1, randomYaw: true, heightOffset: 0.1 });
  loadAndReplace(basePath + 'car.gltf', 'car_', { scale: 1, candidates: [ak + '/Fantasy Props MegaKit[Standard]/Exports/glTF/Stall_Cart_Empty.gltf'], randomYaw: true, scaleJitter: 0.15, fitHeight: 2.8 });
  loadAndReplace(basePath + 'lamp.gltf', 'lamp', { scale: 1, candidates: [ak + '/Fantasy Props MegaKit[Standard]/Exports/glTF/Lantern_Wall.gltf'], heightOffset: 0.2, randomYaw: true });
  loadAndReplace(ak + '/Fantasy Props MegaKit[Standard]/Exports/glTF/Stall_Empty.gltf', 'building_placeholder_', { fitHeight: 3.6, randomYaw: true, scaleJitter: 0.25, candidates: [ak + '/Fantasy Props MegaKit[Standard]/Exports/glTF/Stall_Cart_Empty.gltf', ak + '/Fantasy Props MegaKit[Standard]/Exports/glTF/Cabinet.gltf', ak + '/Fantasy Props MegaKit[Standard]/Exports/glTF/Workbench.gltf', ak + '/Fantasy Props MegaKit[Standard]/Exports/glTF/Workbench_Drawers.gltf'] });
  loadAndReplace(ak + '/Fantasy Props MegaKit[Standard]/Exports/glTF/Stall_Empty.gltf', 'house_', { fitHeight: 3.2, randomYaw: true, scaleJitter: 0.3, candidates: [ak + '/Fantasy Props MegaKit[Standard]/Exports/glTF/Cabinet.gltf', ak + '/Fantasy Props MegaKit[Standard]/Exports/glTF/Bench.gltf', ak + '/Fantasy Props MegaKit[Standard]/Exports/glTF/Crate_Wooden.gltf', ak + '/Fantasy Props MegaKit[Standard]/Exports/glTF/Barrel.gltf'] });

      // For NPCs we want an NPC wrapper that handles mixer and simple AI. Use a specialized loader callback.
      try {
        const npcCandidates = [basePath + 'npc.gltf', '/assetKits/Universal Base Characters[Standard]/glTF/npc.gltf', '/assetKits/Fantasy Props MegaKit[Standard]/Exports/glTF/npc.gltf'];
        const tryNpc = (idx = 0) => {
          if (idx >= npcCandidates.length) return;
          loader.load(npcCandidates[idx], (gltf: any) => {
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
                const overrides = modelOverrides['npc.gltf'];
                const scale = typeof overrides?.scale === 'number' ? overrides.scale : baseScale;
                // create an NPC instance which clones the provided model internally
                const npc = new NPC(model, animations, pos, quat, scale, this.center, this.radius);
                this.npcInstances.push(npc);
                // add NPC group to the same parent as placeholder
                const parent = ph.parent || this.mesh;
                parent.add(npc.group);
                // fade placeholder out and leave NPC visible
                try { ph.visible = false; } catch (e) {}
                // 30% of NPCs patrol between two nearby points
                try {
                  if (Math.random() < 0.35) {
                    const dir = ph.position.clone().sub(this.center).normalize();
                    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0), dir).normalize();
                    const p1 = ph.position.clone().add(right.clone().multiplyScalar(0.8));
                    const p2 = ph.position.clone().add(right.clone().multiplyScalar(-0.8));
                    // ensure projected to surface
                    try {
                      // sample patrol points to account for displacement
                      const s1 = this.sampleSurfacePosition(p1, 0.58);
                      const s2 = this.sampleSurfacePosition(p2, 0.58);
                      try { (npc as any).startPatrol && (npc as any).startPatrol([s1.position, s2.position]); } catch (e) {}
                    } catch (e) {}
                  }
                } catch (e) {}
                // attach simple dialogue/bubble text
                try { npc.group.name = 'villager'; npc.group.userData = npc.group.userData || {}; npc.group.userData.bubbleText = 'Hello there!'; npc.group.userData.dialogue = 'Nice to meet you.'; } catch (e) {}
              } catch (e) {}
            });
          }, undefined, () => { tryNpc(idx + 1); });
        };
        tryNpc(0);
      } catch (e) { }

      // Trees: replace instanced trunks/foliage with model clones if tree model exists
      try {
        const treeCandidates = [basePath + 'tree.gltf', '/assetKits/Stylized Nature MegaKit[Standard]/glTF/CommonTree_1.gltf', '/assetKits/Stylized Nature MegaKit[Standard]/glTF/CommonTree_2.gltf', '/assetKits/Stylized Nature MegaKit[Standard]/glTF/CommonTree_3.gltf'];
        const tryTree = (idx = 0) => {
          if (idx >= treeCandidates.length) return;
          loader.load(treeCandidates[idx], (gltf: any) => {
            const model = gltf.scene || gltf.scenes?.[0];
            if (!model) { tryTree(idx + 1); return; }
            const overrides = modelOverrides['tree.gltf'];
          // remove instanced meshes (if present)
          const toRemove: THREE.Object3D[] = [];
          this.mesh.traverse((o: any) => { if (o && o.name && /trees_trunk_instanced|trees_foliage_instanced/.test(o.name)) toRemove.push(o); });
          toRemove.forEach(o => { if (o.parent) o.parent.remove(o); });
          // scatter clones roughly where trees were generated previously: random distribution across island
          const treeCount = 48;
          for (let i = 0; i < treeCount; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = (this.radius * 0.45) + Math.random() * (this.radius * 0.45);
            const p = new THREE.Vector3(Math.cos(angle) * dist, 0, Math.sin(angle) * dist);
            const usedScale = typeof overrides?.scale === 'number' ? overrides.scale * (0.9 + Math.random() * 0.4) : (0.9 + Math.random() * 0.4);
            const copy = prepareClone(model, usedScale, overrides);
            try { this.placeObjectOnSurface(copy, p.clone(), 0.55 + Math.random() * 0.7, true); } catch (e) {}
            this.mesh.add(copy);
            // If tree model contains animations (rare), add mixer
            try {
              const animations = gltf.animations || [];
              if (animations && animations.length) {
                const mixer = new THREE.AnimationMixer(copy);
                const clip = animations[0];
                const action = mixer.clipAction(clip);
                action.reset(); action.play();
                this.animationMixers.push(mixer);
              }
            } catch (e) { }
            // quick fade-in
            const duration = 800; const start = performance.now();
            const step = () => { const now = performance.now(); const t = Math.min(1, (now - start) / duration); copy.traverse((o: any) => { if (o.isMesh && o.material) { const mats = Array.isArray(o.material) ? o.material : [o.material]; mats.forEach((m: any) => { if (m && 'opacity' in m) m.opacity = t; }); } }); if (t < 1) requestAnimationFrame(step); };
            requestAnimationFrame(step);
          }
        }, undefined, () => { tryTree(idx + 1); });
        };
        tryTree(0);
      } catch (e) { }

    } catch (e) {
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
   * Public wrapper to sample the displaced surface given a direction vector (world-space).
   * Returns an object with { position, normal } so callers can place markers accurately.
   */
  public sampleSurfaceByDirection(direction: THREE.Vector3, desiredOffset: number = 0): { position: THREE.Vector3; normal: THREE.Vector3 } {
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
            const m = new THREE.Matrix3().getNormalMatrix((hit.object as any).matrixWorld);
            normal = hit.face.normal.clone().applyMatrix3(m).normalize();
          }

          // Ensure normal points outward from center
          const toHit = hitPoint.clone().sub(this.center);
          if (normal.dot(toHit) < 0) {
            normal.negate();
          }
          normal.normalize();

          // Apply offset along normal
          const finalPos = hitPoint.clone().add(normal.clone().multiplyScalar(desiredOffset));
          return { position: finalPos, normal };
        }
      } catch (e) {
        // Silently fail and use fallback
      }
    }

    // Fallback: simple sphere approximation with offset
    const spherePoint = this.center.clone().add(dir.clone().multiplyScalar(this.radius));
    return {
      position: spherePoint.clone().add(dir.clone().multiplyScalar(desiredOffset)),
      normal: dir
    };
  }  /**
   * Place an object on the island surface near an approximate position.
   * This will sample the displaced terrain, set object.position and optionally
   * align object.up to the surface normal (by setting quaternion). Returns the sampled info.
   */
  private placeObjectOnSurface(obj: THREE.Object3D, approxPos: THREE.Vector3, desiredOffset: number = 0, alignToNormal: boolean = true): { position: THREE.Vector3; normal: THREE.Vector3 } {
    try {
      const sampled = this.sampleSurfacePosition(approxPos, desiredOffset);
      obj.position.copy(sampled.position);
      if (alignToNormal) {
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal);
        obj.quaternion.copy(q);
      }
      return sampled;
    } catch (e) {
      // fallback radial math
      const normal = approxPos.clone().normalize();
      const pos = this.center.clone().add(normal.multiplyScalar(this.radius + desiredOffset));
      obj.position.copy(pos);
      if (alignToNormal) obj.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal));
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
    this.mesh.traverse((obj: any) => {
      if (obj.name && obj.name.startsWith('trees_foliage_instanced')) {
        // Instanced foliage sway
        const matrix = new THREE.Matrix4();
        for (let i = 0; i < (obj as any).count; i++) {
          (obj as any).getMatrixAt(i, matrix);
          const position = new THREE.Vector3().setFromMatrixPosition(matrix);
          const sway = Math.sin(time * 2 + i * 0.5) * 0.02;
          position.x += sway;
          matrix.setPosition(position);
          (obj as any).setMatrixAt(i, matrix);
        }
        (obj as any).instanceMatrix.needsUpdate = true;
      }
    });

    // Blink lamp lights at night (simulate time-based)
    const isNight = (time % 24) > 18 || (time % 24) < 6; // rough night hours
    this.mesh.traverse((obj: any) => {
      if (obj.userData && obj.userData.isLampLight) {
        obj.visible = isNight && Math.sin(time * 3) > -0.5; // blink pattern
      }
    });

    // Idle NPC animations (subtle bobbing)
    this.mesh.traverse((obj: any) => {
      if (obj.name && obj.name.startsWith('npc_placeholder_')) {
        // only bob placeholders if no NPC instance replaced them
        const idx = parseInt(obj.name.split('_')[2]);
        const exists = this.npcInstances && this.npcInstances.some(n => {
          try { return n.group && n.group.position && n.group.position.distanceTo(obj.position) < 0.01; } catch (e) { return false; }
        });
        if (!exists) obj.position.y += Math.sin(time * 2 + idx) * 0.005;
      }
    });

    // Animate ambient particles (floating sparkles)
    this.mesh.traverse((obj: any) => {
      if (obj.userData && obj.userData.baseY !== undefined) {
        obj.position.y = obj.userData.baseY + Math.sin(time * 1.5 + obj.userData.phase) * 0.1;
        obj.rotation.y += deltaTime * 0.5;
      }
    });

    // Animate dust particles
    this.mesh.traverse((obj: any) => {
      if (obj.name === 'dust' && obj.userData && obj.userData.baseY !== undefined) {
        obj.position.y = obj.userData.baseY + Math.sin(time * 0.5 + obj.userData.phase) * 0.5;
        obj.position.x += Math.sin(time * 0.3 + obj.userData.phase) * 0.01;
        obj.position.z += Math.cos(time * 0.3 + obj.userData.phase) * 0.01;
      }
    });

    // Advance any animation mixers created for loaded GLTF clones (NPCs, props, trees)
    try {
      for (const m of this.animationMixers) {
        m.update(deltaTime);
      }
    } catch (e) { }

    // Update NPC instances (state machines)
    try {
      for (const n of this.npcInstances) {
        try { n.update(deltaTime); } catch (e) { }
      }
    } catch (e) { }
  }

  /**
   * Cleanup method to dispose all Three.js resources (geometries, materials, textures).
   * Call this when tearing down the island or on hot reload to prevent memory leaks.
   */
  public dispose(): void {
    // Dispose all geometries, materials, and textures in the mesh hierarchy
    this.mesh.traverse((obj) => {
      if ((obj as any).isMesh) {
        const mesh = obj as THREE.Mesh;

        // Dispose geometry
        if (mesh.geometry) {
          mesh.geometry.dispose();
        }

        // Dispose material(s)
        if (mesh.material) {
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach((mat) => this.disposeMaterial(mat));
          } else {
            this.disposeMaterial(mesh.material);
          }
        }
      }
    });

    // Stop all animation mixers
    this.animationMixers.forEach((mixer) => {
      try {
        mixer.stopAllAction();
      } catch (e) {
        // ignore
      }
    });
    this.animationMixers = [];

    // Dispose NPC instances
    this.npcInstances.forEach((npc) => {
      try {
        // NPCs may have their own resources to clean up
        if ((npc as any).dispose) {
          (npc as any).dispose();
        }
      } catch (e) {
        // ignore
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
    const materialWithMaps = material as any;
    if (materialWithMaps.map) materialWithMaps.map.dispose();
    if (materialWithMaps.normalMap) materialWithMaps.normalMap.dispose();
    if (materialWithMaps.roughnessMap) materialWithMaps.roughnessMap.dispose();
    if (materialWithMaps.metalnessMap) materialWithMaps.metalnessMap.dispose();
    if (materialWithMaps.aoMap) materialWithMaps.aoMap.dispose();
    if (materialWithMaps.emissiveMap) materialWithMaps.emissiveMap.dispose();
    if (materialWithMaps.bumpMap) materialWithMaps.bumpMap.dispose();
    if (materialWithMaps.displacementMap) materialWithMaps.displacementMap.dispose();
    if (materialWithMaps.alphaMap) materialWithMaps.alphaMap.dispose();
    if (materialWithMaps.envMap) materialWithMaps.envMap.dispose();

    // Dispose the material itself
    material.dispose();
  }
}

