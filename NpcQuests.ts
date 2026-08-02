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
  coinBaseline: number;
  carrying?: boolean; // 'fetch': the item has been picked up, not yet delivered
}

export interface TalkResult {
  lines: string[];
  accepted?: NpcQuest;
  completed?: NpcQuest;
  pickedUp?: NpcQuest; // 'fetch': just collected the item at the target
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
        const saved = JSON.parse(raw) as Record<
          string,
          { state: NpcQuestState; coinBaseline: number; carrying?: boolean }
        >;
        for (const q of this.quests) {
          const s = saved[q.id];
          if (s) {
            q.state = s.state;
            q.coinBaseline = s.coinBaseline;
            q.carrying = s.carrying;
          }
        }
      }
    } catch {
      /* fresh state */
    }
  }

  private save(): void {
    try {
      const out: Record<
        string,
        { state: NpcQuestState; coinBaseline: number; carrying?: boolean }
      > = {};
      for (const q of this.quests)
        out[q.id] = { state: q.state, coinBaseline: q.coinBaseline, carrying: q.carrying };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch {
      /* session-only */
    }
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
        this.save();
        return { lines: q.introDialogue, accepted: q };
      }
      if (q.state === 'active') {
        if (q.kind === 'coins') {
          const progress = Math.max(0, currentCoins - q.coinBaseline);
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
