# Quick Reference Guide - Simplified Architecture

## File Structure

```
root/
├── main-simple.ts          ← Entry point (new)
├── GameScene.ts            ← Main scene (replaces SceneManager)
├── SimplePlanet.ts         ← Terrain (replaces Island.ts)
├── SimplePlayer.ts         ← Character (replaces Player.ts)
├── OrbitCamera.ts          ← Camera (replaces Camera.ts)
├── SimpleRenderer.ts       ← WebGL (replaces Renderer.ts)
├── SimpleInputManager.ts   ← Input (replaces InputManager.ts)
├── index.html              ← Updated to use main-simple.ts
├── style.css               ← Reusable styles
└── dist/                   ← Production build (deployed)
```

## Core Classes Overview

### GameScene (extends THREE.Scene)
```typescript
const scene = new GameScene();
await scene.ready();

// Access components
scene.getPlanet();        // SimplePlanet
scene.getPlayer();        // SimplePlayer
scene.getCamera();        // THREE.PerspectiveCamera
scene.getOrbitCamera();   // OrbitCamera

// Update every frame
scene.update(deltaTime);

// Player control
scene.setPlayerMovement(forward, strafe); // -1 to 1
scene.playerJump();

// Camera control
scene.setCameraInput(deltaX, deltaY);
```

### SimplePlanet (extends THREE.Group)
```typescript
const planet = new SimplePlanet(radius);
await planet.ready();

// Raycast queries
const hitPoint = planet.rayCastToSurface(position);
const normal = planet.getSurfaceNormal(position);
const groundPoint = planet.getGroundPoint(position);
const isOnSurface = planet.isOnSurface(position);

// Terrain mesh
const mesh = planet.getTerrainMesh();
const radius = planet.getRadius();

// Cleanup
planet.dispose();
```

### SimplePlayer (extends THREE.Group)
```typescript
const player = new SimplePlayer(planet, startPosition);

// Update physics
player.update(deltaTime);

// Control
player.setMovement(forward, strafe);
player.jump();
player.setRotation(yaw, pitch);

// Query state
player.getWorldPosition();
player.getForwardDirection();
player.getYaw();
player.getIsGrounded();

// Cleanup
player.dispose();
```

### OrbitCamera
```typescript
const camera = new OrbitCamera(threeCamera, player);

// Update every frame
camera.update(deltaTime);

// Control
camera.setInput(deltaYaw, deltaPitch);
camera.setDistance(distance);
camera.setHeight(height);
camera.setSideOffset(offset);
camera.setSmoothness(smoothness);

// Query
camera.getCameraPosition();
camera.getForwardDirection();
camera.getYaw();

// Effects
await camera.flyInFromDistant(duration, targetOffset);
```

### SimpleRenderer
```typescript
const renderer = new SimpleRenderer(canvas);

// Setup post-processing
renderer.initPostProcessing(scene, camera);

// Start render loop
renderer.startRenderLoop(scene, camera, (deltaTime) => {
  // Update game logic
  scene.update(deltaTime);
});

// Control
renderer.setPostProcessingEnabled(enabled);
renderer.stopRenderLoop();

// Cleanup
renderer.dispose();
```

### SimpleInputManager
```typescript
const input = new SimpleInputManager();
input.attachToCanvas(canvas);

// Every frame
const move = input.getMovementInput();     // { forward, strafe }
const cam = input.getCameraInput();        // { deltaX, deltaY }
const jump = input.getJumpInput();         // boolean

// Query
input.isKeyPressed('w');
input.getMousePosition();
input.isLocked();

// Cleanup
input.dispose();
```

## Typical Game Loop

```typescript
// In main-simple.ts
renderer.startRenderLoop(scene, camera, (deltaTime) => {
  // 1. Gather input
  const moveInput = inputManager.getMovementInput();
  const cameraInput = inputManager.getCameraInput();
  const jumpInput = inputManager.getJumpInput();

  // 2. Apply to scene
  scene.setPlayerMovement(moveInput.forward, moveInput.strafe);
  if (jumpInput) scene.playerJump();
  scene.setCameraInput(cameraInput.deltaX, cameraInput.deltaY);

  // 3. Update scene (physics, camera, all systems)
  scene.update(deltaTime);

  // 4. Renderer handles drawing automatically
});
```

## Common Tasks

### Adding an NPC or Object
```typescript
const model = new THREE.Mesh(geometry, material);
model.position.copy(planet.getGroundPoint(position));
scene.add(model);

// Update in game loop
model.position.copy(planet.getGroundPoint(newPosition));
```

### Adding UI Overlay
```typescript
const uiDiv = document.createElement('div');
uiDiv.style.position = 'fixed';
uiDiv.style.zIndex = '10';
document.body.appendChild(uiDiv);
```

### Raycasting from Camera
```typescript
const hits = scene.rayCastFromCamera(mouseX, mouseY);
if (hits.length > 0) {
  console.log('Hit:', hits[0].object, hits[0].point);
}
```

### Getting Player State
```typescript
const player = scene.getPlayer();
const pos = player.getWorldPosition();
const forward = player.getForwardDirection();
const isGrounded = player.getIsGrounded();
```

### Modifying Camera
```typescript
const camera = scene.getOrbitCamera();
camera.setDistance(8);      // Closer
camera.setHeight(1.5);      // Lower
camera.setSideOffset(0.5);  // Less shoulder offset
camera.setSmoothness(0.15); // More responsive
```

## Physics Constants

In `SimplePlayer.ts`:
```typescript
private speed: number = 15;           // Movement speed
private jumpForce: number = 8;        // Jump height
private gravity: number = -25;        // Acceleration down
private groundStickThreshold: number = 0.5;  // How far to stick to surface
```

Adjust these for different feel:
- **Faster**: Increase `speed` (15 → 20)
- **Higher jump**: Increase `jumpForce` (8 → 12)
- **Floatier**: Decrease `gravity` magnitude (25 → 18)
- **Snappier**: Decrease ground threshold (0.5 → 0.2)

## Rendering Constants

In `GameScene.ts`:
```typescript
this.background = new THREE.Color(0x87ceeb);  // Sky blue
this.fog = new THREE.Fog(0x87ceeb, 80, 200); // Fog range
```

In `SimpleRenderer.ts`:
```typescript
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;  // Brightness
```

## Debug Helpers

In `main-simple.ts`:
```typescript
(window as any).getGameState(); // Check if running
```

In browser console:
```javascript
// Access scene
const scene = document.querySelector('canvas').__scene;
const player = scene.getPlayer();
console.log(player.getWorldPosition());
```

## Performance Tips

1. **Reduce complexity**: Fewer objects on planet = faster raycasts
2. **Simplify terrain**: Lower icosphere subdivision (5 → 4)
3. **Disable post-processing**: `renderer.setPostProcessingEnabled(false)`
4. **Batch similar objects**: Use THREE.BatchedMesh
5. **Use LOD**: Different mesh details based on distance

## Troubleshooting

### Player floating in air
- Check `SimplePlanet.rayCastToSurface()` raycast range
- Verify planet radius matches in `SimplePlayer` constructor
- Check ground stick threshold in physics update

### Camera jittering
- Increase `OrbitCamera.smoothness` (0.1 → 0.2)
- Reduce input sensitivity in `SimpleInputManager`
- Check for large deltaTime values (cap at 16ms)

### No terrain visible
- Verify icosphere is being created
- Check camera far plane (should be > 500)
- Verify terrain material and lighting

### Slow performance
- Reduce draw calls: combine meshes
- Profile in DevTools: Performance tab
- Check GPU memory in Three.js stats
- Reduce terrain complexity

## Key Design Decisions

1. **Why extend THREE.Scene?** - Direct Three.js patterns, familiar API
2. **Why Promise-based ready?** - Clean async/await without callbacks
3. **Why separate input/render?** - Single responsibility principle
4. **Why simple physics?** - Easier to debug and understand
5. **Why no abstract managers?** - Less indirection = fewer bugs

## Next Steps if Adding Features

1. **NPCs/Creatures**: Create `Creature` class extending `THREE.Group`
2. **Delivery System**: Wire to player collision detection
3. **Chat/Dialogue**: Add UI div, hook to interaction raycasts
4. **Audio**: Create `SoundPlayer` class, call from game events
5. **Animations**: Use Three.js `AnimationMixer` on imported models

---

**Status**: This simplified architecture is production-ready. Add features by creating new components that follow the same patterns.

# 🚀 GCP VM Quick Reference

## Essential VM Commands

### VM Management (run from your local machine)
```bash
# Create VM
gcloud compute instances create digiscale-dev-vm --zone=us-central1-a --machine-type=e2-standard-4 --boot-disk-size=100GB --boot-disk-type=pd-ssd --image-family=ubuntu-2204-lts --image-project=ubuntu-os-cloud --tags=http-server,https-server

# SSH into VM
gcloud compute ssh digiscale-dev-vm --zone=us-central1-a

# Start/Stop VM
gcloud compute instances start digiscale-dev-vm --zone=us-central1-a
gcloud compute instances stop digiscale-dev-vm --zone=us-central1-a

# Get VM IP
gcloud compute instances describe digiscale-dev-vm --zone=us-central1-a --format='get(networkInterfaces[0].accessConfigs[0].natIP)'
```

### Setup Firewall (run once)
```bash
gcloud compute firewall-rules create allow-code-server --allow tcp:8080 --source-ranges 0.0.0.0/0
gcloud compute firewall-rules create allow-dev-ports --allow tcp:3000-3010 --source-ranges 0.0.0.0/0
```

### On VM Setup Commands
```bash
# Setup development environment
curl -O https://raw.githubusercontent.com/digiscalability/portfolio-island/master/gcp-vm-setup.sh && chmod +x gcp-vm-setup.sh && ./gcp-vm-setup.sh

# Clone additional projects
curl -O https://raw.githubusercontent.com/digiscalability/portfolio-island/master/clone-all-projects.sh && chmod +x clone-all-projects.sh && ./clone-all-projects.sh

# Start all projects
~/workspace/start-all-projects.sh

# Monitor performance
~/workspace/monitor.sh
```

## VM Access URLs
- **VS Code**: `http://VM_IP:8080`
- **Portfolio Island**: `http://VM_IP:3000`
- **Project 2**: `http://VM_IP:3001`
- **Project 3**: `http://VM_IP:3002`
- **Project 4**: `http://VM_IP:3003`

## VM Cost Optimization
- **Running**: ~$2.40/day
- **Stopped**: ~$1.20/day (storage only)
- **Monthly (always on)**: ~$70
- **Monthly (8hrs/day)**: ~$40
