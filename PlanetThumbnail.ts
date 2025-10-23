import * as THREE from 'three';

import { Materials } from './Materials';

// Helper to add a simple low-poly house on the sphere surface
function createHouse(): THREE.Group {
  const g = new THREE.Group();
  const bodyGeo = new THREE.BoxGeometry(0.6, 0.5, 0.6);
  const bodyMat = Materials.createHouseMaterial(0xffddaa);
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 0.25;
  body.castShadow = true;
  g.add(body);

  const roofGeo = new THREE.ConeGeometry(0.6, 0.4, 4);
  const roofMat = Materials.createHouseMaterial(0x8b3b2e);
  const roof = new THREE.Mesh(roofGeo, roofMat);
  roof.position.y = 0.6;
  roof.rotation.y = Math.PI / 4;
  g.add(roof);

  return g;
}

function createTree(): THREE.Group {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.3), Materials.createPBRMaterial({ color: 0x8b5a2b, roughness: 0.6 }));
  trunk.position.y = 0.15;
  g.add(trunk);
  const foliage = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.3, 6), Materials.createTreeMaterial());
  foliage.position.y = 0.45;
  g.add(foliage);
  return g;
}

function createMailbox(): THREE.Group {
  const g = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.6), Materials.createPBRMaterial({ color: 0x6b3b2b, roughness: 0.6 }));
  post.position.y = 0.3;
  g.add(post);
  // Use standard mailbox material to better catch highlights at small sizes
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.18, 0.18), Materials.createMailboxStandard());
  box.position.y = 0.55;
  box.position.x = 0.12;
  g.add(box);

  const flag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.02), Materials.createPBRMaterial({ color: 0xff3333, roughness: 0.4 }));
  flag.position.set(0.28, 0.62, 0);
  g.add(flag);

  return g;
}

export function createPlanetThumbnail(container: HTMLElement): { dispose: () => void } {
  // create canvas
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  container.appendChild(canvas);

  // ensure container can position overlays
  try { if (getComputedStyle(container).position === 'static') container.style.position = 'relative'; } catch (_e) { container.style.position = 'relative'; }

  // overlay UI (title + begin button)
  const overlay = document.createElement('div');
  overlay.style.position = 'absolute';
  overlay.style.left = '0';
  overlay.style.top = '0';
  overlay.style.right = '0';
  overlay.style.bottom = '0';
  overlay.style.display = 'flex';
  overlay.style.flexDirection = 'column';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.pointerEvents = 'none';

  const title = document.createElement('div');
  title.innerText = 'MESSENGER';
  title.style.fontFamily = 'Arial, Helvetica, sans-serif';
  title.style.fontWeight = '900';
  title.style.letterSpacing = '6px';
  title.style.color = '#ffffff';
  title.style.fontSize = '84px';
  title.style.lineHeight = '0.8';
  title.style.textAlign = 'center';
  title.style.textShadow = '0 2px 0 #000, -2px 0 #000, 2px 0 #000';
  title.style.marginBottom = '18px';
  title.style.pointerEvents = 'none';
  overlay.appendChild(title);

  const beginBtn = document.createElement('button');
  beginBtn.innerText = 'BEGIN';
  beginBtn.style.pointerEvents = 'auto';
  beginBtn.style.background = '#f4bf2e';
  beginBtn.style.border = 'none';
  beginBtn.style.padding = '14px 28px';
  beginBtn.style.borderRadius = '6px';
  beginBtn.style.fontWeight = '700';
  beginBtn.style.boxShadow = '0 6px 0 #d49a24';
  beginBtn.style.cursor = 'pointer';
  beginBtn.style.fontFamily = 'Arial, Helvetica, sans-serif';
  beginBtn.style.fontSize = '18px';
  beginBtn.style.transition = 'transform 160ms ease, opacity 200ms';
  beginBtn.style.opacity = '0.98';
  overlay.appendChild(beginBtn);

  // subtle pulse animation for the button via requestAnimationFrame (keeps code self-contained)
  let _btnPulseStart = performance.now();

  function updateButtonPulse(now: number) {
    const t = (now - _btnPulseStart) / 1000;
    const scale = 1 + Math.sin(t * 2.0) * 0.02;
    beginBtn.style.transform = `scale(${scale})`;
  }

  container.appendChild(overlay);

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  const crect = container.getBoundingClientRect();
  const w = Math.max(1, Math.floor(crect.width));
  const h = Math.max(1, Math.floor(crect.height));
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(50, Math.max(0.1, crect.width / crect.height), 0.1, 100);
  camera.position.set(0, 2.2, 4.2);
  camera.lookAt(0, 0, 0);

  // lights
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.9);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 0.6);
  dir.position.set(5, 10, 7);
  scene.add(dir);

  // planet
  const planetRadius = 1.6;
  const planetGeo = new THREE.SphereGeometry(planetRadius, 64, 64);
  const planetMat = Materials.createPlanetMaterial();
  const planet = new THREE.Mesh(planetGeo, planetMat);
  planet.receiveShadow = true;
  scene.add(planet);

  // outline (inverted hull)
  const outlineMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
  const outline = new THREE.Mesh(planetGeo.clone(), outlineMat);
  outline.scale.multiplyScalar(1.03);
  scene.add(outline);

  // small props
  const house = createHouse();
  // place at a surface point
  const pos = new THREE.Vector3(0.9, 1.1, 0.6).normalize().multiplyScalar(planetRadius + 0.01);
  house.position.copy(pos);
  // orient to surface normal
  const normal = pos.clone().normalize();
  house.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
  scene.add(house);

  const tree = createTree();
  const tpos = new THREE.Vector3(-0.8, 1.0, -0.5).normalize().multiplyScalar(planetRadius + 0.01);
  tree.position.copy(tpos);
  tree.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tpos.clone().normalize());
  scene.add(tree);

  const mailbox = createMailbox();
  const mpos = new THREE.Vector3(0.4, 1.05, 0.9).normalize().multiplyScalar(planetRadius + 0.01);
  mailbox.position.copy(mpos);
  mailbox.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), mpos.clone().normalize());
  mailbox.scale.setScalar(0.7);
  scene.add(mailbox);

  // soft shadow disks under props (fake contact shadow)
  function addContactShadow(targetPos: THREE.Vector3, size = 0.35) {
    const shadowGeo = new THREE.CircleGeometry(size, 32);
  const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 });
    const sh = new THREE.Mesh(shadowGeo, shadowMat);
    // position slightly above surface along normal
    const n = targetPos.clone().normalize();
    sh.position.copy(n.multiplyScalar(planetRadius + 0.006));
    // orient to be tangent to planet surface
    sh.lookAt(sh.position.clone().multiplyScalar(2));
    // offset a touch outward so it doesn't z-fight
    sh.position.add(n.multiplyScalar(0.002));
    scene.add(sh);
  }

  addContactShadow(pos, 0.35);
  addContactShadow(tpos, 0.18);
  addContactShadow(mpos, 0.12);

  // subtle cloud layer (slightly warmer tint)
  const cloudGeo = new THREE.SphereGeometry(planetRadius + 0.02, 32, 32);
  const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.07 });
  const clouds = new THREE.Mesh(cloudGeo, cloudMat);
  scene.add(clouds);

  // group rotation for nice motion
  const root = new THREE.Group();
  root.add(planet);
  root.add(outline);
  root.add(house);
  root.add(tree);
  root.add(clouds);
  scene.add(root);

  // running flag for animation loop

  function onResize() {
  const crect2 = container.getBoundingClientRect();
  const w = Math.max(200, Math.floor(crect2.width || 200));
    const h = container.clientHeight || 200;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  window.addEventListener('resize', onResize);

  let last = performance.now();
  let running = true;
  let paused = false;
  function animate() {
    if (!running) return;
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;

    if (!paused) {
      // slow gentle rotation and a small wobble scale
      root.rotation.y += dt * 0.26;
      clouds.rotation.y += dt * 0.08;
      outline.rotation.y = root.rotation.y; // keep outline aligned
      const wobble = 1 + Math.sin(now / 1200) * 0.008;
      root.scale.setScalar(wobble);
    }

    // update button pulse animation
    updateButtonPulse(now);

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }

  animate();

  // Pause rotation when user hovers the container, resume on leave
  const onEnter = () => { paused = true; overlay.style.pointerEvents = 'auto'; };
  const onLeave = () => { paused = false; overlay.style.pointerEvents = 'none'; };
  container.addEventListener('mouseenter', onEnter);
  container.addEventListener('mouseleave', onLeave);

  // Begin button behavior: dispatch a custom event so the main app can listen
  const onBeginClick = (ev: MouseEvent) => {
    ev.stopPropagation();
    const e = new CustomEvent('planet-begin', { bubbles: true });
    container.dispatchEvent(e);
  };
  beginBtn.addEventListener('click', onBeginClick);

  return {
    dispose() {
      running = false;
      window.removeEventListener('resize', onResize);
        container.removeEventListener('mouseenter', onEnter);
        container.removeEventListener('mouseleave', onLeave);
        beginBtn.removeEventListener('click', onBeginClick);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      try {
        // attempt to lose the GL context to avoid accumulating contexts in webviews
        const gl = renderer.getContext();
        try {
          const ext = gl.getExtension && gl.getExtension('WEBGL_lose_context');
          if (ext && typeof ext.loseContext === 'function') ext.loseContext();
        } catch (_e) { }
      } catch (_e) { }
      try { renderer.dispose(); } catch (_e) { }
      try { if (canvas.parentNode) canvas.parentNode.removeChild(canvas); } catch (_e) { }
    }
  };
}
