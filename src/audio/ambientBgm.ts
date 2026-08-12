export type AmbientTrackId =
  | "greenhouse"
  | "meadow"
  | "forest"
  | "clear-sky"
  | "sunlit-piano"
  | "sacred-grove"
  | "resonant-chimes"
  | "shrine-ritual"
  | "ancient-temple";

export interface AmbientTrackInfo {
  id: AmbientTrackId;
  url: string;
  title: string;
  artist: string;
  license: string;
  licenseUrl: string;
  sourceUrl: string;
}

export const AMBIENT_TRACKS: Record<AmbientTrackId, AmbientTrackInfo> = {
  greenhouse: {
    id: "greenhouse",
    url: "/assets/audio/tracks/skye-cuillin.mp3",
    title: "Skye Cuillin",
    artist: "Kevin MacLeod",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    sourceUrl: "https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100346",
  },
  meadow: {
    id: "meadow",
    url: "/assets/audio/tracks/celtic-impulse.mp3",
    title: "Celtic Impulse",
    artist: "Kevin MacLeod",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    sourceUrl: "https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100297",
  },
  forest: {
    id: "forest",
    url: "/assets/audio/tracks/yoiyami-core-theme.mp3",
    title: "Yoiyami Core Theme",
    artist: "Yoiyami",
    license: "CC0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    sourceUrl: "https://opengameart.org/content/yoiyami-core-theme-%E2%80%93-deep-blue-ambient-piano",
  },
  "clear-sky": {
    id: "clear-sky",
    url: "/assets/audio/tracks/warm-home.mp3",
    title: "Children's Game Music 3 - Home",
    artist: "heartade",
    license: "CC0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    sourceUrl: "https://opengameart.org/content/childrens-game-music-3-home",
  },
  "sunlit-piano": {
    id: "sunlit-piano",
    url: "/assets/audio/tracks/first-light-particles.mp3",
    title: "First Light Particles",
    artist: "Yoiyami",
    license: "CC0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    sourceUrl: "https://opengameart.org/node/182244",
  },
  "sacred-grove": {
    id: "sacred-grove",
    url: "/assets/audio/tracks/sacred-grove-bells.mp3?v=2",
    title: "Sacred Grove Bells",
    artist: "yd · Canopy arrangement",
    license: "CC0 source · original bell arrangement",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    sourceUrl: "https://opengameart.org/content/shrine",
  },
  "resonant-chimes": {
    id: "resonant-chimes",
    url: "/assets/audio/tracks/resonant-chimes.mp3",
    title: "Wind Chimes Loop 2",
    artist: "pmiller",
    license: "CC0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    sourceUrl: "https://opengameart.org/content/wind-chimes",
  },
  "shrine-ritual": {
    id: "shrine-ritual",
    url: "/assets/audio/tracks/shrine-ritual.mp3",
    title: "Ritual",
    artist: "brainiac256",
    license: "CC BY 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
    sourceUrl: "https://opengameart.org/content/ritual",
  },
  "ancient-temple": {
    id: "ancient-temple",
    url: "/assets/audio/tracks/ancient-temple.mp3",
    title: "Ancient Temple",
    artist: "Alexandr Zhelanov",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    sourceUrl: "https://opengameart.org/content/ancient-temple",
  },
};

const DEFAULT_VOLUME = 0.88;
const CROSSFADE_MS = 760;

function clampVolume(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : DEFAULT_VOLUME));
}

function isAutoplayBlock(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "NotAllowedError";
}

export function ambientTrackInfo(id: AmbientTrackId): AmbientTrackInfo {
  return AMBIENT_TRACKS[id];
}

export class AmbientBgm {
  private audio: HTMLAudioElement | null = null;
  private trackId: AmbientTrackId | null = null;
  private volume = DEFAULT_VOLUME;
  private transitionId = 0;

  setVolume(value: number): void {
    this.volume = clampVolume(value);
    if (this.audio) this.audio.volume = this.volume;
  }

  getVolume(): number {
    return this.volume;
  }

  async start(trackId: AmbientTrackId = "meadow"): Promise<boolean> {
    const existing = this.audio;
    if (existing && this.trackId === trackId) {
      try {
        await existing.play();
      } catch (reason) {
        if (isAutoplayBlock(reason)) return false;
        throw reason;
      }
      existing.volume = this.volume;
      return !existing.paused;
    }

    const transitionId = ++this.transitionId;
    const next = this.createAudio(trackId);
    try {
      await next.play();
    } catch (reason) {
      next.remove();
      if (isAutoplayBlock(reason)) return false;
      throw reason;
    }

    if (transitionId !== this.transitionId) {
      next.pause();
      next.remove();
      return false;
    }

    this.audio = next;
    this.trackId = trackId;
    await Promise.all([
      this.fade(next, 0, this.volume, CROSSFADE_MS, transitionId),
      existing ? this.fade(existing, existing.volume, 0, CROSSFADE_MS, transitionId) : Promise.resolve(),
    ]);
    if (existing) {
      existing.pause();
      existing.remove();
    }
    return transitionId === this.transitionId && !next.paused;
  }

  async stop(immediate = false): Promise<void> {
    const current = this.audio;
    this.audio = null;
    this.trackId = null;
    const transitionId = ++this.transitionId;
    if (!current) return;
    if (!immediate) {
      await this.fade(current, current.volume, 0, 420, transitionId);
    }
    current.pause();
    current.remove();
  }

  private createAudio(trackId: AmbientTrackId): HTMLAudioElement {
    const track = ambientTrackInfo(trackId);
    const audio = new Audio(track.url);
    audio.loop = true;
    audio.preload = "auto";
    audio.volume = 0;
    audio.dataset.canopyBgm = trackId;
    audio.setAttribute("aria-hidden", "true");
    audio.style.display = "none";
    document.body.append(audio);
    return audio;
  }

  private fade(
    audio: HTMLAudioElement,
    from: number,
    to: number,
    durationMs: number,
    transitionId: number,
  ): Promise<void> {
    const startVolume = clampVolume(from);
    const endVolume = clampVolume(to);
    audio.volume = startVolume;
    if (durationMs <= 0) {
      audio.volume = endVolume;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const startedAt = performance.now();
      const step = (now: number) => {
        if (transitionId !== this.transitionId) {
          resolve();
          return;
        }
        const progress = Math.min(1, (now - startedAt) / durationMs);
        audio.volume = clampVolume(startVolume + (endVolume - startVolume) * Math.max(0, progress));
        if (progress < 1) {
          window.requestAnimationFrame(step);
        } else {
          resolve();
        }
      };
      window.requestAnimationFrame(step);
    });
  }
}

let uiContext: AudioContext | null = null;
const DEFAULT_UI_VOLUME = 0.72;
const MAX_UI_GAIN = 0.08;

export function playUiClick(volume = DEFAULT_UI_VOLUME): void {
  const AudioContextClass = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return;
  const normalizedVolume = clampVolume(volume);
  if (normalizedVolume === 0) return;
  if (!uiContext || uiContext.state === "closed") uiContext = new AudioContextClass();
  const context = uiContext;
  void context.resume();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(520, context.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(690, context.currentTime + 0.045);
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(MAX_UI_GAIN * normalizedVolume, context.currentTime + 0.007);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.08);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.09);
}
