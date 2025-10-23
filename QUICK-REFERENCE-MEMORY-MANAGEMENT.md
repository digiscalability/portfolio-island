# Memory Management Quick Reference

## 🚀 Quick Start

All major classes now have `dispose()` methods. Call them when cleaning up!

```typescript
// Cleanup example
engine.dispose();
uiManager.dispose();
audioManager.dispose();
island.dispose();
player.dispose();
```

## 📋 Cleanup Checklist

When creating a new class that uses any of these, add a `dispose()` method:

- [ ] Event listeners (addEventListener)
- [ ] Timers (setTimeout, setInterval)
- [ ] Animation loops (requestAnimationFrame)
- [ ] Three.js resources (geometry, material, texture)
- [ ] Audio nodes (AudioContext, sources, nodes)
- [ ] DOM elements (created dynamically)

## 🔧 Common Patterns

### Event Listener Pattern

```typescript
class MyClass {
  private boundHandlers: {
    myHandler?: (e: Event) => void;
  } = {};

  constructor() {
    this.boundHandlers.myHandler = (e) => this.handleEvent(e);
    window.addEventListener('click', this.boundHandlers.myHandler);
  }

  dispose() {
    if (this.boundHandlers.myHandler) {
      window.removeEventListener('click', this.boundHandlers.myHandler);
    }
  }
}
```

### Timer Pattern

```typescript
class MyClass {
  private timers: number[] = [];

  doSomethingLater() {
    const timer = window.setTimeout(() => {}, 1000);
    this.timers.push(timer);
  }

  dispose() {
    this.timers.forEach(t => clearTimeout(t));
    this.timers = [];
  }
}
```

### Three.js Pattern

```typescript
class MyClass {
  private mesh: THREE.Mesh;

  dispose() {
    if (this.mesh.geometry) this.mesh.geometry.dispose();
    if (this.mesh.material) {
      if (Array.isArray(this.mesh.material)) {
        this.mesh.material.forEach(m => m.dispose());
      } else {
        this.mesh.material.dispose();
      }
    }
  }
}
```

### Audio Pattern

```typescript
class MyClass {
  private ctx: AudioContext;
  private sources: AudioBufferSourceNode[] = [];

  dispose() {
    this.sources.forEach(s => s.stop());
    this.ctx.close();
  }
}
```

## ✅ Classes with dispose()

1. **AudioManager** - Stops audio, closes context
2. **Island** - Disposes Three.js resources, NPCs
3. **Player** - Disposes character model, animations
4. **InputManager** - Removes event listeners
5. **VirtualJoystick** - Removes touch listeners, DOM
6. **Engine** - Stops loop, cleanup managers
7. **UIManager** - Clears timers, removes DOM
8. **App (main.ts)** - Coordinates global cleanup

## 🧪 Testing

```javascript
// Browser console test
app.dispose();
// Check console for errors - should be clean

// Memory leak test
// 1. Open DevTools Memory tab
// 2. Take heap snapshot
// 3. Hot reload 5-10 times
// 4. Take another snapshot
// 5. Compare - should not grow significantly
```

## ⚠️ Important Notes

1. **Always store handler references** before adding listeners
2. **Call parent dispose()** if extending a class with dispose
3. **Wrap in try-catch** to continue cleanup on errors
4. **Make idempotent** - safe to call multiple times
5. **Dispose children first** - then parent resources

## 🎯 beforeunload Handler

The App class automatically calls dispose() on page unload:

```typescript
window.addEventListener('beforeunload', () => app.dispose());
```

This ensures cleanup even if user navigates away!

## 📚 Full Documentation

See [MEMORY-LEAK-FIXES-COMPLETE.md](./MEMORY-LEAK-FIXES-COMPLETE.md) for complete details.
