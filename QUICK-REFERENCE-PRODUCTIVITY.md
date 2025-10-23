# Quick Reference - Development Workflows

## 🎯 Common Commands

```bash
# Development
npm run dev              # Start dev server (http://localhost:5173)
npm run preview          # Preview production build

# Quality Checks
npm run lint             # Run ESLint
npm run typecheck        # Run TypeScript compiler
npm run format           # Format code with Prettier

# Build
npm run build            # Production build
```

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+B` | Run default build task |
| `Ctrl+Shift+T` | Run tests (lint + typecheck) |
| `F5` | Start debugging |
| `Ctrl+Shift+P` → "Tasks: Run Task" | Show all tasks |

## 🔍 VS Code Tasks

1. **npm: dev** - Start development server (background)
2. **npm: build** - Build for production
3. **npm: preview** - Preview production build
4. **npm: lint** - Lint TypeScript files
5. **npm: typecheck** - Type check without emit
6. **npm: format** - Format all files
7. **test:all** - Run lint + typecheck together ⭐

## 🐛 Debug Configurations

| Configuration | Use Case |
|---------------|----------|
| **Launch Vite in Chrome** | Debug web app in browser |
| **Debug TypeScript (Node)** | Debug Node.js scripts |
| **Run npm script** | Debug any npm script interactively |

## 📁 Path Aliases

Use clean imports with path aliases:

```typescript
// Old way
import { Engine } from '../../../Engine';
import { MathUtils } from '../../../src/utils/MathUtils';

// New way
import { Engine } from '@core/Engine';
import { MathUtils } from '@utils/MathUtils';
```

**Available aliases:**

- `@/*` → Root directory
- `@core/*` → Root directory (core modules)
- `@utils/*` → `src/utils/`
- `@assets/*` → `assets/`
- `@assetKits/*` → `assetKits/`

## 🔧 Environment Setup

```bash
# Use correct Node version
nvm use        # Reads from .nvmrc
# or
fnm use        # Reads from .nvmrc

# Install dependencies
npm install    # Uses package-lock.json for deterministic install

# Check everything works
npm run typecheck && npm run build
```

## 📝 VS Code Extensions

Recommended extensions (auto-suggested):

- ✅ Prettier - Code formatter
- ✅ ESLint - Linting
- ✅ TypeScript Next - Latest TS features
- ✅ Shader - GLSL syntax
- ✅ WebGL GLSL Editor - WebGL shader support
- ✅ GitHub Copilot - AI pair programming
- ✅ Better Comments - Enhanced comments
- ✅ Todo Tree - Track TODOs
- ✅ Project Manager - Multi-project workflow

## 🚀 Performance Tips

1. **File Watching** - Large asset folders are excluded from watchers
2. **NPM Cache** - Configured at `/home/node/.npm-cache`
3. **Build Cache** - `node_modules` caching in devcontainer
4. **GPU Support** - Optional, requires host nvidia-docker2

## ⚠️ Known Issues

- **TypeCheck warnings**: 19 pre-existing unused variable warnings (non-blocking)
- **Large bundle**: Main bundle is 512KB (consider code-splitting)
- **GPU access**: Commented out by default (enable if needed)

## 🎨 Code Style

Enforced by Prettier (`.prettierrc.cjs`):

- Single quotes
- Semicolons
- 2 spaces indentation
- 100 char line width
- Trailing commas (ES5)
- LF line endings

## 📚 Documentation

- **Full Setup Guide**: See `PRODUCTIVITY-SETUP.md`
- **Project README**: See `README.md` (if exists)
- **Environment Docs**: See `ENVIRONMENT-*.md` files

---

💡 **Tip**: Run `npm run typecheck && npm run build` before committing to ensure code quality!
