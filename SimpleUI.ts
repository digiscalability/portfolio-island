/**
 * SimpleUI - Simplified UI manager for the basic app
 * Handles loading screen, welcome message, interaction prompts, and FPS display
 */
export class SimpleUI {
  private overlay: HTMLElement;
  private loadingDiv: HTMLElement | null = null;
  private welcomeDiv: HTMLElement | null = null;
  private interactionDiv: HTMLElement | null = null;
  private fpsDiv: HTMLElement | null = null;
  private playerCountDiv: HTMLElement | null = null;
  private customizeDiv: HTMLElement | null = null;
  private zonePanelDiv: HTMLElement | null = null;

  constructor(id: string) {
    // Create or get overlay
    this.overlay = document.getElementById(id) as HTMLElement;
    if (!this.overlay) {
      this.overlay = document.createElement('div');
      this.overlay.id = id;
      document.body.appendChild(this.overlay);
    }

    // Style the overlay
    Object.assign(this.overlay.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: '1000',
      fontFamily: 'Arial, sans-serif',
    });

    this.createFPSDisplay();
  }

  /**
   * Show loading screen with progress
   */
  showLoading(progress: number): void {
    if (!this.loadingDiv) {
      this.loadingDiv = document.createElement('div');
      Object.assign(this.loadingDiv.style, {
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        background: 'rgba(0, 0, 0, 0.8)',
        color: 'white',
        padding: '20px',
        borderRadius: '10px',
        textAlign: 'center',
        pointerEvents: 'auto',
      });
      this.overlay.appendChild(this.loadingDiv);
    }

    this.loadingDiv.innerHTML = `
      <div style="font-size: 24px; margin-bottom: 10px;">🌎 Loading DigiScalability Life Island</div>
      <div style="width: 200px; height: 20px; background: #333; border-radius: 10px; margin: 0 auto 10px;">
        <div style="width: ${progress}%; height: 100%; background: #4CAF50; border-radius: 10px; transition: width 0.3s;"></div>
      </div>
      <div>${progress}%</div>
    `;
  }

  /**
   * Hide loading screen
   */
  hideLoading(): void {
    if (this.loadingDiv) {
      this.loadingDiv.remove();
      this.loadingDiv = null;
    }
  }

  /**
   * Show welcome message
   */
  showWelcome(): void {
    if (!this.welcomeDiv) {
      this.welcomeDiv = document.createElement('div');
      Object.assign(this.welcomeDiv.style, {
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        background: 'rgba(0, 0, 0, 0.9)',
        color: 'white',
        padding: '30px',
        borderRadius: '15px',
        textAlign: 'center',
        pointerEvents: 'auto',
        maxWidth: '400px',
      });
      this.overlay.appendChild(this.welcomeDiv);
    }

    this.welcomeDiv.innerHTML = `
      <h2 style="margin: 0 0 20px 0; color: #4CAF50;">Welcome to DigiScalability Life Island</h2>
      <p style="margin: 0 0 20px 0;">Use WASD to move, mouse to look around, space to jump.</p>
      <p style="margin: 0 0 20px 0; font-size: 14px; color: #ccc;">Press any key to start exploring!</p>
    `;

    // Auto-hide on any key press
    const hideWelcome = () => {
      this.hideWelcome();
      document.removeEventListener('keydown', hideWelcome);
      document.removeEventListener('click', hideWelcome);
    };
    document.addEventListener('keydown', hideWelcome);
    document.addEventListener('click', hideWelcome);
  }

  /**
   * Hide welcome message
   */
  hideWelcome(): void {
    if (this.welcomeDiv) {
      this.welcomeDiv.remove();
      this.welcomeDiv = null;
    }
  }

  /**
   * Check if welcome is visible
   */
  isWelcomeVisible(): boolean {
    return this.welcomeDiv !== null;
  }

  /**
   * Show interaction prompt
   */
  showInteractionPrompt(text: string): void {
    if (!this.interactionDiv) {
      this.interactionDiv = document.createElement('div');
      Object.assign(this.interactionDiv.style, {
        position: 'absolute',
        bottom: '100px',
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(0, 0, 0, 0.8)',
        color: 'white',
        padding: '15px 25px',
        borderRadius: '25px',
        textAlign: 'center',
        pointerEvents: 'auto',
        fontSize: '16px',
      });
      this.overlay.appendChild(this.interactionDiv);
    }

    this.interactionDiv.innerHTML = text;
  }

  /**
   * Hide interaction prompt
   */
  hideInteractionPrompt(): void {
    if (this.interactionDiv) {
      this.interactionDiv.remove();
      this.interactionDiv = null;
    }
  }

  /**
   * Create FPS display
   */
  private createFPSDisplay(): void {
    this.fpsDiv = document.createElement('div');
    Object.assign(this.fpsDiv.style, {
      position: 'absolute',
      top: '10px',
      right: '10px',
      background: 'rgba(0, 0, 0, 0.7)',
      color: 'white',
      padding: '5px 10px',
      borderRadius: '5px',
      fontSize: '12px',
      fontFamily: 'monospace',
      pointerEvents: 'none',
    });
    this.overlay.appendChild(this.fpsDiv);
    this.fpsDiv.textContent = 'FPS: --';

    // Create player count display
    this.playerCountDiv = document.createElement('div');
    Object.assign(this.playerCountDiv.style, {
      position: 'absolute',
      top: '35px',
      right: '10px',
      background: 'rgba(0, 0, 0, 0.7)',
      color: 'white',
      padding: '5px 10px',
      borderRadius: '5px',
      fontSize: '12px',
      fontFamily: 'monospace',
      pointerEvents: 'none',
    });
    this.overlay.appendChild(this.playerCountDiv);
    this.updatePlayerCount(1); // Start with 1 (self)
  }

  /**
   * Update FPS display
   */
  updateFPS(fps: number): void {
    if (this.fpsDiv) {
      this.fpsDiv.textContent = `FPS: ${fps.toFixed(1)}`;
    }
  }

  /**
   * Update player count display
   */
  updatePlayerCount(count: number): void {
    if (this.playerCountDiv) {
      this.playerCountDiv.textContent = `👥 ${count} online`;
    }
  }

  /**
   * Show character customization panel
   */
  showCustomize(onCustomize?: (part: string, value: string) => void): void {
    if (!this.customizeDiv) {
      this.customizeDiv = document.createElement('div');
      Object.assign(this.customizeDiv.style, {
        position: 'absolute',
        bottom: '20px',
        left: '20px',
        background: 'rgba(0, 0, 0, 0.9)',
        color: 'white',
        padding: '15px',
        borderRadius: '10px',
        pointerEvents: 'auto',
        fontSize: '14px',
      });
      this.overlay.appendChild(this.customizeDiv);
    }

    this.customizeDiv.innerHTML = `
      <div style="margin-bottom: 10px; font-weight: bold;">🎨 Customize Character</div>
      <div style="margin-bottom: 5px;">
        <label>Hair: </label>
        <select id="hair-select" style="background: #333; color: white; border: none; padding: 2px;">
          <option value="short">Short</option>
          <option value="long">Long</option>
          <option value="curly">Curly</option>
        </select>
      </div>
      <div style="margin-bottom: 5px;">
        <label>Top: </label>
        <select id="top-select" style="background: #333; color: white; border: none; padding: 2px;">
          <option value="shirt">Shirt</option>
          <option value="jacket">Jacket</option>
          <option value="hoodie">Hoodie</option>
        </select>
      </div>
      <div style="margin-bottom: 5px;">
        <label>Bottom: </label>
        <select id="bottom-select" style="background: #333; color: white; border: none; padding: 2px;">
          <option value="pants">Pants</option>
          <option value="shorts">Shorts</option>
          <option value="skirt">Skirt</option>
        </select>
      </div>
      <div style="margin-bottom: 5px;">
        <label>Shoes: </label>
        <select id="shoes-select" style="background: #333; color: white; border: none; padding: 2px;">
          <option value="sneakers">Sneakers</option>
          <option value="boots">Boots</option>
          <option value="sandals">Sandals</option>
        </select>
      </div>
      <button id="close-customize" style="background: #4CAF50; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; margin-top: 5px;">Close</button>
    `;

    // Add event listeners
    const selects = ['hair', 'top', 'bottom', 'shoes'];
    selects.forEach(part => {
      const select = this.customizeDiv!.querySelector(`#${part}-select`) as HTMLSelectElement;
      select.addEventListener('change', () => {
        if (onCustomize) {
          onCustomize(part, select.value);
        }
      });
    });

    const closeBtn = this.customizeDiv!.querySelector('#close-customize') as HTMLButtonElement;
    closeBtn.addEventListener('click', () => this.hideCustomize());
  }

  /**
   * Hide customization panel
   */
  hideCustomize(): void {
    if (this.customizeDiv) {
      this.customizeDiv.remove();
      this.customizeDiv = null;
    }
  }

  /**
   * Show quest completion notification
   */
  showQuestComplete(quest: { name: string; reward?: { value: string } }): void {
    const div = document.createElement('div');
    Object.assign(div.style, {
      position: 'absolute',
      top: '20%',
      left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(0, 0, 0, 0.9)',
      color: 'white',
      padding: '20px 30px',
      borderRadius: '15px',
      textAlign: 'center',
      pointerEvents: 'none',
      fontSize: '18px',
      border: '2px solid #4CAF50',
      zIndex: '1500',
      transition: 'opacity 0.5s',
    });
    div.innerHTML = `
      <div style="font-size:28px;margin-bottom:8px;">🎉 Quest Complete!</div>
      <div style="color:#4CAF50;font-weight:bold;">${quest.name}</div>
      ${quest.reward ? `<div style="margin-top:8px;font-size:14px;color:#ccc;">${quest.reward.value}</div>` : ''}
    `;
    this.overlay.appendChild(div);
    setTimeout(() => {
      div.style.opacity = '0';
      setTimeout(() => div.remove(), 500);
    }, 3000);
  }

  /**
   * Show zone interaction panel
   */
  showZonePanel(zone: any): void {
    this.hideZonePanel(); // Hide any existing panel

    this.zonePanelDiv = document.createElement('div');
    Object.assign(this.zonePanelDiv.style, {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      background: 'rgba(0, 0, 0, 0.9)',
      color: 'white',
      padding: '30px',
      borderRadius: '15px',
      textAlign: 'center',
      pointerEvents: 'auto',
      fontSize: '16px',
      zIndex: '1500',
      border: `3px solid ${this.getZoneColor(zone.id)}`,
      maxWidth: '500px',
      maxHeight: '70vh',
      overflowY: 'auto',
    });

    const content = this.getZoneContent(zone);
    this.zonePanelDiv.innerHTML = content;

    // Add close button
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    Object.assign(closeBtn.style, {
      position: 'absolute',
      top: '10px',
      right: '15px',
      background: 'transparent',
      color: 'white',
      border: 'none',
      fontSize: '24px',
      cursor: 'pointer',
      padding: '0',
      width: '30px',
      height: '30px',
      borderRadius: '50%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    });
    closeBtn.addEventListener('click', () => this.hideZonePanel());
    this.zonePanelDiv.appendChild(closeBtn);

    this.overlay.appendChild(this.zonePanelDiv);

    // Add keyboard listener for escape
    const escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.hideZonePanel();
        document.removeEventListener('keydown', escapeHandler);
      }
    };
    document.addEventListener('keydown', escapeHandler);
  }

  /**
   * Hide zone interaction panel
   */
  hideZonePanel(): void {
    if (this.zonePanelDiv) {
      this.zonePanelDiv.remove();
      this.zonePanelDiv = null;
    }
  }

  /**
   * Get color for zone
   */
  private getZoneColor(zoneId: string): string {
    const colors: { [key: string]: string } = {
      welcome: '#4CAF50',
      professional: '#2196F3',
      projects: '#FF9800',
      personal: '#E91E63',
      contact: '#9C27B0',
    };
    return colors[zoneId] || '#666';
  }

  /**
   * Get content for zone
   */
  private getZoneContent(zone: any): string {
    const contents: { [key: string]: string } = {
      welcome: `
        <h2 style="margin-top: 0; color: #4CAF50;">🏠 Welcome to DigiScalability Life Island</h2>
        <p>Your personal 3D portfolio space inspired by Messenger.</p>
        <p>Explore the island to discover different aspects of my work and life:</p>
        <ul style="text-align: left; display: inline-block;">
          <li><strong>Professional Experience</strong> - Career journey and skills</li>
          <li><strong>Project Portfolio</strong> - Key projects and technologies</li>
          <li><strong>Personal Life</strong> - Hobbies and interests</li>
          <li><strong>Contact</strong> - Get in touch</li>
        </ul>
        <p style="margin-top: 20px;"><em>Use WASD to move, mouse to look around, E to interact</em></p>
      `,
      professional: `
        <h2 style="margin-top: 0; color: #2196F3;">💼 Professional Experience</h2>
        <p>Full-stack developer with expertise in modern web technologies.</p>
        <h3>Skills & Technologies</h3>
        <div style="display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; margin: 20px 0;">
          <span style="background: #333; padding: 5px 10px; border-radius: 15px;">TypeScript</span>
          <span style="background: #333; padding: 5px 10px; border-radius: 15px;">React</span>
          <span style="background: #333; padding: 5px 10px; border-radius: 15px;">Node.js</span>
          <span style="background: #333; padding: 5px 10px; border-radius: 15px;">Three.js</span>
          <span style="background: #333; padding: 5px 10px; border-radius: 15px;">Python</span>
          <span style="background: #333; padding: 5px 10px; border-radius: 15px;">AWS</span>
        </div>
        <p>Experienced in building scalable web applications, 3D experiences, and AI integrations.</p>
      `,
      projects: `
        <h2 style="margin-top: 0; color: #FF9800;">🚀 Project Portfolio</h2>
        <p>Showcase of innovative projects and technical achievements.</p>
        <div style="text-align: left;">
          <h3>🌍 DigiScalability Life Island</h3>
          <p><em>Current Project</em> - 3D portfolio experience built with Three.js</p>
          <ul>
            <li>Interactive spherical world navigation</li>
            <li>Quest-based delivery system</li>
            <li>Real-time 3D rendering with toon shading</li>
          </ul>
          <h3>🤖 AI Chat Integration</h3>
          <p>Gemini API-powered conversational interfaces</p>
          <h3>☁️ Cloud Infrastructure</h3>
          <p>Serverless applications on Firebase & AWS</p>
        </div>
      `,
      personal: `
        <h2 style="margin-top: 0; color: #E91E63;">🎨 Personal Life</h2>
        <p>Beyond coding, I enjoy creative pursuits and continuous learning.</p>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 20px 0;">
          <div>
            <h3>🎵 Music & Audio</h3>
            <p>Creating ambient soundscapes and exploring generative music</p>
          </div>
          <div>
            <h3>🎮 Gaming</h3>
            <p>Strategy games, indie development, and game design</p>
          </div>
          <div>
            <h3>📚 Learning</h3>
            <p>Always exploring new technologies and creative coding</p>
          </div>
          <div>
            <h3>🌱 Growth</h3>
            <p>Building meaningful connections and contributing to open source</p>
          </div>
        </div>
      `,
      contact: `
        <h2 style="margin-top: 0; color: #9C27B0;">📬 Get In Touch</h2>
        <p>Let's connect and discuss opportunities!</p>
        <div style="margin: 30px 0;">
          <p><strong>Email:</strong> contact@example.com</p>
          <p><strong>LinkedIn:</strong> linkedin.com/in/yourprofile</p>
          <p><strong>GitHub:</strong> github.com/yourusername</p>
          <p><strong>Portfolio:</strong> yourwebsite.com</p>
        </div>
        <div style="background: #333; padding: 20px; border-radius: 10px; margin: 20px 0;">
          <h3>💬 Quick Chat</h3>
          <p>Press <strong>C</strong> to open the AI chat assistant for questions about my work or collaborations.</p>
        </div>
      `,
    };

    return contents[zone.id] || `<h2>${zone.name}</h2><p>${zone.description}</p>`;
  }

  /**
   * Dispose of UI elements
   */
  dispose(): void {
    this.hideLoading();
    this.hideWelcome();
    this.hideInteractionPrompt();
    this.hideCustomize();
    this.hideZonePanel();
    if (this.fpsDiv) {
      this.fpsDiv.remove();
      this.fpsDiv = null;
    }
    if (this.playerCountDiv) {
      this.playerCountDiv.remove();
      this.playerCountDiv = null;
    }
    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
  }
}
