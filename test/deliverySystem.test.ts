// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest';

import { DeliverySystem } from '../DeliverySystem';
import { Mailbox } from '../Mailbox';

/** The shipped quest data: welcome_1 -> welcome_2 -> welcome_3 unlock in
 *  sequence (welcome_quest), then explore_1 -> explore_2 (explorer_quest). */

const makeMailboxes = (n: number) => Array.from({ length: n }, () => new Mailbox());

describe('DeliverySystem quest chain', () => {
  test('only the first delivery is active initially', () => {
    const ds = new DeliverySystem();
    expect(ds.getActiveDeliveries().map((d) => d.id)).toEqual(['welcome_1']);
    expect(ds.getCompletedCount()).toBe(0);
  });

  test('assignDestinations distributes round-robin and lights only the active mailbox', () => {
    const ds = new DeliverySystem();
    const boxes = makeMailboxes(4);
    ds.assignDestinations(boxes);

    // 5 deliveries over 4 boxes: box0 gets welcome_1 AND explore_2
    expect(boxes[0].hasDelivery).toBe(true); // welcome_1 is active
    expect(boxes[1].hasDelivery).toBe(false); // welcome_2 locked
    expect(boxes[2].hasDelivery).toBe(false);
    expect(boxes[3].hasDelivery).toBe(false);
  });

  test('collectFromMailbox completes the chain in order and lights the next box', () => {
    const ds = new DeliverySystem();
    const boxes = makeMailboxes(4);
    ds.assignDestinations(boxes);

    expect(ds.collectFromMailbox(boxes[0])).toBe(true); // welcome_1
    expect(ds.getCompletedCount()).toBe(1);
    expect(ds.getActiveDeliveries().map((d) => d.id)).toEqual(['welcome_2']);
    expect(boxes[1].hasDelivery).toBe(true); // next unlocked and lit
    expect(boxes[0].hasDelivery).toBe(false); // collected box cleared
  });

  test('collecting from a mailbox without an active delivery returns false', () => {
    const ds = new DeliverySystem();
    const boxes = makeMailboxes(4);
    ds.assignDestinations(boxes);

    // welcome_2 (box1) is still locked — collecting there must fail
    expect(ds.collectFromMailbox(boxes[1])).toBe(false);
    expect(ds.getCompletedCount()).toBe(0);
    expect(ds.getActiveDeliveries().map((d) => d.id)).toEqual(['welcome_1']);
  });

  test('full chain completes both quests and fires the quest callback', () => {
    vi.useFakeTimers(); // completeDelivery schedules bubble-reset timeouts
    try {
      const ds = new DeliverySystem();
      const boxes = makeMailboxes(4);
      ds.assignDestinations(boxes);

      const completedQuests: string[] = [];
      ds.setOnQuestComplete((q) => completedQuests.push(q.id));

      for (let guard = 0; guard < 10 && ds.getActiveDeliveries().length > 0; guard++) {
        const d = ds.getActiveDeliveries()[0];
        expect(ds.collectFromMailbox(d.destination)).toBe(true);
      }

      expect(ds.getCompletedCount()).toBe(5);
      expect(ds.getActiveDeliveries()).toEqual([]);
      expect(completedQuests).toEqual(['welcome_quest', 'explorer_quest']);
      expect(ds.getCompletedQuests().map((q) => q.id)).toEqual([
        'welcome_quest',
        'explorer_quest',
      ]);
      // every mailbox dark once the chain is done
      expect(boxes.every((b) => !b.hasDelivery)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('delivery-complete callback fires per collection', () => {
    const ds = new DeliverySystem();
    const boxes = makeMailboxes(4);
    ds.assignDestinations(boxes);

    const seen: string[] = [];
    ds.setOnDeliveryComplete((d) => seen.push(d.id));
    ds.collectFromMailbox(boxes[0]);
    expect(seen).toEqual(['welcome_1']);
  });

  test('assignDestinations with no mailboxes is a safe no-op', () => {
    const ds = new DeliverySystem();
    expect(() => ds.assignDestinations([])).not.toThrow();
    expect(ds.getActiveDeliveries().map((d) => d.id)).toEqual(['welcome_1']);
  });
});
