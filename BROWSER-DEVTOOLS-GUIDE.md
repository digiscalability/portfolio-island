# Browser DevTools Integration Guide

## 🌐 Recommended Extensions Installed

### 1. **Microsoft Edge DevTools for VS Code** (Primary)

**Extension ID:** `ms-edgedevtools.vscode-edge-devtools`

**Features:**

- ✅ Full DevTools suite (Console, Network, Elements, Performance, Memory)
- ✅ Inspect live DOM and styles
- ✅ Monitor network requests and responses
- ✅ Debug JavaScript with breakpoints
- ✅ Performance profiling and memory analysis
- ✅ Application storage inspection (localStorage, sessionStorage, cookies)
- ✅ Source maps support for debugging TypeScript

**Use Cases:**

- Debug console errors and warnings
- Inspect network API calls
- Analyze UI/UX elements and CSS
- Monitor performance bottlenecks
- Check memory leaks
- Debug Service Workers and PWA features

### 2. **Live Server** (Backup/Alternative)

**Extension ID:** `ms-vscode.live-server`

**Features:**

- Simple HTTP server for static files
- Auto-reload on file changes
- Lightweight preview option

---

## 🚀 How to Use

### Method 1: Edge DevTools (Recommended)

1. **Install Extension:**
   - Press `Ctrl+Shift+X` → Search "Edge DevTools"
   - Or let VS Code auto-suggest from recommendations

2. **Launch with DevTools:**
   - Press `F5` → Select "Launch Vite in Edge DevTools"
   - Or run: Command Palette → "Edge DevTools: Launch"

3. **Access DevTools Panels:**
   - **Console:** View logs, errors, warnings
   - **Network:** Monitor all HTTP requests, responses, timings
   - **Elements:** Inspect DOM, modify CSS live
   - **Sources:** Debug TypeScript with breakpoints
   - **Performance:** Record and analyze runtime performance
   - **Memory:** Find memory leaks and heap snapshots
   - **Application:** Check storage, service workers, cache

### Method 2: Attach to Running Server

If Vite is already running:

1. Start dev server: `npm run dev`
2. Press `F5` → Select "Attach to Edge DevTools"
3. DevTools panel opens automatically

---

## ⌨️ Keyboard Shortcuts

| Action           | Shortcut                                   |
| ---------------- | ------------------------------------------ |
| Open DevTools    | `F12` (in browser) or `F5` (launch config) |
| Console          | `Ctrl+Shift+J`                             |
| Inspect Element  | `Ctrl+Shift+C`                             |
| Network Panel    | `Ctrl+Shift+E`                             |
| Sources/Debugger | `Ctrl+Shift+O`                             |

---

## 🎯 Debug Configurations

### Available Launch Configs

1. **Launch Vite in Chrome** - Opens in external Chrome browser
2. **Launch Vite in Edge DevTools** ⭐ - Full DevTools in VS Code
3. **Attach to Edge DevTools** - Attach to running dev server
4. **Debug TypeScript (Node)** - Debug Node.js scripts
5. **Run npm script** - Debug any npm script

---

## 📊 Common Development Tasks

### Debugging Console Errors

```javascript
// Your code logs appear in DevTools Console panel
console.log('Debug info');
console.error('Error details');
console.warn('Warning message');
```

→ View in: **Console Panel**

### Monitoring Network Requests

```javascript
// All fetch/XHR requests appear automatically
fetch('/api/data')
  .then((res) => res.json())
  .then((data) => console.log(data));
```

→ View in: **Network Panel**

- See request/response headers
- Check payload and response data
- Monitor timing and performance
- Filter by type (XHR, JS, CSS, Images)

### Inspecting UI Elements

1. Click inspect icon in Elements panel
2. Hover over elements in preview
3. See computed styles, box model, event listeners
4. Edit CSS live to test changes

→ View in: **Elements Panel**

### Performance Profiling

1. Open **Performance Panel**
2. Click record button
3. Interact with your app
4. Stop recording
5. Analyze flame charts, FPS, memory usage

→ View in: **Performance Panel**

### Memory Leak Detection

1. Open **Memory Panel**
2. Take heap snapshot
3. Interact with app
4. Take another snapshot
5. Compare to find leaks

→ View in: **Memory Panel**

---

## 🔧 Configuration

### Settings Applied

```json
{
  "vscode-edge-devtools.mirrorEdits": true,
  "vscode-edge-devtools.defaultUrl": "http://localhost:5173",
  "vscode-edge-devtools.headless": false,
  "vscode-edge-devtools.sourceMapPathOverrides": {
    // TypeScript source maps configured
  }
}
```

### Launch Configuration

```json
{
  "name": "Launch Vite in Edge DevTools",
  "type": "msedge",
  "request": "launch",
  "url": "http://localhost:5173",
  "sourceMaps": true
}
```

---

## 💡 Pro Tips

### 1. Live DOM Editing

- Edit HTML/CSS directly in Elements panel
- Changes persist until page reload
- Perfect for rapid UI tweaking

### 2. Network Throttling

- Simulate slow 3G/4G connections
- Test app performance on slow networks
- Network Panel → Throttling dropdown

### 3. Device Emulation

- Test responsive designs
- Emulate mobile devices
- Device toolbar in DevTools

### 4. Preserve Logs

- Keep console logs across page reloads
- Enable "Preserve log" in Console panel
- Useful for debugging redirects

### 5. Break on DOM Changes

- Elements Panel → Right-click element
- "Break on" → Subtree modifications
- Catches unexpected DOM mutations

### 6. Network Request Filtering

```
// Filter syntax in Network panel
domain:localhost          # Only localhost requests
method:POST              # Only POST requests
status-code:404          # Only 404 errors
larger-than:1000        # Files > 1KB
```

### 7. JavaScript Debugging

- Set breakpoints in Sources panel
- Use `debugger;` statement in code
- Step through TypeScript source (not compiled JS)
- Inspect variables in scope

---

## 🚨 Common Issues & Solutions

### Issue: DevTools not connecting

**Solution:**

1. Ensure dev server is running (`npm run dev`)
2. Check port 5173 is accessible
3. Restart VS Code
4. Try "Attach" config instead of "Launch"

### Issue: Source maps not working

**Solution:**

- Vite automatically generates source maps in dev mode
- Check `vite.config.ts` has `sourcemap: true` for debug builds
- Verify TypeScript files appear in Sources panel

### Issue: Network panel empty

**Solution:**

1. Ensure recording is enabled (red dot)
2. Check "Preserve log" is enabled
3. Hard refresh page (`Ctrl+Shift+R`)

---

## 📈 Workflow Integration

### Typical Development Flow

1. **Start Dev Server**

   ```bash
   npm run dev
   ```

2. **Launch DevTools**
   - Press `F5` → "Launch Vite in Edge DevTools"

3. **Development Loop**
   - Edit code in VS Code
   - See changes via HMR
   - Check console for errors
   - Inspect elements/styles
   - Monitor network calls
   - Profile performance

4. **Debug Issues**
   - Set breakpoints in Sources
   - Use Console for REPL
   - Check Network for failed requests
   - Inspect Elements for CSS issues

5. **Optimize Performance**
   - Record performance profile
   - Check memory usage
   - Analyze network waterfall
   - Identify bottlenecks

---

## 🎓 Learning Resources

### Official Docs

- [Edge DevTools Extension](https://learn.microsoft.com/en-us/microsoft-edge/visual-studio-code/microsoft-edge-devtools-extension)
- [Chrome DevTools Guide](https://developer.chrome.com/docs/devtools/)
- [Debugging in VS Code](https://code.visualstudio.com/docs/editor/debugging)

### Quick References

- **Console API:** `console.log()`, `.error()`, `.table()`, `.time()`, `.trace()`
- **Network Panel:** Filter, search, copy as cURL, block requests
- **Elements Panel:** Edit as HTML, computed styles, event listeners
- **Performance:** FPS meter, screenshots, flame charts

---

## ✅ Summary

With **Microsoft Edge DevTools** extension, you now have:

✅ **Full browser DevTools** inside VS Code
✅ **Console access** for debugging logs
✅ **Network monitoring** for API calls
✅ **Elements inspector** for UI/UX
✅ **Performance profiling** for optimization
✅ **Memory analysis** for leak detection
✅ **Source maps** for TypeScript debugging
✅ **Integrated workflow** - no context switching

**Launch command:** Press `F5` → "Launch Vite in Edge DevTools" 🚀
