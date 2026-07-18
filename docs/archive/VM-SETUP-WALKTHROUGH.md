# 🚀 Step-by-Step GCP VM Setup Guide

Follow these commands to set up your development VM and clone all 4 projects.

## Step 1: Create Google Cloud VM

### Prerequisites

Make sure you have Google Cloud CLI installed:

```powershell
# On Windows (run in PowerShell as Administrator)
winget install Google.CloudSDK

# Login to your Google Cloud account
gcloud auth login

# Set your project (replace with your project ID)
gcloud config set project YOUR_PROJECT_ID
```

### Create the VM Instance

```bash
# Create the VM with optimal specs for development
gcloud compute instances create digiscale-dev-vm \
    --zone=us-central1-a \
    --machine-type=e2-standard-4 \
    --boot-disk-size=100GB \
    --boot-disk-type=pd-ssd \
    --image-family=ubuntu-2204-lts \
    --image-project=ubuntu-os-cloud \
    --tags=http-server,https-server \
    --scopes=https://www.googleapis.com/auth/cloud-platform
```

### Setup Firewall Rules

```bash
# Allow VS Code Server (port 8080)
gcloud compute firewall-rules create allow-code-server \
    --allow tcp:8080 \
    --source-ranges 0.0.0.0/0 \
    --description "Allow Code Server" \
    --target-tags=http-server

# Allow development ports (3000-3010)
gcloud compute firewall-rules create allow-dev-ports \
    --allow tcp:3000-3010 \
    --source-ranges 0.0.0.0/0 \
    --description "Development servers" \
    --target-tags=http-server
```

### Get VM Information

```bash
# Get your VM's external IP
gcloud compute instances describe digiscale-dev-vm \
    --zone=us-central1-a \
    --format='get(networkInterfaces[0].accessConfigs[0].natIP)'
```

## Step 2: Connect to VM and Run Setup

### SSH into the VM

```bash
# Connect via gcloud SSH
gcloud compute ssh digiscale-dev-vm --zone=us-central1-a

# Alternative: Use browser SSH
# Go to: https://console.cloud.google.com/compute/instances
# Click SSH button next to your VM
```

### Download and Run Setup Script

```bash
# Once connected to your VM, run these commands:

# Download the setup script
curl -O https://raw.githubusercontent.com/digiscalability/portfolio-island/master/gcp-vm-setup.sh

# Make it executable
chmod +x gcp-vm-setup.sh

# Run the setup (this takes 5-10 minutes)
./gcp-vm-setup.sh
```

## Step 3: Clone Your 4 Projects

After the setup script completes, clone your additional projects:

```bash
# Navigate to workspace
cd ~/workspace

# Clone your other 3 projects (replace with your actual repo URLs)
echo "📂 Cloning additional projects..."

# Project 2 - Replace with your actual repo
git clone https://github.com/digiscalability/PROJECT_2_NAME.git project2

# Project 3 - Replace with your actual repo
git clone https://github.com/digiscalability/PROJECT_3_NAME.git project3

# Project 4 - Replace with your actual repo
git clone https://github.com/digiscalability/PROJECT_4_NAME.git project4

# Install dependencies for each project
echo "📦 Installing dependencies..."

# Project 2
cd ~/workspace/project2
npm install
cd ..

# Project 3
cd ~/workspace/project3
npm install
cd ..

# Project 4
cd ~/workspace/project4
npm install
cd ..

echo "✅ All projects cloned and dependencies installed!"
```

## Step 4: Update Multi-Project Runner

Update the start script to include your actual projects:

```bash
# Edit the startup script
nano ~/workspace/start-all-projects.sh
```

Replace the commented lines with your actual project names:

```bash
# Start projects
start_project "$HOME/workspace/portfolio-island" "Portfolio-Island" 3000
start_project "$HOME/workspace/project2" "Project-2" 3001
start_project "$HOME/workspace/project3" "Project-3" 3002
start_project "$HOME/workspace/project4" "Project-4" 3003
```

## Step 5: Test Your Setup

### Start All Projects

```bash
# Start all projects
~/workspace/start-all-projects.sh
```

### Access Your Development Environment

```bash
# Get your VM IP and password
cat ~/workspace/.vm-info

# Your endpoints will be:
# VS Code Server: http://YOUR_VM_IP:8080
# Portfolio Island: http://YOUR_VM_IP:3000
# Project 2: http://YOUR_VM_IP:3001
# Project 3: http://YOUR_VM_IP:3002
# Project 4: http://YOUR_VM_IP:3003
```

## Step 6: Optimize for Your Workflow

### Set up VS Code Extensions (run in VS Code terminal on VM)

```bash
# Install essential extensions
code-server --install-extension ms-vscode.vscode-typescript-next
code-server --install-extension esbenp.prettier-vscode
code-server --install-extension ms-vscode.vscode-eslint
code-server --install-extension slevesque.shader
code-server --install-extension github.copilot
```

### Create Project Shortcuts

```bash
# Create easy access scripts
cat > ~/workspace/goto-portfolio.sh << 'EOF'
#!/bin/bash
cd ~/workspace/portfolio-island
echo "📂 Now in Portfolio Island project"
echo "🚀 Start dev server: npm run dev -- --host 0.0.0.0 --port 3000"
bash
EOF

cat > ~/workspace/goto-project2.sh << 'EOF'
#!/bin/bash
cd ~/workspace/project2
echo "📂 Now in Project 2"
echo "🚀 Start dev server: npm run dev -- --host 0.0.0.0 --port 3001"
bash
EOF

# Make them executable
chmod +x ~/workspace/goto-*.sh
```

## Useful Commands for Daily Use

### VM Management

```bash
# Stop VM (save money when not working)
gcloud compute instances stop digiscale-dev-vm --zone=us-central1-a

# Start VM
gcloud compute instances start digiscale-dev-vm --zone=us-central1-a

# SSH into running VM
gcloud compute ssh digiscale-dev-vm --zone=us-central1-a
```

### Project Management on VM

```bash
# Start all projects
~/workspace/start-all-projects.sh

# Monitor performance
~/workspace/monitor.sh

# Check logs
tail -f ~/logs/*.log

# Kill all Node processes (if needed)
pkill -f node
```

### Access Your Work

- **VS Code**: `http://YOUR_VM_IP:8080` (password in `~/workspace/.vm-info`)
- **Portfolio Island**: `http://YOUR_VM_IP:3000`
- **Project 2**: `http://YOUR_VM_IP:3001`
- **Project 3**: `http://YOUR_VM_IP:3002`
- **Project 4**: `http://YOUR_VM_IP:3003`

## Troubleshooting

### If VS Code Server isn't accessible

```bash
# Restart code-server
sudo systemctl restart code-server@$USER

# Check status
sudo systemctl status code-server@$USER
```

### If projects won't start

```bash
# Check if ports are free
netstat -tuln | grep :3000

# Install dependencies again
cd ~/workspace/PROJECT_NAME && npm install
```

### Check VM external IP

```bash
curl ifconfig.me
```

---

## 💡 Pro Tips

1. **Bookmark your VM URLs** in your browser for quick access
2. **Use browser tabs** for each project's dev server
3. **Keep VS Code open** in a dedicated browser window
4. **Monitor costs** in Google Cloud Console
5. **Stop the VM** when not working to save money (~$1.20/day when stopped vs ~$2.40/day when running)

Your VM is now ready for powerful, multi-project development with zero local files! 🚀
