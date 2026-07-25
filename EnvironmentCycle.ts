import * as THREE from 'three';

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

  private starLayers: Array<{ points: THREE.Points; mat: THREE.PointsMaterial; peak: number }> = [];
  private moon: THREE.Mesh;
  private moonMat: THREE.MeshBasicMaterial;

  private precip: THREE.Points | null = null;
  private precipGeo: THREE.BufferGeometry | null = null;
  private precipSpeeds: Float32Array | null = null;
  // Cached sprite textures for the two precipitation looks (built once,
  // shared across every rebuild). Snow = soft round flake; rain = a thin
  // vertical streak that reads as a falling drop on the camera-facing quad.
  private static _snowTex: THREE.Texture | null = null;
  private static _rainTex: THREE.Texture | null = null;

  private glowLights: Array<{ light: THREE.Light; base: number }> = [];

  private baseSunIntensity: number;
  private baseHemiIntensity: number;
  private baseFogDensity: number;

  /** Debug override: fractional hour 0-24, or null for the real clock. */
  public debugHour: number | null = null;

  /** Last computed day factor (0 = deep night, 1 = full day). */
  private lastDayFactor = 1;

  public getDayFactor(): number {
    return this.lastDayFactor;
  }

  // Scratch
  private readonly _c1 = new THREE.Color();
  private readonly _c2 = new THREE.Color();
  private readonly _up = new THREE.Vector3(0, 1, 0);
  private readonly _normal = new THREE.Vector3();

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
    this.baseFogDensity = this.fog ? this.fog.density : 0.012;

    // Collect lamp + house-window lights so they can brighten at night
    scene.traverse((obj) => {
      const l = obj as THREE.Light;
      if (!l.isLight) return;
      const data = obj.userData as { isLampLight?: boolean; isHouseWarmLight?: boolean };
      if (data.isLampLight || data.isHouseWarmLight) {
        this.glowLights.push({ light: l, base: l.intensity });
      }
    });

    // Star field in two layers (dense faint + sparse bright). fog: false is
    // essential — at radius 700 the scene's FogExp2 otherwise erases them.
    const makeStars = (count: number, size: number, peak: number) => {
      const pos = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const dir = new THREE.Vector3(
          Math.random() * 2 - 1,
          Math.random() * 2 - 1,
          Math.random() * 2 - 1,
        ).normalize();
        pos[i * 3] = dir.x * 700;
        pos[i * 3 + 1] = dir.y * 700;
        pos[i * 3 + 2] = dir.z * 700;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({
        color: 0xffffff,
        size,
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
      this.starLayers.push({ points, mat, peak });
    };
    makeStars(750, 1.6, 0.75);
    makeStars(220, 3.0, 1.0);

    // Moon disc: position and brightness follow the real lunar phase
    this.moonMat = new THREE.MeshBasicMaterial({
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

    void this.fetchWeather();
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
      hour >= sunrise && hour < sunrise + 2 ? '🌅 Morning'
      : hour >= sunrise + 2 && hour < sunset - 1.5 ? '☀️ Day'
      : hour >= sunset - 1.5 && hour < sunset + 0.75 ? '🌇 Evening'
      : '🌙 Night';
    const wName = { clear: '', cloudy: '☁️ Cloudy', rain: '🌧️ Rain', snow: '❄️ Snow' }[this.weather];
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
        code <= 2 ? 'clear'
        : code === 3 || code === 45 || code === 48 ? 'cloudy'
        : (code >= 71 && code <= 77) || code === 85 || code === 86 ? 'snow'
        : 'rain';
      this.rebuildPrecipitation();
      console.log(`🌦️ Visitor weather: code ${code} → ${this.weather}${this.placeLabel ? ` (${this.placeLabel})` : ''}`);
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
    const count = snow ? 550 : 650;
    const pos = new Float32Array(count * 3);
    this.precipSpeeds = new Float32Array(count);
    // Taller spawn column: with size-attenuation, the spread in depth gives a
    // natural flake/drop size variance (nearer particles read bigger).
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 14;
      pos[i * 3 + 1] = Math.random() * 11;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 14;
      this.precipSpeeds[i] = snow ? 1.1 + Math.random() * 1.3 : 13 + Math.random() * 8;
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

  /** Call every frame with the player's world position. */
  public update(deltaTime: number, playerPos: THREE.Vector3, time: number): void {
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
    const duskFactor = Math.max(0, 1 - Math.abs(elev) / 0.35);
    this.lastDayFactor = dayFactor;

    // Sun position on its arc (moon takes over below the horizon)
    const e = Math.max(elev, 0.06);
    this.sun.position
      .set(Math.cos(azimuth) * Math.sqrt(1 - e * e), e, Math.sin(azimuth) * Math.sqrt(1 - e * e))
      .multiplyScalar(60);

    // Weather dimming
    const wDim = { clear: 1, cloudy: 0.55, rain: 0.35, snow: 0.5 }[this.weather];
    const overcastMix =
      this.weather === 'cloudy' ? 0.45 : this.weather === 'rain' ? 0.7 : this.weather === 'snow' ? 0.45 : 0;

    // Lights
    this.sun.intensity = this.baseSunIntensity * (0.12 + 0.88 * dayFactor) * wDim;
    this.hemi.intensity = this.baseHemiIntensity * (0.32 + 0.68 * dayFactor) * (0.6 + 0.4 * wDim);
    this._c1.set(0xfff2dd).lerp(this._c2.set(0xffb066), duskFactor * 0.8);
    this._c1.lerp(this._c2.set(0x93a4cc), 1 - dayFactor);
    this.sun.color.copy(this._c1);

    // Sky palette: night → day, pushed toward dusk at the horizon crossing,
    // then washed toward overcast by weather
    const skyKeys: Array<keyof typeof PALETTE.day> = ['top', 'horizon', 'bottom'];
    for (const key of skyKeys) {
      this._c1.copy(PALETTE.night[key]).lerp(PALETTE.day[key], dayFactor);
      this._c1.lerp(PALETTE.dusk[key], duskFactor * 0.75);
      this._c1.lerp(PALETTE.overcast[key], overcastMix * dayFactor);
      const target =
        key === 'top' ? this.sky.topColor.value
        : key === 'horizon' ? this.sky.horizonColor.value
        : this.sky.bottomColor.value;
      target.copy(this._c1);
    }

    // Fog follows the horizon color; thicker in bad weather
    if (this.fog) {
      this.fog.color.copy(this.sky.horizonColor.value);
      this.fog.density =
        this.baseFogDensity +
        (this.weather === 'rain' ? 0.01 : this.weather === 'cloudy' || this.weather === 'snow' ? 0.005 : 0);
    }

    // Stars: night only, hidden by bad weather
    const starVis = (1 - dayFactor) * (this.weather === 'clear' ? 1 : 0.15);
    for (const layer of this.starLayers) {
      layer.mat.opacity = starVis * layer.peak;
    }

    // Moon: real lunar phase (0 = new, 0.5 = full), trailing the sun by
    // ~phase * 24h so a full moon rises at sunset. Brightness follows the
    // illuminated fraction; overcast hides it.
    const SYNODIC_MS = 29.530588 * 86400000;
    const sinceNew = Date.now() - Date.UTC(2000, 0, 6, 18, 14);
    const phase = (((sinceNew % SYNODIC_MS) + SYNODIC_MS) % SYNODIC_MS) / SYNODIC_MS;
    const illum = (1 - Math.cos(phase * Math.PI * 2)) / 2;
    const moonHour = hour - phase * 24;
    const mElev = Math.sin(((moonHour - 6) / 24) * Math.PI * 2);
    if (mElev > 0.03) {
      const mAz = (moonHour / 24) * Math.PI * 2;
      this.moon.position
        .set(
          Math.cos(mAz) * Math.sqrt(1 - mElev * mElev),
          mElev,
          Math.sin(mAz) * Math.sqrt(1 - mElev * mElev),
        )
        .multiplyScalar(640);
      this.moon.lookAt(0, 0, 0);
      this.moonMat.opacity =
        illum * (0.25 + 0.75 * (1 - dayFactor)) * (this.weather === 'clear' ? 1 : 0.25);
      this.moon.visible = this.moonMat.opacity > 0.02;
    } else {
      this.moon.visible = false;
    }

    // Lamps and house windows glow up as the sun goes down
    const glow = 0.25 + (1 - dayFactor) * 1.05;
    for (const g of this.glowLights) {
      g.light.intensity = g.base * glow;
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
    this.scene.remove(this.moon);
    this.moon.geometry.dispose();
    this.moonMat.dispose();
    if (this.precip) {
      this.scene.remove(this.precip);
      this.precipGeo?.dispose();
      (this.precip.material as THREE.Material).dispose();
    }
  }
}
