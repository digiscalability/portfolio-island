# Launch kit — ready-to-paste posts (prepared 2026-08-02)

Everything below is paste-ready. Sequence per the competitive research:
**capture wired first** (✅ done — Say Hi widget + leads + analytics live), then
X clip → Show HN (Tue–Thu, 8–11am ET = Tue–Thu ~10pm–1am Melbourne) →
three.js forum → r/webdev Showoff Saturday → Awwwards/FWA.

**One asset to record first (the only missing piece):** a 20–40s captioned
screen clip that shows a CHAT PANEL MID-REPLY (the differentiator — not just
scenery). Suggested beats: walk up to the Gardener (bubble greeting fires) →
press E → ask "what are you doing today?" → live reply cites the planner's
assignment → cut to the Island Times board → cut to the GitHub issues list
(#5/#6, auto-filed). Capture at ?hour=10 for golden light. OBS or the in-app
photo mode won't do video — use OBS/Xbox Game Bar (Win+Alt+R).

---

## X / Twitter

> My portfolio is a little 3D planet — and its townsfolk are live AI agents.
>
> An AI planner assigns their jobs every morning. A nightly AI analyst studies
> real usage, emails me a digest… and files GitHub issues about its own island.
>
> Walk it: https://island.digiscalability.com
>
> Built with three.js — standing on the shoulders of @bruno_simon's genre.
> Source: https://github.com/digiscalability/portfolio-island

(Attach the clip. Post the GitHub-issues screenshot as a reply for the
"wait, really?" beat.)

## Show HN

**Title (≤80 chars):**
`Show HN: My portfolio's NPCs file GitHub issues about their own island every night`

**URL:** https://island.digiscalability.com

**First comment (post immediately after submitting):**

> Hi HN — solo builder here. This is my portfolio as a walkable 3D planet
> (three.js), but the part I'm proudest of is the autonomy loop:
>
> - Every townsperson is a live LLM persona (server-side Claude behind
>   Cloud Functions — rate-limited, spend-capped, moderated).
> - A daily planner call assigns each NPC a job every morning; a 60fps
>   client engine executes the schedules (they garden, patrol, deliver mail,
>   walk home at dusk and sleep in the cottages).
> - A nightly analyst aggregates real usage from the database, emails me a
>   digest, and files GitHub issues proposing improvements — two of its
>   issues are already implemented and live.
> - The safety invariant that makes it shippable: the LLM never writes free
>   prose to any world-visible surface. It only index-selects from
>   pre-authored pools, validated on both server and client. Free prose is
>   confined to my email and the issue tracker.
>
> Runs ~$0.03–0.06/day inside hard caps. Source:
> https://github.com/digiscalability/portfolio-island
> If you'd rather skim than walk: press the 90-second tour button.
> Happy to answer anything about the guardrails or the three.js side.

## three.js forum (Showcase category)

**Title:** `Life Island — a living-world portfolio: LLM NPCs with daily AI-planned schedules`

> Live: https://island.digiscalability.com · Source: https://github.com/digiscalability/portfolio-island
>
> A spherical-planet portfolio (R=75 displaced sphere, ~1MB build, custom sea
> shader with a CPU mirror so boats ride the visible waves). The showcase-y
> bits for this crowd:
>
> - Sphere-walking character controller (tangent/normal velocity split) with a
>   parallel-transported follow camera
> - 18 NPCs on a goal-driven activity engine — an LLM plans the day, cheap
>   trig executes it at 60fps (no per-frame model calls)
> - Enterable buildings via a hidden-room teleport trick (no hollowed meshes,
>   no second scene — the spherical physics never notices)
> - InstancedMesh grass (~180k blades on desktop, 32k on phones) with a load-governor, batched ambient
>   particles, draw-call budget kept mobile-friendly
>
> Assets are Blender-headless-Python generated, ~200KB of glb total.
> Feedback very welcome — especially perf on your device.

## r/webdev (Showoff Saturday)

**Title:** `My portfolio is a 3D island where the NPCs are real AI agents — one of them files GitHub issues at night`

> Live: https://island.digiscalability.com (there's a skippable 90-second tour
> if you don't feel like walking). Source in the comments.
> Stack: three.js + TypeScript + Vite, Firebase RTDB for multiplayer presence,
> Cloud Functions holding the LLM key and every guardrail. The AI townsfolk
> cost me pennies a day inside hard monthly caps.

## LinkedIn (native video)

> I rebuilt my portfolio as a living 3D world — and gave it a staff.
>
> Every townsperson on the island is a live AI agent. A planner model assigns
> their jobs each morning (gardening, patrols, mail rounds). At night they walk
> home and sleep — and an analyst model studies the day's real usage, emails me
> a digest, and files GitHub issues proposing improvements. Two of its
> suggestions are already shipped.
>
> This is the pattern I build for clients at DigiScalability: small,
> guard-railed AI agents doing real operational work — planned daily, verified
> nightly, capped in spend.
>
> Walk it here: https://island.digiscalability.com

## Awwwards / FWA (when ready)

- Submit URL: island.digiscalability.com · Category: Sites of the Day →
  Games/3D. Description: reuse the X post. Both need the site to be
  phone-solid — verify the mobile tier first on a real device.

## Post-launch checklist

- Re-scrape OG on the X/LinkedIn/Discord validators (per-zone cards now live
  at /z/professional, /z/projects, /z/personal, /z/contact).
- Watch: Vercel Analytics (utm_source per channel), leads/ inbox, the
  analyst's nightly digest (it will report the traffic spike), aiUsage spend.
- Reply fast in the first 2 hours on HN — that's what keeps a Show HN alive.
