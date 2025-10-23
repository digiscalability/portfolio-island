# 🚀 DigiScalability Portfolio Island - Codespace Setup

This repository is optimized for GitHub Codespaces with powerful hardware specifications to handle multiple concurrent projects.

## 🔧 Hardware Specifications

- **CPU**: 4 cores (Premium Linux)
- **RAM**: 8GB
- **Storage**: 64GB SSD
- **GPU**: Enabled for WebGL/3D acceleration

## 🚀 Quick Start in Codespace

1. **Create Codespace**: Click "Code" → "Codespaces" → "Create codespace on master"
2. **Automatic Setup**: The environment will auto-configure with all dependencies
3. **Start Development**: Run `npm run dev` to start the development server

## 📁 Multi-Project Workflow

### Adding Additional Projects

1. Clone your other projects to `/workspaces/`:

```bash
cd /workspaces
git clone https://github.com/yourusername/project2.git
git clone https://github.com/yourusername/project3.git
```

2. Start multiple projects concurrently:

```bash
# Terminal 1 - Portfolio Island (Port 3000)
npm run dev

# Terminal 2 - Project 2 (Port 3001)
cd /workspaces/project2
npm run dev -- --port 3001

# Terminal 3 - Project 3 (Port 3002)
cd /workspaces/project3
npm run dev -- --port 3002
```

### Using the Multi-Project Runner

```bash
# Run the automated multi-project script
npm run multi-dev
```

## 🛠️ Available Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server (port 3000) |
| `npm run build` | Build for production |
| `npm run preview` | Preview production build |
| `npm run setup-dev` | Run development environment setup |
| `npm run multi-dev` | Start multi-project development mode |
| `npm run performance` | Monitor system performance |

## 📊 Performance Monitoring

Monitor your codespace performance:

```bash
npm run performance
```

This shows:

- CPU usage
- Memory consumption
- Disk space
- Active Node processes

## 🔌 Port Configuration

Your codespace automatically forwards these ports:

- **3000**: Main Portfolio Island development server
- **3001-3002**: Additional projects
- **4000**: Firebase emulator
- **5173**: Vite alternative port
- **8080**: General purpose
- **9005**: Debugging

## 💡 Optimization Tips

### Memory Management

- The environment excludes large asset files from search/watch
- Git LFS handles large 3D assets efficiently
- TypeScript is configured for optimal performance

### Multi-Project Best Practices

1. Use separate terminals for each project
2. Monitor memory usage when running multiple projects
3. Use the PORTS tab to quickly access different applications
4. Close unused projects to free up resources

### File Management

- Large assets (*.fbx,*.bin, *.gltf) are tracked with Git LFS
- Search excludes asset directories for faster performance
- Workspace folders are optimized for large projects

## 🔄 Workspace Configuration

The codespace includes a VS Code workspace file (`portfolio-workspace.code-workspace`) that:

- Organizes multiple projects in folders
- Provides optimized settings for TypeScript/3D development
- Includes recommended extensions
- Configures file associations for shaders

## 🚨 Troubleshooting

### High Memory Usage

```bash
# Check memory usage
free -h

# Kill all Node processes if needed
pkill -f node

# Restart development servers
npm run dev
```

### Port Conflicts

If ports are busy:

```bash
# Kill process on specific port
npx kill-port 3000

# Or use alternative port
npm run dev -- --port 3005
```

### Performance Issues

```bash
# Monitor system resources
htop

# Check running processes
ps aux | grep node

# Clean up and restart
npm run setup-dev
```

## 🎯 VS Code Extensions Included

- **TypeScript/JavaScript**: Enhanced IntelliSense and debugging
- **3D Development**: Shader syntax highlighting, WebGL support
- **Git/GitHub**: Pull requests, Copilot integration
- **Productivity**: Project management, bookmarks, TODO tracking
- **Performance**: Path IntelliSense, code completion

## 🔗 Quick Links

- [GitHub Codespaces Docs](https://docs.github.com/en/codespaces)
- [Vite Documentation](https://vitejs.dev/)
- [Three.js Documentation](https://threejs.org/docs/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)

---

**💻 Enjoy your powerful cloud development environment!**

Your codespace is configured for optimal performance with multiple concurrent projects. The premium hardware ensures smooth development experience even with resource-intensive 3D applications.
