/**
 * SoftLook — the "polished soft-real" display experiment (?look=soft).
 *
 * Bake-off candidate B from the 2026-08 quality deep-dive: keeps the default
 * graded-PBR look and adds the three display upgrades the research ranked
 * highest for it:
 *   1. HEIGHT FOG + AERIAL PERSPECTIVE (this module) — one combined patch of
 *      the stock fog chunks, applied to THREE.ShaderChunk BEFORE any material
 *      compiles. Haze hugs sea level; distant fragments desaturate and pull
 *      toward the horizon color. Zero new uniforms: the horizon color rides
 *      `fogColor`, which EnvironmentCycle already recolors per frame, and the
 *      planet radius is a compile-time constant. Composer-free → ships on the
 *      mobile tier too.
 *   2. Time-of-day grade pass (SimpleRenderer, desktop composer only).
 *   3. Bloom taste pass (soft knee + day-modulated strength, SimpleRenderer).
 *
 * MUST be a single combined patch: height fog and aerial tint both rewrite
 * the fog_pars/fog_fragment chunks — two competing edits of the same chunks
 * would silently clobber each other (adversarial-verify finding). The
 * world-position varying is uniquely named (vFogWorldPos) to dodge envmap's
 * vWorldPosition.
 */
import * as THREE from 'three';

import { seaLevelFor } from './WorldScale';

let cached: boolean | null = null;

/** True when the soft-real display experiment is active (?look=soft). */
export function isSoftLook(): boolean {
  if (cached === null) {
    try {
      cached = new URLSearchParams(window.location.search).get('look') === 'soft';
    } catch {
      cached = false;
    }
  }
  return cached;
}

let patched = false;

/**
 * Mutate the global fog shader chunks. Call ONCE, before any material
 * compiles (the program cache never rebuilds already-compiled materials).
 * Safe alongside the sea/terrain/grass onBeforeCompile injections — none of
 * them touch the fog chunks (verified against the working tree).
 */
export function applySoftLookFogPatch(): void {
  if (patched || !isSoftLook()) return;
  patched = true;

  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogWorldPos;
#endif`;

  THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	#ifdef USE_INSTANCING
		vFogWorldPos = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
	#else
		vFogWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
	#endif
#endif`;

  // The sprite vertex shader includes fog_vertex but never defines
  // `transformed`, so the chunk above fails ITS compile — SpriteMaterial has
  // fog:true by default, which silently blanked every name pin / chat bubble
  // under ?look=soft (three skips objects whose program failed). A sprite's
  // fog anchor is simply its world translation (the billboard offset is
  // view-space), so give ShaderLib.sprite its own exact, zero-cost line.
  THREE.ShaderLib.sprite.vertexShader = THREE.ShaderLib.sprite.vertexShader.replace(
    '#include <fog_vertex>',
    /* glsl */ `#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vFogWorldPos = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
#endif`,
  );

  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorldPos;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif`;

  // Altitude above the sea shell (max(0,·) also stops the displaced sea's swell
  // from shimmering the haze). Height fog: density boosted near sea level,
  // fading out by +4u so the mountain rises above the haze. Aerial perspective:
  // with distance, desaturate then pull toward the horizon color BEFORE the
  // final fog mix — the classic depth cue.
  //
  // The shell radius MUST track the world. This was hardcoded `50.35`; at any
  // other radius `fogAltitude` saturates the smoothstep below and sea-level
  // height fog silently stops existing — no error, no console warning, the
  // feature is just gone. Pinned by test/islandRadius.test.ts.
  const fogSeaShell = (seaLevelFor() + 0.25).toFixed(4);
  THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
	float fogAltitude = max( 0.0, length( vFogWorldPos ) - ${fogSeaShell} );
	float fogHeightBoost = 1.0 + 1.5 * ( 1.0 - smoothstep( 0.0, 4.0, fogAltitude ) );
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth * fogHeightBoost );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	float fogAerial = smoothstep( 12.0, 60.0, vFogDepth );
	float fogLuma = dot( gl_FragColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
	gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( fogLuma ), 0.28 * fogAerial );
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, 0.40 * fogAerial );
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;

  console.log('🌫️ SoftLook: height-fog + aerial-perspective chunk patch applied');
}

/** Fragment shader for the time-of-day grade pass (desktop composer only).
 *  Runs AFTER OutputPass, i.e. on display-referred sRGB — the space grading
 *  is normally authored in. Gentle S-curve, golden-hour warm lift, cool
 *  night shift, +6% saturation. uDay = EnvironmentCycle dayFactor. */
export const GradeShader = {
  name: 'SoftLookGradeShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uDay: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uDay;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D( tDiffuse, vUv );
      vec3 g = c.rgb;
      // gentle S-curve contrast
      g = mix( g, g * g * ( 3.0 - 2.0 * g ), 0.16 );
      // golden-hour warmth: peaks while the sun is low but up
      float dusk = smoothstep( 0.55, 0.15, uDay ) * smoothstep( 0.0, 0.12, uDay );
      g += dusk * vec3( 0.05, 0.022, -0.012 ) * ( 1.0 - g );
      // night cool shift
      float night = 1.0 - smoothstep( 0.0, 0.12, uDay );
      g = mix( g, g * vec3( 0.88, 0.94, 1.08 ), night * 0.45 );
      // small saturation lift
      float l = dot( g, vec3( 0.299, 0.587, 0.114 ) );
      g = mix( vec3( l ), g, 1.06 );
      gl_FragColor = vec4( clamp( g, 0.0, 1.0 ), c.a );
    }`,
};
