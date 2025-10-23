# 🌤️ Environment Quick Reference

## User Controls

### Open Panel

- **Button**: Click 🌤️ in top-right corner
- **Keyboard**: Press `E` key

### Quick Presets

| Preset | Time | Description |
|--------|------|-------------|
| 🌙 Midnight | 0.0 | Dark night, stars visible |
| 🌅 Sunrise | 0.25 | Orange morning glow |
| ☀️ Noon | 0.5 | Bright daylight |
| 🌆 Sunset | 0.75 | Red/orange evening |

### Settings

- **Time Slider**: Manual time control (0-100%)
- **Auto Cycle**: Toggle automatic day/night progression
- **Cycle Speed**: 1-10 minutes per full cycle (default: 3 min)

## Developer Console Commands

```javascript
// Access environment
const env = window.engine.getSceneManager().environment;

// Set time (0.0 - 1.0)
env.setTimeOfDay(0.5); // Noon
env.setTimeOfDay(0.0); // Midnight
env.setTimeOfDay(0.75); // Sunset

// Toggle auto cycle
env.setAutoCycle(true);  // Enable
env.setAutoCycle(false); // Disable

// Change cycle speed (seconds)
env.cycleDuration = 60;   // 1 minute
env.cycleDuration = 300;  // 5 minutes

// Check current time
console.log(env.timeOfDay);

// Check if auto cycling
console.log(env.autoCycle);
```

## Time Scale Reference

| Time Value | Period | Visual |
|------------|--------|--------|
| 0.00 | Midnight | Deep night, full stars |
| 0.10 | Late night | Stars fading |
| 0.20 | Dawn | Sky lightening |
| 0.25 | Sunrise | Orange horizon |
| 0.35 | Morning | Bright, clear |
| 0.50 | Noon | Peak brightness |
| 0.65 | Afternoon | Still bright |
| 0.75 | Sunset | Red/orange sky |
| 0.85 | Dusk | Darkening |
| 0.95 | Late evening | Stars appearing |

## Environment Features

### ☁️ Clouds (25)

- Drift speed: 0.3-0.8 units/sec
- Orbit: Slow rotation around island
- Height: 30-130 units
- Fade: Transparent, overlapping

### ⭐ Stars (3000)

- Visible: Night only (time 0.0-0.2, 0.85-1.0)
- Colors: White (70%), Blue-white (15%), Yellow (15%)
- Size: 1.5 pixels
- Rotation: Gentle spin (0.002 rad/sec)

### ☀️ Sun & 🌙 Moon

- Orbit: 300 unit radius
- Sun peaks: Time 0.5 (noon)
- Moon peaks: Time 0.0 (midnight)
- Auto-fade: Below horizon invisible

### 🌫️ Atmospheric Effects

- Dynamic fog color
- Sky gradient shader
- Ambient light tinting
- Shadow intensity changes

## Performance

| Metric | Impact |
|--------|--------|
| CPU | +2-3% |
| GPU | +5-8% |
| Memory | +15MB |
| Draw Calls | +27 |

## File Locations

- **Environment.ts** - Core system (580 lines)
- **SceneManager.ts** - Integration
- **UIManager.ts** - Control panel
- **main.ts** - Event handlers
- **ENVIRONMENT-SYSTEM-GUIDE.md** - Full docs

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `E` | Toggle environment panel |
| `Esc` | Close environment panel |

## Common Issues

**Stars not visible?**
→ Set time to night (0.0-0.2 or 0.85-1.0)

**Clouds not moving?**
→ Wait 10-15 seconds (slow drift)

**Panel won't open?**
→ Check browser console for errors

**Poor performance?**
→ Reduce cloud count in Environment.ts

---

Press `E` to get started! 🌤️
