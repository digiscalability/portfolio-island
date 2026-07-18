# MCP Notion Server Troubleshooting Guide

## Current Status

- ✅ **MCP Server Package**: `@notionhq/notion-mcp-server` is installed and functional
- ✅ **Configuration File**: `mcp.json` is properly configured
- ✅ **VS Code Settings**: MCP access and autostart enabled
- ❌ **VS Code Integration**: Server not starting automatically

## Issue Analysis

The Notion MCP server package is working correctly when tested manually, but VS Code is not automatically starting it through the MCP integration.

## Possible Causes & Solutions

### 1. VS Code Version Compatibility

**Current Version**: 1.105.1
**Issue**: MCP support in VS Code might be limited to newer versions or specific builds
**Solution**: Check if you have GitHub Copilot Chat extension with MCP support

### 2. Missing VS Code Extension

**Issue**: MCP support requires specific extensions
**Solutions**:

```bash
# Check installed extensions
code --list-extensions | grep -i copilot

# Install required extensions if missing
code --install-extension GitHub.copilot-chat
```

### 3. Configuration Location

**Issue**: VS Code might not be finding the `mcp.json` file
**Solutions**:

- Ensure `mcp.json` is in the workspace root
- Try absolute path in settings
- Restart VS Code completely

### 4. Manual MCP Server Start (Workaround)

If VS Code integration isn't working, you can start the server manually:

```bash
# HTTP Mode (recommended for debugging)
NOTION_TOKEN=your_actual_token npx -y @notionhq/notion-mcp-server --transport http --port 3000

# Then configure VS Code to use HTTP transport instead of stdio
```

### 5. Alternative: HTTP Transport Configuration

Update `mcp.json` to use HTTP instead of stdio:

```json
{
  "servers": {
    "notion": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "env": {
        "NOTION_TOKEN": "${input:notion-token}",
        "OPENAPI_MCP_HEADERS": "{\"Notion-Version\":\"2025-09-03\"}"
      }
    }
  }
}
```

## Recommended Next Steps

1. **Check GitHub Copilot Chat Extension**:
   - Open VS Code Command Palette (`Ctrl+Shift+P`)
   - Search for "MCP"
   - Look for MCP-related commands

2. **Verify Notion Token**:
   - Go to <https://www.notion.so/profile/integrations>
   - Create a new Internal Integration
   - Copy the token (starts with `ntn_`)
   - Grant access to your pages/databases

3. **Test Manual Connection**:

   ```bash
   # Start server manually
   NOTION_TOKEN=ntn_your_token npx -y @notionhq/notion-mcp-server --transport http --port 3000

   # Test in another terminal
   curl http://localhost:3000/health
   ```

4. **VS Code Restart**:
   - Completely close VS Code
   - Restart with: `code /workspaces/portfolio-island`
   - Check Command Palette for MCP commands

## Current Working Test

The server package itself works fine:

```bash
✅ Package installation: npx -y @notionhq/notion-mcp-server --help
✅ HTTP server start: Server starts on port 3333 successfully
✅ Configuration format: mcp.json syntax is valid
```

## If Nothing Works

As a last resort, you can use the Notion API directly without MCP:

- Install `@notionhq/client`
- Use the helper script in `tools/notion/get-data-source-id.mjs`
- Directly integrate with Notion API in your application

## References

- [Notion MCP Server GitHub](https://github.com/makenotion/notion-mcp-server)
- [VS Code MCP Documentation](https://code.visualstudio.com/docs/copilot/copilot-mcp)
- [Notion API Documentation](https://developers.notion.com/)
