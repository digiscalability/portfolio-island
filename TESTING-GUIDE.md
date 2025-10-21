# Quick Testing Guide

## 🚀 Server is Running!
**URL:** http://localhost:5173/

---

## ✅ What Was Fixed

### 1. **Island Terrain** - No More Falling Through!
- Added radius clamping to prevent deep valleys
- Terrain now stays exterior to the sphere
- Min radius: ~94% of base (prevents hollow interior)
- Max radius: base + 3.8 units (limits peaks)

### 2. **Props/Assets** - GLTF Models Now Load
- Fixed asset path from `'assets/models/'` to `'/assets/models/'`
- Vite can now correctly resolve model files
- Props like benches, stalls, workbenches should load

### 3. **Dev Server** - Clean Startup
- Removed problematic predev scripts
- Server starts without errors
- Faster startup time

---

## 🎮 What to Test in Browser

### Open: http://localhost:5173/

1. **Visual Check:**
   - Island should be visible and solid
   - No hollow areas or holes in terrain
   - Props/buildings should be visible (placeholders or loaded models)

2. **Player Movement (WASD or Arrow Keys):**
   - Player spawns on island surface
   - Movement feels smooth
   - Player doesn't fall through terrain
   - Walking up hills and down valleys works

3. **Jump (Spacebar):**
   - Player jumps away from surface
   - Lands back on terrain
   - No falling through on landing

4. **Camera:**
   - Third-person view follows player
   - Mouse/touch controls camera rotation
   - No clipping issues

---

## 🐛 Debug Tools

### Enable Debug Mode in Browser Console:
```javascript
// Enable island raycasting debug helpers
window.__ISLAND_DEBUG = true;

// Enable player debug overlay
window.__DEBUG_PLAYER = true;
```

### Check Console for:
- GLTF model loading attempts
- Any error messages
- Asset load failures
- Performance warnings

---

## 📋 Quick Verification

### In Browser Console, run:
```javascript
// Check player exists
console.log(window.game?.player);

// Check island exists
console.log(window.game?.island);

// Get current FPS (if available)
console.log(window.game?.renderer?.info);
```

---

## 🔧 If Something Doesn't Work

### Terrain Issues:
- Refresh the page (Ctrl+F5)
- Check console for errors
- Verify textures loading from `/assetKits/`

### Player Falls Through:
- This should be fixed, but if it happens:
- Check console for "stickToIsland" errors
- Verify player starting position

### Props Don't Load:
- Check browser console for 404 errors
- Verify `/assets/models/` folder exists
- GLTF files may not be present yet (placeholders will show)

### Performance Issues:
- Lower graphics settings in game UI
- Check FPS in browser dev tools
- Consider reducing terrain detail

---

## ✨ Expected Behavior

### Good Signs:
- ✅ Island renders as complete sphere
- ✅ Player visible and moves smoothly
- ✅ No console errors (or only asset 404s)
- ✅ Jumping works naturally
- ✅ Camera follows player

### It's Normal If:
- Some props are still placeholder geometry (models loading async)
- Initial load takes a few seconds
- Some textures appear after first render

---

## 🎯 Success Criteria

The fixes are working if:
1. **No falling through terrain** ✓
2. **Player stays on surface** ✓
3. **Movement feels natural** ✓
4. **Dev server runs clean** ✓
5. **No blocking errors** ✓

---

## 📝 Report Issues

If you find problems:
1. Note the exact steps to reproduce
2. Check browser console for errors
3. Screenshot any visual glitches
4. Note your browser and OS version

---

**Ready to test!** Open http://localhost:5173/ and enjoy the island! 🏝️
