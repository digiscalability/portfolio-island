#!/bin/bash

# DigiScalability Development VM Setup
# Run this script on your new Google Cloud VM

echo "🚀 Setting up DigiScalability Development Environment on Google Cloud VM..."

# Update system
echo "📦 Updating system packages..."
sudo apt-get update && sudo apt-get upgrade -y

# Install Node.js 18
echo "📦 Installing Node.js 18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install essential development tools
echo "🔧 Installing development tools..."
sudo apt-get install -y \
    git \
    build-essential \
    curl \
    wget \
    htop \
    tree \
    unzip \
    software-properties-common

# Install VS Code Server
echo "💻 Installing VS Code Server..."
curl -fsSL https://code-server.dev/install.sh | sh

# Configure VS Code Server
echo "⚙️ Configuring VS Code Server..."
mkdir -p ~/.config/code-server

# Generate random password
VSCODE_PASSWORD=$(openssl rand -base64 20)

cat > ~/.config/code-server/config.yaml << EOF
bind-addr: 0.0.0.0:8080
auth: password
password: ${VSCODE_PASSWORD}
cert: false
EOF

# Install global npm packages
echo "📚 Installing global npm packages..."
sudo npm install -g \
    @vite/cli \
    firebase-tools \
    typescript \
    ts-node \
    nodemon \
    concurrently \
    create-vite

# Setup workspace
echo "📁 Setting up workspace..."
mkdir -p ~/workspace
cd ~/workspace

# Clone your portfolio project
echo "📂 Cloning portfolio island project..."
git clone https://github.com/digiscalability/portfolio-island.git

# Install project dependencies
echo "📦 Installing project dependencies..."
cd portfolio-island
npm install

# Create multi-project runner script
echo "🔧 Creating multi-project runner..."
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
        npm run dev -- --host 0.0.0.0 --port $port > ~/logs/${project_name}.log 2>&1 &
        echo "✅ $project_name started (PID: $!)"
    else
        echo "⚠️ Project not found: $project_path"
    fi
}

# Create logs directory
mkdir -p ~/logs

# Start projects
start_project "~/workspace/portfolio-island" "Portfolio-Island" 3000
# Add your other projects here:
# start_project "~/workspace/project2" "Project-2" 3001
# start_project "~/workspace/project3" "Project-3" 3002
# start_project "~/workspace/project4" "Project-4" 3003

echo ""
echo "🌐 Access your projects:"
echo "  Portfolio Island: http://$(curl -s ifconfig.me):3000"
echo "  Project 2:        http://$(curl -s ifconfig.me):3001"
echo "  Project 3:        http://$(curl -s ifconfig.me):3002"
echo "  Project 4:        http://$(curl -s ifconfig.me):3003"
echo ""
echo "📝 VS Code Server: http://$(curl -s ifconfig.me):8080"
echo "🔑 Password: ${VSCODE_PASSWORD}"
echo ""
echo "📊 Monitor with: htop"
echo "🔍 View logs: tail -f ~/logs/*.log"
EOF

chmod +x ~/workspace/start-all-projects.sh

# Create performance monitor script
echo "📊 Creating performance monitor..."
cat > ~/workspace/monitor.sh << 'EOF'
#!/bin/bash
echo "=== DigiScalability VM Performance Monitor ==="
echo "Date: $(date)"
echo ""
echo "🖥️ CPU Usage:"
top -bn1 | grep "Cpu(s)" | awk '{print $2}' | sed 's/%us,//'
echo ""
echo "💾 Memory Usage:"
free -h
echo ""
echo "💿 Disk Usage:"
df -h / | tail -1
echo ""
echo "🌐 External IP:"
curl -s ifconfig.me
echo ""
echo ""
echo "🔄 Active Node Processes:"
ps aux | grep node | grep -v grep | awk '{print $2, $11, $12, $13, $14}'
echo ""
echo "📊 Network Connections:"
netstat -tuln | grep ":3[0-9][0-9][0-9]"
EOF

chmod +x ~/workspace/monitor.sh

# Start and enable VS Code Server
echo "🚀 Starting VS Code Server..."
sudo systemctl enable --now code-server@$USER

# Setup Git (if needed)
echo "⚙️ Setting up Git..."
git config --global user.name "DigiScalability"
git config --global user.email "portfolio@digiscalability.com"

# Create startup script for auto-start projects
echo "🔄 Creating startup script..."
cat > ~/workspace/startup.sh << EOF
#!/bin/bash
# Wait for system to be ready
sleep 30

# Start all projects
cd ~/workspace
./start-all-projects.sh

# Log startup
echo "$(date): VM started and projects launched" >> ~/logs/startup.log
EOF

chmod +x ~/workspace/startup.sh

# Add to crontab for auto-start on reboot
(crontab -l 2>/dev/null; echo "@reboot ~/workspace/startup.sh") | crontab -

# Display final information
VM_IP=$(curl -s ifconfig.me)
echo ""
echo "🎉 Setup Complete!"
echo ""
echo "📋 Connection Information:"
echo "  VM External IP: $VM_IP"
echo "  VS Code Server: http://$VM_IP:8080"
echo "  Password: $VSCODE_PASSWORD"
echo ""
echo "🚀 Quick Commands:"
echo "  Start all projects: ~/workspace/start-all-projects.sh"
echo "  Monitor performance: ~/workspace/monitor.sh"
echo "  View logs: tail -f ~/logs/*.log"
echo ""
echo "🔧 Next Steps:"
echo "  1. Clone your other 3 projects to ~/workspace/"
echo "  2. Update start-all-projects.sh with your project paths"
echo "  3. Access VS Code at http://$VM_IP:8080"
echo ""
echo "💰 Cost Saving:"
echo "  Stop VM: gcloud compute instances stop INSTANCE_NAME --zone=ZONE"
echo "  Start VM: gcloud compute instances start INSTANCE_NAME --zone=ZONE"
echo ""

# Save credentials for easy access
echo "VM_IP=$VM_IP" > ~/workspace/.vm-info
echo "VSCODE_PASSWORD=$VSCODE_PASSWORD" >> ~/workspace/.vm-info
echo "SETUP_DATE=$(date)" >> ~/workspace/.vm-info

echo "ℹ️ VM info saved to ~/workspace/.vm-info"
