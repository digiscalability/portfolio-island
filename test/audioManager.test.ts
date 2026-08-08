// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';

import { AudioManager } from '../AudioManager';

describe('AudioManager basics', () => {
  test('constructs and toggles mute', () => {
    const am = new AudioManager();
    expect(am.isMuted()).toBe(false);
    am.toggleMute();
    expect(typeof am.isMuted()).toBe('boolean');
  });

  test('isPlaying returns false for unknown key', () => {
    const am = new AudioManager();
    expect(am.isPlaying('no-such-key')).toBe(false);
  });

  test('setVolume clamps to [0,1] and persists as v2', () => {
    localStorage.removeItem('ds_audio_settings'); // isolate from prior tests
    const am = new AudioManager();
    am.setVolume(1.7);
    expect(am.getVolume()).toBe(1);
    am.setVolume(-0.3);
    expect(am.getVolume()).toBe(0);
    am.setVolume(0.45);
    expect(am.getVolume()).toBe(0.45);
    const stored = JSON.parse(localStorage.getItem('ds_audio_settings') ?? '{}');
    expect(stored.v).toBe(2);
    expect(stored.volume).toBe(0.45);
  });

  test('effective volume folds mute in', () => {
    localStorage.removeItem('ds_audio_settings'); // isolate from prior tests
    const am = new AudioManager();
    am.setVolume(0.6);
    expect(am.getEffectiveVolume()).toBe(0.6);
    am.toggleMute();
    expect(am.getEffectiveVolume()).toBe(0);
    am.toggleMute();
    expect(am.getEffectiveVolume()).toBe(0.6);
  });
});
