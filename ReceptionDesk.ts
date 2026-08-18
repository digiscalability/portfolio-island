/**
 * ReceptionDesk — live voice conversation with the DigiScalability reception
 * agent, mounted in the "Get In Touch" district panel.
 *
 * ARCHITECTURE. Unlike npcVoice (a server proxy we fully control), an
 * ElevenLabs agent connects the BROWSER DIRECTLY to ElevenLabs. The agent is
 * therefore PRIVATE (platform_settings.auth.enable_auth), and a connection
 * requires a short-lived signed URL that only our `agentSession` Cloud Function
 * can mint — behind App Check, per-IP windows and daily/monthly session caps.
 * A raw agent id is useless to a scraper. See functions/src/agentSession.ts.
 *
 * AUDIO. The SDK owns its own output path — it does NOT route through
 * AudioManager's master bus, so the HUD mute cannot silence it. That is the
 * right call for a deliberate, user-initiated phone call (you don't mute a call
 * with the music slider), but it means the game must get out of the way: we
 * duck the sfx bus for the duration and restore on hang-up.
 *
 * The SDK is dynamically imported so it stays off the startup critical path —
 * same convention as firebaseClient. Nothing here loads until a visitor
 * actually clicks "Talk to reception".
 */

import { track } from './Analytics';
import { sfx } from './Sfx';

type Conversation = {
  endSession: () => Promise<void>;
};

let active: Conversation | null = null;
let restoreAudio: (() => void) | null = null;

/** How far the game steps back while the caller is on the line, as a FACTOR
 *  of the user's volume (0.2 × the 0.7 default ≈ the old absolute 0.15). */
const CALL_DUCK_FACTOR = 0.2;

/** Duck the game while the caller is on the line; returns the restore fn. */
function duckGame(): () => void {
  const w = window as unknown as {
    audioManager?: { setDuckFactor?: (f: number) => void };
  };
  // sfx is IMPORTED, not read off window: nothing ever assigns window.sfx, so
  // the optional-chained `w.sfx?.duckForVoice?.()` this replaced was a silent
  // no-op — the game never actually stepped back during a call.
  try {
    sfx.duckForVoice(true);
  } catch {
    /* audio not booted yet — nothing to duck */
  }
  // setDuckFactor, NOT setVolume. setVolume is the user-preference API and it
  // PERSISTS: a tab closed mid-call saved 0.15 into ds_audio_settings and the
  // next session booted at 15% volume with the slider showing it. It also
  // snapshot-restored the pre-call volume on hang-up, clobbering any change
  // the user made during the call. The duck factor is transient (dies with
  // the session), invisible to the slider, and composes with live volume
  // changes instead of overwriting them.
  w.audioManager?.setDuckFactor?.(CALL_DUCK_FACTOR);
  return () => {
    try {
      sfx.duckForVoice(false);
    } catch {
      /* ignore */
    }
    w.audioManager?.setDuckFactor?.(1);
  };
}

/**
 * Ask the server for a signed URL. Returns null for every failure mode — cap
 * hit, rate limited, offline, App Check missing, function not deployed — so the
 * caller can degrade to the written contact form rather than showing an error.
 */
async function mintSignedUrl(): Promise<{ url: string | null; reason?: string }> {
  try {
    const [{ getFirebaseApp }, fns] = await Promise.all([
      import('./firebaseClient'),
      import('firebase/functions'),
    ]);
    const app = await getFirebaseApp();
    const functions = fns.getFunctions(app, 'us-central1');
    const call = fns.httpsCallable<Record<string, never>, { url: string | null; reason?: string }>(
      functions,
      'agentSession',
    );
    const res = await call({} as Record<string, never>);
    return res.data ?? { url: null, reason: 'bad-shape' };
  } catch {
    return { url: null, reason: 'client-error' };
  }
}

/** Mount the reception-desk block into the contact panel. */
export function appendReceptionDesk(container: HTMLElement): void {
  const box = document.createElement('div');
  box.style.cssText =
    'margin-top:18px;text-align:left;border-top:1px solid rgba(255,255,255,0.12);padding-top:16px;';
  box.innerHTML = `
    <h3 style="margin:0 0 4px;font-size:15px;">Talk to my AI receptionist</h3>
    <p style="margin:0 0 10px;font-size:12px;color:#9aa;">A live voice agent I built — ask it what I do, what things cost, or how I'd approach your project.</p>
    <button id="rd-start" style="width:100%;padding:11px;border:none;border-radius:10px;background:linear-gradient(135deg,#26a69a,#00695c);color:#fff;font-size:15px;font-weight:600;cursor:pointer;">🎙 Start voice call</button>
    <div id="rd-status" role="status" aria-live="polite" style="margin:8px 0 0;font-size:12px;color:#9aa;min-height:16px;"></div>
    <div id="rd-log" style="margin:8px 0 0;font-size:13px;line-height:1.45;max-height:150px;overflow-y:auto;display:none;"></div>`;
  // Sit ABOVE the written form — its heading ("Or send a message") reads as the
  // secondary option. This module is dynamically imported so it always resolves
  // after the form's synchronous append; anchor to the node, don't trust order.
  const anchor = container.querySelector('#lead-form-block');
  if (anchor) container.insertBefore(box, anchor);
  else container.appendChild(box);

  const btn = box.querySelector('#rd-start') as HTMLButtonElement;
  const status = box.querySelector('#rd-status') as HTMLDivElement;
  const log = box.querySelector('#rd-log') as HTMLDivElement;

  const say = (msg: string) => {
    status.textContent = msg;
  };
  const addLine = (who: string, text: string, color: string) => {
    log.style.display = 'block';
    const p = document.createElement('p');
    p.style.cssText = `margin:0 0 6px;color:${color};`;
    p.textContent = `${who}: ${text}`;
    log.appendChild(p);
    log.scrollTop = log.scrollHeight;
  };

  const hangUp = async () => {
    const conv = active;
    active = null;
    btn.textContent = '🎙 Start voice call';
    btn.disabled = false;
    say('Call ended.');
    restoreAudio?.();
    restoreAudio = null;
    try {
      await conv?.endSession();
    } catch {
      /* already closed */
    }
  };

  btn.addEventListener('click', async () => {
    if (active) {
      void hangUp();
      return;
    }
    btn.disabled = true;
    say('Connecting…');
    track('reception_call_start');

    const { url, reason } = await mintSignedUrl();
    if (!url) {
      btn.disabled = false;
      // 'cap'/'rate' are the spend guards doing their job — say so plainly and
      // point at the form below rather than presenting it as a fault.
      say(
        reason === 'cap' || reason === 'rate'
          ? "The voice desk is at its daily limit — please use the message form below and I'll reply personally."
          : "Couldn't start the call. The message form below works fine.",
      );
      track('reception_call_blocked', { reason: String(reason ?? 'unknown') });
      return;
    }

    try {
      const { Conversation } = await import('@elevenlabs/client');
      restoreAudio = duckGame();
      const conv = (await Conversation.startSession({
        signedUrl: url,
        // signedUrl is the WebSocket auth path; WebRTC uses conversation tokens.
        connectionType: 'websocket',
        onConnect: () => {
          say('Connected — just talk. Click again to hang up.');
          btn.textContent = '■ End call';
          btn.disabled = false;
        },
        onDisconnect: () => void hangUp(),
        onError: () => {
          say('The call dropped. The message form below still works.');
          void hangUp();
        },
        onMessage: ({ message, source }: { message: string; source: string }) => {
          if (!message) return;
          if (source === 'user') addLine('You', message, '#9aa');
          else addLine('Reception', message, '#b2dfdb');
        },
      })) as unknown as Conversation;
      active = conv;
    } catch (err) {
      restoreAudio?.();
      restoreAudio = null;
      btn.disabled = false;
      btn.textContent = '🎙 Start voice call';
      // Overwhelmingly the mic permission prompt being dismissed.
      const denied = String(err).toLowerCase().includes('permission');
      say(
        denied
          ? 'Microphone access is needed for the call — or just use the form below.'
          : "Couldn't start the call. The message form below works fine.",
      );
      track('reception_call_error', { denied: String(denied) });
    }
  });
}

/** Hang up if the panel closes mid-call — otherwise the agent keeps listening
 *  (and billing) after the visitor has walked away. */
export async function stopReceptionCall(): Promise<void> {
  if (!active) return;
  const conv = active;
  active = null;
  restoreAudio?.();
  restoreAudio = null;
  try {
    await conv.endSession();
  } catch {
    /* already closed */
  }
}
