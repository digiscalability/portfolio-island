# Quick Tuning Guide - Gameplay Parameters

## 🎮 Player Movement

### Speed & Sprint

```typescript
// Player.ts - Line ~27-28
speed: 4.8                    // Base walking speed (try 4.0-6.0)
sprintMultiplier: 1.85        // Sprint multiplier (try 1.5-2.2)
```

### Jump & Gravity

```typescript
// Player.ts - Line ~32-34
jumpStrength: 5.5             // Jump power (try 4.0-7.0)
gravity: 18.0                 // Pull down force (try 15-25)
gravityMultiplier: dynamic    // Auto-calculated based on height
```

### Responsiveness

```typescript
// Player.ts - Line ~38-40
accel: 22                     // How fast to speed up (try 15-30)
friction: 16                  // How fast to slow down (try 12-22)
turnSpeed: 8.5                // Rotation speed (try 6-12)
```

### Feel & Polish

```typescript
// Player.ts - Line ~47-49
velocitySmoothing: 0.12       // Movement smoothing (0=instant, 1=very smooth)
rotationSmoothing: 0.18       // Turn smoothing (0=instant, 1=very smooth)
airborneControlFactor: 0.65   // Air control (0=none, 1=full)
```

---

## 📷 Camera Settings

### Field of View (FOV)

```typescript
// Camera.ts - Line ~73-78
baseFOV: 55                   // Default FOV (try 50-65)
speedFOVBoost: 8              // Extra FOV at max speed (try 5-12)
sprintFOVBoost: 5             // Extra FOV when sprinting (try 3-8)
fovSmoothSpeed: 6.0           // FOV change speed (try 4-10)
```

### Camera Motion

```typescript
// Camera.ts - Line ~44, 45
smoothness: 0.15              // Position lag (0=rigid, 0.3=floaty)
lookAtSmooth: 3.5             // Rotation lag (try 2-6)
```

### Look-Ahead

```typescript
// Camera.ts - Line ~80-82
lookAheadDistance: 0          // Calculated automatically
lookAheadSpeed: 4.0           // Prediction speed (try 2-8)
maxLookAhead: 2.5             // Max prediction distance (try 1-4)
```

---

## 🏝️ Island Terrain

### Terrain Height

```typescript
// Island.ts - Line ~59-60 (approximately)
minRadius: radius * 0.96      // Valley depth (try 0.93-0.98)
maxRadius: radius + 4.2       // Peak height (try 3.0-6.0)
```

### Terrain Detail

```typescript
// Island.ts - Line ~49-56 (approximately)
largeTerrain: 3.2             // Mountain scale (try 2.5-4.0)
mediumTerrain: 1.5            // Hill scale (try 1.0-2.0)
smallDetail: 0.7              // Rolling terrain (try 0.5-1.0)
microNoise: 0.25              // Surface roughness (try 0.1-0.4)
```

---

## ⚡ Quick Tweaks for Different Feels

### Arcade Style (Fast & Responsive)

```typescript
// Player
speed: 6.0
sprintMultiplier: 2.0
accel: 28
friction: 20
airborneControlFactor: 0.8

// Camera
speedFOVBoost: 12
fovSmoothSpeed: 8.0
smoothness: 0.08
```

### Realistic/Simulation (Slow & Weighty)

```typescript
// Player
speed: 3.5
sprintMultiplier: 1.6
accel: 15
friction: 12
airborneControlFactor: 0.4

// Camera
speedFOVBoost: 5
fovSmoothSpeed: 4.0
smoothness: 0.2
```

### Cinematic (Smooth & Dramatic)

```typescript
// Player
speed: 4.5
sprintMultiplier: 2.2
velocitySmoothing: 0.2
rotationSmoothing: 0.25

// Camera
speedFOVBoost: 10
sprintFOVBoost: 8
smoothness: 0.18
lookAtSmooth: 2.5
```

### Floaty/Moon Gravity

```typescript
// Player
jumpStrength: 8.0
gravity: 12.0
airborneControlFactor: 0.85
friction: 10
```

---

## 🧪 Testing Commands

```javascript
// In browser console

// Enable debug overlay
window.__DEBUG_PLAYER = true;

// Access player directly
const player = window.engine.getPlayer();

// Change speed on the fly
player.speed = 6.0;
player.sprintMultiplier = 2.0;

// Access camera
const camera = window.engine.sceneManager.getCameraController();

// Change FOV settings
camera.baseFOV = 60;
camera.speedFOVBoost = 10;

// Apply camera preset
camera.applyPreset('close');   // Close follow
camera.applyPreset('default'); // Normal
camera.applyPreset('wide');    // Far follow
```

---

## 📊 Recommended Ranges

### Player Speed

- **Too Slow**: < 3.0 (feels sluggish)
- **Good Range**: 4.0 - 6.0
- **Too Fast**: > 7.0 (hard to control)

### Jump Strength

- **Too Low**: < 4.0 (can't jump obstacles)
- **Good Range**: 4.5 - 6.5
- **Too High**: > 8.0 (floaty, disorienting)

### Gravity

- **Too Light**: < 12 (moon physics)
- **Good Range**: 15 - 22
- **Too Heavy**: > 28 (feels weighted down)

### Camera FOV

- **Too Narrow**: < 45 (tunnel vision)
- **Good Range**: 50 - 65
- **Too Wide**: > 75 (fish-eye distortion)

---

## 🎯 Current "Sweet Spot" Settings

The default values are tuned for:

- **Modern third-person action feel**
- **Responsive but realistic physics**
- **Cinematic camera with speed emphasis**
- **Smooth, polished movement**

If it feels off, try adjusting in small increments:

- ±10% for subtle changes
- ±25% for noticeable differences
- ±50% for dramatic shifts

---

## 🔄 Iterative Tuning Process

1. **Pick ONE parameter** to adjust
2. **Test for 2-3 minutes** of gameplay
3. **Note the feel** (too fast? too slow?)
4. **Adjust by 10-20%** in the right direction
5. **Repeat** until it feels right
6. **Move to next parameter**

Don't change everything at once!

---

## 💾 Saving Your Settings

Once you find settings you like, update the class properties:

```typescript
// Player.ts - Lines 27-52 (approximately)
private speed: number = YOUR_VALUE;
private sprintMultiplier: number = YOUR_VALUE;
// etc...

// Camera.ts - Lines 73-82 (approximately)
private baseFOV: number = YOUR_VALUE;
private speedFOVBoost: number = YOUR_VALUE;
// etc...
```

Then rebuild: `npm run build`

---

**Happy Tuning!** 🎮✨
