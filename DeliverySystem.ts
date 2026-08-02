import { Mailbox } from './Mailbox';

export interface Delivery {
  id: string;
  destination: Mailbox;
  message: string;
  completed: boolean;
  reward?: string;
  questId?: string;
  unlocks?: string[]; // IDs of deliveries this unlocks
  requiredDeliveries?: string[]; // IDs that must be completed first
}

export interface Quest {
  id: string;
  name: string;
  description: string;
  deliveries: string[]; // Delivery IDs in this quest
  completed: boolean;
  reward: {
    type: 'visual' | 'unlock' | 'message';
    value: string;
  };
}

export class DeliverySystem {
  private deliveries: Delivery[] = [];
  private activeDeliveries: Delivery[] = [];
  private completedDeliveries: Delivery[] = [];
  private quests: Quest[] = [];
  private onDeliveryCompleteCallback?: (delivery: Delivery) => void;
  private onQuestCompleteCallback?: (quest: Quest) => void;

  // The whole 10-delivery chain used to reset on every page load — the "island
  // is complete" finale was effectively unreachable. Persist completed IDs so
  // progress (and the finale) survives a refresh, mirroring NpcQuests.
  private static readonly STORAGE_KEY = 'ds_deliveries';

  constructor() {
    this.initializeQuests();
    this.restoreProgress();
  }

  private initializeQuests(): void {
    // Define quests with chained deliveries
    this.quests = [
      {
        id: 'welcome_quest',
        name: 'Welcome to the Island',
        description: 'Complete your first deliveries to get settled.',
        deliveries: ['welcome_1', 'welcome_2', 'welcome_3'],
        completed: false,
        reward: {
          type: 'message',
          value: "🏠 Welcome home! You've completed your first deliveries.",
        },
      },
      {
        id: 'explorer_quest',
        name: 'Island Explorer',
        description: 'Explore the island and help the residents.',
        deliveries: ['explore_1', 'explore_2'],
        completed: false,
        reward: {
          type: 'message',
          value: '🗺️ You know this island like the back of your hand!',
        },
      },
      {
        id: 'community_quest',
        name: 'Community Helper',
        description: 'Lend a hand around the village.',
        deliveries: ['community_1', 'community_2', 'community_3'],
        completed: false,
        reward: {
          type: 'message',
          value: "🤝 The village owes you one. You're officially a local!",
        },
      },
      {
        id: 'secret_quest',
        name: 'The Last Delivery',
        description: 'A mysterious package with no return address.',
        deliveries: ['secret_1', 'secret_2'],
        completed: false,
        reward: {
          type: 'message',
          value: "✨ You've delivered everything there is. The island is complete.",
        },
      },
    ];

    // Define deliveries with dependencies
    const allDeliveries: Delivery[] = [
      {
        id: 'welcome_1',
        destination: null as any, // Will be set when added
        message: 'Welcome package for new resident!',
        completed: false,
        reward: '🏠 Welcome to the island!',
        questId: 'welcome_quest',
      },
      {
        id: 'welcome_2',
        destination: null as any,
        message: 'Essential supplies delivery',
        completed: false,
        reward: '📦 Supplies received!',
        questId: 'welcome_quest',
        requiredDeliveries: ['welcome_1'],
      },
      {
        id: 'welcome_3',
        destination: null as any,
        message: 'Final welcome gift',
        completed: false,
        reward: '🎁 Special delivery!',
        questId: 'welcome_quest',
        requiredDeliveries: ['welcome_2'],
      },
      {
        id: 'explore_1',
        destination: null as any,
        message: 'Help a neighbor with groceries',
        completed: false,
        reward: '🛒 Groceries delivered!',
        questId: 'explorer_quest',
        requiredDeliveries: ['welcome_3'],
      },
      {
        id: 'explore_2',
        destination: null as any,
        message: 'Deliver important documents',
        completed: false,
        reward: '📄 Documents delivered!',
        questId: 'explorer_quest',
        requiredDeliveries: ['explore_1'],
      },
      {
        id: 'community_1',
        destination: null as any,
        message: 'Bring hot soup to the elder',
        completed: false,
        reward: '🍲 The elder sends thanks!',
        questId: 'community_quest',
        requiredDeliveries: ['explore_2'],
      },
      {
        id: 'community_2',
        destination: null as any,
        message: 'Return a lost book to the storyteller',
        completed: false,
        reward: '📖 Story unlocked!',
        questId: 'community_quest',
        requiredDeliveries: ['community_1'],
      },
      {
        id: 'community_3',
        destination: null as any,
        message: 'Deliver flowers from the gardener',
        completed: false,
        reward: '💐 Beautiful!',
        questId: 'community_quest',
        requiredDeliveries: ['community_2'],
      },
      {
        id: 'secret_1',
        destination: null as any,
        message: 'A sealed letter with no name',
        completed: false,
        reward: '🔮 Curious...',
        questId: 'secret_quest',
        requiredDeliveries: ['community_3'],
      },
      {
        id: 'secret_2',
        destination: null as any,
        message: 'The final package — handle with care',
        completed: false,
        reward: '🌟 Congratulations, master courier!',
        questId: 'secret_quest',
        requiredDeliveries: ['secret_1'],
      },
    ];

    this.deliveries = allDeliveries;
    this.updateAvailableDeliveries();
  }

  private updateAvailableDeliveries(): void {
    // Clear current active deliveries
    this.activeDeliveries = [];

    // Check which deliveries are now available
    for (const delivery of this.deliveries) {
      if (delivery.completed) continue;

      // Check if all required deliveries are completed
      const requirementsMet =
        !delivery.requiredDeliveries ||
        delivery.requiredDeliveries.every((reqId) =>
          this.completedDeliveries.some((d) => d.id === reqId),
        );

      if (requirementsMet) {
        this.activeDeliveries.push(delivery);
      }
    }
  }

  /**
   * Assign every delivery a destination mailbox (round-robin), then light up
   * only the currently unlocked ones. Later deliveries in a chain point at
   * different mailboxes, so the quest walks the player around the island.
   */
  public assignDestinations(mailboxes: Mailbox[]): void {
    if (mailboxes.length === 0) return;
    this.deliveries.forEach((delivery, index) => {
      delivery.destination = mailboxes[index % mailboxes.length];
    });
    this.syncMailboxState();
  }

  /**
   * Reflect delivery availability on the mailboxes: active (unlocked, not yet
   * completed) deliveries show a bubble + glow, everything else is cleared.
   */
  private syncMailboxState(): void {
    const seen = new Set<Mailbox>();
    for (const delivery of this.activeDeliveries) {
      if (delivery.destination) {
        delivery.destination.setHasDelivery(true);
        delivery.destination.setBubbleText(`📬 ${delivery.message}`);
        seen.add(delivery.destination);
      }
    }
    for (const delivery of this.deliveries) {
      if (delivery.destination && !seen.has(delivery.destination)) {
        delivery.destination.setHasDelivery(false);
      }
    }
  }

  /**
   * Player pressed E at a mailbox: complete the active delivery held there.
   * Returns true if a delivery was collected.
   */
  public collectFromMailbox(mailbox: Mailbox): boolean {
    const delivery = this.activeDeliveries.find((d) => d.destination === mailbox);
    if (!delivery) return false;
    this.completeDelivery(delivery);
    return true;
  }

  private completeDelivery(delivery: Delivery): void {
    delivery.completed = true;
    delivery.destination.setHasDelivery(false);
    delivery.destination.setBubbleText(`✅ ${delivery.reward || 'Delivery complete!'}`);

    // Remove from active list
    const index = this.activeDeliveries.indexOf(delivery);
    if (index > -1) {
      this.activeDeliveries.splice(index, 1);
    }

    this.completedDeliveries.push(delivery);

    // Reset bubble text after 3 seconds
    setTimeout(() => {
      delivery.destination.setBubbleText(undefined);
    }, 3000);

    console.log(`📬 Completed delivery: ${delivery.message}`);

    // Check if this completes a quest
    this.checkQuestCompletion(delivery);

    // Update available deliveries (may unlock new ones) and light up
    // the mailboxes holding the newly unlocked deliveries
    this.updateAvailableDeliveries();
    this.syncMailboxState();
    this.saveProgress();

    if (this.onDeliveryCompleteCallback) {
      this.onDeliveryCompleteCallback(delivery);
    }
  }

  private checkQuestCompletion(completedDelivery: Delivery): void {
    if (!completedDelivery.questId) return;

    const quest = this.quests.find((q) => q.id === completedDelivery.questId);
    if (!quest || quest.completed) return;

    // Check if all deliveries in this quest are completed
    const questCompleted = quest.deliveries.every((deliveryId) =>
      this.completedDeliveries.some((d) => d.id === deliveryId),
    );

    if (questCompleted) {
      quest.completed = true;
      console.log(`🎉 Quest completed: ${quest.name}`);
      console.log(`🏆 Reward: ${quest.reward.value}`);

      if (this.onQuestCompleteCallback) {
        this.onQuestCompleteCallback(quest);
      }
    }
  }

  public getActiveDeliveries(): Delivery[] {
    return this.activeDeliveries;
  }

  public getCompletedCount(): number {
    return this.completedDeliveries.length;
  }

  public getQuests(): Quest[] {
    return this.quests;
  }

  public getActiveQuests(): Quest[] {
    return this.quests.filter((q) => !q.completed);
  }

  public getCompletedQuests(): Quest[] {
    return this.quests.filter((q) => q.completed);
  }

  public setOnQuestComplete(callback: (quest: Quest) => void): void {
    this.onQuestCompleteCallback = callback;
  }

  public setOnDeliveryComplete(callback: (delivery: Delivery) => void): void {
    this.onDeliveryCompleteCallback = callback;
  }

  /** All ten deliveries done — drives the finale reward. */
  public isAllComplete(): boolean {
    return this.completedDeliveries.length >= this.deliveries.length;
  }

  /** Persist the set of completed delivery IDs. */
  private saveProgress(): void {
    try {
      const ids = this.completedDeliveries.map((d) => d.id);
      localStorage.setItem(DeliverySystem.STORAGE_KEY, JSON.stringify(ids));
    } catch {
      /* storage unavailable — non-fatal */
    }
  }

  /**
   * Re-apply saved completions on boot: mark those deliveries done, rebuild the
   * completed list, silently recompute which quests are finished, and refresh
   * the unlocked set. Runs before assignDestinations, so no mailbox/destination
   * is touched here — syncMailboxState lights the right ones once destinations
   * are assigned. Quest-complete callbacks are NOT fired (no reward re-grant).
   */
  private restoreProgress(): void {
    let ids: string[] = [];
    try {
      ids = JSON.parse(localStorage.getItem(DeliverySystem.STORAGE_KEY) ?? '[]');
    } catch {
      return;
    }
    if (!Array.isArray(ids) || ids.length === 0) return;
    const done = new Set(ids);
    for (const delivery of this.deliveries) {
      if (done.has(delivery.id)) {
        delivery.completed = true;
        this.completedDeliveries.push(delivery);
      }
    }
    for (const quest of this.quests) {
      quest.completed = quest.deliveries.every((id) => done.has(id));
    }
    this.updateAvailableDeliveries();
  }
}
