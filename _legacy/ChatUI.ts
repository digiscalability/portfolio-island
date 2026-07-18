/**
 * ChatUI — extracted from UIManager.ts
 *
 * Owns the chat window DOM element and wires it to ChatSystem.
 * UIManager delegates all chat window operations here.
 */

import type { ChatMessage } from './ChatSystem';
import { ChatSystem } from './ChatSystem';

export class ChatUI {
  private chatWindow: HTMLElement;
  private chatMessages?: HTMLElement;
  private chatInput?: HTMLInputElement;
  private chatSystem: ChatSystem;

  constructor(container: HTMLElement, chatSystem: ChatSystem) {
    this.chatSystem = chatSystem;
    this.chatWindow = this.createChatWindow();
    container.appendChild(this.chatWindow);
    this.setup();
  }

  /** Returns the underlying DOM element (for fade-in/hide-all helpers in UIManager). */
  public getElement(): HTMLElement {
    return this.chatWindow;
  }

  private createChatWindow(): HTMLElement {
    const chatWindow = document.createElement('div');
    chatWindow.className = 'chat-window hidden';
    chatWindow.innerHTML = `
      <div class="chat-header">
        <div style="display:flex; gap:12px; align-items:center;">
          <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(90deg,var(--primary),var(--primary-600));display:flex;align-items:center;justify-content:center;color:white;font-weight:700;">A</div>
          <div>
            <div style="font-weight:700">AI Guide</div>
            <div style="font-size:12px; color:var(--muted)">I'm here to help — press C to toggle</div>
          </div>
        </div>
        <button class="chat-close" id="chat-close">×</button>
      </div>
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-input-container">
        <input type="text" id="chat-input" placeholder="Ask me anything..." />
        <button id="chat-send">Send</button>
      </div>
    `;

    setTimeout(() => {
      this.chatMessages = chatWindow.querySelector('#chat-messages') as HTMLElement;
      this.chatInput = chatWindow.querySelector('#chat-input') as HTMLInputElement;

      const closeBtn = chatWindow.querySelector('#chat-close');
      const sendBtn = chatWindow.querySelector('#chat-send');

      if (closeBtn) closeBtn.addEventListener('click', () => this.hide());
      if (sendBtn && this.chatInput) {
        sendBtn.addEventListener('click', () => this.sendMessage());
        this.chatInput.addEventListener('keypress', (e) => {
          if (e.key === 'Enter') this.sendMessage();
        });
      }
    }, 0);

    return chatWindow;
  }

  private setup(): void {
    this.chatSystem.onMessage((message) => {
      this.addMessage(message);
    });

    this.chatSystem.getMessages().forEach((message) => {
      this.addMessage(message);
    });
  }

  private addMessage(message: ChatMessage): void {
    if (!this.chatMessages) return;

    const messageEl = document.createElement('div');
    messageEl.className = `chat-message ${message.sender}`;
    messageEl.textContent = message.text;
    this.chatMessages.appendChild(messageEl);
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
  }

  private async sendMessage(): Promise<void> {
    if (!this.chatInput) return;
    const text = this.chatInput.value.trim();
    if (!text) return;
    this.chatInput.value = '';
    await this.chatSystem.sendMessage(text);
  }

  public show(): void {
    this.chatWindow.classList.remove('hidden');
  }

  public hide(): void {
    this.chatWindow.classList.add('hidden');
  }

  public toggle(): void {
    if (this.chatWindow.classList.contains('hidden')) {
      this.show();
    } else {
      this.hide();
    }
  }
}
