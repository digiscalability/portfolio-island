# Proximity chat — text bubbles + push-to-talk voice clips

> ⚠️ **SUPERSEDED — SHIPPED.** World-scale constants here are frozen at the R=22
> era; chat reach is now `0.35 × WORLD_RADIUS` (`Chat.ts` / `WorldScale.ts`).
> Design intent still applies — the numbers do not.

**Date:** 2026-07-26
**Status:** Approved (design) — ready for implementation plan
**Scope:** Add player-to-player communication (text + audio) to the Life Island
multiplayer world.

## Goal

Let players who share the island talk to each other — by typed messages and by
short spoken clips — in a way that feels part of the 3D world rather than a
chat app bolted on top. Minimal UI, no new paid services, privacy-respecting.

## Decisions locked in

| Decision | Choice | Why |
|---|---|---|
| Voice model | **Push-to-talk voice clips** (record → send → play), not live WebRTC | No WebRTC/TURN complexity or reliability tax; works on every network; fits the existing Firebase transport. |
| Reach | **Proximity** — text and voice only reach nearby players | Immersive, rewards walking up to someone, scales; leans into the spatial world. |
| Text display | **Speech bubbles only** — above the sender's avatar, ~6s then fade. No panel/history. | Minimal, in-world, matches the existing name-label / wave-emoji sprites. |
| Voice transport | **base64 Opus in an RTDB `push`** (≤8s, ≤~40KB), auto-deleted after playback/next clip | Zero new infra; matches presence. Swappable to Firebase Storage + URL behind the same seam if clips ever need to be longer/HQ. |
| Proximity radius | **~14 world-units** (tunable constant) | Roughly "in view / walking distance" on the R=22 island. |
| Key bindings | `Enter` opens/sends text; hold `V` records voice (desktop). Mobile: 💬 and press-hold 🎤 HUD buttons. | Familiar; mobile parity via existing touch detection + HUD pattern. |

## Non-goals (YAGNI)

- No live/real-time voice call (WebRTC). Ruled out in favour of clips.
- No persistent chat history / scrollback panel.
- No global (island-wide) channel — proximity only.
- No server-side content moderation of audio (clips are ephemeral; client-side
  per-peer mute is provided instead).
- No message reactions, threads, DMs, or typing indicators.

## Architecture

Communication rides the **existing pluggable transport seam** in
`Multiplayer.ts` (Firebase RTDB primary; WebSocket-relay and BroadcastChannel
fallbacks). It reuses the peer position tracking, the `CanvasTexture → Sprite`
label pattern, and the per-frame expiry loop that already ages out wave sprites.

### Components

- **`Chat.ts` (new)** — the communication subsystem, kept separate from the
  already-large `Multiplayer.ts`. Responsibilities:
  - Own the outgoing/incoming `chat` and `voice` wire messages.
  - **Proximity filter** (receiver-side): given a peer id, ask `Multiplayer`
    for that peer's world position; render only if within `PROXIMITY_RADIUS`
    of the local player.
  - **Text bubbles:** build a word-wrapped speech-bubble sprite, attach above
    the sender's avatar (and above self for own messages), expire after ~6s.
  - **Voice record/playback:** `MediaRecorder` (Opus) capped at 8s; playback
    through a Web Audio `GainNode` with `gain = f(distance)`; a 🔊 indicator
    sprite over the sender while a clip plays.
  - **Per-peer mute** list (client-side), persisted to `localStorage`.
  - Feature-detect `MediaRecorder`/`getUserMedia`; degrade to text-only if absent.
  - What it depends on: `Multiplayer` (transport send + peer lookup),
    `Moderation` (text clean), `SimpleUI` (input affordance + mobile buttons).

- **`Multiplayer.ts` (changed)** — the transport owner. Adds:
  - `chat` and `voice` to the `WireMessage` union.
  - A public API for `Chat` to (a) send a wire message through the active
    transport and (b) look up a peer's current world position + local player
    position for the proximity filter.
  - RTDB transport: two new **`push()` paths** — `/chat/island` and
    `/voice/island` — with `onChildAdded` streaming and TTL / `onDisconnect`
    cleanup so blobs don't accumulate. (Presence keeps using `set()`.)
  - WebSocket-relay and BroadcastChannel transports relay `chat`/`voice`
    exactly as they already relay `state`/`wave`.

- **`SimpleUI.ts` (changed)** — the text input affordance (a slim input that
  appears on `Enter`, sends on `Enter`, cancels on `Esc`) and the mobile
  💬 / press-hold 🎤 HUD buttons, using the `makeHudButtonAccessible` helper
  (role/aria-label/keyboard) added in the accessibility pass.

- **`SimpleInputManager.ts` / `main-simple.ts` (changed)** — bind `Enter`
  (text) and hold-`V` (voice), route to `Chat`. Guard against firing while the
  text input is focused.

- **`Moderation.ts` (changed)** — add `cleanChatText(raw)`: trim, cap length
  (≤120 chars), strip control chars, run the existing offensive-word filter.
  Applied on **both** send and receive (never trust the wire).

- **`database.rules.json` (changed)** — rules for `/chat/island` and
  `/voice/island`: authenticated users may append; each entry carries the
  writer's `uid`; size caps (text length, audio byte budget); read allowed to
  authenticated island members.

- **`public/privacy.html` (changed)** — one line: voice is opt-in
  (push-to-talk), the mic is only active while held, and messages/clips are
  ephemeral (not stored or logged server-side beyond brief in-transit relay).

### Data flow

**Text send:** key/button → `SimpleUI` returns the string → `Chat.sendText()`
→ `Moderation.cleanChatText()` → `Multiplayer.sendWire({kind:'chat', id, text})`
→ transport fan-out. Own bubble shown immediately over the local player.

**Text receive:** transport → `Multiplayer` routes `chat` to `Chat.onChat(id,
text)` → proximity check → `Moderation.cleanChatText()` again → bubble sprite
over that peer's avatar, ~6s expiry.

**Voice send:** hold key → `getUserMedia` (first time prompts) → `MediaRecorder`
records Opus, hard-stop at 8s or on release → Blob → base64 →
`Multiplayer.sendWire({kind:'voice', id, audio, dur})` → RTDB `push` (or relay).

**Voice receive:** transport → `Chat.onVoice(id, audio, dur)` → proximity check
→ decode → play via `GainNode(gain = distanceAttenuation(dist))` → 🔊 sprite
over sender while playing → cleanup.

### Constants (initial, tunable)

- `PROXIMITY_RADIUS = 14` (world units)
- `BUBBLE_TTL = 6` (seconds)
- `TEXT_MAX = 120` (chars)
- `VOICE_MAX_MS = 8000`
- `VOICE_MAX_BYTES ≈ 40_000` (post-base64 guard; drop if exceeded)
- Distance→gain: **smoothstep** falloff, `gain = 1` at distance 0 → `gain = 0`
  at `PROXIMITY_RADIUS` (nearby is clear, edge of range fades to silence)

## Error handling & edge cases

- **Mic denied / unavailable / `MediaRecorder` unsupported** → voice disabled
  gracefully; text unaffected; one-time non-blocking toast explaining voice is off.
- **Oversized or malformed wire message** → dropped by the caps + `try/catch`,
  same defensive posture as the existing `handleMessage`.
- **Proximity uses last-known peer position** (10 Hz presence) — fine for a
  6-second bubble or an 8-second clip.
- **Sender leaves mid-clip** → playback finishes from the received bytes; the
  🔊 sprite is cleaned up on peer removal.
- **RTDB blob accumulation** → each voice node is removed after playback / on
  next clip / `onDisconnect`; a max-node trim as a backstop.
- **Text input focus vs game input** → while the chat input is focused,
  movement/voice keys are suppressed so typing "w" doesn't walk.

## Privacy

- Mic access is **opt-in and user-initiated** (only while push-to-talk is held);
  a visible recording indicator shows when the mic is live.
- Text and voice are **ephemeral** — rendered then discarded; voice nodes are
  short-lived in transit and deleted; nothing is written to a durable log.
- Per-peer client-side **mute** for unwanted voice.
- Documented in `public/privacy.html`.

## Testing

Unit tests (vitest, no DOM/audio required):

- **Proximity filter:** peers inside/outside `PROXIMITY_RADIUS` are
  rendered/dropped correctly (inject positions).
- **`cleanChatText`:** trims, caps length, strips control chars, filters
  offensive words, passes benign text (incl. the Scunthorpe case already handled).
- **Voice size guard:** a clip over `VOICE_MAX_BYTES` is rejected before send.
- **Wire routing:** a `chat` / `voice` message routes to the right handler and
  a self-id message is ignored (matches existing `handleMessage` contract).

Manual/browser verification: mic permission flow, bubble render + expiry,
distance-attenuated playback, mobile buttons, a11y (aria-labels + keyboard).

## Scaling note

base64-in-RTDB fan-out is O(clients) per clip — negligible at the current 1–5
concurrent players. If concurrency grows, the `voice` seam swaps to Firebase
Storage + URL (bucket already provisioned) or, later, WebRTC streaming, with no
change to `Chat`'s callers.

## Rollout

Ships on the same `claude/overnight-20260719-0649` branch as the audit work,
behind no flag (the feature is additive and degrades to text-only or silence if
transport/mic is unavailable). Deploy to LIVE bundled with the pending audit
deploy, or separately — user's call.
