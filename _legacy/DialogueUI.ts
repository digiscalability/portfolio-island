/**
 * DialogueUI — extracted from UIManager.ts
 *
 * Manages the in-game dialogue box: creation, show/hide, queue advancement,
 * and keyboard interaction. Owns all dialogue-related DOM state so UIManager
 * does not need to touch it directly.
 */

export class DialogueUI {
  private dialogueBox: HTMLElement;
  private dialogueQueue: string[] = [];
  private dialogueTitle: string = '';
  private dialogueVisible: boolean = false;

  constructor(container: HTMLElement) {
    this.dialogueBox = this.createDialogueBox();
    container.appendChild(this.dialogueBox);
  }

  /** Returns the underlying DOM element (for fade-in/hide-all helpers in UIManager). */
  public getElement(): HTMLElement {
    return this.dialogueBox;
  }

  private createDialogueBox(): HTMLElement {
    const box = document.createElement('div');
    box.className = 'dialogue-box hidden';
    box.innerHTML = `
      <div class="dialogue-inner">
        <div class="dialogue-label" id="dialogue-label">Messenger</div>
        <div class="dialogue-text" id="dialogue-text">Hello, welcome!</div>
        <div class="dialogue-tail"></div>
        <div class="dialogue-next" id="dialogue-next">▶</div>
      </div>
    `;

    setTimeout(() => {
      const next = box.querySelector('#dialogue-next');
      if (next) next.addEventListener('click', () => this.advance());
    }, 0);

    return box;
  }

  /**
   * Show the dialogue box with a title and text.
   * Optional screenX/screenY animate the box from an NPC position to centre.
   */
  public show(title: string, text: string, screenX?: number, screenY?: number): void {
    this.dialogueQueue = [text];
    this.dialogueTitle = title;
    this.render();

    try {
      const el = this.dialogueBox;
      if (typeof screenX === 'number' && typeof screenY === 'number') {
        el.style.left = `${screenX}px`;
        el.style.top = `${screenY - 48}px`;
        el.classList.remove('hidden');
        el.style.transition = 'transform 280ms cubic-bezier(.2,.9,.2,1), opacity 220ms';
        el.style.transform = 'translate(-50%,-50%) scale(0.9)';
        el.style.opacity = '0';
        requestAnimationFrame(() => {
          el.style.left = '50%';
          el.style.top = '50%';
          el.style.transform = 'translate(-50%,-50%) scale(1)';
          el.style.opacity = '1';
        });
      } else {
        el.classList.remove('hidden');
        el.style.left = '';
        el.style.top = '';
        el.style.transform = '';
        el.style.opacity = '';
      }
    } catch {
      /* ignore UI animation errors */
    }

    this.dialogueVisible = true;
    window.addEventListener('keydown', this.onKey);

    try {
      window.dispatchEvent(new CustomEvent('ui:dialogue-start', { detail: { title, text } }));
    } catch {}
  }

  public hide(): void {
    this.dialogueBox.classList.add('hidden');
    this.dialogueVisible = false;
    window.removeEventListener('keydown', this.onKey);

    try {
      window.dispatchEvent(
        new CustomEvent('ui:dialogue-end', { detail: { title: this.dialogueTitle } }),
      );
    } catch {}
  }

  public isVisible(): boolean {
    return this.dialogueVisible;
  }

  private onKey = (e: KeyboardEvent): void => {
    if (!this.dialogueVisible) return;
    if (e.key === ' ' || e.key.toLowerCase() === 'e') {
      e.preventDefault();
      this.advance();
    }
  };

  public advance(): void {
    if (this.dialogueQueue.length > 1) {
      this.dialogueQueue.shift();
      this.render();
    } else {
      this.hide();
    }
  }

  private render(): void {
    const label = this.dialogueBox.querySelector('#dialogue-label');
    const body = this.dialogueBox.querySelector('#dialogue-text');
    if (label) (label as HTMLElement).textContent = this.dialogueTitle;
    if (body) (body as HTMLElement).textContent = this.dialogueQueue[0] || '';
  }
}
