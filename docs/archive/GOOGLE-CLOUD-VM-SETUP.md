# Google Cloud VM Setup for DigiScalability Development

# Zero local files, maximum performance, minimum cost

## 🔧 VM Specifications (Recommended)

- **Machine Type**: e2-standard-4 (4 vCPU, 16GB RAM)
- **Boot Disk**: Ubuntu 22.04 LTS, 100GB SSD
- **Zone**: us-central1-a (or closest to you)
- **Cost**: ~$50-70/month for 24/7 operation

## 🚀 Quick Setup Commands

### 1. Create VM Instance

```bash
gcloud compute instances create dev-workstation \
    --zone=us-central1-a \
    --machine-type=e2-standard-4 \
    --boot-disk-size=100GB \
    --boot-disk-type=pd-ssd \
    --image-family=ubuntu-2204-lts \
    --image-project=ubuntu-os-cloud \
    --tags=http-server,https-server \
    --metadata=startup-script='#!/bin/bash
    apt-get update
    apt-get install -y curl git nodejs npm
    curl -fsSL https://code-server.dev/install.sh | sh
    systemctl enable --now code-server@$USER'
```

### 2. Setup Firewall Rules

```bash
# Allow VS Code Server (port 8080)
gcloud compute firewall-rules create allow-code-server \
    --allow tcp:8080 \
    --source-ranges 0.0.0.0/0 \
    --description "Allow Code Server"

# Allow development ports
gcloud compute firewall-rules create allow-dev-ports \
    --allow tcp:3000-3010 \
    --source-ranges 0.0.0.0/0 \
    --description "Development servers"
```

### 3. Connect to VM

```bash
# SSH into your VM
gcloud compute ssh dev-workstation --zone=us-central1-a

# Or use browser SSH (zero local setup)
# Go to: console.cloud.google.com → Compute Engine → VM instances → SSH
```

## 💻 Development Environment Setup

### Auto-Setup Script for VM

```bash
#!/bin/bash
# Run this once on your new VM

# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install development tools
sudo apt-get install -y git build-essential htop tree

# Install VS Code Server
curl -fsSL https://code-server.dev/install.sh | sh

# Configure code-server
mkdir -p ~/.config/code-server
cat > ~/.config/code-server/config.yaml << EOF
bind-addr: 0.0.0.0:8080
auth: password
password: your-secure-password-here
cert: false
EOF

# Install global npm tools
npm install -g @vite/cli firebase-tools typescript concurrently

# Setup workspace directory
mkdir -p ~/workspace
cd ~/workspace

# Clone your projects
git clone https://github.com/digiscalability/portfolio-island.git
# Add your other 3 projects here

# Start code-server
sudo systemctl enable --now code-server@$USER

echo "✅ Setup complete!"
echo "🌐 Access VS Code at: http://YOUR_VM_EXTERNAL_IP:8080"
echo "🔑 Password: your-secure-password-here"
```

## 🔐 Security Best Practices

```bash
# Restrict access to your IP only
gcloud compute firewall-rules update allow-code-server \
    --source-ranges YOUR_HOME_IP/32

# Use SSH tunnel (more secure)
gcloud compute ssh dev-workstation --zone=us-central1-a \
    --ssh-flag="-L 8080:localhost:8080"
# Then access: http://localhost:8080
```

## 📁 Project Management (Zero Local Files)

```bash
# All work happens on VM - no local files needed!

# Start multiple projects simultaneously
cd ~/workspace/portfolio-island && npm run dev -- --host 0.0.0.0 --port 3000 &
cd ~/workspace/project2 && npm run dev -- --host 0.0.0.0 --port 3001 &
cd ~/workspace/project3 && npm run dev -- --host 0.0.0.0 --port 3002 &

# Access via: http://YOUR_VM_IP:3000, :3001, :3002
```

## 💰 Cost Optimization

```bash
# Stop VM when not working (saves money)
gcloud compute instances stop dev-workstation --zone=us-central1-a

# Start when needed
gcloud compute instances start dev-workstation --zone=us-central1-a

# Auto-shutdown at night (optional)
# Add to VM startup script:
echo "0 2 * * * root shutdown -h now" >> /etc/crontab
```
