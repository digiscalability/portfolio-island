#!/bin/bash

# DigiScalability Portfolio Island - Development Setup Script
# Optimized for GitHub Codespaces multi-project workflow

echo "🚀 Setting up DigiScalability Portfolio Island development environment..."

# Update system packages
echo "📦 Updating system packages..."
sudo apt-get update

# Install additional development tools
echo "🔧 Installing development tools..."
sudo apt-get install -y \
    htop \
    tree \
    curl \
    wget \
    git-lfs \
    build-essential

# Setup Git LFS for large assets
echo "📁 Configuring Git LFS for large assets..."
git lfs install
git lfs track "*.fbx"
git lfs track "*.bin"
git lfs track "*.gltf"
git lfs track "*.png"
git lfs track "*.jpg"

# Install global npm packages for development
echo "📚 Installing global development tools..."
npm install -g \
    @vite/cli \
    firebase-tools \
    typescript \
    ts-node \
    nodemon \
    concurrently

# Setup workspace for multiple projects
echo "🏗️ Setting up multi-project workspace..."
mkdir -p /workspaces/active-projects

# Create development scripts
echo "📝 Creating development scripts..."

# Performance monitoring script
cat > monitor-performance.sh << 'EOF'
#!/bin/bash
echo "=== Codespace Performance Monitor ==="
echo "CPU Usage:"
top -bn1 | grep "Cpu(s)" | sed "s/.*, *\([0-9.]*\)%* id.*/\1/" | awk '{print 100 - $1"%"}'
echo ""
echo "Memory Usage:"
free -h
echo ""
echo "Disk Usage:"
df -h /
echo ""
echo "Active Node Processes:"
ps aux | grep node | grep -v grep
EOF

chmod +x monitor-performance.sh

# Multi-project runner script
cat > run-multiple-projects.sh << 'EOF'
#!/bin/bash
echo "🚀 Starting multi-project development environment..."

# Function to run project in background
run_project() {
    local project_path=$1
    local project_name=$2
    local port=$3

    echo "Starting $project_name on port $port..."
    cd "$project_path"
    npm run dev -- --port $port --host 0.0.0.0 &
    echo "$project_name PID: $!"
}

# Start portfolio island (current project)
run_project "/workspaces/portfolio-island" "Portfolio Island" 3000

# Wait for additional project paths to be mounted
# run_project "/workspaces/project2" "Project 2" 3001

echo "✅ All projects started! Check the PORTS tab to access them."
echo "Use 'pkill -f node' to stop all projects."
EOF

chmod +x run-multiple-projects.sh

# Optimize npm for performance
echo "⚡ Optimizing npm configuration..."
npm config set progress=false
npm config set audit=false
npm config set fund=false

# Setup project dependencies
echo "📦 Installing project dependencies..."
if [ -f "package.json" ]; then
    npm install
    echo "✅ Dependencies installed successfully!"
else
    echo "⚠️ No package.json found in current directory"
fi

# Create VS Code workspace for multi-project setup
echo "🎯 Creating multi-project VS Code workspace..."
cat > portfolio-workspace.code-workspace << 'EOF'
{
    "folders": [
        {
            "name": "Portfolio Island (Main)",
            "path": "."
        }
    ],
    "settings": {
        "typescript.preferences.maxInlayHintLength": 30,
        "search.exclude": {
            "**/node_modules": true,
            "**/assets/**/*.fbx": true,
            "**/assets/**/*.bin": true
        },
        "files.associations": {
            "*.frag": "glsl",
            "*.vert": "glsl"
        }
    },
    "extensions": {
        "recommendations": [
            "ms-vscode.vscode-typescript-next",
            "esbenp.prettier-vscode",
            "slevesque.shader",
            "github.copilot"
        ]
    }
}
EOF

echo ""
echo "🎉 Setup complete! Your optimized development environment is ready."
echo ""
echo "📋 Quick Commands:"
echo "  • npm run dev          - Start development server"
echo "  • ./monitor-performance.sh - Check system performance"
echo "  • ./run-multiple-projects.sh - Start multiple projects"
echo ""
echo "💡 Tips:"
echo "  • Use the PORTS tab to access running applications"
echo "  • Your codespace has 4 CPUs and 8GB RAM"
echo "  • Large assets are tracked with Git LFS"
echo ""
echo "🔗 Access your project:"
echo "  • Main server will be available on port 3000"
echo "  • Additional projects can run on ports 3001, 3002, etc."
echo ""
