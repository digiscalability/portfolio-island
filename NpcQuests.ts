/**
 * NpcQuests — lightweight NPC-given quests with stateful dialogue.
 *
 * Two kinds:
 *  - 'relay': carry a message from the giver to a target NPC; talking to
 *    the target completes the quest.
 *  - 'coins': collect N meadow coins after accepting, then return to the
 *    giver to complete.
 *
 * Dialogue is state-dependent (available → active → done) and replaces
 * the NPC's ambient lines while relevant. State persists in localStorage.
 */

export type NpcQuestState = 'available' | 'active' | 'done';

export interface NpcQuest {
  id: string;
  giverName: string;
  // 'relay' = carry a message to a target (completes at the target)
  // 'fetch' = accept at giver, pick up an item at the target, return to giver
  // 'coins' = gather N meadow coins, return to giver
  kind: 'relay' | 'fetch' | 'coins';
  targetName?: string;
  coinTarget?: number;
  introDialogue: string[];
  activeGiverDialogue: string[];
  relayDialogue?: string[]; // reused by 'fetch' as the pickup line at the target
  doneDialogue: string[];
  rewardCoins: number;
  state: NpcQuestState;
  /** Kept in the save shape for one release (P2-A10), then ignored: the
   *  coins held at the accept, for the old held-coins arithmetic. */
  coinBaseline: number;
  /** 'coins': meadow coins picked up since the accept (P2-A10). A shop
   *  purchase or a +10 lesson no longer moves it. */
  meadowCoins?: number;
  carrying?: boolean; // 'fetch': the item has been picked up, not yet delivered
}

/** One quest's persisted row. */
interface SavedQuest {
  state: NpcQuestState;
  coinBaseline: number;
  meadowCoins?: number;
  carrying?: boolean;
}

export interface TalkResult {
  lines: string[];
  accepted?: NpcQuest;
  completed?: NpcQuest;
  pickedUp?: NpcQuest; // 'fetch': just collected the item at the target
}

/**
 * What talking to a villager would do for a quest right now (P2-A7):
 * - 'offer': they have a request to give (onTalk would accept it);
 * - 'errand': the visitor's errand moves on here (a pickup, a delivery, a
 *   completion);
 * - 'status': only a reminder or a thank-you (onTalk changes nothing);
 * - null: no quest involves them.
 */
export type QuestTalk = 'offer' | 'errand' | 'status' | null;

/** An accepted quest, as the Next chip lists it: 'Gardener: dew-coins 2/5'. */
export interface ActiveQuest {
  id: string;
  giver: string;
  label: string;
  progress: string;
}

const STORAGE_KEY = 'ds_npc_quests';

export class NpcQuestSystem {
  private quests: NpcQuest[] = [
    {
      id: 'sage_greetings',
      giverName: 'Elder Sage',
      kind: 'relay',
      targetName: 'Storyteller',
      introDialogue: [
        'Ah, the courier! Just who I hoped to see.',
        'The Storyteller and I quarrelled years ago over the ending of a tale.',
        'Carry my greetings to them — tell them the Sage says their ending was better.',
        '📜 Quest accepted: find the Storyteller!',
      ],
      activeGiverDialogue: [
        'Have you found the Storyteller yet?',
        'They love the market crowd — follow the stalls.',
      ],
      relayDialogue: [
        'A message? From the Sage? After all these years...',
        '"Their ending was better"... ha! I always knew it.',
        'Thank you, courier. Here — for your trouble.',
        '✅ Quest complete!',
      ],
      doneDialogue: ['The Storyteller and I are speaking again. You did a good thing.'],
      rewardCoins: 5,
      state: 'available',
      coinBaseline: 0,
    },
    {
      id: 'baker_catch',
      giverName: 'Village Baker',
      kind: 'fetch',
      targetName: 'Fisherman',
      introDialogue: [
        'My fish pies are famous, but my supplier vanished!',
        'Bring me a fresh fish from the Fisherman down at the shore.',
        '📜 Quest accepted: fetch a fish for the Baker!',
      ],
      activeGiverDialogue: [
        'No fish yet? The Fisherman works the beach — bring me his best catch.',
      ],
      relayDialogue: [
        'The Baker sent you? Here — the finest snapper of the day.',
        '🐟 You take the fish. Get it to the Baker while it’s fresh!',
      ],
      doneDialogue: [
        'A beauty! Watch closely — straight into the pie it goes. 🥧',
        '✅ Quest complete! Come back for a slice.',
      ],
      rewardCoins: 6,
      state: 'available',
      coinBaseline: 0,
    },
    {
      id: 'gardener_coins',
      giverName: 'Gardener',
      kind: 'coins',
      coinTarget: 5,
      introDialogue: [
        'These flower beds need rare dew-coin fertiliser.',
        'The shiny coins in the meadows — gather 5 of them and come back.',
        '📜 Quest accepted: collect 5 meadow coins!',
      ],
      activeGiverDialogue: [], // generated dynamically with progress
      doneDialogue: [
        'The flowers will bloom like never before. Take these — you earned more than you gathered!',
      ],
      rewardCoins: 8,
      state: 'available',
      coinBaseline: 0,
    },
  ];

  constructor() {
    // Restore persisted quest state
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Record<string, SavedQuest>;
        for (const q of this.quests) {
          const s = saved[q.id];
          if (s) {
            q.state = s.state;
            q.coinBaseline = s.coinBaseline;
            q.carrying = s.carrying;
            // An active 'coins' quest from an older save has no counter: it
            // restarts at 0 rather than credit coins of unknown origin.
            if (q.kind === 'coins') {
              q.meadowCoins = typeof s.meadowCoins === 'number' ? s.meadowCoins : 0;
            }
          }
        }
      }
    } catch {
      /* fresh state */
    }
  }

  private save(): void {
    try {
      const out: Record<string, SavedQuest> = {};
      for (const q of this.quests)
        out[q.id] = {
          state: q.state,
          coinBaseline: q.coinBaseline,
          meadowCoins: q.meadowCoins,
          carrying: q.carrying,
        };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch {
      /* session-only */
    }
  }

  /** True once the scene feeds meadow pickups in (setOnMeadowCoin). Without
   *  that feed, 'coins' quests keep the held-coins arithmetic. */
  private countsMeadow = false;

  /**
   * A meadow or trail coin was picked up (GameScene.setOnMeadowCoin, P2-B7).
   * Only meadow pickups count toward a 'coins' quest; the first call also
   * switches the quest from held coins to this counter.
   */
  public onMeadowCoin(e: { trail: boolean }): void {
    this.countsMeadow = true;
    if (e.trail) return;
    let changed = false;
    for (const q of this.quests) {
      if (q.kind !== 'coins' || q.state !== 'active') continue;
      q.meadowCoins = (q.meadowCoins ?? 0) + 1;
      changed = true;
    }
    if (changed) this.save();
  }

  /** The scene feeds meadow pickups: count them, not held coins (P2-A10). */
  public useMeadowCounter(): void {
    this.countsMeadow = true;
  }

  /** A 'coins' quest's progress: meadow pickups since the accept when the
   *  scene feeds them, else held coins over the baseline (never negative). */
  private coinProgress(q: NpcQuest, currentCoins: number): number {
    if (this.countsMeadow) return q.meadowCoins ?? 0;
    return Math.max(0, currentCoins - q.coinBaseline);
  }

  /** NPC names that should show a quest "!" marker right now. */
  public getGiverNamesWithAvailableQuests(): string[] {
    return this.quests.filter((q) => q.state === 'available').map((q) => q.giverName);
  }

  /** True if a fetch item has been picked up but not yet delivered (restore the
   * carried prop after a reload). */
  public isCarryingFetchItem(): boolean {
    return this.quests.some((q) => q.kind === 'fetch' && q.state === 'active' && !!q.carrying);
  }

  /**
   * What onTalk(npcName) would do now, without doing it. Mirrors onTalk's
   * order branch for branch; test/questTracker.test.ts runs the two side by
   * side over every state.
   */
  public talkKind(npcName: string, currentCoins = 0): QuestTalk {
    for (const q of this.quests) {
      if (q.kind !== 'fetch' || q.state !== 'active') continue;
      if (npcName === q.targetName && !q.carrying) return 'errand';
      if (npcName === q.giverName && q.carrying) return 'errand';
    }
    for (const q of this.quests) {
      if (q.state === 'active' && q.kind === 'relay' && q.targetName === npcName) return 'errand';
    }
    for (const q of this.quests) {
      if (q.giverName !== npcName) continue;
      if (q.state === 'available') return 'offer';
      if (q.state === 'active' && q.kind === 'coins') {
        return this.coinProgress(q, currentCoins) >= (q.coinTarget ?? 0) ? 'errand' : 'status';
      }
      return 'status';
    }
    return null;
  }

  /** A quest step waits at this villager: a request to accept, or the
   *  visitor's errand moving on. The talk prompt says so instead of 'ask
   *  anything', which that press would not do. */
  public hasPendingStep(npcName: string, currentCoins = 0): boolean {
    const k = this.talkKind(npcName, currentCoins);
    return k === 'offer' || k === 'errand';
  }

  /** Every accepted quest with where it stands, in catalogue order. */
  public getActiveQuests(currentCoins = 0): ActiveQuest[] {
    const out: ActiveQuest[] = [];
    for (const q of this.quests) {
      if (q.state !== 'active') continue;
      let label: string;
      let progress: string;
      if (q.kind === 'coins') {
        const target = q.coinTarget ?? 0;
        label = 'dew-coins';
        progress = `${Math.min(target, this.coinProgress(q, currentCoins))}/${target}`;
      } else if (q.kind === 'fetch') {
        label = `a fish from the ${q.targetName ?? 'shore'}`;
        progress = q.carrying ? 'in hand, take it back' : 'to collect';
      } else {
        label = `a message for the ${q.targetName ?? 'villager'}`;
        progress = 'to deliver';
      }
      out.push({ id: q.id, giver: q.giverName, label, progress });
    }
    return out;
  }

  /**
   * Called when the player talks to an NPC. Returns quest dialogue and any
   * accept/complete event, or null to use the NPC's ambient dialogue.
   */
  public onTalk(npcName: string, currentCoins: number): TalkResult | null {
    // 0. Fetch quests: pick the item up at the target, deliver it back to the giver
    for (const q of this.quests) {
      if (q.kind !== 'fetch' || q.state !== 'active') continue;
      if (npcName === q.targetName && !q.carrying) {
        q.carrying = true;
        this.save();
        return { lines: q.relayDialogue ?? ['Take this back!'], pickedUp: q };
      }
      if (npcName === q.giverName && q.carrying) {
        q.state = 'done';
        this.save();
        return { lines: q.doneDialogue, completed: q };
      }
    }
    // 1. Completing a relay quest by reaching its target
    for (const q of this.quests) {
      if (q.state === 'active' && q.kind === 'relay' && q.targetName === npcName) {
        q.state = 'done';
        this.save();
        return { lines: q.relayDialogue ?? ['✅ Quest complete!'], completed: q };
      }
    }
    // 2. Talking to a giver
    for (const q of this.quests) {
      if (q.giverName !== npcName) continue;
      if (q.state === 'available') {
        q.state = 'active';
        q.coinBaseline = currentCoins;
        if (q.kind === 'coins') q.meadowCoins = 0;
        this.save();
        return { lines: q.introDialogue, accepted: q };
      }
      if (q.state === 'active') {
        if (q.kind === 'coins') {
          const progress = this.coinProgress(q, currentCoins);
          const target = q.coinTarget ?? 0;
          if (progress >= target) {
            q.state = 'done';
            this.save();
            return { lines: q.doneDialogue, completed: q };
          }
          return {
            lines: [
              `Dew-coins gathered: ${progress} of ${target}.`,
              'The meadows between the districts sparkle with them.',
            ],
          };
        }
        return { lines: q.activeGiverDialogue };
      }
      if (q.state === 'done') {
        return { lines: q.doneDialogue };
      }
    }
    return null;
  }
}
