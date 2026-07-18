# Portfolio Island (Life Island) — Claude Code context

This repo is part of a multi-venture operator setup. **Portfolio Island / "DigiScalability Life Island" is a product under DigiScalability** (parent holding co). Live state and decisions are tracked in Notion, not in this file. **Read Notion FIRST.**

## Live state (read this before anything else)

Fetch via Notion MCP: {PASTE PORTFOLIO ISLAND STATE PAGE URL AFTER CREATING IT IN NOTION}

Before answering my first prompt in any session:

1. Fetch the State page above
2. Read "Last session summary", "Open threads", "Decisions locked in"
3. Also read `.claude/LOCAL-STATE.md` for local-only context from the last Code session
4. Acknowledge where we left off in ≤20 words, then wait for my prompt.

## Operator context

I'm Abbas — Melbourne-based, solo founder of DigiScalability (parent). Portfolio Island is the 3D interactive portfolio / "Life Island" product. Related product: Planet Messenger (integrated architecture — see `Integrated Architecture Design_ DigiScalability Life Island & Planet Messenger.md`).

When I arrive, assume I'm resuming. Never ask "what would you like to work on today?" first.

## Output discipline

- No preamble, no self-narration
- Concise prose. Code blocks for code.
- Plans when asked, not docs.

## Decision autonomy

- Reversible + context → act, tell me after
- Irreversible (prod deploy, money, public asset changes) → ask first

## Stack (don't ask)

- **Runtime:** Three.js scene (island + interactive props + player movement)
- **Language:** TypeScript (look at the scattered `.ts` files at repo root — Camera, Environment, Island, Lighting, InputManager, InteractionSystem, FeedbackSystem, Emoji, ChatSystem, AppointmentSystem)
- **Backend:** Firebase (Auth, Firestore for feedback/appointments/chat)
- **Deploy:** Firebase Hosting + Google Cloud VM for heavier workloads (see `GOOGLE-CLOUD-VM-SETUP.md`)
- **MCP integrations:** Notion, Playwright (for visual testing — `.playwright-mcp/` has state screenshots)
- **Dev env:** Codespaces-ready (`.codespaces.yml`, `.devcontainer/`)

## Recurring concerns (read before touching)

- Memory leaks in Three.js scene — `MEMORY-LEAK-FIXES-APPLIED.md`
- Critical gameplay fixes history — `CRITICAL-FIXES-COMPLETE.md`
- Island prop / player interaction — `ISLAND-PROPS-PLAYER-FIXES.md`
- Frontend fixes summary — `FRONTEND-FIXES-SUMMARY.md`
- Environment system — `ENVIRONMENT-SYSTEM-GUIDE.md` (read before changing env logic)

## What I hate (don't suggest)

- Swapping Three.js for another 3D engine
- Moving off Firebase
- "Let me restructure the scene graph" — only refinement, not rebuilds
- Long explanations when visual testing (Playwright screenshots) would answer faster

## Visual regression protocol

Before claiming a visual fix worked, invoke Playwright MCP to capture a new screenshot of the affected state, compare against the named baseline in `.playwright-mcp/`, and attach the diff description. Don't trust "looks good in my head."

## Cross-venture awareness

Life Island + Planet Messenger share architecture (`Integrated Project Requirements_ DigiScalability Life Island & Planet Messenger.md`). If a change affects Planet Messenger's contract, note it in the Sessions DB handoff; don't edit cross-repo.

## Checkpoint protocol

When I say "checkpoint", when you hit an error/limit, or when we wrap:

1. Summarize session in ≤6 bullets
2. Write to `.claude/LOCAL-STATE.md` (replace entire file — branch, files in flight, visual state captured, next step)
3. Update the Notion State page "Last session summary" via MCP
4. Create a row in the Notion Sessions DB (Venture=PortfolioIsland, Surface="code", Status=Checkpointed, What I was doing, Next step, Blockers)
5. Confirm in chat: "Checkpointed. See Notion [URL]."

Do ALL FIVE steps — Notion writes must complete. If MCP fails, save locally and flag loudly.
