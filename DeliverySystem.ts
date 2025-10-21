import { Mailbox } from './Mailbox';
import { Player } from './Player';
import { Zone } from './Zones';

export interface Delivery {
  id: string;
  destination: Mailbox | Zone;
  message: string;
  completed: boolean;
}

export class DeliverySystem {
  private deliveries: Delivery[] = [];
  private currentDeliveryIndex: number = 0;
  private onDeliveryCompleteCallback?: (delivery: Delivery) => void;
  private onAllDeliveriesCompleteCallback?: () => void;

  constructor() {
    // Initialize with some placeholder deliveries
    // In a full implementation, these would be loaded from Firestore or generated dynamically
  }

  public addDelivery(destination: Mailbox | Zone, message: string): void {
    const delivery: Delivery = {
      id: this.generateId(),
      destination,
      message,
      completed: false,
    };
    this.deliveries.push(delivery);
  }

  public update(player: Player, _mailboxes: Mailbox[], actionPressed: boolean): void {
    if (this.currentDeliveryIndex >= this.deliveries.length) {
      return; // All deliveries completed
    }

    const currentDelivery = this.deliveries[this.currentDeliveryIndex];
    if (currentDelivery.completed) {
      return;
    }

    // Check if player is near the destination mailbox
    const destination = currentDelivery.destination;
    if (destination instanceof Mailbox) {
      if (destination.isNearby(player.getPosition(), 2) && actionPressed) {
        this.completeDelivery(currentDelivery);
      }
    }
  }

  private completeDelivery(delivery: Delivery): void {
    delivery.completed = true;

    if (this.onDeliveryCompleteCallback) {
      this.onDeliveryCompleteCallback(delivery);
    }

    this.currentDeliveryIndex++;

    if (this.currentDeliveryIndex >= this.deliveries.length) {
      if (this.onAllDeliveriesCompleteCallback) {
        this.onAllDeliveriesCompleteCallback();
      }
    }
  }

  public getCurrentDelivery(): Delivery | null {
    if (this.currentDeliveryIndex < this.deliveries.length) {
      return this.deliveries[this.currentDeliveryIndex];
    }
    return null;
  }

  public getCompletedCount(): number {
    return this.deliveries.filter((d) => d.completed).length;
  }

  public getTotalCount(): number {
    return this.deliveries.length;
  }

  public isAllComplete(): boolean {
    return this.currentDeliveryIndex >= this.deliveries.length;
  }

  public onDeliveryComplete(callback: (delivery: Delivery) => void): void {
    this.onDeliveryCompleteCallback = callback;
  }

  public onAllDeliveriesComplete(callback: () => void): void {
    this.onAllDeliveriesCompleteCallback = callback;
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  public reset(): void {
    this.deliveries = [];
    this.currentDeliveryIndex = 0;
  }
}

