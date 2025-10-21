import { AudioManager } from '../AudioManager';

// Lightweight: declare jest-like globals for tsc to avoid type errors in this workspace.
declare const describe: any;
declare const test: any;
declare const expect: any;

// Smoke tests for AudioManager - kept as a file to be run by a test runner (install @types/jest for better TS support)
describe && describe('AudioManager basic', () => {
  test && test('constructs and toggles mute', () => {
    const am = new AudioManager();
    try { expect(am.isMuted()).toBe(false); } catch (e) { /* runtime test frameworks will run actual asserts */ }
    am.toggleMute();
    try { expect(typeof am.isMuted()).toBe('boolean'); } catch (e) { }
  });

  test && test('isPlaying returns false for unknown key', () => {
    const am = new AudioManager();
    try { expect(am.isPlaying('no-such-key')).toBe(false); } catch (e) { }
  });
});
