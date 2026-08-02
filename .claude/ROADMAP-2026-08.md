# Roadmap — from deep audit + competitive analysis (2026-08-02)

## STATUS (updated 2026-08-02, commit 49c92a4 — DEPLOYED):
- ACT 1: ✅ ALL DONE (1-7 + spawn reframe; #8 digiscalability.com banner PENDING — other repo/domain)
- ACT 2: ✅ ALL DONE (9-14; concierge verified live: Cartographer sells Abbas + routes to contact)
- ACT 3: PARTIAL — crawlable HTML ✅, llms.txt ✅; STILL ABBAS'S CALL: GitHub repo public + pins,
  photo/resume assets, per-zone OG route, launch posts, RankPilot domain, tour mode, completion meter
- ACT 4: MOSTLY DONE — CI ✅, presence validators ✅, lead throttle ✅, SW eviction ✅, fonts ✅;
  remaining: functions tests, wave-mirror test, voice kill-switch, PAT rotation (user)

Source: 6-agent audit (product-ux, tech-health, growth, living-world, comp-landscape, comp-conversion).
Full findings: session workflow wf_5ceeaef9-04c journal. Goal metric: visits → impressed → contact/hired.

## The one-line verdict
The island is technically ahead of every competitor on AI/living-world systems, but it hides its
builder, hides its AI, and sends its best traffic to dead ends. Conversion, not construction, is the gap.

## ACT 1 — Conversion fixes (all Small, do first)
1. Flip onboarding: Abbas pitch BEFORE the name gate; name asked lazily (first chat/race/guestbook)
   + "just browsing" skip. Suppress modals when ?zone= deep link present. (main-simple.ts:558-576)
2. Compass priority: districts first until reached_portfolio fires; deliveries only after. (main-simple.ts:1318)
3. First-visit forced golden hour (localStorage flag) — night visitors land on a black island today.
4. Spawn camera reframe — first frame currently half blank wall.
5. Analytics: inject() at module top (pre-boot pageviews are lost today), boot_fallback beacon,
   window.onerror beacon, share_result outcome event. (main-simple.ts:638; index.html:477)
6. Loading screen: real progress bar + one pitch line ("Abbas Ali's hand-built 3D portfolio…").
7. Lead context: attach referrer/UTM/zones-explored/dwell to submitLead. (Boards.ts:88)
8. digiscalability.com banner link → island (it's an ORPHAN page today, zero inbound links).

## ACT 2 — Make the AI undeniable (the differentiator is invisible today)
9. Tell the story: welcome modal line 2 = "Every townsperson is a live AI agent…"; ✨ live-AI badge
   on chat panel; prompt → "Press E to talk — ask anything". (No competitor has embodied AI NPCs.)
10. Concierge NPC(s): give Storyteller + 1-2 others a curated fact sheet about Abbas/projects/stack
    + route-to-contact. Today personas CANNOT talk about Abbas (index.ts:250 forbids it).
11. Close the planner→chat loop: append today's activity/event/mood to the persona system prompt
    so "what are you doing today?" cites the actual plan. (functions/src/index.ts:283)
12. Island Times byline ("Compiled nightly by the island's AI analyst") + surface the board more
    (contextual toast near a working NPC) + public 14-day archive node ("Past editions" = proof it runs).
13. Third welcome CTA: "🤖 Meet the AI townsfolk" → guided to a primed chat.
14. "This Island" flagship project card — the site itself is the best case study and has NO card.
    Stack, cost guardrails, agent architecture, "how I built it" link.

## ACT 3 — Reach (launch kit; the competitive research says this is where value converts)
15. GitHub credibility: make portfolio-island public (scrub secrets first!), pin repos, profile README.
    All panels link to a near-empty org today.
16. Static crawlable HTML content block (SEO sees ~2 sentences today) + per-?zone= OG via edge route.
17. Recruiter mode: skip-intro plain HTML resume + PDF; photo/avatar + "Abbas Ali — Melbourne"
    identity (the human is anonymous today); llms.txt / MCP resume endpoint (AI-native table stake).
18. Launch kit: 20-40s captioned clip (chat panel mid-reply, NOT just scenery) → X (credit
    @bruno_simon ecosystem), LinkedIn native video, Show HN Tue-Thu 8-11am ET ("my portfolio's NPCs
    file GitHub issues about their own island every night"), three.js forum Showcase, r/webdev
    Showoff Saturday, Awwwards/FWA submissions. Wire capture (email list/CTA) BEFORE launching.
19. Visitor goal loop: completion meter (stamps/collectibles) + tour-mode camera rail for the
    90-second recruiter (Breton pattern). RankPilot behind custom domain (web.app link reads prototype).

## ACT 4 — Hardening (background)
20. CI workflow (none exists!): check + test + build on push. ~30 lines.
21. Functions tests (rate-window, cap, seededPick, prune = the money logic; zero tests today).
22. Presence rules validators + lead-email flood throttle + fine-grained PAT rotation (still open).
23. waveHeightAt↔shader mirror test; SW cache eviction; self-host fonts; voice-note mute/kill-switch.

## Competitive positioning (for copy/launch)
- UNIQUE (nobody has these): embodied LLM NPCs w/ daily AI-planned schedules; autonomous nightly
  analyst that emails + files GitHub issues; self-writing in-world newspaper; multiplayer in a
  personal portfolio; enterable venture buildings.
- BENCHMARKS: bruno-simon.com (one-verb onboarding; converts via course), henryheffernan.com
  (resume INSIDE the toy; hired at Vercel), jesse-zhou.com (every object = one hire-me artifact),
  messenger.abeto.co (same spherical-planet genre at 5.7MB/phone-ready = the perf bar),
  jordan-breton.com (island motif w/ camera rail), rleonardi.com (content IS the gimmick).
- FAILURE MODE TO AVOID (Bruno's HN thread): "high effort, low signal" — 30s loads, no identity,
  no hire-me path. Recruiters decide in ~6-8s; always pair spectacle with a fast-skim layer.
