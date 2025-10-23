import type * as THREE from 'three';

import type { GameScene } from './GameScene';
import type { OrbitCamera } from './OrbitCamera';
import type { InputRecording } from './SimpleInputManager';
import type { SimplePlanet } from './SimplePlanet';
import type { SimplePlayer } from './SimplePlayer';
import type { SimpleRenderer } from './SimpleRenderer';

interface HDRIBoostOptions {
  envMapIntensity?: number;
  metalness?: number;
  roughness?: number;
  max?: number;
}

declare global {
  interface Window {
    engine: import('./Engine').Engine | undefined;
    uiManager: import('./UIManager').UIManager | undefined;
    audioManager: import('./AudioManager').AudioManager | undefined;
    virtualJoystick: import('./VirtualJoystick').VirtualJoystick | undefined;
    disablePostProcessing?: () => void;
    enablePostProcessing?: () => void;
    adjustCamera?: (offset: { x?: number; y?: number; z?: number } | null, smooth?: number) => void;
    makeHDRIVisible?: (options?: HDRIBoostOptions) => Promise<void>;
    restoreOriginalMaterials?: () => void;
    togglePointerDebug?: () => void;
    __FORCE_DEBUG?: boolean;
    __ISLAND_DEBUG?: boolean;
    __DEBUG_MODE?: boolean;
    __hdrEnvironments?: string[];
    __deferredAudio?: Record<string, string>;
    __originalMaterials?: Array<{ obj: THREE.Object3D; material: THREE.Material }>;
    __makeHDRIVisibleState?: boolean;
    __ormDiagnostics?: Array<{ map: string; result: string; reason?: string }>;
    __DEBUG_PLAYER?: boolean;
    __LOGGER?: LoggerInstance;
    toggleDebugOverlay?: (enabled: boolean) => void;
    scene?: GameScene;
    camera?: THREE.Camera;
    renderer?: ReturnType<SimpleRenderer['getRenderer']>;
    player?: SimplePlayer;
    planet?: SimplePlanet;
    orbitCamera?: OrbitCamera;
    runCameraFlyIn?: (duration?: number) => Promise<void>;
    listRecentLogs?: () => unknown[];
    __INPUT_RECORDER?: {
      start(): void;
      stop(): InputRecording | null;
      export(): string | null;
      clear(): void;
      get(): InputRecording | null;
      isRecording(): boolean;
    };
    enableDebugTools?: () => void;
    captureInput?: (seconds?: number) => Promise<InputRecording | null>;
    webkitAudioContext?: typeof AudioContext;
  }
}

export {};
