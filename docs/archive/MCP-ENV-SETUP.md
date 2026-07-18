# MCP Environment Setup Guide

## ✅ Configuration Updated

The MCP Notion server has been configured to use environment variables instead of prompts.

## Setup Instructions

### 1. Set Your Notion Token

You have two options:

#### Option A: Add to .env.local file (Recommended)

```bash
# Edit .env.local and replace the empty NOTION_TOKEN value:
NOTION_TOKEN=ntn_your_actual_token_here
```

#### Option B: Export in terminal

```bash
# Set for current session
export NOTION_TOKEN=ntn_your_actual_token_here

# Add to shell profile for persistence (optional)
echo 'export NOTION_TOKEN=ntn_your_actual_token_here' >> ~/.bashrc
```

### 2. Get Your Notion Token

1. Go to <https://www.notion.so/profile/integrations>
2. Click "New integration"
3. Choose "Internal integration"
4. Give it a name (e.g., "Portfolio Island MCP")
5. Copy the "Internal Integration Token" (starts with `ntn_`)

### 3. Grant Access to Pages/Databases

After creating the integration:

1. Go to your Notion pages/databases
2. Click the "..." menu → "Connect to" → Select your integration
3. Or use the integration's "Access" tab to grant permissions

### 4. Restart VS Code

After setting the environment variable:

```bash
# Reload environment and restart VS Code
source ~/.bashrc  # if you used Option B
code /workspaces/portfolio-island
```

## Updated Configuration

The `mcp.json` now uses:

- `"NOTION_TOKEN": "${env:NOTION_TOKEN}"` (environment variable)
- No more input prompts
- Automatic startup when token is available

## Test Connection

After setup, you can test:

```bash
# Check if token is set
echo $NOTION_TOKEN

# Test MCP server manually
npx -y @notionhq/notion-mcp-server --help
```

## Troubleshooting

If the server still doesn't start:

1. Check token is set: `echo $NOTION_TOKEN`
2. Restart VS Code completely
3. Check Command Palette: `Ctrl+Shift+P` → "MCP: Restart Servers"

The MCP server should now start automatically when VS Code loads!
