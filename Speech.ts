// Speech.ts — free, on-device text-to-speech for NPC voices via the browser's
// SpeechSynthesis API. Zero cost, no key, no server. Voices are system-provided
// (quality varies by device) but per-NPC rate/pitch make each NPC distinct.
//
// A premium-voice upgrade (e.g. ElevenLabs) would be a SEPARATE, costed add-on
// behind the same server-proxy + spend-cap pattern as the NPC brain — dynamic
// per-reply cloud TTS on anonymous public traffic is a denial-of-wallet risk,
// so it is deliberately not the default.

let enabled = true;
let chosen: SpeechSynthesisVoice | null = null;

function supported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

// Prefer a natural English voice; voices can load async, so re-pick on change.
function pickVoice(): SpeechSynthesisVoice | null {
  if (!supported()) return null;
  if (chosen) return chosen;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  chosen =
    voices.find((v) => /en[-_]?(GB|AU)/i.test(v.lang)) ||
    voices.find((v) => /^en/i.test(v.lang)) ||
    voices[0];
  return chosen;
}

if (supported()) {
  try {
    window.speechSynthesis.onvoiceschanged = () => {
      chosen = null;
      pickVoice();
    };
    pickVoice();
  } catch {
    /* ignore */
  }
}

export function isSpeechSupported(): boolean {
  return supported();
}

export function isSpeechEnabled(): boolean {
  return enabled;
}

export function setSpeechEnabled(on: boolean): void {
  enabled = on;
  if (!on) cancelSpeech();
}

export function cancelSpeech(): void {
  if (supported()) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  }
}

/** Speak a line in an NPC's voice (rate/pitch per NPC). No-op if muted/unsupported. */
export function speak(text: string, rate = 1, pitch = 1): void {
  if (!enabled || !supported()) return;
  const clean = text.trim();
  if (!clean) return;
  try {
    window.speechSynthesis.cancel(); // never overlap two NPC lines
    const u = new SpeechSynthesisUtterance(clean.slice(0, 400));
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = rate;
    u.pitch = pitch;
    u.volume = 1;
    window.speechSynthesis.speak(u);
  } catch {
    /* speech failure never breaks the chat */
  }
}
