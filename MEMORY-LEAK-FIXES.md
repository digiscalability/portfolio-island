# Memory Leak and Conflict Fixes

## Critical Issues Found

### 1. InputManager.ts

- **Problem**: Event listeners on `window` and `canvas` never removed
- **Impact**: Memory leak on page navigation/hot reload
- **Fix**: Add dispose() method and store bound handlers

### 2. Engine.ts

- **Problem**: F1 keydown listener never removed
- **Impact**: Memory leak, potential conflicts
- **Fix**: Add cleanup method and store handler reference

### 3. main.ts

- **Problem**: Multiple global event listeners never cleaned up
- **Impact**: Listeners accumulate on hot reload
- **Fix**: Track and remove all listeners in cleanup

### 4. UIManager.ts

- **Problem**: setTimeout/setInterval not tracked for cleanup
- **Impact**: Timers run after component destroyed
- **Fix**: Track all timers and clear on dispose

### 5. VirtualJoystick.ts

- **Problem**: Touch listeners added but never removed
- **Impact**: Memory leak
- **Fix**: Add dispose() method

### 6. Three.js Resources

- **Problem**: Geometries, materials, textures never disposed
- **Impact**: GPU memory leak
- **Fix**: Add dispose() methods to Island, Player, etc.

### 7. AudioManager.ts

- **Problem**: No global cleanup method
- **Impact**: Audio context and buffers persist
- **Fix**: Add dispose() method

## Implementation Plan

1. Add dispose() to InputManager
2. Add cleanup() to Engine
3. Add dispose() to UIManager
4. Add dispose() to VirtualJoystick
5. Add dispose() to Island
6. Add dispose() to Player
7. Add dispose() to AudioManager
8. Update main.ts to track and cleanup listeners
9. Add beforeunload handler to cleanup everything
