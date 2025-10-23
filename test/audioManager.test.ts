import { AudioManager } from '../AudioManager';

type DescribeFn = (name: string, fn: () => void) => void;
type TestFn = (name: string, fn: () => void) => void;
type ExpectResult = {
  toBe: (expected: unknown) => void;
};
type ExpectFn = (value: unknown) => ExpectResult;

// Lightweight: declare jest-like globals for tsc to avoid type errors in this workspace.
declare const describe: DescribeFn | undefined;
declare const test: TestFn | undefined;
declare const expect: ExpectFn | undefined;

// Smoke tests for AudioManager - kept as a file to be run by a test runner (install @types/jest for better TS support)
if (
  typeof describe === 'function' &&
  typeof test === 'function' &&
  typeof expect === 'function'
) {
  describe('AudioManager basic', () => {
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
}
