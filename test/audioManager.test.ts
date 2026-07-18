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
});
