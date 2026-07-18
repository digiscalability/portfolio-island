# MCP Tools Configuration Strategy

**128 Tool Limit Optimization for portfolio-island**

---

## 📊 TOOL INVENTORY & USAGE

### ✅ **CORE TOOLS (Always Active)** — ~45 tools

Essential for TypeScript/Three.js development tasks.

#### File & Project Operations (12)

- `read_file` — Read file contents
- `create_file` — Create new files
- `replace_string_in_file` — Edit existing files
- `list_dir` — List directory contents
- `file_search` — Find files by glob pattern
- `grep_search` — Search file contents (regex/text)
- `create_directory` — Create directories
- `semantic_search` — Semantic code search
- `list_code_usages` — Find symbol references & usages
- `get_errors` — Check compile/lint errors
- `create_new_jupyter_notebook` — Create notebooks
- `edit_notebook_file` — Edit notebook cells

#### Execution & Task Management (10)

- `run_in_terminal` — Execute shell commands
- `run_task` — Run VS Code tasks (npm build, lint, etc.)
- `run_notebook_cell` — Execute notebook cells
- `create_and_run_task` — Create & run new tasks
- `copilot_getNotebookSummary` — Analyze notebook structure
- `read_notebook_cell_output` — Get notebook cell output
- `run_vscode_command` — Execute VS Code commands
- `install_extension` — Install VS Code extensions
- `terminal_last_command` — Get last terminal command
- `terminal_selection` — Get terminal selection

#### Project Infrastructure (6)

- `create_new_workspace` — Initialize new projects
- `get_project_setup_info` — Get project templates
- `manage_todo_list` — Track progress & planning
- `think` — Deep reasoning & problem analysis
- `mcp_sequentialthi_sequentialthinking` — Chain-of-thought analysis
- `get_vscode_api` — VS Code API documentation

#### External Documentation (3)

- `fetch_webpage` — Fetch web content
- `mcp_markitdown_convert_to_markdown` — Convert URLs to markdown
- `open_simple_browser` — Preview URLs in VS Code

**Subtotal Core: 45 tools**
**Used Capacity: 45/128**

---

### 🟡 **ON-DEMAND TOOL CATEGORIES** — ~80 available tools

Activate only when specific tasks require them.

#### Category 1: GitHub & Version Control (28 tools)

**When needed:** Managing PRs, issues, commits, branches
**Activation keywords:**

- "Create/review pull requests"
- "Manage GitHub issues"
- "Create branches/commits"
- "Search GitHub code"
- "Manage releases/tags"

**Tools activated by:**

- `activate_github_pull_request_management` (8)
- `activate_github_issue_management` (6)
- `activate_github_file_management` (5)
- `activate_github_repository_management` (4)
- `activate_github_search_tools` (3)
- `activate_github_commit_management` (2)

#### Category 2: Git & Version Control (8 tools)

**When needed:** Complex git workflows, stashing, rebasing
**Activation keywords:**

- "Manage git branches"
- "Review commit history"
- "Stash/restore changes"
- "Track who changed what"

**Tools activated by:**

- `activate_git_tools_version_control` (5)
- `activate_git_tools_pull_request_management` (3)

#### Category 3: Browser & Testing (20+ tools)

**When needed:** Frontend testing, visual validation, E2E tests
**Activation keywords:**

- "Test the UI visually"
- "Capture screenshots"
- "Test button clicks"
- "Monitor network requests"
- "Resize for responsive testing"

**Tools activated by:**

- `activate_playwright_browser_navigation` (3)
- `activate_playwright_browser_interaction` (7)
- `activate_playwright_browser_visuals_and_screenshots` (3)
- `activate_playwright_browser_console_and_network` (2)
- `activate_playwright_browser_evaluation_and_waiting` (2)
- `activate_playwright_browser_dialogs` (2)
- `activate_playwright_browser_file_management` (2)

#### Category 4: Python Development (7 tools)

**When needed:** Python-specific coding, pip management
**Activation keywords:**

- "Install Python packages"
- "Configure Python environment"
- "Check Python imports"
- "Run Python code"

**Tools activated by:**

- `activate_python_environment_tools` (4)
- `activate_pylance_tools` (3)

#### Category 5: Jupyter Notebooks (3 tools)

**When needed:** Advanced Jupyter operations
**Activation keywords:**

- "Configure Jupyter kernel"
- "Install notebook packages"
- "List installed packages"

**Tools activated by:**

- `activate_notebook_management_tools` (3)

#### Category 6: Library Documentation (4 tools)

**When needed:** Research Three.js, frameworks, libraries
**Activation keywords:**

- "Look up Three.js documentation"
- "Find library examples"
- "Research npm package"

**Tools activated by:**

- `mcp_context7_resolve-library-id` (1)
- `mcp_context7_get-library-docs` (1)
- `mcp_upstash_conte_resolve-library-id` (1)
- `mcp_upstash_conte_get-library-docs` (1)

#### Category 7: Payment & Billing (12 tools) ⚠️ NOT NEEDED

- Stripe customer, subscription, invoice, coupon, product, payment, dispute management
- **Status:** Disabled — Not a payment project

#### Category 8: Error Tracking (14 tools) ⚠️ NOT NEEDED

- Sentry issue analysis, project management, DSN management, event management, etc.
- **Status:** Disabled — Not configured for this project

#### Category 9: ML/Data (7 tools) ⚠️ NOT NEEDED

- Hugging Face datasets, models, image generation, spaces
- **Status:** Disabled — Not an ML project

#### Category 10: Productivity/Integration (12 tools) ⚠️ NOT NEEDED

- Notion pages/databases, Zapier workflows
- **Status:** Disabled — Not using these tools

---

## 🎯 OPTIMAL CONFIGURATION

### Current State

**Core tools active:** 45/128
**Available for on-demand:** 83 tools across 6 categories
**Reserve capacity:** ~40 slots for peak usage

---

## 📋 DYNAMIC ACTIVATION PROTOCOL

### How It Works

1. **You describe the task:** "I need to review GitHub issues and create a PR"
2. **I analyze required tools** and activate only what's needed
3. **I confirm:** "Activating GitHub tools (28 tools). New total: 73/128 ✓"
4. **We proceed** with the task
5. **After task completion:** Tools remain active for next similar task, or I deactivate if not needed

### Example Scenarios

#### Scenario 1: Lint Fixes (Current)

```
Task: "Continue resolving lint warnings in batches"
Tools needed: Core only
Activation: None (already active)
Total: 45/128
```

#### Scenario 2: Create Feature Branch & PR

```
Task: "Create a branch for new camera feature and open a PR"
Tools needed: GitHub + Git
Activation:
  - activate_github_pull_request_management
  - activate_git_tools_version_control
Total: 45 + 28 + 8 = 81/128
```

#### Scenario 3: Test UI Changes

```
Task: "Visually test the new dialogue UI and take screenshots"
Tools needed: Core + Browser tools
Activation:
  - activate_playwright_browser_visuals_and_screenshots
  - activate_playwright_browser_interaction
  - activate_playwright_browser_navigation
Total: 45 + 20 = 65/128
```

#### Scenario 4: Research Three.js Patterns

```
Task: "Look up Three.js camera and lighting patterns"
Tools needed: Core + Library docs
Activation:
  - mcp_context7_resolve-library-id
  - mcp_context7_get-library-docs
Total: 45 + 4 = 49/128
```

---

## 🛠️ TOOL REQUEST LANGUAGE

You can make requests like any of these:

### Implicit (I'll detect and activate)

- "I need to create a GitHub PR for this fix"
- "Let me test the UI visually"
- "Look up the Three.js documentation for..."

### Explicit (clearest)

- "Activate GitHub tools, I'm making a PR"
- "Enable browser testing tools"
- "I need git version control tools"

### For peak usage

- "Activate all safe tools for maximum capability"
- "Only activate core + GitHub tools"

---

## 📌 RECOMMENDATIONS

### For Current Session (Lint Fixes)

**Active:** Core tools only (45/128)
**Why:** All necessary for file editing, terminal execution, error checking
**When to expand:** If we need to review git history or test UI changes

### For Best Performance

1. **Keep core tools always active** → No context loss
2. **Activate categories on-demand** → Use capacity efficiently
3. **Deactivate after task** → Keep room for future needs
4. **Request explicitly** if unsure → I'll handle activation

### What NOT to Activate

❌ Stripe/Payment tools (not applicable)
❌ Sentry/Error tracking (not configured)
❌ Hugging Face/ML tools (not an ML project)
❌ Notion tools (not using Notion)
❌ Zapier tools (not needed)

---

## 🚀 NEXT STEPS

**Ready to proceed with:**

1. Lint warning fixes using core tools (45/128 active) ✓
2. On-demand activations as you request them ✓
3. Efficient tool management throughout the session ✓

**Your choice:** Shall I continue with lint fixes now, or do you want to activate any additional tools first?
