/**
 * audioPrefs — the persisted HUD audio settings (ds_audio_settings), readable
 * BEFORE the AudioManager exists.
 *
 * The manager boots ~5 seconds after first paint (idle + dynamic import), but
 * the voice paths are live from init, and both have playback routes that need
 * no manager at all: Chat's private fallback AudioContext and Speech's
 * HTMLAudioElement / speechSynthesis. Their mute checks read the LIVE manager
 * and defaulted to "not muted" when it was absent — so a visitor who muted
 * last session could hear peer voice and NPC speech during the boot window,
 * with the HUD button (which flips this very key pre-boot) showing muted.
 *
 * Deliberately a tiny standalone module rather than an export from
 * AudioManager.ts: Chat and Speech import it STATICALLY, and a static import
 * from AudioManager would pull the whole manager into the critical bundle
 * that its dynamic import exists to keep it out of. AudioManager imports the
 * shared default from here instead (safe direction — this module is a leaf).
 */

/** Default master volume. v2 of ds_audio_settings — quieter than the old 1.0
 *  ("reduce default sound volume"); stored v1 profiles are migrated down. */
export const DEFAULT_VOLUME = 0.7;

/** The persisted mute flag, or false when nothing is stored / storage fails.
 *  Same read the AudioManager constructor performs at boot. */
export function persistedAudioMuted(): boolean {
  try {
    const stored = localStorage.getItem('ds_audio_settings');
    return stored ? !!JSON.parse(stored).muted : false;
  } catch {
    return false;
  }
}

/** The persisted volume under the same v2 gate the AudioManager applies
 *  (v1 values are ignored so old 1.0 profiles stay migrated down). */
export function persistedAudioVolume(): number {
  try {
    const stored = localStorage.getItem('ds_audio_settings');
    if (!stored) return DEFAULT_VOLUME;
    const parsed = JSON.parse(stored);
    return parsed.v === 2 && typeof parsed.volume === 'number' ? parsed.volume : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}
