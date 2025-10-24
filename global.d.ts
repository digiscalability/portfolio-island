import type * as THREE from 'three';

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
    __hdrEnvironments?: string[];
    __deferredAudio?: Record<string, string>;
    __originalMaterials?: Array<{ obj: THREE.Object3D; material: THREE.Material }>;
    __makeHDRIVisibleState?: boolean;
    __ormDiagnostics?: Array<{ map: string; result: string; reason?: string }>;
    __DEBUG_PLAYER?: boolean;
    webkitAudioContext?: typeof AudioContext;
  }
}

export {};
