import { inject } from '@vercel/analytics';
import * as THREE from 'three';

import { a11y } from './Accessibility';
import { startDwellTracking, track, trackOnce } from './Analytics';
import { Chat, PROXIMITY_RADIUS } from './Chat';
import { DeliverySystem } from './DeliverySystem';
import { DISTRICTS } from './Districts';
import { EnvironmentCycle } from './EnvironmentCycle';
import { GameScene } from './GameScene';
import { Multiplayer } from './Multiplayer';
import { askNpc, askNpcOpening, composeAwareGreeting, isAiNpc, voiceProfileFor } from './NpcChat';
import { NpcQuestSystem } from './NpcQuests';
import { Passport, PASSPORT_META, type PassportZone } from './Passport';
import { loadProfile, saveProfile } from './profileSync';
import { sfx } from './Sfx';
import { SimpleInputManager } from './SimpleInputManager';
import type { BodyPart, HatId } from './SimplePlayer';
import { SimpleRenderer } from './SimpleRenderer';
import { SimpleUI } from './SimpleUI';
import { isRealTheme } from './Theme';
import { connectWorldState, getWorldState, moodNpcFlavor, MOOD_META } from './WorldState';

import './style.css';

// Analytics MUST fire at module evaluation, not after the world boots: the old
// idle-deferred inject meant every visitor who bounced during the loading
// screen (or hit the WebGL fallback) was invisible — the top of the funnel was
// unmeasured. inject() is cookieless and failure-safe; custom events stay lazy.
try {
  inject({ mode: import.meta.env.PROD ? 'production' : 'development' });
} catch {
  /* ad-blocker / offline — never let analytics break the app */
}

// Capture the entry context ONCE for lead attribution: which channel and
// campaign produced this session. Read back by Boards.submitLead so the lead
// email can say "came from the Show HN link" instead of arriving anonymous.
try {
  if (!sessionStorage.getItem('ds_entry')) {
    const sp = new URLSearchParams(location.search);
    const utm: Record<string, string> = {};
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign']) {
      const v = sp.get(k);
      if (v) utm[k] = v.slice(0, 60);
    }
    sessionStorage.setItem(
      'ds_entry',
      JSON.stringify({ ref: document.referrer.slice(0, 200), utm, t: Date.now() }),
    );
  }
} catch {
  /* no storage — attribution is best-effort */
}

/**
 * SimpleApp
 *
 * Simplified main application entry point following Messenger's pattern
 * Replaces the 500+ line main.ts with focused initialization
 *
 * Responsibilities:
 * - Setup WebGL canvas
 * - Initialize renderer, scene, camera
 * - Setup input handling
 * - Start render loop
 * - Handle cleanup
 */
class SimpleApp {
  private renderer!: SimpleRenderer;
  private scene!: GameScene;
  private inputManager!: SimpleInputManager;
  private ui!: SimpleUI;
  private deliverySystem!: DeliverySystem;
  private npcQuests!: NpcQuestSystem;
  private multiplayer: Multiplayer | null = null;
  private chat?: Chat;
  private isRunning: boolean = false;
  // "Meet the AI townsfolk" compass override (welcome CTA → cleared on AI chat)
  private aiGuideTarget: THREE.Vector3 | null = null;
  // "Beat the lap record" CTA → compass points at the start gate until a race starts
  private raceGuideTarget: THREE.Vector3 | null = null;

  // Tour mode: a skippable cinematic rail over the districts for the visitor
  // who won't touch WASD (the Breton camera-rail pattern from the audit).
  // While active the orbit camera is suspended and this drives the scene
  // camera directly; the world (NPCs, sea, activities) keeps living.
  private tour: {
    stops: Array<{
      caption: string;
      look: THREE.Vector3; // surface point the camera studies
      dir: THREE.Vector3; // camera position direction (unit, from planet centre)
      r: number; // camera position radius
    }>;
    idx: number;
    t: number;
    phase: 'fly' | 'dwell';
    fromDir: THREE.Vector3;
    fromR: number;
    fromLook: THREE.Vector3;
  } | null = null;
  // Tour scratch (kept allocation-free per frame)
  private readonly _tourDir = new THREE.Vector3();
  private readonly _tourLook = new THREE.Vector3();
  private readonly _tourUp = new THREE.Vector3();
  private readonly _tourAxis = new THREE.Vector3();
  private readonly _tourQ = new THREE.Quaternion();

  // Completion meter recompute throttle (localStorage reads are cheap; 2.5s
  // keeps the pill fresh without touching storage every frame)
  private completionAccum = 0;

  // Island shop (hat cosmetics, paid with meadow coins)
  private readonly hatCatalog: Array<{ id: HatId; icon: string; name: string; price: number }> = [
    { id: 'cap', icon: '🧢', name: 'Explorer Cap', price: 8 },
    { id: 'party', icon: '🥳', name: 'Party Hat', price: 10 },
    { id: 'flower', icon: '🌸', name: 'Flower Crown', price: 12 },
    { id: 'chef', icon: '👨‍🍳', name: "Chef's Toque", price: 14 },
    { id: 'top', icon: '🎩', name: 'Top Hat', price: 15 },
    { id: 'headphones', icon: '🎧', name: 'Headphones', price: 16 },
    { id: 'pirate', icon: '🏴‍☠️', name: 'Pirate Hat', price: 18 },
    { id: 'wizard', icon: '🧙', name: 'Wizard Hat', price: 20 },
    { id: 'crown', icon: '👑', name: 'Golden Crown', price: 25 },
    { id: 'halo', icon: '😇', name: 'Halo', price: 40 },
  ];
  private ownedHats: Set<string> = new Set();
  private equippedHat: string | null = null;
  private passport: Passport | null = null;

  // FPS tracking
  private frameCount: number = 0;
  private fpsUpdateInterval: number = 0;

  // Minimap refresh throttle (10 Hz is plenty for a 190px map)
  private mapAccum: number = 0;

  // Footstep/landing SFX state. Grounding flickers frame-to-frame while
  // walking (integrate-out then snap-back), so landings are debounced by
  // continuous airborne time rather than raw grounded transitions.
  private stepAccum: number = 0;
  private stepAlt: boolean = false;
  private prevWalkPhase: number = -1; // last sampled walk-cycle phase (-1 = stride inactive)
  private airborneTime: number = 0;
  private prevJumpHeld: boolean = false;
  private lastSwimWarnAt = 0; // throttle for the shoreline-barrier hint
  private currentThrottle = 0; // last vehicle throttle magnitude (for engine sfx)

  // Scratch vectors reused every frame to keep the update loop allocation-free
  // (mobile minor-GC hitch reduction). Never hold a reference to these across
  // frames — each consumer copies into them fresh before use.
  private readonly _listenerPos = new THREE.Vector3();
  private readonly _listenerFwd = new THREE.Vector3();
  private readonly _listenerUp = new THREE.Vector3(0, 1, 0);
  private readonly _qcPlayerPos = new THREE.Vector3();
  private readonly _qcNormal = new THREE.Vector3();
  private readonly _qcToTarget = new THREE.Vector3();
  private readonly _qcCamFwd = new THREE.Vector3();
  private readonly _qcCross = new THREE.Vector3();
  private readonly _qcTmp = new THREE.Vector3();

  private boundHandlers: {
    beforeUnload?: () => void;
    debugKeydown?: (event: KeyboardEvent) => void;
    chatKeydown?: (event: KeyboardEvent) => void;
    chatKeyup?: (event: KeyboardEvent) => void;
    mutePointerDown?: (event: PointerEvent) => void;
    mutePointerUp?: (event: PointerEvent) => void;
  } = {};

  constructor() {
    (window as any).__simpleApp = this;
    (window as any).__app = this;
    this.init();
  }

  /**
   * Initialize the application
   */
  private async init(): Promise<void> {
    try {
      console.log('🎮 Starting SimpleApp initialization...');

      // Get or create canvas
      let canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.id = 'game-canvas';
        document.body.insertBefore(canvas, document.body.firstChild);
      }

      // Always enforce canvas styling so the WebGL output stays on top of the gradient background
      Object.assign(canvas.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        width: '100%',
        height: '100%',
        zIndex: '500',
        display: 'block',
      });

      console.log('✓ Canvas created');

      // Remove legacy DOM overlays that conflict with the simplified UI stack
      this.disableLegacyUI();

      // Accessibility prefs (reduced motion) — seed before anything animates
      a11y.init();

      // Create UI first (shows loading screen)
      try {
        this.ui = new SimpleUI('ui-overlay');
        console.log('✓ UI constructor called with canvas');
        this.ui.showLoading(10);
        console.log('✓ Loading screen shown');
      } catch (uiError) {
        console.error('❌ UI creation failed:', uiError);
        throw uiError;
      }

      // Create renderer
      this.renderer = new SimpleRenderer(canvas);
      console.log('🎨 SimpleRenderer created:', {
        canvas: this.renderer.getCanvas(),
        renderer: this.renderer.getRenderer(),
        devicePixelRatio: this.renderer.getDevicePixelRatio(),
      });
      this.ui.showLoading(50);
      console.log('✓ Renderer created');

      // Create scene (this will also create planet and player)
      this.scene = new GameScene();
      this.ui.showLoading(60);
      await this.scene.ready();
      this.ui.showLoading(90);
      console.log('✓ Scene initialized and ready');

      // Initialize delivery system
      this.deliverySystem = new DeliverySystem();
      this.ui.showLoading(95);
      console.log('✓ Delivery system initialized');

      // Assign the full quest chain across the mailboxes (round-robin) and
      // route mailbox interaction through the delivery system
      const mailboxes = this.scene.getMailboxes();
      this.deliverySystem.assignDestinations(mailboxes);
      this.scene.setOnMailboxInteract((mailbox) => {
        const collected = this.deliverySystem.collectFromMailbox(mailbox);
        if (collected) this.scene.wiggleMailbox(mailbox);
        return collected;
      });
      console.log(`✓ Quest deliveries assigned across ${mailboxes.length} mailboxes`);

      // Setup quest completion callback
      this.deliverySystem.setOnQuestComplete((quest) => {
        console.log(`🎉 Quest "${quest.name}" completed!`);
        sfx.questComplete();
        this.ui.showQuestComplete(quest);
        track('quest_completed', { id: quest.id });
        // Finale: finishing all ten deliveries makes good on the NPC's promise
        // ("unlock something special") — grant the rare 😇 Halo + 25 coins, once.
        if (this.deliverySystem.isAllComplete()) {
          track('delivery_all_complete');
          this.grantCourierReward();
        }
      });

      // Pickup ding + analytics on every completed delivery
      this.deliverySystem.setOnDeliveryComplete((d) => {
        sfx.collect();
        track('delivery_completed', {
          id: d.id,
          count: this.deliverySystem.getCompletedCount(),
        });
      });

      // Walking up to a zone building + E now STEPS INSIDE it (3D interior) and
      // shows the content over the room. Proximity is still the only path that
      // stamps the passport. (Menu/deep-link opens still just show the panel.)
      this.scene.setOnZoneInteract((zone) => {
        console.log(`🎯 Entering zone: ${zone.name}`);
        this.enterBuilding(zone.id, true, zone);
      });
      // Cottage doors: walk up + E → step inside a cosy room.
      this.scene.setOnHouseEnter((id) => this.enterBuilding(id, false));

      // NPC quests: stateful dialogue + rewards layered over ambient lines
      this.npcQuests = new NpcQuestSystem();
      this.scene.setQuestMarkers(this.npcQuests.getGiverNamesWithAvailableQuests());

      // Restore the shop wardrobe (owned + equipped hats)
      try {
        this.ownedHats = new Set(JSON.parse(localStorage.getItem('ds_owned_hats') ?? '[]'));
        this.equippedHat = localStorage.getItem('ds_hat');
        if (this.equippedHat) this.scene.equipPlayerHat(this.equippedHat as HatId);
      } catch {
        /* fresh wardrobe */
      }

      // Restore saved body colours (applied now; re-applied when the GLTF loads)
      try {
        const stored = JSON.parse(localStorage.getItem('ds_appearance') ?? '{}') as Record<
          string,
          string
        >;
        const player = this.scene.getPlayer();
        for (const key of Object.keys(stored)) {
          const hex = parseInt(stored[key].replace('#', ''), 16);
          if (Number.isFinite(hex)) player?.setBodyColor(key as BodyPart, hex);
        }
      } catch {
        /* default colours */
      }

      // Multiplayer: other visitors on the same island, waves included
      this.multiplayer = new Multiplayer(this.scene, this.scene.getPlayer());
      this.multiplayer.onCount((count) => this.ui.updatePlayerCount(count));
      this.multiplayer.setHat((this.equippedHat as HatId) ?? null);

      // Proximity chat: text bubbles + push-to-talk voice between nearby
      // visitors. Wired to the mobile chat/mic HUD buttons and to
      // Enter/V(oice) on desktop (see setupDebugShortcuts-adjacent binding
      // below, near the input manager setup).
      this.chat = new Chat(this.multiplayer);
      this.ui.setVoiceSupported(this.chat.voiceSupported);
      this.multiplayer.setChatHandler((msg) => this.chat?.onWire(msg));
      this.ui.setOnChatSend((text) => this.chat?.sendText(text));
      this.ui.setOnMicDown(() => void this.chat?.startRecording());
      this.ui.setOnMicUp(() => this.chat?.stopRecording());
      // Show the "● Recording Xs" indicator only while the mic is truly live.
      this.chat.setOnRecordingStart(() => this.ui.showRecordingIndicator());
      this.chat.setOnRecordingStop(() => this.ui.hideRecordingIndicator());

      // Portfolio Passport: visiting all four work zones unlocks the Founder's
      // Golden Crown — the mechanic that routes explorers through the real work.
      this.passport = new Passport();
      this.passport.setOnComplete(() => this.grantPassportReward());
      this.ui.setPassport(this.passport);

      // Roster: click the online-count to see who's here and mute per peer.
      this.ui.setRosterProvider(() => this.multiplayer?.getPeerList() ?? []);
      this.ui.setOnPeerMuteToggle((id) => {
        const muted = this.chat?.toggleMute(id) ?? false;
        this.multiplayer?.setPeerMuted(id, muted);
        return muted;
      });

      // Tap a peer (their avatar or name) to mute/unmute them. A tap is
      // distinguished from a camera-orbit drag by small movement + short time,
      // so it coexists with OrbitCamera's own pointer handling on the canvas.
      const muteCanvas = document.getElementById('game-canvas');
      if (muteCanvas) {
        let tapX = 0;
        let tapY = 0;
        let tapT = 0;
        this.boundHandlers.mutePointerDown = (e: PointerEvent) => {
          tapX = e.clientX;
          tapY = e.clientY;
          tapT = performance.now();
        };
        this.boundHandlers.mutePointerUp = (e: PointerEvent) => {
          if (this.ui.isChatInputOpen()) return;
          if (Math.hypot(e.clientX - tapX, e.clientY - tapY) > 6) return; // was a drag
          if (performance.now() - tapT > 400) return; // was a long-press
          const hits = this.scene.rayCastFromCamera(e.clientX, e.clientY);
          for (const h of hits) {
            const id = this.multiplayer?.peerIdForObject(h.object);
            if (!id) continue;
            const muted = this.chat?.toggleMute(id) ?? false;
            this.multiplayer?.setPeerMuted(id, muted);
            const name = this.multiplayer?.getPeerName(id) ?? 'player';
            this.ui.toast(`${muted ? '🔇 Muted' : '🔊 Unmuted'} ${name}`);
            break; // only the nearest peer under the tap
          }
        };
        muteCanvas.addEventListener('pointerdown', this.boundHandlers.mutePointerDown);
        muteCanvas.addEventListener('pointerup', this.boundHandlers.mutePointerUp);
      }

      // Setup NPC interaction callback (quest dialogue wins when relevant)
      this.scene.setOnNPCInteract((npcData) => {
        console.log(`💬 Talking to: ${npcData.name}`);
        // The Market Vendor runs the island shop.
        if (npcData.name === 'Market Vendor') {
          sfx.blip();
          this.openShop();
          return;
        }
        // Quest steps take PRIORITY over idle chat, so a quest-giver still gives
        // its quest (and fetch pickups / completions still fire) even though it
        // is also an AI NPC. When it has no active quest step, it falls through
        // to free-text chat below.
        const talk = this.npcQuests.onTalk(npcData.name, this.scene.getCoinsCollected());
        if (talk) {
          this.ui.showDialogue(npcData.name, talk.lines);
          if (talk.accepted) {
            sfx.blip();
            this.scene.setQuestMarkers(this.npcQuests.getGiverNamesWithAvailableQuests());
          }
          // Fetch quest: picked the fish up at the Fisherman — carry it in hand
          if (talk.pickedUp) {
            sfx.collect();
            this.scene.setPlayerCarryingFish(true);
          }
          if (talk.completed) {
            const q = talk.completed;
            // Delivering the fish → the Baker bakes it into a pie before your eyes
            if (q.id === 'baker_catch') this.scene.deliverFishToBaker();
            this.scene.addCoins(q.rewardCoins);
            sfx.questComplete();
            this.ui.showQuestComplete({
              name: `${q.giverName}'s request`,
              reward: { type: 'message', value: `+${q.rewardCoins} 🪙 reward` },
            } as any);
            this.scene.setQuestMarkers(this.npcQuests.getGiverNamesWithAvailableQuests());
          }
          return;
        }
        // No active quest for this NPC → intelligent free-text conversation if it
        // has a brain wired up. On ANY failure (function/App Check/rate/spend
        // cap/moderation/offline) askNpc returns a fallback and we cycle the
        // NPC's authored canned lines, so the NPC never appears broken.
        if (isAiNpc(npcData.name)) {
          this.aiGuideTarget = null; // meet-the-townsfolk guide fulfilled
          this.markDone('ds_npc_chatted');
          sfx.blip();
          const canned = npcData.dialogue;
          let ci = 1; // first fallback skips the opening line (canned[0])
          // Aware opening: same live-state composition as the proximity bubble
          // (planner-assigned activity + hour + day-theme), so the walk-up line
          // and the conversation flow as one — no more static canned[0].
          const aware = composeAwareGreeting({
            activity: this.scene.getNpcActivity(npcData.name),
            hour: this.scene.getEnvironmentCycle()?.getHour() ?? 12,
            event: getWorldState()?.npcPlan?.event,
          });
          this.ui.showNpcChat(
            npcData.name,
            aware || canned[0] || 'Hello, traveller.',
            async (text) => {
              track('npc_chat_sent', { npc: npcData.name });
              const res = await askNpc(npcData.name, text);
              if (res.reply && !res.fallback) return res.reply;
              return canned[ci++ % canned.length] ?? '…';
            },
            voiceProfileFor(npcData.name),
          );
          // Deepen the opening in the background: the composed line shows
          // instantly; when the persona's generated continuation arrives the
          // NPC simply keeps talking. Failures resolve silently — the
          // composed opening already stands on its own.
          void askNpcOpening(npcData.name, aware).then((res) => {
            if (res.reply && !res.fallback) {
              this.ui.appendNpcChatLine(npcData.name, res.reply);
            }
          });
          return;
        }
        // Non-AI, non-quest NPC → canned dialogue, led by a living-world mood line.
        let lines = npcData.dialogue;
        const flavor = moodNpcFlavor();
        if (flavor) lines = [flavor, ...lines];
        this.ui.showDialogue(npcData.name, lines);
      });

      // Living world: subscribe to the server-owned world/island beat (a mood +
      // pre-authored headline the scheduled director evolves every few hours).
      // Surface it as a bulletin banner; it also colours NPC tone via
      // moodNpcFlavor() above. Degrades to silence if the backend/beat is
      // absent (e.g. before the director is deployed). ?mood=festive previews.
      connectWorldState((s) => {
        this.ui.showWorldBulletin(s.headline, MOOD_META[s.mood].accent);
        track('world_beat_seen', { mood: s.mood });
        // Hand the day's NPC assignments to the activity engine (Phase 2).
        if (s.npcPlan) this.scene.setNpcActivities(s.npcPlan);
        // Feed the "Island Times" board its notice + plan + past editions.
        // Cached lazily — the board reads it only when the visitor opens it.
        this.ui.setIslandTimes(s.notice ?? null, s.npcPlan ?? null, s.noticeArchive ?? null);
      });

      // Restore the carried fish if a fetch quest was mid-delivery on reload
      if (this.npcQuests.isCarryingFetchItem()) {
        this.scene.setPlayerCarryingFish(true);
      }

      // Environment badge: weather · time of day · place
      this.scene.getEnvironmentCycle()?.onStatus((status) => {
        this.ui.setEnvironmentBadge(status);
      });

      // Live weather is opt-in (it shares approximate location) — the badge is
      // the consent gate. Day/night runs off the device clock regardless.
      this.ui.setWeatherConsentHandler(EnvironmentCycle.hasWeatherConsent(), (on) => {
        this.scene.getEnvironmentCycle()?.setWeatherConsent(on);
        this.ui.flashMessage(on ? '🌦️ Live weather on' : '🌤️ Live weather off');
      });

      // Photo mode: capture the next rendered frame, brand it, preview it.
      this.ui.setOnPhotoRequest(() => this.capturePhoto());

      // ?hour= override: let a shared link show the island at a chosen time so
      // daytime visitors can see the night art (stars/moon/fireflies/windows).
      this.applyHourParam();

      // First-ever visit lands in golden daylight regardless of local clock:
      // an evening recruiter used to land on a near-black island that looked
      // nothing like the sunny OG card they clicked. One session only — the
      // live clock (and the night art) takes over from the second visit; an
      // explicit ?hour= share link always wins.
      try {
        const env = this.scene.getEnvironmentCycle();
        if (env && env.debugHour === null && !localStorage.getItem('ds_visited')) {
          localStorage.setItem('ds_visited', '1');
          env.debugHour = 10.5;
        }
      } catch {
        /* no storage */
      }

      // Coin counter (persisted across visits + mirrored to the cloud profile)
      this.ui.updateCoinCounter(this.scene.getCoinsCollected());
      this.scene.setOnCoinCollected((total) => {
        this.ui.updateCoinCounter(total);
        saveProfile({ coins: total });
        if (total >= 100) trackOnce('coins_milestone', { n: 100 });
        else if (total >= 50) trackOnce('coins_milestone', { n: 50 });
      });

      // Drowning: washed back to shore with a splash message
      this.scene.setOnDrownRespawn(() => {
        this.ui.flashMessage('🌊 You nearly drowned! Washed ashore.');
        sfx.land();
      });

      // Vehicle time-trials: banner on start/checkpoint/finish + live lap HUD
      this.scene.setOnRaceEvent((e) => {
        if (e.kind === 'finish') {
          sfx.questComplete();
          // Racing paid NOTHING before — the most complete loop in the game had
          // no reward. Every finish now pays out (bigger on a PB).
          const reward = e.improved ? 15 : 5;
          this.scene.addCoins(reward);
          this.ui.updateCoinCounter(this.scene.getCoinsCollected());
          this.ui.flashMessage(`${e.text}  ·  +${reward} 🪙`);
          track('race_finish', {
            circuit: e.circuit ?? 'unknown',
            timeMs: Math.round((e.timeSec ?? 0) * 1000),
            improved: !!e.improved,
          });
          this.markDone('ds_raced');
          const name = this.multiplayer?.selfName ?? 'Guest';
          if (e.improved && e.circuit && typeof e.timeSec === 'number') {
            void import('./Boards').then((b) => b.submitRaceTime(e.circuit!, e.timeSec!, name));
          }
          // Surface the (otherwise buried) global leaderboard a beat after the
          // finish, with a Share button — turns every PB into a share prompt.
          if (e.circuit) {
            const circuit = e.circuit;
            const tMs = typeof e.timeSec === 'number' ? Math.round(e.timeSec * 1000) : null;
            window.setTimeout(() => void this.ui.showRaceLeaderboard(circuit, tMs, name), 1200);
          }
          return;
        }
        this.ui.flashMessage(e.text);
        if (e.kind === 'start') {
          sfx.raceGo();
          this.raceGuideTarget = null; // the guide CTA is fulfilled
          track('race_start', { circuit: e.circuit ?? 'unknown' });
        } else if (e.kind === 'checkpoint') sfx.checkpoint();
      });
      this.scene.setOnRaceHud((s) => this.ui.updateRaceHud(s));

      // "Meet the AI townsfolk" welcome CTA: compass-guide to the Storyteller
      // until the visitor actually talks to an AI NPC (cleared there).
      this.ui.setOnMeetAi(() => {
        this.aiGuideTarget =
          this.scene.getNpcPosition('Storyteller') ?? this.scene.getNpcPosition('Elder Sage');
        if (this.aiGuideTarget) {
          this.ui.flashMessage(
            '🤖 Follow the compass — walk up to the Storyteller and ask anything',
          );
        }
      });

      // Cinematic tour + race guide CTAs (welcome modal / leaderboards) and the
      // UI-side completion flags (guestbook, Times, say-hi) refreshing the pill.
      this.ui.setOnTour(() => this.startTour());
      this.ui.setOnRaceGuide(() => this.guideToRace());
      this.ui.setOnProgressMade(() => this.refreshCompletion());
      this.refreshCompletion();

      // 🎨 button / C key: toggle the appearance editor
      this.ui.setOnCustomizeToggle(() => {
        if (this.ui['customizeDiv']) this.ui.hideCustomize();
        else this.openCustomize();
      });

      // Mute button → shared AudioManager (created by startBackgroundMusic)
      this.ui.setOnMuteToggle(() => {
        const am = (window as unknown as { audioManager?: { toggleMute(): boolean } }).audioManager;
        return am ? am.toggleMute() : false;
      });

      // Initialize post-processing. Awaited so the lazily-loaded bloom addons
      // are constructed before warmUp() compiles their shaders ahead of reveal.
      // On the coarse/low-core tier this never constructs a composer (nor
      // fetches the chunk) — phones stay on the native antialiased canvas.
      if (SimpleRenderer.isLowTierDevice()) {
        console.log('📱 Low-tier device: bloom skipped, native MSAA path.');
      } else {
        await this.renderer.initPostProcessing(this.scene, this.scene.getCamera());
        console.log('✓ Post-processing initialized');

        this.renderer.setPostProcessingEnabled(true);
        console.log('✨ Bloom enabled by default (Ctrl+B to toggle).');
      }

      this.setupDebugShortcuts();

      // Create input manager
      this.inputManager = new SimpleInputManager();
      this.inputManager.attachToCanvas(canvas);
      console.log('✓ Input manager created');

      // Chat keybindings: Enter opens the text input; V is push-to-talk
      // voice (no existing hotkey uses V — checked SimpleInputManager and
      // this file's debug shortcuts, which use C and Ctrl+B). Bound on
      // window rather than through SimpleInputManager so the chat input's
      // own keydown handler (which calls stopPropagation) can fully own
      // the keyboard while it's focused.
      this.boundHandlers.chatKeydown = (e: KeyboardEvent) => {
        if (this.ui.isChatInputOpen()) return; // the input owns the keyboard while typing
        if (e.key === 'Enter') {
          // First time a name becomes visible to OTHERS — ask for it here
          // (lazily), not as a gate on the whole site.
          this.ensureNamed(() => this.ui.openChatInput());
          return;
        }
        if ((e.key === 'v' || e.key === 'V') && !e.repeat) {
          void this.chat?.startRecording();
        }
      };
      this.boundHandlers.chatKeyup = (e: KeyboardEvent) => {
        if (e.key === 'v' || e.key === 'V') this.chat?.stopRecording();
      };
      window.addEventListener('keydown', this.boundHandlers.chatKeydown);
      window.addEventListener('keyup', this.boundHandlers.chatKeyup);

      // Setup cleanup on page unload
      this.boundHandlers.beforeUnload = () => this.dispose();
      window.addEventListener('beforeunload', this.boundHandlers.beforeUnload);

      // ?theme=real: set the sky PMREM environment BEFORE the shader
      // precompile below, so every material compiles once with its envmap
      // defines instead of recompiling mid-fly-in when the env appears.
      if (isRealTheme()) {
        this.scene.applyRealEnvironment(this.renderer.getRenderer());
      }

      // Pre-compile every shader program while the loading screen is still
      // up. Otherwise the first rendered frames compile ~50 programs
      // (toonified materials, sky, bloom) mid-fly-in — seconds of jank on
      // every refresh.
      this.ui.showLoading(100);
      try {
        const gl = this.renderer.getRenderer() as unknown as {
          compile: (scene: unknown, camera: unknown) => void;
          compileAsync?: (scene: unknown, camera: unknown) => Promise<unknown>;
        };
        if (typeof gl.compileAsync === 'function') {
          await gl.compileAsync(this.scene, this.scene.getCamera());
        } else {
          gl.compile(this.scene, this.scene.getCamera());
        }
        console.log('✓ Shaders pre-compiled');
      } catch (e) {
        console.warn('Shader pre-compile skipped:', e);
      }

      // Pitch FIRST: a recruiter learns who Abbas is before anything is asked
      // of them. The name prompt used to gate the whole site ("name yourself
      // for a multiplayer game" before the portfolio pitch) — it is now lazy,
      // asked only when a social feature actually needs a name (ensureNamed).
      const afterIntro = () => {
        let saved: string | null = null;
        try {
          saved = localStorage.getItem('ds_player_name');
        } catch {
          /* no storage */
        }
        if (saved) this.multiplayer?.setName(saved);
        // ?tour=1 share links go straight into the cinematic rail (skippable);
        // otherwise deep-linked visitors get their shared content directly and
        // everyone else gets the pitch.
        const wantTour = new URLSearchParams(window.location.search).get('tour') === '1';
        if (wantTour) this.startTour();
        else if (!this.openDeepLinkZone()) this.ui.showWelcome();
      };
      // Start the fly-in BEFORE the first frame renders: its first act is
      // placing the camera at the distant start, so no frame can ever show
      // the degenerate pre-placement view. The opaque loader then fades
      // out over the already-moving cinematic. Reduced-motion skips the
      // swoop entirely and drops straight into the settled follow view.
      if (a11y.reducedMotion) {
        afterIntro();
      } else {
        this.scene.getOrbitCamera().flyInFromDistant(2500).then(afterIntro);
      }

      // Warm the post-processing + shadow shaders on a hidden frame (camera is
      // already at the distant fly-in start) so the first VISIBLE frame doesn't
      // hitch — a cause of the reveal flash.
      this.renderer.warmUp(this.scene, this.scene.getCamera());

      // Start render loop
      this.startRenderLoop();
      console.log('✓ Render loop started');

      // Hold the loader a touch longer so a couple of clean frames render
      // before it fades over them (was 350ms — too eager, revealed mid-warmup).
      setTimeout(() => this.ui.hideLoading(), 500);

      // Register the service worker for instant repeat visits + offline shell.
      // Production only (SW caching would fight Vite HMR in dev), on load so it
      // never competes with the initial render.
      if (import.meta.env.PROD && 'serviceWorker' in navigator) {
        window.addEventListener('load', () => {
          navigator.serviceWorker.register('/sw.js').catch(() => {
            /* SW is a progressive enhancement — ignore failures */
          });
        });
      }

      // Background music synthesis is heavy — it generates a minute of stereo
      // samples with per-sample trig on the main thread. Running it during
      // init (as before) stalled the opening fly-in: the startup "lag". Defer
      // it to an idle slot after first paint; audio needs a user gesture to
      // play anyway, so nothing is lost by generating it lazily.
      const startMusic = () => void this.startBackgroundMusic();
      // Cloud profile: reconcile name/hat/coins once Firebase auth has settled.
      const syncProfile = () => void this.syncProfile();
      const idle = (cb: () => void, timeout: number) => {
        if ('requestIdleCallback' in window) {
          (
            window as unknown as {
              requestIdleCallback: (c: () => void, o?: { timeout: number }) => void;
            }
          ).requestIdleCallback(cb, { timeout });
        } else {
          setTimeout(cb, timeout / 3);
        }
      };
      idle(startMusic, 5000);
      idle(syncProfile, 4000);
      // (Vercel Analytics inject() moved to module top — pre-boot pageviews.)

      // Browsers create AudioContexts suspended until a user gesture; nothing
      // resumed it before, so music (and now SFX) stayed silent. Resume once
      // on the first key/click, unless the user has muted.
      const resumeAudio = () => {
        window.removeEventListener('keydown', resumeAudio);
        window.removeEventListener('pointerdown', resumeAudio);
        try {
          const am = (
            window as unknown as {
              audioManager?: { ensureCtx(): AudioContext; isMuted(): boolean };
            }
          ).audioManager;
          if (am && !am.isMuted()) void am.ensureCtx().resume();
        } catch {
          /* ignore */
        }
      };
      window.addEventListener('keydown', resumeAudio);
      window.addEventListener('pointerdown', resumeAudio);

      console.log('🌎 DigiScalability Life Island - Simplified Edition initialized!');

      // Debug: Log canvas visibility once so we can confirm it's mounted correctly
      console.log('🖼️ Canvas ready:', {
        width: canvas.width,
        height: canvas.height,
        style: canvas.style.cssText,
      });
    } catch (error) {
      console.error('❌ Failed to initialize app:', error);
      this.showErrorScreen(error as Error);
    }
  }

  /**
   * Remove existing static overlays from index.html so the simplified UI can take over
   */
  private disableLegacyUI(): void {
    // welcome-modal / hud-overlay were deleted from index.html; the pre-JS
    // #loading-screen placeholder is the only static element left to retire.
    const legacyIds = ['loading-screen'];
    legacyIds.forEach((id) => {
      const element = document.getElementById(id);
      if (element) {
        element.remove();
        console.log(`🧹 Removed legacy UI element: ${id}`);
      }
    });
  }

  /** Passport complete: grant + auto-equip the Golden Crown, persist, celebrate. */
  private grantPassportReward(): void {
    const hat = 'crown';
    if (!this.ownedHats.has(hat)) {
      this.ownedHats.add(hat);
      try {
        localStorage.setItem('ds_owned_hats', JSON.stringify([...this.ownedHats]));
      } catch {
        /* ignore */
      }
    }
    this.equippedHat = hat;
    try {
      localStorage.setItem('ds_hat', hat);
    } catch {
      /* ignore */
    }
    this.scene.equipPlayerHat(hat as HatId);
    this.multiplayer?.setHat(hat as HatId);
    this.ui.showPassportComplete();
  }

  /** True while a photo capture is composing, so P/📸 don't stack requests. */
  private capturing = false;

  /**
   * Photo mode: hide the HUD for one frame, capture the drawing buffer, brand
   * it into a share card, and preview it. The renderer captures in-frame (no
   * preserveDrawingBuffer) so the HUD must be hidden BEFORE the capture frame
   * and restored after.
   */
  private async capturePhoto(): Promise<void> {
    if (this.capturing) return;
    this.capturing = true;
    const overlay = this.ui.getOverlay();
    const prevVis = overlay?.style.visibility ?? '';
    try {
      if (overlay) overlay.style.visibility = 'hidden';
      // Let the hidden-HUD state paint, then grab the very next rendered frame.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const shot = await this.renderer.captureFrame();
      if (overlay) overlay.style.visibility = prevVis;
      if (!shot) {
        this.ui.flashMessage('📸 Capture failed — try again.');
        return;
      }
      const { composePhotoCard } = await import('./Share');
      const card = await composePhotoCard(shot);
      track('photo_captured');
      this.markDone('ds_photo_taken');
      this.ui.showPhotoPreview(card);
    } catch {
      if (overlay) overlay.style.visibility = prevVis;
      this.ui.flashMessage('📸 Capture failed — try again.');
    } finally {
      this.capturing = false;
    }
  }

  /**
   * Apply a /?hour=<0-24> override to the day/night clock and show a revert
   * pill. Lets a shared night link reveal the art most daytime visitors never
   * see. The revert restores the live clock and strips the param.
   */
  private applyHourParam(): void {
    try {
      const raw = new URLSearchParams(location.search).get('hour');
      if (raw === null) return;
      const h = Number(raw);
      if (!Number.isFinite(h) || h < 0 || h > 24) return;
      const env = this.scene.getEnvironmentCycle();
      if (!env) return;
      env.debugHour = h;
      const hh = Math.floor(h) % 24;
      const label = `🕐 ${((hh + 11) % 12) + 1}${hh < 12 ? 'am' : 'pm'}`;
      this.ui.showTimeOverridePill(label, () => {
        env.debugHour = null;
        try {
          const sp = new URLSearchParams(location.search);
          sp.delete('hour');
          const q = sp.toString();
          history.replaceState(null, '', `${location.pathname}${q ? `?${q}` : ''}`);
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
  }

  /**
   * One-time finale reward for delivering all ten packages: +25 coins and the
   * rare 😇 Halo (normally the priciest hat), owned + equipped. Guarded so a
   * refresh after completion doesn't re-grant. Mirrors the passport crown flow.
   */
  private grantCourierReward(): void {
    try {
      if (localStorage.getItem('ds_courier_reward') === '1') return;
      localStorage.setItem('ds_courier_reward', '1');
    } catch {
      /* storage blocked — still grant for this session */
    }
    this.scene.addCoins(25);
    this.ui.updateCoinCounter(this.scene.getCoinsCollected());
    const hat: HatId = 'halo';
    if (!this.ownedHats.has(hat)) {
      this.ownedHats.add(hat);
      try {
        localStorage.setItem('ds_owned_hats', JSON.stringify([...this.ownedHats]));
      } catch {
        /* ignore */
      }
    }
    this.equippedHat = hat;
    try {
      localStorage.setItem('ds_hat', hat);
    } catch {
      /* ignore */
    }
    this.scene.equipPlayerHat(hat);
    this.multiplayer?.setHat(hat);
    saveProfile({ hat, ownedHats: [...this.ownedHats], coins: this.scene.getCoinsCollected() });
    this.ui.flashMessage('🌟 Master Courier! +25 coins and the rare 😇 Halo — equipped.');
  }

  /**
   * Step inside a building: fade to black → move the camera into the interior
   * room → (zones) show the content panel over it → a Leave button. The player
   * world is frozen (GameScene.update), so leaving drops them back at the door.
   */
  // Short content shown on the interior side walls so entering a building
  // actually SHOWS the portfolio, not just its name (the full panel still opens).
  private static readonly INTERIOR_CONTENT: Record<string, [string, string]> = {
    welcome: ['5 districts\nto explore', 'Hand-built\nin Three.js'],
    professional: ['Abbas Ali\nFull-stack\nAI builder', 'Next.js · TS\nFirebase\nPython'],
    projects: ['RankPilot\nlive AI-SEO\nplatform', 'ChocoMate\nBano’s\nInsta Services'],
    personal: ['Food · Family\nCreative\ntooling', 'Melbourne,\nAustralia'],
    contact: ['Work with\nDigiScalability', 'admin@\ndigiscalability\n.com'],
  };

  // Which themed furniture set each zone building opens into (houses → cottage).
  private static readonly INTERIOR_THEMES: Record<string, string> = {
    welcome: 'hall',
    professional: 'office',
    projects: 'workshop',
    personal: 'home',
    contact: 'post',
  };

  // What building the player is currently inside (for hotspot actions + leave).
  private insideZone: { id: string; name: string } | null = null;
  private insideIsZone = false;

  /** Execute the interior hotspot the player pressed E on. */
  private runInteriorAction(hs: { action: string; text?: string }): void {
    if (hs.action === 'leave') {
      this.exitBuilding(this.insideIsZone);
    } else if (hs.action === 'times') {
      void this.ui.showIslandTimes();
    } else if (hs.action === 'panel' && this.insideZone) {
      this.ui.showZonePanel(
        { id: this.insideZone.id, name: this.insideZone.name },
        { source: 'proximity' },
      );
    } else if (hs.text) {
      this.ui.flashMessage(hs.text);
    }
  }

  private enterBuilding(id: string, isZone: boolean, zone?: { id: string; name: string }): void {
    if (this.scene.isInsideInterior()) return;
    const d = DISTRICTS.find((x) => x.id === id);
    const title = isZone ? (zone?.name ?? d?.name ?? id) : 'A cosy home';
    const wall = isZone ? (d?.accent ?? 0xcfc4ae) : 0xe0c9a8;
    const theme = isZone ? (SimpleApp.INTERIOR_THEMES[id] ?? 'hall') : 'cottage';
    this.insideZone = isZone ? (zone ?? { id, name: title }) : null;
    this.insideIsZone = isZone;
    const [left, right] = isZone
      ? (SimpleApp.INTERIOR_CONTENT[id] ?? ['', ''])
      : ['A place to\nrest', 'Someone\nlives here'];
    sfx.blip();
    this.markDone('ds_entered_building');
    this.ui.fadeThrough(() => {
      this.scene.enterInterior(title, wall, left, right, theme, isZone ? undefined : id);
      if (isZone && zone) {
        this.ui.showZonePanel({ id: zone.id, name: zone.name }, { source: 'proximity' });
      }
      this.ui.showLeaveButton(() => this.exitBuilding(isZone));
    });
  }

  private exitBuilding(isZone: boolean): void {
    this.ui.fadeThrough(() => {
      this.scene.exitInterior();
      this.ui.hideLeaveButton();
      if (isZone) this.ui.hideZonePanel();
    });
  }

  /** Open a section directly from a /?zone=<id> deep link, if present + valid. */
  /** Open a ?zone= deep link. Returns true when a panel was opened (the
   *  caller then skips the welcome modal — shared content comes first). */
  private openDeepLinkZone(): boolean {
    try {
      const z = new URLSearchParams(location.search).get('zone');
      if (!z) return false;
      if (['welcome', 'professional', 'projects', 'personal', 'contact'].includes(z)) {
        this.ui.hideWelcome();
        this.ui.showZonePanel({ id: z, name: z }, { source: 'deeplink' });
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  /**
   * Lazy naming: run `then` once the visitor has a name, prompting only the
   * first time a social feature (race leaderboard, chat) actually needs one.
   * An empty name from the prompt (skip) proceeds anonymously without saving.
   */
  private ensureNamed(then: () => void): void {
    try {
      if (localStorage.getItem('ds_player_name')) {
        then();
        return;
      }
    } catch {
      /* no storage — proceed to prompt */
    }
    this.ui.promptName('', (name) => {
      if (name) {
        this.multiplayer?.setName(name);
        saveProfile({ name });
      }
      then();
    });
  }

  private setupDebugShortcuts(): void {
    if (this.boundHandlers.debugKeydown) return;

    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        if (!this.renderer.isPostProcessingAvailable()) {
          console.log('✨ Bloom unavailable on this device tier (no composer).');
          return;
        }
        const enabled = this.renderer.togglePostProcessing();
        console.log(
          enabled
            ? '✨ Bloom enabled (Ctrl+B to toggle).'
            : '✨ Bloom disabled (Ctrl+B to toggle).',
        );
      } else if (event.key.toLowerCase() === 'c') {
        // Toggle the appearance editor
        if (this.ui['customizeDiv']) {
          this.ui.hideCustomize();
        } else {
          this.openCustomize();
        }
      } else if (event.key.toLowerCase() === 'p' && !event.ctrlKey && !event.metaKey) {
        // Photo mode — but not while typing in chat / the name field.
        const el = document.activeElement as HTMLElement | null;
        const typing =
          el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
        if (!typing) {
          event.preventDefault();
          void this.capturePhoto();
        }
      }
    };

    this.boundHandlers.debugKeydown = handler;
    document.addEventListener('keydown', handler);
  }

  /**
   * Start the main render loop
   */
  private startRenderLoop(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    // Signals the boot guard in index.html that the app really is running, so
    // it stands down (a late error must not blank a playable game). Distinct
    // from __lifeIslandBooted, which is set before construction as a
    // double-boot latch and so can't prove init succeeded.
    (window as unknown as { __lifeIslandReady?: boolean }).__lifeIslandReady = true;
    // Funnel denominator: pageviews vs world_ready shows how many visitors
    // actually got the 3D scene running (device/WebGL compatibility signal).
    // `ms` is time-to-interactive from navigation start — the cold-start cost.
    trackOnce('world_ready', {
      touch: this.ui.isTouchDevice(),
      ms: Math.round(performance.now()),
    });
    // Begin dwell tracking now that the world is up (fires session_end on leave).
    startDwellTracking();

    console.log('🔄 Starting render loop...');
    console.log('🔍 Render loop parameters:', {
      scene: this.scene,
      camera: this.scene.getCamera(),
      sceneChildren: this.scene.children.length,
      hasPlayer: !!this.scene.getPlayer(),
      hasPlanet: this.scene.children.some((child) => child.userData.type === 'planet'),
    });

    this.renderer.startRenderLoop(this.scene, this.scene.getCamera(), (deltaTime: number) =>
      this.update(deltaTime),
    );

    // Debug: Log that render loop is active after 1 second
    setTimeout(() => {
      console.log('✅ Render loop has been active for 1 second, FPS counter should show data');
    }, 1000);
  }

  /**
   * Update game logic (called every frame)
   */
  private update(deltaTime: number): void {
    // Update FPS counter
    this.updateFPS(deltaTime);

    // Completion meter: recompute on a slow cadence (plus immediately at each
    // flag site) so passport stamps landed elsewhere still surface here.
    this.completionAccum += deltaTime;
    if (this.completionAccum > 2.5) {
      this.completionAccum = 0;
      this.refreshCompletion();
    }

    // Only process input once the loader and welcome screen are gone
    if (!this.ui.isWelcomeVisible() && !this.ui.isLoadingVisible()) {
      // Cinematic tour: the rail owns the camera and the player stands still.
      // Everything else in the world keeps running (that's the point of it).
      if (this.tour) {
        this.scene.setPlayerMovement(0, 0);
        this.ui.hideInteractionPrompt();
        this.updateTour(deltaTime);
      } else if (this.scene.isInsideInterior()) {
        // Inside a building: the world is frozen; WASD/joystick walks the room
        // (GameScene's interior mode) and E interacts with the nearby hotspot.
        const moveInput = this.inputManager.getMovementInput();
        const joy = this.ui.getJoystick();
        this.scene.setInteriorMove(
          Math.max(-1, Math.min(1, moveInput.forward + joy.forward)),
          Math.max(-1, Math.min(1, moveInput.strafe + joy.strafe)),
        );
        const hs = this.scene.getInteriorHotspot();
        if (hs) {
          this.ui.showInteractionPrompt(hs.label);
          if (this.inputManager.consumeKeyPress('e')) {
            sfx.blip();
            this.runInteriorAction(hs);
          }
        } else {
          this.ui.hideInteractionPrompt();
        }
      } else if (this.ui.isDialogueActive()) {
        // If dialogue is active, E advances/closes it; suppress movement
        this.scene.setPlayerMovement(0, 0);
        this.ui.hideInteractionPrompt();
        const cameraInput = this.inputManager.getCameraInput();
        this.scene.setCameraInput(cameraInput.deltaX, cameraInput.deltaY);

        if (this.inputManager.consumeKeyPress('e')) {
          sfx.blip();
          this.ui.advanceDialogue();
        }

        // Walking away from the NPC closes dialogue
        const nearby = this.scene.getNearbyInteractable();
        if (!nearby || nearby.type !== 'npc') {
          this.ui.hideDialogue();
        }
      } else if (this.scene.isPlayerSeated()) {
        // Seated on a bench: movement suppressed, E stands back up
        this.scene.setPlayerMovement(0, 0);
        this.ui.showInteractionPrompt('🪑 Press <strong>E</strong> to stand up');
        const cameraInput = this.inputManager.getCameraInput();
        this.scene.setCameraInput(cameraInput.deltaX, cameraInput.deltaY);
        if (this.inputManager.consumeKeyPress('e')) {
          this.scene.standUpFromBench();
          this.ui.hideInteractionPrompt();
        }
      } else if (this.scene.isRidingVehicle()) {
        // Driving a boat/jetski: WASD/joystick steers the craft; E hops off
        const moveInput = this.inputManager.getMovementInput();
        const joy = this.ui.getJoystick();
        const vFwd = Math.max(-1, Math.min(1, moveInput.forward + joy.forward));
        const vStrafe = Math.max(-1, Math.min(1, moveInput.strafe + joy.strafe));
        this.scene.setVehicleMove(vFwd, vStrafe);
        this.currentThrottle = Math.max(Math.abs(vFwd), Math.abs(vStrafe) * 0.5);
        const cameraInput = this.inputManager.getCameraInput();
        this.scene.setCameraInput(cameraInput.deltaX, cameraInput.deltaY);
        this.ui.showInteractionPrompt('🚤 Press <strong>E</strong> to hop off');
        if (this.inputManager.consumeKeyPress('e')) {
          this.scene.disembarkVehicle();
          this.ui.hideInteractionPrompt();
        }
        this.ui.updateBreath(1, false);
      } else {
        // Get input
        const moveInput = this.inputManager.getMovementInput();
        const cameraInput = this.inputManager.getCameraInput();
        const jumpInput = this.inputManager.getJumpInput();

        // Apply player input (keyboard merged with the touch joystick)
        const joy = this.ui.getJoystick();
        this.scene.setPlayerMovement(
          Math.max(-1, Math.min(1, moveInput.forward + joy.forward)),
          Math.max(-1, Math.min(1, moveInput.strafe + joy.strafe)),
        );
        const player = this.scene.getPlayer();
        // Swim: hold Space to stay afloat in water (same key jumps on land)
        if (player) player.setSwimIntent(jumpInput);
        if (jumpInput && player && !player.isInWater()) {
          // Edge-triggered: one blip per press, only from the ground
          if (player.isOnGround() && !this.prevJumpHeld) sfx.jump();
          this.scene.playerJump();
        }
        this.prevJumpHeld = jumpInput;
        // Breath meter + underwater vignette
        if (player) this.ui.updateBreath(player.getOxygen(), player.isInWater());
        // Shoreline barrier: nudge the swimmer back with a throttled hint
        if (player && player.isBeyondSwimLimit()) {
          const now = performance.now();
          if (now - this.lastSwimWarnAt > 4500) {
            this.lastSwimWarnAt = now;
            this.ui.flashMessage('🌊 The current pulls you back to shore');
          }
        }

        // Wave at nearby visitors — peers see it, and the townsfolk wave back
        if (this.inputManager.consumeKeyPress('q')) {
          this.multiplayer?.wave();
          this.scene.greetNearbyNPCs();
          sfx.blip();
        }

        // Footsteps while walking; thud when landing from a real jump/fall
        if (player) {
          const grounded = player.isOnGround();
          const speed = player.getTangentialSpeed();
          if (!grounded) {
            this.airborneTime += deltaTime;
          } else {
            if (this.airborneTime > 0.12) {
              sfx.land();
              this.scene.spawnDust(player.getWorldPosition(), 6);
            }
            this.airborneTime = 0;
          }
          const onFoot = speed > 0.8 && this.airborneTime < 0.12;
          // Prefer clip-synced footfalls: the avatar exposes its normalised
          // walk-cycle phase (added by the avatar rig this wave). Firing on the
          // two mid-stride plants locks footsteps to the animation instead of a
          // distance accumulator that visibly drifts as speed varies. The getter
          // is optional — fall back to the accumulator when it's absent.
          const walkPhase = (player as { getWalkCyclePhase?: () => number }).getWalkCyclePhase?.();
          if (typeof walkPhase === 'number') {
            if (onFoot) {
              // Two footfalls per cycle; alt-foot falls out of which plant fired.
              if (this.crossedPhase(this.prevWalkPhase, walkPhase, 0.25)) {
                this.stepAlt = false;
                sfx.footstep(this.stepAlt);
                this.scene.spawnDust(player.getWorldPosition(), 1);
              }
              if (this.crossedPhase(this.prevWalkPhase, walkPhase, 0.75)) {
                this.stepAlt = true;
                sfx.footstep(this.stepAlt);
                this.scene.spawnDust(player.getWorldPosition(), 1);
              }
              this.prevWalkPhase = walkPhase;
            } else {
              // Not striding: reset so a resumed walk never fires from a stale phase.
              this.prevWalkPhase = -1;
            }
          } else if (onFoot) {
            this.stepAccum += speed * deltaTime;
            if (this.stepAccum > 1.7) {
              this.stepAccum = 0;
              this.stepAlt = !this.stepAlt;
              sfx.footstep(this.stepAlt);
              this.scene.spawnDust(player.getWorldPosition(), 1);
            }
          } else if (speed <= 0.8) {
            // Primed so the first step after moving again lands quickly
            this.stepAccum = 1.0;
          }
        }

        // Apply camera input (mouse/touch)
        this.scene.setCameraInput(cameraInput.deltaX, cameraInput.deltaY);

        // Check for nearby interactable and handle interaction.
        // Interpolated values are HTML-escaped: the prompt renders via
        // innerHTML (for the <strong> keycap), and names/bubble text must
        // never become an XSS vector once they turn dynamic (multiplayer).
        const esc = (s: string) =>
          s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const board = this.scene.nearestBoardable();
        const nearby = this.scene.getNearbyInteractable();
        // Nearest thing wins: the vehicle only takes the prompt when it is
        // actually the closest interactable — a parked car used to shadow
        // every NPC, mailbox and cottage door within its 3.2u board range.
        if (board.idx >= 0 && board.dist < (nearby?.distance ?? Infinity)) {
          // A vehicle is within reach (swim up to craft / walk up to a car)
          const kind = this.scene.vehicleKind(board.idx);
          const icon = kind === 'jetski' ? '🌊' : kind === 'car' ? '🚗' : '⛵';
          const verb = kind === 'car' ? 'drive' : 'ride';
          this.ui.showInteractionPrompt(`${icon} Press <strong>E</strong> to ${verb}`);
          if (this.inputManager.consumeKeyPress('e')) {
            this.scene.boardVehicle(board.idx);
            sfx.blip();
            track('vehicle_enter', { kind });
          }
        } else if (player && player.isInWater() && !player.isSwimming()) {
          // In the water and sinking: tell them how to swim
          this.ui.showInteractionPrompt('🏊 Hold <strong>Space</strong> to swim');
        } else if (nearby) {
          // Show interaction prompt
          let text = '⌨️ Press <strong>E</strong> to interact';
          if (nearby.type === 'mailbox') {
            // State-aware copy: the glowing mailbox's prompt should CONFIRM
            // "this is the one" — the old generic line never did.
            text = nearby.mailbox.bubbleText
              ? esc(nearby.mailbox.bubbleText)
              : nearby.mailbox.hasDelivery
                ? '📬 Press <strong>E</strong> to collect the delivery'
                : '📭 Press <strong>E</strong> to check the mailbox';
          } else if (nearby.type === 'lamp') {
            text = '💡 Press <strong>E</strong> to toggle lamp';
          } else if (nearby.type === 'zone') {
            text = `🚪 Press <strong>E</strong> to enter ${esc(nearby.zone.name)}`;
          } else if (nearby.type === 'house_door') {
            text = '🚪 Press <strong>E</strong> to enter';
          } else if (nearby.type === 'npc') {
            // AI townsfolk advertise free-text chat — "talk" alone reads as a
            // canned dialogue tree, and visitors never discover the real LLM.
            text = isAiNpc(nearby.npcData.name)
              ? `💬 Press <strong>E</strong> to talk to <strong>${esc(nearby.npcData.name)}</strong> — ask anything`
              : `💬 Press <strong>E</strong> to talk to <strong>${esc(nearby.npcData.name)}</strong>`;
          } else if (nearby.type === 'bench') {
            text = '🪑 Press <strong>E</strong> to sit down';
          }
          this.ui.showInteractionPrompt(text);

          if (this.inputManager.consumeKeyPress('e')) {
            this.scene.interactWith(nearby);
          }
        } else if (this.multiplayer && this.multiplayer.nearestPeerDistance() < 4) {
          // Another visitor is close: offer a wave
          this.ui.showInteractionPrompt('👋 Press <strong>Q</strong> to wave');
        } else {
          // Hide prompt when not near interactable
          this.ui.hideInteractionPrompt();
        }
      }
    } else {
      // Stop player movement when welcome screen is visible
      this.scene.setPlayerMovement(0, 0);
      this.scene.setCameraInput(0, 0);
    }

    // Quest compass: point at the active delivery's mailbox
    this.updateQuestCompass();

    // Minimap: player + NPCs + plazas + delivery target + online peers
    // (throttled to 10 Hz). Peers come from Multiplayer (GameScene stays
    // decoupled from the network layer), merged in here.
    this.mapAccum += deltaTime;
    if (this.mapAccum > 0.1) {
      this.mapAccum = 0;
      const mapData = this.scene.getMinimapData();
      // Project peers through the same player-centred radar basis getMinimapData
      // just set up (worldToRadar reads the cached basis).
      const peers = this.multiplayer
        ? this.multiplayer.getPeerWorlds().map((p) => ({
            ...this.scene.worldToRadar(p.pos),
            waving: p.waving,
          }))
        : [];
      this.ui.updateMinimap({
        ...mapData,
        peers,
        online: (this.multiplayer ? this.multiplayer.getPeerCount() : 0) + 1,
      });
    }

    // Rain ambience follows the live weather (no-op unless the level changes)
    sfx.setRainLevel(this.scene.getEnvironmentCycle()?.getWeather() === 'rain' ? 1 : 0);

    // Ambient sea swell — a distant murmur inland, coastal near the shore,
    // full when in the water (quantised so setSeaLevel only fires on changes).
    const audioPlayer = this.scene.getPlayer();
    if (audioPlayer) {
      const wp = audioPlayer.getWorldPosition();
      const lat = Math.asin(Math.max(-1, Math.min(1, wp.y / (wp.length() || 1))));
      let sea = lat < 0.5 ? 0.45 : 0.15;
      if (audioPlayer.isInWater()) sea = 1;
      sfx.setSeaLevel(sea);
    }
    // Vehicle engine loop while driving; silent on foot
    if (this.scene.isRidingVehicle()) {
      sfx.setEngine(this.scene.getActiveVehicleKind(), this.currentThrottle);
    } else {
      sfx.setEngine(null, 0);
    }

    // Multiplayer: broadcast our state (incl. the vehicle index + transform
    // we're driving) and interpolate peers, then apply peers' vehicles onto
    // the shared world vehicles — so a peer drives the real craft (right
    // colour) and a car they park stays there for anyone to drive.
    this.multiplayer?.setVehicle(this.scene.getActiveVehicleState());
    this.multiplayer?.update(deltaTime);
    this.chat?.update(deltaTime);

    // First time a real visitor comes within chat range, surface how to
    // interact (idempotent + persisted, so this is effectively free after once).
    if (this.multiplayer && this.multiplayer.nearestPeerDistance() < PROXIMITY_RADIUS) {
      this.ui.showProximityCoachMark();
    }

    // Drive the Web Audio listener from the local player + camera each frame so
    // positional voice (and spatial sfx) is heard from the character's location
    // and facing. Nothing else updates the listener, so without this the whole
    // 3D audio field sits inert at the origin.
    const am = (
      window as unknown as {
        audioManager?: {
          updateListener?: (
            p: { x: number; y: number; z: number },
            f?: { x: number; y: number; z: number },
            u?: { x: number; y: number; z: number },
          ) => void;
        };
      }
    ).audioManager;
    if (am?.updateListener && this.scene) {
      // Vector3 satisfies the {x,y,z} shape updateListener reads, and it copies
      // the values out synchronously, so reusing these scratches is safe.
      const lp = this._listenerPos.copy(this.scene.getPlayer().getWorldPosition());
      const fwd = this.scene.getCamera().getWorldDirection(this._listenerFwd);
      am.updateListener(lp, fwd, this._listenerUp);
    }
    if (this.multiplayer) {
      this.scene.syncRemoteVehicles(this.multiplayer.getRemoteVehicleStates());
    }

    // Always update scene (for animations, etc.)
    this.scene.update(deltaTime);
  }

  /**
   * Compute the bearing from the camera's forward direction to the active
   * delivery target (both projected onto the player's tangent plane) and
   * feed it to the HUD compass. Hidden when the chain is complete.
   */
  private updateQuestCompass(): void {
    const player = this.scene.getPlayer();
    if (!player) {
      this.ui.updateQuestCompass(null);
      return;
    }
    // Copy into scratch (getWorldPosition/getSurfaceNormal return fresh clones)
    // so the active-delivery path allocates nothing.
    const playerPos = this._qcPlayerPos.copy(player.getWorldPosition());
    const normal = this._qcNormal.copy(player.getSurfaceNormal());

    // PORTFOLIO first for new visitors: until the first district is stamped,
    // the compass guides to the nearest unstamped zone even while the
    // auto-active delivery chain runs (it used to read "📬 Delivery" from the
    // very first frame, steering every new visitor to a mini-game before
    // they'd seen a single piece of Abbas's work). After the first stamp,
    // active deliveries take priority as before.
    const active = this.deliverySystem?.getActiveDeliveries?.() ?? [];
    const delivery = active.length > 0 ? active[0] : null;
    const zone = this.nearestUnstampedZone(playerPos);
    const portfolioFirst = (this.passport?.count() ?? 0) === 0;
    let targetPos: THREE.Vector3 | null = null;
    let label = '';
    if (this.aiGuideTarget) {
      // "Meet the AI townsfolk" welcome CTA — outranks everything until the
      // visitor talks to an AI NPC (cleared in the chat-open branch).
      targetPos = this.aiGuideTarget;
      label = '🤖 The Storyteller';
    } else if (this.raceGuideTarget) {
      // "Beat the lap record" CTA — explicit intent, cleared when a race starts.
      targetPos = this.raceGuideTarget;
      label = '🏁 Race start';
    } else if (zone && (portfolioFirst || !delivery?.destination)) {
      targetPos = zone.pos;
      label = `${PASSPORT_META[zone.id].icon} ${PASSPORT_META[zone.id].label}`;
    } else if (delivery?.destination) {
      targetPos = delivery.destination.mesh.position;
      label = '📬 Delivery';
    }
    if (!targetPos) {
      this.ui.updateQuestCompass(null);
      this.scene.setGuideTarget(null);
      return;
    }

    // Feed the in-world breadcrumb trail the same target as the HUD compass
    this.scene.setGuideTarget(targetPos);

    // Bearing vectors projected onto the player's tangent plane (reused scratch).
    const toTarget = this.projectTangent(
      this._qcToTarget,
      this._qcTmp.copy(targetPos).sub(playerPos),
      normal,
    );
    const camForward = this.projectTangent(
      this._qcCamFwd,
      this.scene.getOrbitCamera().getForwardDirection(),
      normal,
    );
    if (toTarget.lengthSq() < 1e-6 || camForward.lengthSq() < 1e-6) {
      this.ui.updateQuestCompass(null);
      return;
    }
    toTarget.normalize();
    camForward.normalize();
    const cross = this._qcCross.copy(camForward).cross(toTarget);
    const angleRad = Math.atan2(cross.dot(normal), camForward.dot(toTarget));
    // great-circle distance on the planet surface
    const R = playerPos.length();
    // _qcTmp and _qcCross are free again here; reuse them for the two great-circle endpoints.
    const arc = this._qcTmp
      .copy(playerPos)
      .normalize()
      .angleTo(this._qcCross.copy(targetPos).normalize());
    this.ui.updateQuestCompass({
      angleRad,
      distance: arc * R,
      label,
    });
  }

  /**
   * Nearest passport zone the visitor hasn't stamped yet, for the compass
   * guide-me fallback. Returns null once the passport is complete (compass off)
   * or before the passport exists. Only the four stamp zones count \u2014 the pole
   * Welcome hub is the intro, not a destination.
   */
  private nearestUnstampedZone(
    playerPos: THREE.Vector3,
  ): { pos: THREE.Vector3; id: PassportZone } | null {
    if (!this.passport || this.passport.isComplete()) return null;
    let best: { pos: THREE.Vector3; id: PassportZone } | null = null;
    let bestD = Infinity;
    for (const z of this.scene.getZonesManager().getZones()) {
      if (!this.passport.isStampZone(z.id) || this.passport.has(z.id)) continue;
      const zp = z.getPosition();
      const d = zp.distanceToSquared(playerPos);
      if (d < bestD) {
        bestD = d;
        best = { pos: zp, id: z.id as PassportZone };
      }
    }
    return best;
  }

  // \u2500\u2500 Tour mode: skippable cinematic rail (welcome CTA / ?tour=1) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  private static readonly TOUR_FLY_S = 2.6; // seconds flying between stops
  private static readonly TOUR_DWELL_S = 6.0; // seconds studying each stop

  /**
   * Build the rail and hand the camera to it. Stops are derived from live
   * world state (zone plazas + a working NPC), so the tour survives layout
   * changes for free. No-op if already touring or inside a building.
   */
  private startTour(): void {
    if (this.tour || this.scene.isInsideInterior()) return;
    const zones = new Map(
      this.scene
        .getZonesManager()
        .getZones()
        .map((z) => [z.id, z.getPosition()] as const),
    );
    const stops: Array<{ caption: string; look: THREE.Vector3; dir: THREE.Vector3; r: number }> =
      [];
    const addStop = (
      p: THREE.Vector3 | null | undefined,
      caption: string,
      alt: number,
      back: number,
    ) => {
      if (!p) return;
      const up = p.clone().normalize();
      const tan = new THREE.Vector3(0, 1, 0).cross(up);
      if (tan.lengthSq() < 0.05) tan.set(1, 0, 0).cross(up);
      tan.normalize();
      const camPos = p.clone().addScaledVector(up, alt).addScaledVector(tan, back);
      stops.push({
        caption,
        look: p.clone().addScaledVector(up, 1.4),
        dir: camPos.clone().normalize(),
        r: camPos.length(),
      });
    };
    addStop(
      zones.get('welcome'),
      "Welcome to Life Island \u2014 Abbas Ali's portfolio, built as a living planet you can walk around.",
      24,
      8,
    );
    addStop(
      zones.get('professional'),
      'The Professional District \u2014 full-stack and AI engineering. Step inside the office for the story.',
      9.5,
      14,
    );
    addStop(
      zones.get('projects'),
      'The Projects District \u2014 ventures under construction: RankPilot, ChocoMate, and friends.',
      9.5,
      14,
    );
    addStop(
      this.scene.getNpcPosition('Gardener') ?? this.scene.getNpcPosition('Guard'),
      'Every townsperson is a live AI agent \u2014 planned each morning, reported on nightly. Talk to anyone.',
      // High enough to clear tree canopies \u2014 NPC positions are live, so a low
      // camera is occlusion roulette (a prod capture found a tree filling it).
      6.5,
      9,
    );
    addStop(
      zones.get('personal'),
      'The Personal District \u2014 the human behind the code, and the cottages the townsfolk sleep in.',
      9.5,
      14,
    );
    addStop(
      zones.get('contact'),
      'Get In Touch \u2014 the Post Office sends Abbas a real email. The island is yours from here.',
      8.5,
      13,
    );
    if (stops.length === 0) return;
    track('tour_start');
    const cam = this.scene.getCamera();
    this.scene.setCameraSuspended(true);
    this.ui.hideInteractionPrompt();
    const playerPos = this.scene.getPlayer()?.getWorldPosition() ?? stops[0].look.clone();
    this.tour = {
      stops,
      idx: 0,
      t: 0,
      phase: 'fly',
      fromDir: cam.position.clone().normalize(),
      fromR: Math.max(cam.position.length(), 20),
      fromLook: playerPos.clone(),
    };
    this.ui.showTourOverlay(() => this.endTour(true));
    this.ui.setTourCaption(stops[0].caption);
  }

  private updateTour(dt: number): void {
    const tour = this.tour;
    if (!tour) return;
    const cam = this.scene.getCamera();
    const stop = tour.stops[tour.idx];
    tour.t += dt;
    if (tour.phase === 'fly') {
      const k = Math.min(1, tour.t / SimpleApp.TOUR_FLY_S);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.slerpDirs(this._tourDir, tour.fromDir, stop.dir, e);
      // Altitude hop: arcing over the terrain beats a chord that dips through it
      const r = tour.fromR + (stop.r - tour.fromR) * e + Math.sin(Math.PI * e) * 7;
      cam.position.copy(this._tourDir).multiplyScalar(r);
      this._tourLook.copy(tour.fromLook).lerp(stop.look, e);
      cam.up.copy(this._tourUp.copy(cam.position).normalize());
      cam.lookAt(this._tourLook);
      if (k >= 1) {
        tour.phase = 'dwell';
        tour.t = 0;
      }
    } else {
      // Gentle drift around the stop while the caption is read
      const up = this._tourUp.copy(stop.look).normalize();
      this._tourQ.setFromAxisAngle(up, 0.045 * dt);
      stop.dir.applyQuaternion(this._tourQ);
      cam.position.copy(stop.dir).multiplyScalar(stop.r);
      cam.up.copy(up);
      cam.lookAt(stop.look);
      if (tour.t >= SimpleApp.TOUR_DWELL_S) this.advanceTourStop();
    }
  }

  private advanceTourStop(): void {
    const tour = this.tour;
    if (!tour) return;
    if (tour.idx + 1 >= tour.stops.length) {
      this.endTour(false);
      return;
    }
    const cam = this.scene.getCamera();
    const prev = tour.stops[tour.idx];
    tour.idx += 1;
    tour.phase = 'fly';
    tour.t = 0;
    tour.fromDir.copy(cam.position).normalize();
    tour.fromR = cam.position.length();
    tour.fromLook.copy(prev.look);
    this.ui.setTourCaption(tour.stops[tour.idx].caption);
  }

  private endTour(skipped: boolean): void {
    if (!this.tour) return;
    this.tour = null;
    this.ui.hideTourOverlay();
    this.scene.setCameraSuspended(false);
    track(skipped ? 'tour_skip' : 'tour_complete');
    this.ui.flashMessage('\ud83e\udded The island is yours \u2014 walk anywhere, talk to anyone');
  }

  /**
   * Constant-speed rotation from direction `a` to `b` (unit vectors) by
   * fraction `t`, written into `out`. Plain lerp+normalize is speed-warped on
   * big arcs; the stops are up to ~90\u00b0 apart so the warp would be visible.
   */
  private slerpDirs(out: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, t: number): void {
    const angle = a.angleTo(b);
    if (angle < 1e-4) {
      out.copy(b);
      return;
    }
    this._tourAxis.copy(a).cross(b);
    if (this._tourAxis.lengthSq() < 1e-8) {
      // Near-antipodal: any perpendicular axis works
      this._tourAxis.set(0, 1, 0).cross(a);
      if (this._tourAxis.lengthSq() < 1e-8) this._tourAxis.set(1, 0, 0).cross(a);
    }
    this._tourAxis.normalize();
    this._tourQ.setFromAxisAngle(this._tourAxis, angle * t);
    out.copy(a).applyQuaternion(this._tourQ).normalize();
  }

  /** "Beat the lap record" CTA \u2192 compass to the land start gate (water fallback). */
  private guideToRace(): void {
    const pos = this.scene.getRaceStartPosition('land') ?? this.scene.getRaceStartPosition('water');
    if (!pos) return;
    this.raceGuideTarget = pos;
    this.ui.flashMessage(
      '\ud83c\udfc1 Follow the compass to the start gate \u2014 grab a car and drive through the glowing rings',
    );
  }

  /** Set a one-shot completion flag + refresh the meter immediately. */
  private markDone(key: string): void {
    try {
      localStorage.setItem(key, '1');
    } catch {
      /* no storage */
    }
    this.refreshCompletion();
  }

  /**
   * The visitor-goal loop: everything worth doing on the island, one weight
   * each. Stamps read the live passport; one-shot acts are localStorage flags
   * set at their event sites (and re-polled every 2.5s, so flags flipped deep
   * inside the UI layer surface without extra wiring).
   */
  private refreshCompletion(): void {
    const flag = (k: string): boolean => {
      try {
        return localStorage.getItem(k) === '1';
      } catch {
        return false;
      }
    };
    const stampIds = (Object.keys(PASSPORT_META) as PassportZone[]).filter(
      (id) => this.passport?.isStampZone(id) ?? false,
    );
    const items = [
      ...stampIds.map((id) => ({
        icon: PASSPORT_META[id].icon,
        label: `Visit ${PASSPORT_META[id].label}`,
        done: this.passport?.has(id) ?? false,
        hint: 'Walk into the district plaza \u2014 the compass points the way.',
      })),
      {
        icon: '\ud83d\udcac',
        label: 'Talk with an AI townsperson',
        done: flag('ds_npc_chatted'),
        hint: 'Walk up to anyone with a name tag and press E.',
      },
      {
        icon: '\ud83c\udfc1',
        label: 'Finish a race',
        done: flag('ds_raced'),
        hint: 'Hop in a car or boat and drive through the white start ring.',
      },
      {
        icon: '\ud83d\udcec',
        label: 'Complete the courier chain',
        done: flag('ds_courier_reward'),
        hint: 'Deliver every parcel \u2014 glowing mailboxes have one waiting.',
      },
      {
        icon: '\ud83d\udc4b',
        label: 'Say hi or sign the guestbook',
        done: flag('ds_said_hi'),
        hint: 'The \ud83d\udc4b Say hi button \u2014 five seconds, promise.',
      },
      {
        icon: '\ud83d\udcf0',
        label: 'Read the Island Times',
        done: flag('ds_read_times'),
        hint: '\ud83d\udcd6 Portfolio menu \u2192 Island Times: the AI-compiled daily.',
      },
      {
        icon: '\ud83d\udcf8',
        label: 'Take an island photo',
        done: flag('ds_photo_taken'),
        hint: 'Press P (or the \ud83d\udcf8 pill) anywhere pretty.',
      },
      {
        icon: '\ud83c\udfe0',
        label: 'Step inside a building',
        done: flag('ds_entered_building'),
        hint: 'Walk to any door and press E.',
      },
    ];
    const done = items.filter((i) => i.done).length;
    this.ui.setCompletion(Math.round((done / items.length) * 100), items);
  }

  /**
   * True when a normalised walk phase [0,1) swept past `thr` between the
   * previous and current sample, accounting for the 1\u21920 wrap. `prev < 0` marks
   * a freshly (re)started stride, so nothing has been crossed yet.
   */
  private crossedPhase(prev: number, cur: number, thr: number): boolean {
    if (prev < 0) return false;
    if (cur >= prev) return prev < thr && thr <= cur;
    return thr > prev || thr <= cur; // wrapped past 1.0 this frame
  }

  /** Project `v` onto the tangent plane defined by `normal`, writing into `out`. */
  private projectTangent(
    out: THREE.Vector3,
    v: THREE.Vector3,
    normal: THREE.Vector3,
  ): THREE.Vector3 {
    out.copy(v);
    return out.addScaledVector(normal, -out.dot(normal));
  }

  /**
   * Update FPS counter
   */
  private updateFPS(deltaTime: number): void {
    this.frameCount++;
    this.fpsUpdateInterval += deltaTime;

    if (this.fpsUpdateInterval >= 1.0) {
      // Update every second
      const fps = this.frameCount / this.fpsUpdateInterval;
      this.ui.updateFPS(fps);
      this.frameCount = 0;
      this.fpsUpdateInterval = 0;
    }
  }

  /**
   * Open the island shop: buy hats with coins, equip owned ones. The UI
   * re-renders after every action so balances and buttons stay current.
   */
  private openShop(): void {
    const render = () => {
      this.ui.showShop(
        {
          coins: this.scene.getCoinsCollected(),
          items: this.hatCatalog.map((h) => ({
            ...h,
            owned: this.ownedHats.has(h.id),
            equipped: this.equippedHat === h.id,
          })),
        },
        (id) => {
          const item = this.hatCatalog.find((h) => h.id === id);
          if (!item) return;
          if (!this.ownedHats.has(id)) {
            if (!this.scene.spendCoins(item.price)) return;
            this.ownedHats.add(id);
            try {
              localStorage.setItem('ds_owned_hats', JSON.stringify([...this.ownedHats]));
            } catch {
              /* session-only */
            }
            sfx.coin();
          } else {
            sfx.blip();
          }
          this.equippedHat = id;
          try {
            localStorage.setItem('ds_hat', id);
          } catch {
            /* session-only */
          }
          this.scene.equipPlayerHat(id as HatId);
          this.multiplayer?.setHat(id as HatId);
          saveProfile({ hat: id, ownedHats: [...this.ownedHats] });
          track('hat_equipped', { hat: id });
          render();
        },
        () => {
          /* closed */
        },
      );
    };
    render();
  }

  /**
   * Open the appearance editor (C): live-recolour body parts + pick an owned
   * hat. Each change applies to the model immediately and persists (local +
   * cloud profile).
   */
  private openCustomize(): void {
    const player = this.scene.getPlayer();
    if (!player) return;
    const appr = player.getAppearance();
    const colors: Record<string, number | undefined> = { ...appr };
    this.ui.showCustomize({
      colors,
      ownedHats: [...this.ownedHats],
      equippedHat: this.equippedHat,
      hats: this.hatCatalog.map((h) => ({ id: h.id, icon: h.icon })),
      onColor: (part, hex) => {
        player.setBodyColor(part as BodyPart, hex);
        this.saveAppearance();
      },
      onHat: (id) => {
        this.equippedHat = id;
        try {
          if (id) localStorage.setItem('ds_hat', id);
          else localStorage.removeItem('ds_hat');
        } catch {
          /* session-only */
        }
        this.scene.equipPlayerHat((id as HatId) ?? null);
        this.multiplayer?.setHat((id as HatId) ?? null);
        saveProfile({ hat: id, ownedHats: [...this.ownedHats] });
      },
    });
  }

  /** Persist the current body colours to localStorage + the cloud profile. */
  private saveAppearance(): void {
    const colors = this.currentColorsHex();
    try {
      localStorage.setItem('ds_appearance', JSON.stringify(colors));
    } catch {
      /* session-only */
    }
    saveProfile({ colors });
  }

  /**
   * Pull the cloud profile once Firebase auth settles and reconcile it with
   * the local state: owned hats are unioned, an equipped hat is restored if the
   * local wardrobe has none, and coins take the higher of the two (progress is
   * never lost). The current name is written back but never overridden — name
   * stays owned by localStorage / the on-visit prompt. Then the merged state is
   * pushed back so the cloud reflects this device.
   */
  private async syncProfile(): Promise<void> {
    const res = await loadProfile();
    if (!res) return;
    const { profile } = res;
    if (profile) {
      if (profile.ownedHats?.length) {
        this.ownedHats = new Set<string>([...profile.ownedHats, ...this.ownedHats]);
        try {
          localStorage.setItem('ds_owned_hats', JSON.stringify([...this.ownedHats]));
        } catch {
          /* session-only */
        }
      }
      if (profile.hat && !this.equippedHat) {
        this.equippedHat = profile.hat;
        try {
          localStorage.setItem('ds_hat', profile.hat);
        } catch {
          /* session-only */
        }
        this.scene.equipPlayerHat(profile.hat as HatId);
        this.multiplayer?.setHat(profile.hat as HatId);
      }
      if (typeof profile.coins === 'number' && profile.coins > this.scene.getCoinsCollected()) {
        this.scene.setCoins(profile.coins);
      }
      // Body colours: apply the cloud choice for any part not set locally
      if (profile.colors) {
        const player = this.scene.getPlayer();
        const local = player?.getAppearance() ?? {};
        for (const key of Object.keys(profile.colors)) {
          if (local[key as BodyPart] === undefined) {
            const hex = parseInt(profile.colors[key].replace('#', ''), 16);
            if (Number.isFinite(hex)) player?.setBodyColor(key as BodyPart, hex);
          }
        }
      }
    }
    saveProfile({
      name: this.multiplayer?.selfName,
      hat: this.equippedHat,
      ownedHats: [...this.ownedHats],
      coins: this.scene.getCoinsCollected(),
      colors: this.currentColorsHex(),
    });
  }

  /** Current body colours as hex strings (for persistence). */
  private currentColorsHex(): Record<string, string> {
    const appr = this.scene.getPlayer()?.getAppearance() ?? {};
    const out: Record<string, string> = {};
    for (const key of Object.keys(appr)) {
      const hex = appr[key as BodyPart];
      if (typeof hex === 'number') out[key] = `#${hex.toString(16).padStart(6, '0')}`;
    }
    return out;
  }

  /**
   * Start background music
   */
  private async startBackgroundMusic(): Promise<void> {
    try {
      // Create audio manager if not exists
      if (!(window as any).audioManager) {
        (window as any).audioManager = new (await import('./AudioManager')).AudioManager();
      }
      const audioManager = (window as any).audioManager;

      console.log('🎵 Generating ambient background music...');

      const ctx = audioManager.ensureCtx();
      const sr = ctx.sampleRate;
      // 60s loop (was 120): halves synthesis cost/memory; the pad+melody
      // cycles still line up, and it loops seamlessly for ambience.
      const duration = 60;
      const N = sr * duration;
      const buffer = ctx.createBuffer(2, N, sr);

      // --- Musical constants ---
      const TAU = 2 * Math.PI;
      // Pentatonic scale frequencies (C major pentatonic across two octaves)
      const NOTE = {
        C3: 130.81,
        D3: 146.83,
        E3: 164.81,
        G3: 196.0,
        A3: 220.0,
        C4: 261.63,
        D4: 293.66,
        E4: 329.63,
        G4: 392.0,
        A4: 440.0,
        C5: 523.25,
        E5: 659.25,
        G5: 783.99,
      };

      // Chord progression: 10s per chord, cycles every 40s
      const chords = [
        { bass: NOTE.C3, tones: [NOTE.C4, NOTE.E4, NOTE.G4] }, // Cmaj
        { bass: NOTE.A3 * 0.5, tones: [NOTE.A3, NOTE.C4, NOTE.E4] }, // Am
        { bass: NOTE.G3 * 0.5, tones: [NOTE.G3, NOTE.D4, NOTE.G4] }, // G5sus
        { bass: NOTE.C3, tones: [NOTE.E4, NOTE.G4, NOTE.C5] }, // Cmaj (inv)
      ];
      const chordDur = 10;

      // Melody: sequence of pentatonic notes with timing
      const melodyNotes = [
        NOTE.E4,
        NOTE.G4,
        NOTE.A4,
        NOTE.G4,
        NOTE.E4,
        NOTE.C4,
        NOTE.D4,
        NOTE.E4,
        NOTE.G4,
        NOTE.C5,
        NOTE.A4,
        NOTE.G4,
        NOTE.E4,
        NOTE.D4,
        NOTE.C4,
        NOTE.E4,
        NOTE.A4,
        NOTE.G4,
        NOTE.E4,
        NOTE.G4,
        NOTE.C5,
        NOTE.A4,
        NOTE.G4,
        NOTE.E4,
      ];
      const melNoteDur = 2.5;

      // Soft waveform: sine with a touch of 2nd harmonic for warmth
      const soft = (phase: number) =>
        Math.sin(phase) * 0.85 + Math.sin(phase * 2) * 0.12 + Math.sin(phase * 3) * 0.03;

      // ADSR envelope
      const env = (
        t: number,
        atk: number,
        dec: number,
        sus: number,
        rel: number,
        total: number,
      ) => {
        if (t < 0 || t > total) return 0;
        if (t < atk) return t / atk;
        if (t < atk + dec) return 1 - (1 - sus) * ((t - atk) / dec);
        if (t < total - rel) return sus;
        return sus * (1 - (t - (total - rel)) / rel);
      };

      // Seeded PRNG for deterministic variation
      let seed = 42;
      const rand = () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
      };

      // Schedule bird chirps (2-note warbles)
      const chirps: { start: number; f1: number; f2: number; dur: number }[] = [];
      for (let s = 2; s < duration; s++) {
        if (rand() < 0.04) {
          const f1 = 2200 + rand() * 1600;
          chirps.push({
            start: (s + rand()) * sr,
            f1,
            f2: f1 * (1.2 + rand() * 0.3),
            dur: (0.08 + rand() * 0.12) * sr,
          });
        }
      }

      // Fill the buffer in idle time-slices instead of one ~1s synchronous
      // block. That block used to land right as the loader faded — freezing
      // rAF mid-reveal (the "flash" + "random lag right before the island
      // opens"). State (ch / i / lp) is carried across slices; output is
      // byte-identical to the old loop.
      await new Promise<void>((resolve) => {
        let ch = 0;
        let i = 0;
        let d = buffer.getChannelData(0);
        let lp = 0;
        let panShift = 0;
        const SLICE = 40000; // samples per slice (~a few ms) — caps each task

        const fill = (deadline?: { timeRemaining: () => number; didTimeout: boolean }) => {
          const hasTime = () =>
            deadline ? deadline.timeRemaining() > 3 || deadline.didTimeout : true;
          while (ch < 2) {
            let budget = SLICE;
            while (i < N && budget-- > 0 && hasTime()) {
              const t = i / sr;

              // --- Chord pad: warm triangle blend, breathing ---
              const chordIdx = Math.floor((t / chordDur) % chords.length);
              const chordT = (t / chordDur) % 1;
              const chord = chords[chordIdx];
              const breathe = 0.4 + 0.6 * Math.sin(t * 0.15 + panShift) ** 2;
              let padVal = soft(t * chord.bass * TAU) * 0.3;
              for (let ci = 0; ci < chord.tones.length; ci++) {
                const detune = 1 + (ci * 0.001 + panShift * 0.002);
                padVal += soft(t * chord.tones[ci] * detune * TAU + ci * 0.5) * 0.2;
              }
              // Crossfade between chords at boundaries
              const xfade = chordT < 0.08 ? chordT / 0.08 : chordT > 0.92 ? (1 - chordT) / 0.08 : 1;
              padVal *= breathe * xfade;

              // --- Melody: pentatonic notes with soft envelope ---
              const melIdx = Math.floor(t / melNoteDur) % melodyNotes.length;
              const melT = t % melNoteDur;
              const melFreq = melodyNotes[melIdx];
              const melEnv = env(melT, 0.6, 0.4, 0.5, 0.8, melNoteDur);
              const melVal = soft(t * melFreq * TAU + panShift * 1.2) * melEnv;

              // --- Arpeggio sparkle: high notes on beat subdivisions ---
              const arpPeriod = 3.33;
              const arpT = t % arpPeriod;
              const arpIdx = Math.floor(t / arpPeriod) % 3;
              const arpFreqs = [NOTE.C5, NOTE.E5, NOTE.G5];
              const arpEnv = env(arpT, 0.02, 0.3, 0.15, 1.5, arpPeriod);
              const arpVal = Math.sin(t * arpFreqs[arpIdx] * TAU) * arpEnv;

              // --- Subtle wind bed ---
              const raw = (Math.random() - 0.5) * 2;
              const cutoff = 160 + 40 * Math.sin(t * 0.04 + ch);
              const alpha = 1 / (1 + sr / (TAU * cutoff));
              lp += alpha * (raw - lp);
              const wind = lp * (0.2 + 0.1 * Math.sin(t * 0.07));

              // --- Bird warble ---
              let birdVal = 0;
              for (const c of chirps) {
                const rel = i - c.start;
                if (rel >= 0 && rel < c.dur) {
                  const p = rel / c.dur;
                  const bEnv = Math.sin(p * Math.PI) * 0.15;
                  const freq = c.f1 + (c.f2 - c.f1) * Math.sin(p * Math.PI * 3);
                  birdVal += Math.sin((rel / sr) * freq * TAU) * bEnv;
                }
              }

              // --- Mix ---
              d[i] = padVal * 0.045 + melVal * 0.05 + arpVal * 0.025 + wind * 0.02 + birdVal * 0.03;
              i++;
            }
            if (i >= N) {
              ch++;
              if (ch >= 2) {
                resolve();
                return;
              }
              d = buffer.getChannelData(ch);
              lp = 0;
              panShift = ch === 0 ? 0 : 0.4;
              i = 0;
            } else {
              break; // out of budget/time — resume next slice
            }
          }
          if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(fill, { timeout: 500 });
          } else {
            setTimeout(() => fill(undefined), 0);
          }
        };
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(fill, { timeout: 500 });
        } else {
          setTimeout(() => fill(undefined), 0);
        }
      });

      // Load the buffer and play
      await audioManager.loadAudioBuffer(buffer, 'background_music');
      audioManager.playBackground('background_music');

      console.log('🎵 Ambient background music started');
    } catch (error) {
      console.warn('Failed to start background music:', error);
    }
  }

  /**
   * Display error screen on initialization failure
   */
  private showErrorScreen(error: Error): void {
    const errorDiv = document.createElement('div');
    Object.assign(errorDiv.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      background: '#1a1a1a',
      color: '#ff6b6b',
      fontFamily: 'monospace',
      padding: '20px',
      zIndex: '9999',
      overflow: 'auto',
    });

    errorDiv.innerHTML = `
      <h1>❌ Initialization Error</h1>
      <p>${error.message}</p>
      <pre>${error.stack || ''}</pre>
      <button onclick="location.reload()" style="
        background: #ff6b6b;
        color: white;
        border: none;
        padding: 10px 20px;
        margin-top: 20px;
        cursor: pointer;
        font-size: 16px;
      ">Reload Page</button>
    `;

    document.body.appendChild(errorDiv);
  }

  /**
   * Cleanup and dispose resources
   */
  private dispose(): void {
    console.log('🛑 Disposing resources...');

    if (this.chat) {
      this.chat.dispose();
    }

    if (this.ui) {
      this.ui.dispose();
    }

    if (this.inputManager) {
      this.inputManager.dispose();
    }

    if (this.scene) {
      this.scene.dispose();
    }

    if (this.renderer) {
      this.renderer.dispose();
    }

    if (this.boundHandlers.beforeUnload) {
      window.removeEventListener('beforeunload', this.boundHandlers.beforeUnload);
    }

    if (this.boundHandlers.debugKeydown) {
      document.removeEventListener('keydown', this.boundHandlers.debugKeydown);
    }

    if (this.boundHandlers.chatKeydown) {
      window.removeEventListener('keydown', this.boundHandlers.chatKeydown);
    }

    if (this.boundHandlers.chatKeyup) {
      window.removeEventListener('keyup', this.boundHandlers.chatKeyup);
    }

    const muteCanvas = document.getElementById('game-canvas');
    if (muteCanvas && this.boundHandlers.mutePointerDown) {
      muteCanvas.removeEventListener('pointerdown', this.boundHandlers.mutePointerDown);
    }
    if (muteCanvas && this.boundHandlers.mutePointerUp) {
      muteCanvas.removeEventListener('pointerup', this.boundHandlers.mutePointerUp);
    }

    this.isRunning = false;
  }
}

// Idempotent boot: guard against any double module evaluation (HMR edge cases,
// prerendered/duplicated page targets) constructing two apps on one canvas.
const bootState = window as unknown as { __lifeIslandBooted?: boolean };
const bootApp = () => {
  if (bootState.__lifeIslandBooted) return;
  bootState.__lifeIslandBooted = true;
  // Exposed for headless E2E verification (drive update(), start the tour,
  // read state). The client is untrusted by design, so this adds no surface.
  (window as unknown as { app?: SimpleApp }).app = new SimpleApp();
};

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootApp);
} else {
  bootApp();
}

// Global debug helpers
(window as any).getGameState = () => {
  return {
    isRunning: (window as any).__app?.isRunning || false,
    timestamp: new Date().toISOString(),
  };
};

console.log(
  '%c🌎 Welcome to DigiScalability Life Island',
  'color: #4ade80; font-size: 16px; font-weight: bold',
);
console.log('%cSimplified architecture ready for deployment', 'color: #60a5fa');
