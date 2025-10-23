# 🚀 GCP VM Setup - Step by Step Execution

## Current Status: ✅ Authenticated as <digiscalability@gmail.com>

## Project: awesome-height-472504-p0

## ⚠️ Next Required Step: Enable Billing

### 1. Enable Billing (Required)

1. Go to: <https://console.developers.google.com/billing/enable?project=awesome-height-472504-p0>
2. Enable billing for your project
3. Wait 2-3 minutes for changes to propagate

### 2. Enable Compute Engine API

```bash
gcloud services enable compute.googleapis.com
```

### 3. Create VM Instance (run after billing is enabled)

```bash
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

### 4. Setup Firewall Rules

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

### 5. Get VM Information

```bash
# Get external IP
gcloud compute instances describe digiscale-dev-vm \
    --zone=us-central1-a \
    --format='get(networkInterfaces[0].accessConfigs[0].natIP)'

# SSH into VM
gcloud compute ssh digiscale-dev-vm --zone=us-central1-a
```

### 6. Setup Development Environment (run on VM)

```bash
# Download setup script
curl -O https://raw.githubusercontent.com/digiscalability/portfolio-island/master/gcp-vm-setup.sh

# Make executable and run
chmod +x gcp-vm-setup.sh
./gcp-vm-setup.sh
```

## Expected Costs

- **VM Running**: ~$2.40/day
- **VM Stopped**: ~$1.20/day (storage only)
- **Free Tier**: Google Cloud gives $300 credit for new accounts

## Next Steps After Billing

1. Enable billing at the URL above
2. Run the compute services enable command
3. Create the VM instance
4. Set up firewall rules
5. SSH into VM and run setup script

Your VM will be accessible at:

- VS Code: `http://VM_IP:8080`
- Portfolio Island: `http://VM_IP:3000`
- Additional projects: `http://VM_IP:3001-3003`
