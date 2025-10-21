#!/bin/bash

# Clone All DigiScalability Projects Script
# Customize this script with your actual project repositories

echo "🚀 Cloning all DigiScalability projects to VM..."

# Navigate to workspace
cd ~/workspace

# Portfolio Island is already cloned by setup script
echo "✅ Portfolio Island already cloned"

# Project 2 - UPDATE WITH YOUR ACTUAL REPO
echo "📂 Cloning Project 2..."
# Replace the URL below with your actual project 2 repository
# git clone https://github.com/digiscalability/YOUR_PROJECT_2.git project2

# Example formats:
# git clone https://github.com/digiscalability/messenger-app.git project2
# git clone https://github.com/digiscalability/portfolio-site.git project2
# git clone https://github.com/digiscalability/game-engine.git project2

echo "⚠️  Please update this script with your actual Project 2 repo URL"
echo "    Edit line above and uncomment the git clone command"

# Project 3 - UPDATE WITH YOUR ACTUAL REPO
echo "📂 Cloning Project 3..."
# Replace the URL below with your actual project 3 repository
# git clone https://github.com/digiscalability/YOUR_PROJECT_3.git project3

echo "⚠️  Please update this script with your actual Project 3 repo URL"
echo "    Edit line above and uncomment the git clone command"

# Project 4 - UPDATE WITH YOUR ACTUAL REPO
echo "📂 Cloning Project 4..."
# Replace the URL below with your actual project 4 repository
# git clone https://github.com/digiscalability/YOUR_PROJECT_4.git project4

echo "⚠️  Please update this script with your actual Project 4 repo URL"
echo "    Edit line above and uncomment the git clone command"

# Install dependencies for all projects
echo "📦 Installing dependencies for all projects..."

# Portfolio Island
if [ -d "portfolio-island" ]; then
    echo "📦 Installing Portfolio Island dependencies..."
    cd portfolio-island
    npm install
    cd ..
fi

# Project 2
if [ -d "project2" ]; then
    echo "📦 Installing Project 2 dependencies..."
    cd project2
    npm install
    cd ..
fi

# Project 3
if [ -d "project3" ]; then
    echo "📦 Installing Project 3 dependencies..."
    cd project3
    npm install
    cd ..
fi

# Project 4
if [ -d "project4" ]; then
    echo "📦 Installing Project 4 dependencies..."
    cd project4
    npm install
    cd ..
fi

# Update the multi-project runner with actual project paths
echo "🔧 Updating multi-project runner..."
cat > ~/workspace/start-all-projects.sh << 'EOF'
#!/bin/bash
echo "🚀 Starting all DigiScalability projects..."

# Function to start project
start_project() {
    local project_path=$1
    local project_name=$2
    local port=$3

    if [ -d "$project_path" ]; then
        echo "Starting $project_name on port $port..."
        cd "$project_path"
        if [ -f "package.json" ]; then
            # Try different common dev commands
            if npm run | grep -q "dev"; then
                npm run dev -- --host 0.0.0.0 --port $port > ~/logs/${project_name}.log 2>&1 &
            elif npm run | grep -q "start"; then
                npm run start -- --host 0.0.0.0 --port $port > ~/logs/${project_name}.log 2>&1 &
            elif npm run | grep -q "serve"; then
                npm run serve -- --host 0.0.0.0 --port $port > ~/logs/${project_name}.log 2>&1 &
            else
                echo "⚠️ No dev/start/serve script found in $project_name"
                return
            fi
            echo "✅ $project_name started (PID: $!)"
        else
            echo "⚠️ No package.json found in $project_path"
        fi
    else
        echo "⚠️ Project not found: $project_path"
    fi
}

# Create logs directory
mkdir -p ~/logs

# Start projects (update these paths with your actual project names)
start_project "$HOME/workspace/portfolio-island" "Portfolio-Island" 3000

# Uncomment and update these lines with your actual project folder names:
# start_project "$HOME/workspace/project2" "Project-2" 3001
# start_project "$HOME/workspace/project3" "Project-3" 3002
# start_project "$HOME/workspace/project4" "Project-4" 3003

echo ""
echo "🌐 Access your projects:"
VM_IP=$(curl -s ifconfig.me 2>/dev/null || echo "YOUR_VM_IP")
echo "  Portfolio Island: http://$VM_IP:3000"
echo "  Project 2:        http://$VM_IP:3001"
echo "  Project 3:        http://$VM_IP:3002"
echo "  Project 4:        http://$VM_IP:3003"
echo ""
echo "📝 VS Code Server: http://$VM_IP:8080"
echo "🔑 Password: $(cat ~/.config/code-server/config.yaml | grep password | cut -d' ' -f2)"
echo ""
echo "📊 Monitor with: ~/workspace/monitor.sh"
echo "🔍 View logs: tail -f ~/logs/*.log"
echo "🛑 Stop all: pkill -f node"
EOF

chmod +x ~/workspace/start-all-projects.sh

echo ""
echo "📋 Next Steps:"
echo "1. Update this script with your actual project repository URLs"
echo "2. Run the script again to clone your projects: ./clone-all-projects.sh"
echo "3. Update ~/workspace/start-all-projects.sh with actual project folder names"
echo "4. Start all projects: ~/workspace/start-all-projects.sh"
echo ""
echo "💡 To find your repositories:"
echo "   • Check your GitHub profile: https://github.com/digiscalability"
echo "   • Or list your local projects to get the names"
echo ""

# Show current directory structure
echo "📁 Current workspace structure:"
ls -la ~/workspace/
