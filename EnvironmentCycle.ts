import * as THREE from 'three';

import { a11y } from './Accessibility';
import { setCelNight } from './CelLook';
import { fx } from './FxBudget';
import { isRealTheme } from './Theme';
import { FOG_DENSITY_X_RADIUS, REFERENCE_RADIUS } from './WorldScale';

// P2-C1: the sun, the moon and the sky's warm lobe run in the visitor's own
// frame (switch 'localSun'; off gives the world-anchored sun back).
fx.register('localSun', { desktop: true, low: true });

// Weather fog was authored as flat +0.010 (rain) / +0.005 (grey) ON TOP of the
// R=50 base density (FOG_DENSITY_X_RADIUS / REFERENCE_RADIUS = 0.009). As the
// base scales with the world those flat deltas silently changed the WEATHER
// LOOK — rain at R=75 was 26% optically thicker than the rain that was tuned.
// Expressed as ratios of the base they reproduce R=50 output exactly and keep
// density x radius weather-invariant at any size.
const WEATHER_FOG_RAIN_RATIO = 0.01 / (FOG_DENSITY_X_RADIUS / REFERENCE_RADIUS);
const WEATHER_FOG_GREY_RATIO = 0.005 / (FOG_DENSITY_X_RADIUS / REFERENCE_RADIUS);

/**
 * EnvironmentCycle — day/night + weather matched to the visitor.
 *
 * Time of day comes from the client clock (always available, no
 * permissions), driving a continuous sun arc, sky palette, fog color,
 * star field, and lamp/window glow. Weather comes from geolocation →
 * Open-Meteo (free, no key), falling back to an IP lookup, falling back
 * to clear skies. Rain and snow are lightweight point particles that
 * follow the player around the sphere.
 */

export type WeatherKind = 'clear' | 'cloudy' | 'rain' | 'snow';

interface SkyUniforms {
  topColor: { value: THREE.Color };
  bottomColor: { value: THREE.Color };
  horizonColor: { value: THREE.Color };
  // Slice B (optional so older callers/tests remain valid):
  zenithColor?: { value: THREE.Color };
  sunDir?: { value: THREE.Vector3 };
  sunWarmth?: { value: number };
}

// Sky palettes. Day blues are deliberately deeper than the target look:
// ACES tone mapping in the output pass lifts and desaturates them, so
// pale source values render near-white.
const PALETTE = {
  day: {
    top: new THREE.Color(0x2a6fd6),
    horizon: new THREE.Color(0x79b7e6),
    bottom: new THREE.Color(0xc0def2),
  },
  dusk: {
    top: new THREE.Color(0x51548e),
    horizon: new THREE.Color(0xff9a5c),
    bottom: new THREE.Color(0xffd9b0),
  },
  night: {
    top: new THREE.Color(0x0a1030),
    horizon: new THREE.Color(0x27395e),
    bottom: new THREE.Color(0x0e1838),
  },
  // Blue-leaning grays: a cloudy sky is dimmer, not white
  overcast: {
    top: new THREE.Color(0x76889f),
    horizon: new THREE.Color(0xa6b4c2),
    bottom: new THREE.Color(0xc3ccd6),
  },
};

/**
 * One shared day-factor cutoff above which EVERY exterior dynamic light goes
 * `visible = false`. The 12 lights (10 lamp/house points + 2 lighthouse
 * spots) used to stay in the renderer's light list all day at visually-nil
 * intensities, so every lit fragment paid the full light loop for zero
 * contribution. ONE shared threshold means the light count changes exactly
 * once per dusk/dawn (a single shader-permutation flip), instead of stepping
 * through intermediate counts as per-light curves cross zero at different
 * times. 0.85 sits past every curve's zero (lamp-follow 1-d*1.35 → 0.741,
 * beams 1-d*1.25 → 0.8) and the glow floor's 0.41·base residue is invisible
 * against full daylight — so the flip never pops.
 */
export const EXTERIOR_LIGHTS_DAY_CUTOFF = 0.85;

/**
 * The key light's ceiling, as the y of its unit direction: 65 degrees. With
 * the sun in the visitor's own frame a noon key would stand at the zenith
 * over every district, where each wall gets N.L = 0 and the cel ramp gives
 * all four sides of a building the same middle band. Held at 65 degrees the
 * walls keep a lit side and a shaded side; flat ground stays in the top band
 * (N.L 0.91). The sun DISC keeps its true height.
 */
export const KEY_ELEVATION_CAP = Math.sin(1.13);

// The local frame's policy (see stepLocalFrame). Angles in radians.
/** A jump of the visitor's up-axis this large in one frame is a teleport
 *  (fast travel, a respawn, leaving a room): 3.4 degrees is 6 u at R = 100,
 *  more than any vehicle covers in a frame. */
const FRAME_TELEPORT_STEP = 0.06;
const FRAME_TELEPORT_COS = Math.cos(FRAME_TELEPORT_STEP);
/** Below this the visitor counts as standing: 0.3 u/s at R = 100. */
const FRAME_STILL_SPEED = 0.003;
/** How long they must stand before the light starts to turn. */
const FRAME_STILL_HOLD = 0.15;
/** The turn: at least 6 degrees a second, faster while far off (1.6 x the
 *  error per second), so a short walk settles unnoticed and a long one takes
 *  about two seconds. */
const FRAME_MIN_RATE = 0.105;
const FRAME_GAIN = 1.6;

// ── The key and the hemisphere through the day (C1, C5) ─────────────────────
// `elev` below is the sun's height as update() carries it: the y of its unit
// direction (the sine of its elevation), 0 at the horizon, negative under it.

/** 1 with the sun on the horizon, 0 once it is 20 degrees above or below. */
export function duskFactorAt(elev: number): number {
  return Math.max(0, 1 - Math.abs(elev) / 0.35);
}

/**
 * 0 by day and through golden hour, 1 once the sun is well under the horizon.
 *
 * The edges are in ORDER on purpose. THREE.MathUtils.smoothstep(x, min, max)
 * returns 0 for x <= min and 1 for x >= max and does not accept min > max: the
 * first plan for this wrote smoothstep(elev, 0.0, -0.15), which is 0 for
 * every negative elevation, so its night tint could never engage.
 * 1 - dayFactor is no night factor either: it is already 0.8 at sunset, which
 * is why the golden-hour key used to come out grey-lavender.
 */
export function nightFactorAt(elev: number): number {
  return THREE.MathUtils.smoothstep(-elev, 0.05, 0.3);
}

/**
 * How far the key has swung from the sun to the moon. The sun stays the key
 * through golden hour: the old ramp ran on dayFactor < 0.5, which is already
 * true at sunset, so a 06:00 key came about 90% from the moon and the dawn
 * look depended on the lunar phase.
 */
export function moonWeightAt(elev: number, moonElev: number): number {
  return (
    THREE.MathUtils.smoothstep(-elev, 0.05, 0.25) * THREE.MathUtils.smoothstep(moonElev, 0.03, 0.2)
  );
}

/** 1 while the sun is up or just under the horizon, 0 once it has set. A
 *  short ramp (about 14 minutes of clock) where a step would pop the key. */
export function sunUpAt(elev: number): number {
  return THREE.MathUtils.smoothstep(elev, -0.08, -0.02);
}

// ── Night (C5): faces readable, the dark patches kept ───────────────────────
//
// Abbas asked to keep the beaches and the mountains dark at night, and the
// plan bounds the night lift by it: beach-band and highland ground within
// +3 L* of what shipped, while the avatar's median L* goes from 5-7 to 14 or
// more. The plan's first numbers (a night key at 0.20 of its base, a night
// hemisphere at 0.60, GameScene's camera fill at 0.30) lift every surface the
// same: MEASURED with them at 21 h, beach ground rose +13.7 L* and highland
// +7.5, and the avatar came out brighter than at noon. Every one of those
// lights is global, so none of them can lift a face without lifting the sand
// under it.
//
// So the night is split in two (the plan's fallback path):
// - the WORLD keeps its levels. The key stays at the day ramp's floor (0.12);
//   it only stands higher (NIGHT_KEY_FLOOR), which costs flat ground one band
//   of a dim light and gives the night shadows and top-lit forms. The
//   hemisphere keeps its floor too and turns moonlit blue (NIGHT_HEMI_GAIN).
//   The camera fill, which lights whatever the camera faces, the ground
//   included, is turned DOWN at night (NIGHT_FILL);
// - PEOPLE get their own light: CelLook's night fill and moon rim, in the
//   cast's shader only (setCelNight).
// Measured at 21 h and 00 h on both tiers, with GameScene's light rig, against
// what shipped: beach ground +0.5 to +1.0 L* (the mean of four points round
// the island), highland -1.2 to -2.1, hub +1.1 to +2.7, the avatar's median
// 20-25. One caveat: the shipped fill and rim were fixed in the WORLD, so its
// beaches ran from L* 8 to 16.7 round the island; evened out at 13-14, the
// stretch that was darkest rises by 3 to 6.5.

/** The night key's floor, as the y of its unit direction: 35.5 degrees. */
export const NIGHT_KEY_FLOOR = Math.sin(0.62);

/**
 * The night hemisphere's tint carries its level. The plan asked for 0.60 of
 * the base with the tint #7c93c8 / #26331f; these are those two colours
 * times 0.60 / 0.32, at the floor the hemisphere already has (0.32). The
 * product is the same, and it is about what shipped (sky side 0.109 against
 * 0.117 in luminance), only blue.
 *
 * Written this way round because the tint reaches the light through
 * GameScene (getHemiTint): where nothing reads it, the level alone decides,
 * and an untinted 0.60 would be a night twice as bright.
 */
const NIGHT_HEMI_GAIN = 0.6 / 0.32;

/**
 * GameScene's camera fill at full night (0.18 by day). It is aimed from the
 * camera, so at any pitch over 19.5 degrees it puts the ground in the ramp's
 * top band: left at 0.18 it alone lifted beach ground +7.8 L* at 21 h.
 */
const NIGHT_FILL = 0.08;

/**
 * The lowest the key light may stand, as the y of its unit direction.
 *
 * The cel ramp's top band starts at N.L = 1/3 (19.5 degrees over flat
 * ground). Floored at 0.06 the dawn and dusk key lit flat ground from 3.4
 * degrees, so the ground stayed in the middle band whatever the intensity:
 * golden hour was a silhouette world. 0.40 at the horizon (23.6 degrees)
 * puts the ground in the top band; a key that high under a disc on the
 * horizon is a deliberate cheat. The disc keeps its true height.
 *
 * At night it is NIGHT_KEY_FLOOR: moonlight from 35.5 degrees, whether or not
 * the moon is up.
 */
export function keyFloorAt(elev: number): number {
  return Math.max(0.06 + 0.34 * duskFactorAt(elev), NIGHT_KEY_FLOOR * nightFactorAt(elev));
}

/**
 * Golden hour's share of the key and of the hemisphere, as fractions of their
 * bases, with the sun on the horizon. They used to be 0.29 and 0.45 there
 * (the day ramp alone), which with the key tinted 80% toward night left the
 * ground at L* 20-26 under a sky at 60-70.
 *
 * The plan's 0.85 and 0.75 measured the sunlit ground at L* 39.4-39.9 in
 * Professional Experience (its ground is the darkest of the districts), just
 * under the target of 40; these clear it in every district.
 */
const GOLDEN_KEY_LEVEL = 0.92;
const GOLDEN_HEMI_LEVEL = 0.8;

/** The key's intensity as a fraction of its base, before weather. Night
 *  keeps the day ramp's floor (0.12). */
export function keyLevelAt(dayFactor: number, elev: number): number {
  return Math.max(0.12 + 0.88 * dayFactor, GOLDEN_KEY_LEVEL * duskFactorAt(elev) * sunUpAt(elev));
}

/** The hemisphere's intensity as a fraction of its base, before weather.
 *  Night keeps the day ramp's floor (0.32). */
export function hemiLevelAt(dayFactor: number, elev: number): number {
  return Math.max(0.32 + 0.68 * dayFactor, GOLDEN_HEMI_LEVEL * duskFactorAt(elev));
}

// Key colours: warm white by day, amber at the horizon, moonlight at night.
const KEY_DAY = new THREE.Color(0xfff2dd);
const KEY_DUSK = new THREE.Color(0xffc58a);
const KEY_NIGHT = new THREE.Color(0x9db3e6);
// Hemisphere: the sky side cools to moonlit blue, the ground side warms at
// the horizon (the bounce off sunlit earth) and sinks to a dark green.
const HEMI_SKY_NIGHT = new THREE.Color(0x7c93c8).multiplyScalar(NIGHT_HEMI_GAIN);
const HEMI_GROUND_DUSK = new THREE.Color(0x6b5a3a);
const HEMI_GROUND_NIGHT = new THREE.Color(0x26331f).multiplyScalar(NIGHT_HEMI_GAIN);

/**
 * The day factor as a shader uniform, written once a frame. Shared by
 * reference (the sea's trough tint reads it as uDayFactor), so no caller
 * plumbs it through.
 */
export const DAY_FACTOR_UNIFORM: { value: number } = { value: 1 };

/** The dusk factor (duskFactorAt: 1 with the sun on the horizon, 0 by day
 *  and at night) as a shader uniform, written once a frame beside the day
 *  factor. The sea's far band reads it as uDusk. */
export const DUSK_FACTOR_UNIFORM: { value: number } = { value: 0 };

// Hoisted out of update() — both were re-created every frame (object literal +
// array literal) in the unconditional day/night tick. Pure constants now.
const WEATHER_DIM: Record<WeatherKind, number> = { clear: 1, cloudy: 0.55, rain: 0.35, snow: 0.5 };
const SKY_KEYS: Array<keyof typeof PALETTE.day> = ['top', 'horizon', 'bottom'];

export class EnvironmentCycle {
  private scene: THREE.Scene;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private sky: SkyUniforms;
  private fog: THREE.FogExp2 | null;

  private weather: WeatherKind = 'clear';
  private placeLabel = '';
  private statusCb?: (status: string) => void;
  // Real sun times for the resolved location (decimal hours, local tz).
  // Until the fetch lands we fall back to a 6am/6pm approximation.
  private sunriseHour: number | null = null;
  private sunsetHour: number | null = null;
  private temperatureC: number | null = null;
  private nextStatusAt = 0;

  private starLayers: Array<{
    points: THREE.Points;
    mat: THREE.PointsMaterial;
    peak: number;
    twinkleFreq: number;
    twinklePhase: number;
  }> = [];
  private moon: THREE.Mesh;
  private moonMat: THREE.MeshBasicMaterial;
  private sunDisc: THREE.Mesh;
  private sunDiscMat: THREE.MeshBasicMaterial;

  private precip: THREE.Points | null = null;
  private precipGeo: THREE.BufferGeometry | null = null;
  private precipSpeeds: Float32Array | null = null;
  // Cached sprite textures for the two precipitation looks (built once,
  // shared across every rebuild). Snow = soft round flake; rain = a thin
  // vertical streak that reads as a falling drop on the camera-facing quad.
  private static _snowTex: THREE.Texture | null = null;
  private static _rainTex: THREE.Texture | null = null;
  private static _sunTex: THREE.Texture | null = null;
  private static _starTex: THREE.Texture | null = null;

  private glowLights: Array<{ light: THREE.Light; base: number }> = [];
  // Tagged emissive materials (house windows, lamp bulbs). Owned by
  // Island — never disposed here.
  private nightEmissives: Array<{
    mat: THREE.MeshStandardMaterial | THREE.MeshToonMaterial;
    base: THREE.Color;
  }> = [];
  // District beacons (the 'zone-beacon' on each hall's roof), with the
  // colour each was authored in. Their own list, never nightEmissives: a
  // beacon is the far-read cue for a district, so it is lit all day and its
  // hue is the district's at every hour (P2-C5).
  private beacons: Array<{
    mat: THREE.MeshStandardMaterial | THREE.MeshToonMaterial;
    base: THREE.Color;
  }> = [];
  private readonly seenBeacon = new Set<THREE.Material>();
  // Dedupe across collection passes (constructor + the late rescan)
  private readonly seenGlow = new Set<THREE.Light>();
  private readonly seenEmissive = new Set<THREE.Material>();
  // Pavement materials (street ribbons, plaza floors — tagged isPavement).
  // At night the ribbon LIFTS toward moonlit stone and picks up a gentle
  // emissive floor, so the road itself is what you navigate by. `emBase` is
  // the authored emissive, kept so the drive is a lerp from truth rather
  // than an absolute write (the material is shared across a whole path).
  private pavementMats: Array<{
    mat: THREE.MeshStandardMaterial | THREE.MeshToonMaterial;
    base: THREE.Color;
    emBase: THREE.Color;
  }> = [];
  private readonly seenPavement = new Set<THREE.Material>();
  private rescanned = false;

  private baseSunIntensity: number;
  private baseHemiIntensity: number;
  private baseFogDensity: number;

  /** Debug override: fractional hour 0-24, or null for the real clock. */
  public debugHour: number | null = null;

  /** Last computed day factor (0 = deep night, 1 = full day). */
  private lastDayFactor = 1;
  private lastDuskFactor = 0;
  private lastNightFactor = 0;

  public getDayFactor(): number {
    return this.lastDayFactor;
  }

  /** 1 with the sun on the horizon, 0 away from dawn and dusk. */
  public getDuskFactor(): number {
    return this.lastDuskFactor;
  }

  /**
   * 0 by day AND through golden hour, 1 at night (nightFactorAt). Anything
   * that should only happen after dark keys on this, never on
   * 1 - getDayFactor(), which is 0.8 at sunset.
   */
  public getNightFactor(): number {
    return this.lastNightFactor;
  }

  // The hemisphere's live tint. GameScene's underwater grade rewrites the
  // hemisphere's two colours every frame, so the tint is also handed out here
  // for it to start from (the Colors are this object's, updated in place).
  private readonly hemiBaseSky: THREE.Color;
  private readonly hemiBaseGround: THREE.Color;
  private readonly hemiTint = { sky: new THREE.Color(), ground: new THREE.Color() };

  /** The hemisphere's sky and ground colours for this frame, before any
   *  underwater grade. Read-only; the same object every call. */
  public getHemiTint(): { readonly sky: THREE.Color; readonly ground: THREE.Color } {
    return this.hemiTint;
  }

  /**
   * The level GameScene's camera fill takes at full night (NIGHT_FILL). One of
   * the three night levers, with the key and the hemisphere; all three are
   * set here, together, against the dark beaches and highlands.
   */
  public getNightFill(): number {
    return NIGHT_FILL;
  }

  /** Current in-world hour 0–24 (honours the ?hour= debug override). Drives the
   *  NPC activity schedules in NpcActivities.ts. */
  public getHour(): number {
    return this.currentHour();
  }

  // ── The visitor's own sky (P2-C1) ───────────────────────────────────────
  // The sun arc is built around world +Y, which is "up" only at the hub. The
  // four districts stand 63 degrees from the pole, so the same sun that is
  // high over the hub sat 5.7 degrees over Professional Experience at 10:30
  // (the hour every first visit gets) and below the horizon of two districts
  // at 09:00 and 15:00, under a midday sky. Both frames below rotate world +Y
  // onto the visitor's up-axis, so the arc is the same everywhere.
  //
  // qSky is the visitor's frame this frame. The sun and moon discs and the
  // sky's warm lobe use it: they cast nothing, so they can follow every step
  // and stay put in the visitor's sky.
  //
  // qLight is the KEY LIGHT's frame, and it only turns while the visitor
  // stands still. GameScene.updateSunShadow snaps the shadow box to texels on
  // a basis built from the sun's direction, so any turn of the light
  // re-quantises every shadow edge in the map; turned every frame of a walk
  // (0.05 degrees a frame at walking speed) the edges boil and every shadow
  // slides. MEASURED before choosing, walking 3 s past static shadows, mean
  // per-frame change on their edge pixels (0-255 luma), desktop / phone:
  // world-anchored 0.042 / 0.108; re-based every frame 0.375 / 0.725;
  // re-based every 0.5 degrees 0.119 / 0.282 (a pop each 0.9 u). Held while
  // walking, the light turns 0.000 degrees over the same walk.
  private readonly qSky = new THREE.Quaternion();
  private readonly qLight = new THREE.Quaternion();
  private readonly _upNow = new THREE.Vector3(0, 1, 0);
  private readonly _upPrev = new THREE.Vector3(0, 1, 0);
  private frameReady = false;
  private frameSettled = false;
  private stillFor = 0;
  private localSunOn = false;
  // stepLocalFrame's arguments (it is called through fx.time, bound once).
  private _framePos: THREE.Vector3 = this._upNow;
  private _frameDt = 0;

  /**
   * The key light's frame: the rotation from world +Y to the visitor's up
   * that the light is using now. Read-only; it trails the visitor while they
   * walk and catches up when they stand (identity with 'localSun' off).
   */
  public getLocalFrame(): Readonly<THREE.Quaternion> {
    return this.qLight;
  }

  /**
   * Advance both frames. Bound once (an arrow property), so fx.time gets the
   * same function every frame and nothing is allocated.
   */
  private readonly stepLocalFrame = (): void => {
    this.localSunOn = fx.on('localSun');
    if (!this.localSunOn) {
      if (this.frameReady) {
        this.qSky.identity();
        this.qLight.identity();
        this.frameReady = false;
      }
      return;
    }
    const pos = this._framePos;
    if (pos.lengthSq() < 1e-8) return;
    this._upNow.copy(pos).normalize();
    this.qSky.setFromUnitVectors(this._up, this._upNow);
    // How far the up-axis turned this frame, as a cosine (no acos per frame).
    const cos = this.frameReady ? this._upNow.dot(this._upPrev) : -1;
    this._upPrev.copy(this._upNow);
    if (cos < FRAME_TELEPORT_COS) {
      // First frame, or the visitor was moved: nothing to ease from.
      this.qLight.copy(this.qSky);
      this.frameReady = true;
      this.frameSettled = true;
      this.stillFor = 0;
      return;
    }
    const dt = this._frameDt;
    if (dt <= 0) return;
    // 1 - cos(a) is a*a/2 for a small turn a: compare with the standing limit.
    const still = FRAME_STILL_SPEED * dt;
    if (1 - cos > 0.5 * still * still) {
      this.stillFor = 0; // walking, riding or sailing: hold the light
      this.frameSettled = false;
      return;
    }
    if (this.frameSettled) return; // standing where the light already is
    this.stillFor += dt;
    if (this.stillFor < FRAME_STILL_HOLD) return;
    const err = this.qLight.angleTo(this.qSky);
    // Reduced motion: no world-wide swing of the light, it is simply right.
    if (err < 1e-5 || a11y.reducedMotion) {
      this.qLight.copy(this.qSky);
      this.frameSettled = true;
      return;
    }
    this.qLight.rotateTowards(this.qSky, Math.max(FRAME_MIN_RATE, err * FRAME_GAIN) * dt);
  };

  // Scratch
  private readonly _c1 = new THREE.Color();
  private readonly _c2 = new THREE.Color();
  private readonly _up = new THREE.Vector3(0, 1, 0);
  private readonly _normal = new THREE.Vector3();
  private readonly _v1 = new THREE.Vector3();
  private readonly _v2 = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    sun: THREE.DirectionalLight,
    hemi: THREE.HemisphereLight,
    sky: SkyUniforms,
  ) {
    this.scene = scene;
    this.sun = sun;
    this.hemi = hemi;
    this.sky = sky;
    this.fog = scene.fog instanceof THREE.FogExp2 ? scene.fog : null;
    this.baseSunIntensity = sun.intensity;
    this.baseHemiIntensity = hemi.intensity;
    this.hemiBaseSky = hemi.color.clone();
    this.hemiBaseGround = hemi.groundColor.clone();
    this.hemiTint.sky.copy(this.hemiBaseSky);
    this.hemiTint.ground.copy(this.hemiBaseGround);
    this.baseFogDensity = this.fog ? this.fog.density : 0.012;

    // Rebuild live precipitation when the ♿ toggle flips mid-storm — the
    // calm rain parameters are baked into the particle buffers at build.
    a11y.onChange(() => this.rebuildPrecipitation());

    this.collectNightAssets();

    // Star field: layered soft sprites (dense faint + sparse bright + two
    // small twinkle layers on staggered rhythms + a Milky Way band along a
    // fixed great circle). fog: false is essential — at radius 700 the
    // scene's FogExp2 otherwise erases them.
    const makeStars = (
      count: number,
      size: number,
      peak: number,
      twinkleFreq = 0,
      bandNormal?: THREE.Vector3,
      color = 0xffffff,
    ) => {
      const pos = new Float32Array(count * 3);
      const dir = new THREE.Vector3();
      const u = new THREE.Vector3();
      const v = new THREE.Vector3();
      if (bandNormal) {
        u.set(0, 1, 0).cross(bandNormal).normalize();
        v.crossVectors(bandNormal, u);
      }
      for (let i = 0; i < count; i++) {
        if (bandNormal) {
          // Great-circle strip: uniform angle around the band, center-weighted
          // offset toward its pole — reads as a Milky Way arch.
          const t = Math.random() * Math.PI * 2;
          const off = ((Math.random() + Math.random() + Math.random()) / 1.5 - 1) * 0.2;
          dir
            .copy(u)
            .multiplyScalar(Math.cos(t) * Math.cos(off))
            .addScaledVector(v, Math.sin(t) * Math.cos(off))
            .addScaledVector(bandNormal, Math.sin(off));
        } else {
          dir.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
        }
        pos[i * 3] = dir.x * 700;
        pos[i * 3 + 1] = dir.y * 700;
        pos[i * 3 + 2] = dir.z * 700;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({
        color,
        size,
        map: EnvironmentCycle.starTexture(),
        sizeAttenuation: false,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        fog: false,
      });
      const points = new THREE.Points(geo, mat);
      points.name = 'stars';
      points.renderOrder = -1;
      points.frustumCulled = false;
      scene.add(points);
      this.starLayers.push({
        points,
        mat,
        peak,
        twinkleFreq,
        twinklePhase: Math.random() * Math.PI * 2,
      });
    };
    makeStars(750, 2.4, 0.75);
    makeStars(220, 3.8, 1.0);
    // Twinklers: per-LAYER opacity wobble in update() — zero per-star cost
    makeStars(70, 4.4, 0.9, 1.7);
    makeStars(50, 3.4, 0.85, 2.6);
    makeStars(900, 2.0, 0.38, 0, new THREE.Vector3(0.42, 0.55, 0.72).normalize(), 0xd8e6ff);

    // Moon disc: position and brightness follow the real lunar phase.
    // Slice C: a canvas terminator (two-arc crescent + flat maria) drawn ONCE
    // per session from today's phase — the "offset dark circle" variant was
    // rejected in design review (coplanar sort instability, dark bites over
    // the starfield).
    this.moonMat = new THREE.MeshBasicMaterial({
      map: EnvironmentCycle.moonTexture(),
      color: 0xf2ecdc,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    this.moon = new THREE.Mesh(new THREE.CircleGeometry(26, 24), this.moonMat);
    this.moon.name = 'moon';
    this.moon.renderOrder = -1;
    this.moon.frustumCulled = false;
    scene.add(this.moon);

    // Sun disc: additive soft-glow billboard riding the TRUE sun arc. The
    // texture's radial falloff carries the golden-hour halo even on tiers
    // where the bloom pass is gated off.
    this.sunDiscMat = new THREE.MeshBasicMaterial({
      color: 0xfff3d0,
      map: EnvironmentCycle.sunTexture(),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.sunDisc = new THREE.Mesh(new THREE.CircleGeometry(55, 24), this.sunDiscMat);
    this.sunDisc.name = 'sun';
    this.sunDisc.renderOrder = -1;
    this.sunDisc.frustumCulled = false;
    scene.add(this.sunDisc);

    // Live weather is OPT-IN: nothing about the visitor leaves the device until
    // they ask for it. Day/night still works from the device clock alone.
    if (EnvironmentCycle.hasWeatherConsent()) void this.fetchWeather();
  }

  /**
   * Collect the lamp lights so they can brighten at night, plus the
   * isNightEmissive-tagged meshes (house windows, lamp bulbs) and the
   * district beacons (by name, into a list of their own).
   * The constructor pass runs after GameScene's toonify pass, so the
   * collected materials are the live toon clones; every tagged mesh owns a
   * private material (created inline in Island, and the toonify cache is
   * keyed per instance), so the emissive writes in update() can't leak to
   * other props. Dedupe: a house's two windows share one material.
   *
   * The porch lights that carried isHouseWarmLight no longer join the scene
   * (P2-C4), so nothing collected carries that flag today. Its branch stays
   * so that reverting P2-C4 alone brings their dusk ramp and day cutoff back
   * with them, instead of leaving six porch lights lit all day.
   *
   * Runs again once on the first update(): TownPlanner props are placed
   * AFTER this cycle is built (GameScene.placeAssets), and the render loop
   * only starts after that init finishes, so the late pass catches them.
   */
  private collectNightAssets(): void {
    this.scene.traverse((obj) => {
      const data = obj.userData as {
        isLampLight?: boolean;
        isHouseWarmLight?: boolean;
        isNightEmissive?: boolean;
        isPavement?: boolean;
      };
      const l = obj as THREE.Light;
      if (l.isLight) {
        if ((data.isLampLight || data.isHouseWarmLight) && !this.seenGlow.has(l)) {
          this.seenGlow.add(l);
          this.glowLights.push({ light: l, base: l.intensity });
        }
        return;
      }
      if (data.isPavement) {
        const pMesh = obj as THREE.Mesh;
        if (pMesh.isMesh && !Array.isArray(pMesh.material)) {
          const pMat = pMesh.material as THREE.MeshStandardMaterial | THREE.MeshToonMaterial;
          if (pMat.color && !this.seenPavement.has(pMat)) {
            this.seenPavement.add(pMat);
            this.pavementMats.push({
              mat: pMat,
              base: pMat.color.clone(),
              emBase: (pMat.emissive ?? new THREE.Color(0x000000)).clone(),
            });
          }
        }
        return;
      }
      // Beacons first, by name: whatever they are tagged, they never join
      // the window-and-bulb drive below.
      if (obj.name === 'zone-beacon') {
        const bMesh = obj as THREE.Mesh;
        if (bMesh.isMesh && !Array.isArray(bMesh.material)) {
          const bMat = bMesh.material as THREE.MeshStandardMaterial | THREE.MeshToonMaterial;
          if (bMat.emissive && !this.seenBeacon.has(bMat)) {
            this.seenBeacon.add(bMat);
            this.beacons.push({ mat: bMat, base: bMat.emissive.clone() });
          }
        }
        return;
      }
      if (!data.isNightEmissive) return;
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material)) return;
      const mat = mesh.material as THREE.MeshStandardMaterial | THREE.MeshToonMaterial;
      if (!mat.emissive || this.seenEmissive.has(mat)) return;
      this.seenEmissive.add(mat);
      this.nightEmissives.push({ mat, base: mat.emissive.clone() });
    });
  }

  /** Has the visitor opted into location-based live weather? */
  public static hasWeatherConsent(): boolean {
    try {
      return localStorage.getItem('ds_weather_consent') === '1';
    } catch {
      return false;
    }
  }

  /**
   * Turn live weather on/off. Enabling triggers the (consented) location +
   * forecast lookup; disabling clears the sky and the place label immediately.
   */
  public setWeatherConsent(on: boolean): void {
    try {
      localStorage.setItem('ds_weather_consent', on ? '1' : '0');
    } catch {
      /* session-only */
    }
    if (on) {
      void this.fetchWeather();
    } else {
      this.weather = 'clear';
      this.placeLabel = '';
      this.temperatureC = null;
      this.sunriseHour = null;
      this.sunsetHour = null;
      this.rebuildPrecipitation();
      this.emitStatus();
    }
  }

  public onStatus(cb: (status: string) => void): void {
    this.statusCb = cb;
    this.emitStatus();
  }

  /** Force a weather kind (debug / testing). */
  public setWeather(kind: WeatherKind): void {
    this.weather = kind;
    this.rebuildPrecipitation();
    this.emitStatus();
  }

  public getWeather(): WeatherKind {
    return this.weather;
  }

  private emitStatus(): void {
    if (!this.statusCb) return;
    const hour = this.currentHour();
    // Time-of-day labels keyed to the location's real sunrise/sunset
    const sunrise = this.sunriseHour ?? 6;
    const sunset = this.sunsetHour ?? 18;
    const timeLabel =
      hour >= sunrise && hour < sunrise + 2
        ? '🌅 Morning'
        : hour >= sunrise + 2 && hour < sunset - 1.5
          ? '☀️ Day'
          : hour >= sunset - 1.5 && hour < sunset + 0.75
            ? '🌇 Evening'
            : '🌙 Night';
    const wName = { clear: '', cloudy: '☁️ Cloudy', rain: '🌧️ Rain', snow: '❄️ Snow' }[
      this.weather
    ];
    const temp = this.temperatureC !== null ? `${Math.round(this.temperatureC)}°C` : '';
    const parts: string[] = [];
    if (wName || temp) parts.push([wName, temp].filter(Boolean).join(' '));
    parts.push(timeLabel);
    if (this.placeLabel) parts.push(this.placeLabel);
    this.statusCb(parts.join(' · '));
  }

  private currentHour(): number {
    if (this.debugHour !== null) return this.debugHour;
    const now = new Date();
    return now.getHours() + now.getMinutes() / 60;
  }

  /** Geolocation → Open-Meteo, falling back to IP lookup, then clear. */
  private async fetchWeather(): Promise<void> {
    let lat: number | null = null;
    let lon: number | null = null;
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        if (!navigator.geolocation) {
          reject(new Error('no geolocation'));
          return;
        }
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          timeout: 4000,
          maximumAge: 600000,
        });
      });
      lat = pos.coords.latitude;
      lon = pos.coords.longitude;
      // Real coordinates granted — reverse-geocode a proper city label
      try {
        const geo = await fetch(
          `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`,
        );
        if (geo.ok) {
          const g = (await geo.json()) as { city?: string; locality?: string };
          this.placeLabel = g.city || g.locality || '';
        }
      } catch {
        /* label stays empty */
      }
    } catch {
      try {
        const resp = await fetch('https://ipapi.co/json/');
        if (resp.ok) {
          const j = (await resp.json()) as { latitude?: number; longitude?: number; city?: string };
          if (typeof j.latitude === 'number' && typeof j.longitude === 'number') {
            lat = j.latitude;
            lon = j.longitude;
            // IP geolocation lands on the ISP's hub, not the visitor —
            // mark the label as approximate
            if (j.city) this.placeLabel = `≈ ${j.city}`;
          }
        }
      } catch {
        /* stay clear */
      }
    }
    if (lat === null || lon === null) {
      this.emitStatus();
      return;
    }
    try {
      const resp = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&daily=sunrise,sunset&timezone=auto&forecast_days=1`,
      );
      if (!resp.ok) return;
      const data = (await resp.json()) as {
        current_weather?: { weathercode?: number; temperature?: number };
        daily?: { sunrise?: string[]; sunset?: string[] };
      };
      // Real sun times for the location — the fixed 6am/6pm fallback is up
      // to ~1.5h wrong in winter/summer (Melbourne July: ~7:30/17:10)
      const parseHour = (iso?: string): number | null => {
        const m = iso?.match(/T(\d{2}):(\d{2})/);
        return m ? parseInt(m[1], 10) + parseInt(m[2], 10) / 60 : null;
      };
      this.sunriseHour = parseHour(data.daily?.sunrise?.[0]);
      this.sunsetHour = parseHour(data.daily?.sunset?.[0]);
      if (typeof data.current_weather?.temperature === 'number') {
        this.temperatureC = data.current_weather.temperature;
      }
      const code = data.current_weather?.weathercode ?? 0;
      // WMO codes → our four kinds
      this.weather =
        code <= 2
          ? 'clear'
          : code === 3 || code === 45 || code === 48
            ? 'cloudy'
            : (code >= 71 && code <= 77) || code === 85 || code === 86
              ? 'snow'
              : 'rain';
      this.rebuildPrecipitation();
      console.log(
        `🌦️ Visitor weather: code ${code} → ${this.weather}${this.placeLabel ? ` (${this.placeLabel})` : ''}`,
      );
    } catch {
      /* stay clear */
    }
    this.emitStatus();
  }

  /** Soft round snowflake: bright core feathering to transparent, with a
   * faint 6-spoke crystal hint. Reads as a fluffy flake instead of a hard dot. */
  private static snowTexture(): THREE.Texture {
    if (this._snowTex) return this._snowTex;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.85)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(32, 32, 30, 0, Math.PI * 2);
    ctx.fill();
    // Subtle crystal spokes for a snowflake read at larger sizes
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(32, 32);
      ctx.lineTo(32 + Math.cos(a) * 22, 32 + Math.sin(a) * 22);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    this._snowTex = tex;
    return tex;
  }

  /** Thin vertical rain streak: a soft-edged bright bar fading top and bottom. */
  private static rainTexture(): THREE.Texture {
    if (this._rainTex) return this._rainTex;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, 0, 64);
    g.addColorStop(0, 'rgba(200,224,255,0)');
    g.addColorStop(0.45, 'rgba(210,230,255,0.95)');
    g.addColorStop(0.75, 'rgba(190,215,255,0.7)');
    g.addColorStop(1, 'rgba(190,215,255,0)');
    ctx.fillStyle = g;
    // Thin bar down the middle; soft horizontal falloff via a second gradient
    ctx.filter = 'blur(1px)';
    ctx.fillRect(28, 2, 8, 60);
    const tex = new THREE.CanvasTexture(c);
    this._rainTex = tex;
    return tex;
  }

  /** Soft-edged sun: hot core feathering into a wide warm glow. The falloff
   * IS the golden-hour halo, so the read survives without the bloom pass. */
  private static _moonTex: THREE.Texture | null = null;

  /** Crescent moon with flat maria, phase-correct, drawn once per session. */
  private static moonTexture(): THREE.Texture {
    if (EnvironmentCycle._moonTex) return EnvironmentCycle._moonTex;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d') as CanvasRenderingContext2D;
    // Days since a known new moon -> phase 0..1 (same epoch the arc uses).
    const phase = ((Date.now() / 86400000 - 10957.5 + 5.73) / 29.53) % 1;
    const lit = 1 - Math.abs(phase - 0.5) * 2; // 0 new .. 1 full
    ctx.clearRect(0, 0, 128, 128);
    ctx.fillStyle = '#f2ecdc';
    ctx.beginPath();
    ctx.arc(64, 64, 60, -Math.PI / 2, Math.PI / 2); // lit limb (right half)
    // Terminator: an ellipse arc whose x-radius sweeps with the phase —
    // the classic two-arc crescent, no overlay circles.
    ctx.ellipse(64, 64, Math.abs(60 * (1 - lit * 2)), 60, 0, Math.PI / 2, -Math.PI / 2, lit < 0.5);
    ctx.fill();
    // Flat maria: three darker blots, toon-flat, only on the lit side.
    ctx.fillStyle = 'rgba(180, 172, 150, 0.55)';
    for (const [mx, my, mr] of [
      [82, 48, 11],
      [74, 80, 8],
      [92, 68, 6],
    ]) {
      ctx.beginPath();
      ctx.arc(mx, my, mr, 0, Math.PI * 2);
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    EnvironmentCycle._moonTex = tex;
    return tex;
  }

  private static sunTexture(): THREE.Texture {
    if (this._sunTex) return this._sunTex;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.22, 'rgba(255,250,235,1)');
    g.addColorStop(0.4, 'rgba(255,236,200,0.55)');
    g.addColorStop(0.7, 'rgba(255,220,170,0.18)');
    g.addColorStop(1, 'rgba(255,210,150,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    this._sunTex = tex;
    return tex;
  }

  /** Tiny soft round sprite — turns the square default points into star discs. */
  private static starTexture(): THREE.Texture {
    if (this._starTex) return this._starTex;
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 15);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(16, 16, 15, 0, Math.PI * 2);
    ctx.fill();
    const tex = new THREE.CanvasTexture(c);
    this._starTex = tex;
    return tex;
  }

  private rebuildPrecipitation(): void {
    if (this.precip) {
      this.scene.remove(this.precip);
      this.precipGeo?.dispose();
      (this.precip.material as THREE.Material).dispose();
      this.precip = null;
      this.precipGeo = null;
      this.precipSpeeds = null;
    }
    if (this.weather !== 'rain' && this.weather !== 'snow') return;

    const snow = this.weather === 'snow';
    // Rain is fast, coherent, full-viewport downward optic flow in a column
    // that TRACKS THE CAMERA — the vestibular problem is the amount of
    // coherent flow, not the per-drop realism. Reduced motion halves the
    // count and roughly halves the speed (~7-9 u/s, still visibly rain, not
    // drifting ash); the sky/fog dimming carries the weather read with zero
    // motion. Snow already falls at 1.1-2.4 u/s and needs nothing.
    const calm = a11y.reducedMotion && !snow;
    const count = snow ? 550 : calm ? 325 : 650;
    const pos = new Float32Array(count * 3);
    this.precipSpeeds = new Float32Array(count);
    // Taller spawn column: with size-attenuation, the spread in depth gives a
    // natural flake/drop size variance (nearer particles read bigger).
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 14;
      pos[i * 3 + 1] = Math.random() * 11;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 14;
      this.precipSpeeds[i] = snow
        ? 1.1 + Math.random() * 1.3
        : calm
          ? 7 + Math.random() * 2
          : 13 + Math.random() * 8;
    }
    this.precipGeo = new THREE.BufferGeometry();
    this.precipGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: snow ? 0xffffff : 0xcfe0ff,
      size: snow ? 0.42 : 0.6,
      map: snow ? EnvironmentCycle.snowTexture() : EnvironmentCycle.rainTexture(),
      transparent: true,
      opacity: snow ? 0.95 : 0.7,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.precip = new THREE.Points(this.precipGeo, mat);
    this.precip.name = 'precipitation';
    this.precip.frustumCulled = false;
    this.scene.add(this.precip);
  }

  /** Hold a unit direction's height between `minY` and `maxY`, keeping its bearing. */
  private static clampElevation(v: THREE.Vector3, minY: number, maxY: number): void {
    const y = Math.min(Math.max(v.y, minY), maxY);
    if (y === v.y) return;
    const flat = Math.hypot(v.x, v.z);
    const reach = Math.sqrt(Math.max(0, 1 - y * y));
    // Straight up has no bearing: lean it toward +X (noon on the arc is -X/+X
    // by a hair either way, so the choice is never seen).
    if (flat < 1e-6) v.set(reach, y, 0);
    else v.set((v.x / flat) * reach, y, (v.z / flat) * reach);
  }

  /** Call every frame with the player's world position. */
  public update(deltaTime: number, playerPos: THREE.Vector3, time: number): void {
    // One-shot late pass for props placed after construction (TownPlanner)
    if (!this.rescanned) {
      this.rescanned = true;
      this.collectNightAssets();
    }
    // The visitor's frame first: everything below that points at the sky uses it.
    this._framePos = playerPos;
    this._frameDt = deltaTime;
    fx.time('localSun', this.stepLocalFrame);
    const hour = this.currentHour();
    // Sun elevation anchored to the location's REAL sunrise/sunset (fetched
    // with the weather); 6am/6pm approximation until/unless that arrives.
    const sunrise = this.sunriseHour ?? 6;
    const sunset = this.sunsetHour ?? 18;
    const dayLen = Math.max(1, sunset - sunrise);
    const nightLen = Math.max(1, 24 - dayLen);
    let elev: number;
    if (hour >= sunrise && hour <= sunset) {
      elev = Math.sin(((hour - sunrise) / dayLen) * Math.PI);
    } else {
      const intoNight = (hour - sunset + 24) % 24;
      elev = -Math.sin((intoNight / nightLen) * Math.PI);
    }
    const azimuth = (hour / 24) * Math.PI * 2;

    // Refresh the HUD badge periodically so the time label tracks the clock
    if (time > this.nextStatusAt) {
      this.nextStatusAt = time + 60;
      this.emitStatus();
    }
    const dayFactor = THREE.MathUtils.smoothstep(elev, -0.12, 0.3);
    const duskFactor = duskFactorAt(elev);
    const night = nightFactorAt(elev);
    this.lastDayFactor = dayFactor;
    this.lastDuskFactor = duskFactor;
    this.lastNightFactor = night;
    DAY_FACTOR_UNIFORM.value = dayFactor;
    DUSK_FACTOR_UNIFORM.value = duskFactor;
    // The cast's own night light (CelLook): people only, never the ground.
    setCelNight(night);

    // ?theme=real: the sky PMREM (GameScene.applyRealEnvironment) is generated
    // once from the DAY palette; dim its contribution with the sun so PBR
    // reflections don't glow daylight-blue at midnight. Floor of 0.2 ≈ moon +
    // starlight bounce.
    if (isRealTheme() && this.scene.environment) {
      this.scene.environmentIntensity = 0.2 + 0.8 * dayFactor;
    }

    // Moon arc, hoisted: the light-direction blend below needs it before the
    // disc is drawn. Real lunar phase (0 = new, 0.5 = full), trailing the sun
    // by ~phase * 24h so a full moon rises at sunset.
    const SYNODIC_MS = 29.530588 * 86400000;
    const sinceNew = Date.now() - Date.UTC(2000, 0, 6, 18, 14);
    const phase = (((sinceNew % SYNODIC_MS) + SYNODIC_MS) % SYNODIC_MS) / SYNODIC_MS;
    const illum = (1 - Math.cos(phase * Math.PI * 2)) / 2;
    const moonHour = hour - phase * 24;
    const mElev = Math.sin(((moonHour - 6) / 24) * Math.PI * 2);
    const mAz = (moonHour / 24) * Math.PI * 2;

    // Directional light rides the sun arc by day and through golden hour;
    // once the sun is under the horizon it swings toward the visible moon, so
    // night shadows come FROM the moon instead of an underground sun
    // (moonWeightAt: no snap, and a setting moon hands the key back smoothly).
    // Its height never drops under keyFloorAt, whichever body it follows.
    const floor = keyFloorAt(elev);
    const e = Math.max(elev, floor);
    this._v1.set(
      Math.cos(azimuth) * Math.sqrt(1 - e * e),
      e,
      Math.sin(azimuth) * Math.sqrt(1 - e * e),
    );
    const moonW = moonWeightAt(elev, mElev);
    if (moonW > 0) {
      this._v2.set(
        Math.cos(mAz) * Math.sqrt(1 - mElev * mElev),
        mElev,
        Math.sin(mAz) * Math.sqrt(1 - mElev * mElev),
      );
      this._v1.lerp(this._v2, moonW).normalize();
    }
    // 65 degrees at most in the visitor's frame (KEY_ELEVATION_CAP); the
    // world-anchored sun keeps its zenith.
    EnvironmentCycle.clampElevation(this._v1, floor, this.localSunOn ? KEY_ELEVATION_CAP : 1);
    if (this.localSunOn) this._v1.applyQuaternion(this.qLight);
    this.sun.position.copy(this._v1).multiplyScalar(60);

    // Weather dimming
    const wDim = WEATHER_DIM[this.weather];
    const overcastMix =
      this.weather === 'cloudy'
        ? 0.45
        : this.weather === 'rain'
          ? 0.7
          : this.weather === 'snow'
            ? 0.45
            : 0;

    // Lights. Golden hour holds a warm key (it used to fall to 0.29 of the
    // base and be tinted 80% toward night at sunset) and a brighter
    // hemisphere; see GOLDEN_KEY_LEVEL.
    this.sun.intensity = this.baseSunIntensity * keyLevelAt(dayFactor, elev) * wDim;
    this.hemi.intensity =
      this.baseHemiIntensity * hemiLevelAt(dayFactor, elev) * (0.6 + 0.4 * wDim);
    this.sun.color
      .copy(KEY_DAY)
      .lerp(KEY_DUSK, 0.85 * duskFactor)
      .lerp(KEY_NIGHT, night);

    // Sun disc rides the TRUE elevation (the shadow light clamps to a floor):
    // warm white and modest at noon, swollen + reddened through golden hour,
    // faded out below the horizon and in bad weather. Terrain occludes it
    // naturally (depthTest stays on).
    const se = Math.max(elev, -0.05);
    this.sunDisc.position
      .set(
        Math.cos(azimuth) * Math.sqrt(1 - se * se),
        se,
        Math.sin(azimuth) * Math.sqrt(1 - se * se),
      )
      .applyQuaternion(this.qSky)
      .multiplyScalar(640);
    this.sunDisc.lookAt(0, 0, 0);
    this.sunDisc.scale.setScalar(1 + 0.6 * duskFactor);
    this._c1.set(0xfff3d0).lerp(this._c2.set(0xff7e3d), Math.min(1, duskFactor * 1.15));
    this.sunDiscMat.color.copy(this._c1);
    this.sunDiscMat.opacity =
      THREE.MathUtils.smoothstep(elev, -0.03, 0.08) *
      (0.55 + 0.45 * duskFactor) *
      (this.weather === 'clear' ? 1 : this.weather === 'cloudy' ? 0.25 : 0.1);
    this.sunDisc.visible = this.sunDiscMat.opacity > 0.02;

    // Sky palette: night → day, pushed toward dusk at the horizon crossing,
    // then washed toward overcast by weather
    for (const key of SKY_KEYS) {
      this._c1.copy(PALETTE.night[key]).lerp(PALETTE.day[key], dayFactor);
      this._c1.lerp(PALETTE.dusk[key], duskFactor * 0.75);
      this._c1.lerp(PALETTE.overcast[key], overcastMix * dayFactor);
      const target =
        key === 'top'
          ? this.sky.topColor.value
          : key === 'horizon'
            ? this.sky.horizonColor.value
            : this.sky.bottomColor.value;
      target.copy(this._c1);
    }

    // Hemisphere tint, after the palette: the sky side leans toward the live
    // horizon at dawn and dusk (a warm sky lights the world warm), then to
    // moonlit blue; the ground side warms, then sinks to dark green.
    this.hemiTint.sky
      .copy(this.hemiBaseSky)
      .lerp(this.sky.horizonColor.value, 0.35 * duskFactor)
      .lerp(HEMI_SKY_NIGHT, night);
    this.hemiTint.ground
      .copy(this.hemiBaseGround)
      .lerp(HEMI_GROUND_DUSK, 0.25 * duskFactor)
      .lerp(HEMI_GROUND_NIGHT, night);
    this.hemi.color.copy(this.hemiTint.sky);
    this.hemi.groundColor.copy(this.hemiTint.ground);

    // Fog follows the horizon color; thicker in bad weather
    if (this.fog) {
      this.fog.color.copy(this.sky.horizonColor.value);
      // Slice B: deep-zenith stop derived from topColor (no new palette keys —
      // a fixed darkening tracks every weather/day mix for free), and the
      // dawn/dusk warmth lobe keyed to the TRUE sun direction. sunWarmth dies
      // with the sun below the horizon and under overcast, mirroring the disc.
      if (this.sky.zenithColor && this.sky.sunDir && this.sky.sunWarmth) {
        this.sky.zenithColor.value.copy(this.sky.topColor.value).multiplyScalar(0.68);
        const se2 = Math.max(elev, -0.05);
        this.sky.sunDir.value
          .set(
            Math.cos(azimuth) * Math.sqrt(1 - se2 * se2),
            se2,
            Math.sin(azimuth) * Math.sqrt(1 - se2 * se2),
          )
          .normalize()
          .applyQuaternion(this.qSky);
        this.sky.sunWarmth.value =
          Math.max(0, Math.min(1, duskFactor * 1.2)) *
          Math.max(0, Math.min(1, (elev + 0.02) * 12)) *
          (1 - overcastMix);
      }
      this.fog.density =
        this.baseFogDensity *
        (1 +
          (this.weather === 'rain'
            ? WEATHER_FOG_RAIN_RATIO
            : this.weather === 'cloudy' || this.weather === 'snow'
              ? WEATHER_FOG_GREY_RATIO
              : 0));
    }

    // Stars: night only, hidden by bad weather. Twinkle is a per-LAYER
    // opacity wobble; visible=false by day drops the draw calls entirely.
    const starVis = (1 - dayFactor) * (this.weather === 'clear' ? 1 : 0.15);
    for (const layer of this.starLayers) {
      let o = starVis * layer.peak;
      if (layer.twinkleFreq > 0) {
        o *= 0.72 + 0.28 * Math.sin(time * layer.twinkleFreq + layer.twinklePhase);
      }
      layer.mat.opacity = o;
      layer.points.visible = o > 0.01;
    }

    // Moon disc (arc + phase hoisted above): brightness follows the
    // illuminated fraction; overcast hides it.
    if (mElev > 0.03) {
      this.moon.position
        .set(
          Math.cos(mAz) * Math.sqrt(1 - mElev * mElev),
          mElev,
          Math.sin(mAz) * Math.sqrt(1 - mElev * mElev),
        )
        .applyQuaternion(this.qSky)
        .multiplyScalar(640);
      this.moon.lookAt(0, 0, 0);
      this.moonMat.opacity =
        illum * (0.25 + 0.75 * (1 - dayFactor)) * (this.weather === 'clear' ? 1 : 0.25);
      this.moon.visible = this.moonMat.opacity > 0.02;
    } else {
      this.moon.visible = false;
    }

    // Lamps and house windows glow up as the sun goes down. Interactive
    // lamps (TownPlanner) carry isOn on their group — a lamp the player
    // switched off must stay dark instead of being re-lit every frame.
    const glow = 0.25 + (1 - dayFactor) * 1.05;
    const exteriorLightsOn = dayFactor < EXTERIOR_LIGHTS_DAY_CUTOFF;
    for (const g of this.glowLights) {
      const host = g.light.parent as ({ isOn?: boolean } & THREE.Object3D) | null;
      const off = host && host.isOn === false;
      g.light.intensity = off ? 0 : g.base * glow;
      // visible AFTER the isOn zeroing so a switched-off lamp stays dark;
      // by day the whole set leaves the renderer's light list (see the
      // cutoff's doc — the intensity formula is deliberately untouched).
      g.light.visible = exteriorLightsOn && !off;
    }

    // Window panes + lamp bulbs: dim by day, glowing after dark, emissive
    // deepened toward amber. 1.3 clears the 0.85 bloom threshold, so the
    // bloom pass wraps them in halos at night for free.
    const nightF = 1 - dayFactor;
    const emIntensity = 0.15 + nightF * 1.15;
    this._c2.set(0xff9c46);
    for (const e of this.nightEmissives) {
      e.mat.emissiveIntensity = emIntensity;
      e.mat.emissive.copy(e.base).lerp(this._c2, nightF * 0.3);
    }

    // District beacons: 1.0 by day, 1.3 at night (the night factor, so they
    // do not swell through golden hour), always in the authored colour.
    const beaconGlow = 1 + 0.3 * night;
    for (const b of this.beacons) {
      b.mat.emissiveIntensity = beaconGlow;
      b.mat.emissive.copy(b.base);
    }

    // Pavement at night: MOONLIT STONE, not asphalt. The road is the thing a
    // visitor navigates by after dark, and it used to be the thing that
    // disappeared — the ribbon was lerped 85% toward 0x3c3f48 while its
    // authored emissive (0x2a241c @ 1) is only ~0.019 linear, i.e. visually
    // nil. Measured result: night road ~0.050 linear against ~0.021 grass,
    // a 2.4:1 read — which is exactly why you could not tell where the path
    // went. Lifting the target to pale stone and driving the emissive that is
    // already on these materials takes it to ~9:1 without a single new light.
    //
    // THIS IS ALSO WHAT KEEPS THE DARK PATCHES DARK, for free: it is scoped to
    // isPavement materials, and there is no pavement on the beaches, the
    // scree or the summit — so the contrast Abbas asked to keep is authored by
    // where the ribbon ISN'T, not by a special case. Held under the 0.85 bloom
    // threshold so it reads as wet stone rather than neon.
    this._c2.set(0x6a7183);
    this._c1.set(0x555f70);
    for (const p of this.pavementMats) {
      p.mat.color.copy(p.base).lerp(this._c2, nightF * 0.6);
      if (p.mat.emissive) {
        p.mat.emissive.copy(p.emBase).lerp(this._c1, nightF);
        p.mat.emissiveIntensity = 0.15 + 0.75 * nightF;
      }
    }

    // Precipitation: particles fall in the player's local frame
    if (this.precip && this.precipGeo && this.precipSpeeds) {
      this.precip.position.copy(playerPos);
      this._normal.copy(playerPos).normalize();
      this.precip.quaternion.setFromUnitVectors(this._up, this._normal);
      const attr = this.precipGeo.getAttribute('position') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      const snow = this.weather === 'snow';
      // Rain is driven at a steady slant; snow drifts on a gentle sine breeze.
      const windX = snow ? 0 : Math.cos(time * 0.15) * 2.2;
      const windZ = snow ? 0 : Math.sin(time * 0.15) * 1.4;
      for (let i = 0; i < this.precipSpeeds.length; i++) {
        arr[i * 3 + 1] -= this.precipSpeeds[i] * deltaTime;
        if (snow) {
          arr[i * 3] += Math.sin(time * 1.5 + i) * deltaTime * 0.5;
          arr[i * 3 + 2] += Math.cos(time * 1.1 + i * 0.7) * deltaTime * 0.4;
        } else {
          arr[i * 3] += windX * deltaTime;
          arr[i * 3 + 2] += windZ * deltaTime;
        }
        if (arr[i * 3 + 1] < -0.5) {
          arr[i * 3 + 1] += 11.5;
          arr[i * 3] = (Math.random() - 0.5) * 14;
          arr[i * 3 + 2] = (Math.random() - 0.5) * 14;
        }
      }
      attr.needsUpdate = true;
    }
  }

  public dispose(): void {
    for (const layer of this.starLayers) {
      this.scene.remove(layer.points);
      layer.points.geometry.dispose();
      layer.mat.dispose();
    }
    this.starLayers.length = 0;
    this.nightEmissives.length = 0;
    this.beacons.length = 0;
    this.seenBeacon.clear();
    this.glowLights.length = 0;
    this.pavementMats.length = 0;
    this.seenGlow.clear();
    this.seenEmissive.clear();
    this.seenPavement.clear();
    this.scene.remove(this.moon);
    this.moon.geometry.dispose();
    this.moonMat.dispose();
    this.scene.remove(this.sunDisc);
    this.sunDisc.geometry.dispose();
    this.sunDiscMat.dispose();
    if (this.precip) {
      this.scene.remove(this.precip);
      this.precipGeo?.dispose();
      (this.precip.material as THREE.Material).dispose();
    }
  }
}
