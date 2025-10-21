// ChatSystem - Handles AI Q&A interactions
// This is a placeholder implementation that will connect to Firebase Functions

export interface ChatMessage {
  id: string;
  text: string;
  sender: 'user' | 'ai';
  timestamp: number;
}

export class ChatSystem {
  private messages: ChatMessage[] = [];
  private onMessageCallback?: (message: ChatMessage) => void;

  constructor() {
    // Add welcome message
    this.addMessage({
      id: this.generateId(),
      text: "Welcome! I'm your AI guide to DigiScalability Life Island. Ask me anything about the island, its zones, or the owner!",
      sender: 'ai',
      timestamp: Date.now(),
    });
  }

  public async sendMessage(text: string): Promise<void> {
    // Add user message
    const userMessage: ChatMessage = {
      id: this.generateId(),
      text,
      sender: 'user',
      timestamp: Date.now(),
    };
    this.addMessage(userMessage);

    // Simulate AI response (replace with actual Firebase Function call)
    const aiResponse = await this.getAIResponse(text);
    const aiMessage: ChatMessage = {
      id: this.generateId(),
      text: aiResponse,
      sender: 'ai',
      timestamp: Date.now(),
    };
    this.addMessage(aiMessage);
  }

  private async getAIResponse(_userMessage: string): Promise<string> {
    // TODO: Replace with actual Firebase Function call to Gemini API
    // Example:
    // const response = await fetch('https://YOUR_REGION-YOUR_PROJECT_ID.cloudfunctions.net/askAI', {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({ message: userMessage })
    // });
    // const data = await response.json();
    // return data.response;

    // Placeholder response
    await new Promise((resolve) => setTimeout(resolve, 1000));
    
    const responses = [
      "That's a great question! The island represents a digital portfolio and interactive experience.",
      "Each zone on the island showcases different aspects of life and work. Try exploring them!",
      "You can interact with zones by walking close to them and pressing 'E' or Space.",
      "The Business Hub contains information about DigiScalability projects and AI products.",
      "Feel free to leave feedback or schedule an appointment at the Contact Dock!",
    ];
    
    return responses[Math.floor(Math.random() * responses.length)];
  }

  private addMessage(message: ChatMessage): void {
    this.messages.push(message);
    if (this.onMessageCallback) {
      this.onMessageCallback(message);
    }
  }

  public getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  public onMessage(callback: (message: ChatMessage) => void): void {
    this.onMessageCallback = callback;
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  public clearMessages(): void {
    this.messages = [];
  }
}

