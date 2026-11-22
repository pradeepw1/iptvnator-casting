/**
 * What the scan reads from each frame of the page: its `<video>` elements and
 * video metadata tags. The script runs in the page, so its result is
 * untrusted and `parseFrameVideoReport` validates every field.
 */

export interface FrameVideoElement {
    readonly srcs: readonly string[];
    readonly poster: string | null;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly loop: boolean;
    readonly muted: boolean;
    readonly durationSeconds: number | null;
    /** Intrinsic height once metadata loaded; 0 when unknown. */
    readonly videoHeight: number;
}

export interface FrameVideoReport {
    readonly frameUrl: string;
    readonly isTopFrame: boolean;
    readonly title: string | null;
    readonly image: string | null;
    readonly metaVideos: readonly string[];
    readonly videos: readonly FrameVideoElement[];
}

const MAX_VIDEOS = 20;
const MAX_SOURCES = 8;
const MAX_TEXT = 300;

/**
 * Lists the frame's videos and asks each to play, muted: many players only
 * request their stream once playback starts.
 */
export const COLLECT_VIDEOS_SCRIPT = `(() => {
  const abs = (value) => {
    try {
      const url = new URL(value, document.baseURI);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch (error) {
      return null;
    }
  };
  const meta = (selector) => {
    const element = document.querySelector(selector);
    return element ? element.getAttribute('content') : null;
  };
  const videos = [];
  for (const video of Array.from(document.querySelectorAll('video')).slice(0, ${MAX_VIDEOS})) {
    const rect = video.getBoundingClientRect();
    const sources = [video.currentSrc, video.getAttribute('src')]
      .concat(Array.from(video.querySelectorAll('source')).map((source) => source.getAttribute('src')))
      .map((value) => (value ? abs(value) : null))
      .filter(Boolean);
    videos.push({
      srcs: Array.from(new Set(sources)),
      poster: video.poster ? abs(video.poster) : null,
      x: rect.left, y: rect.top, width: rect.width, height: rect.height,
      loop: !!video.loop, muted: !!video.muted,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      videoHeight: video.videoHeight || 0,
    });
    try {
      video.muted = true;
      const started = video.play();
      if (started && started.catch) started.catch(() => undefined);
    } catch (error) {}
  }
  const metaVideos = [
    'meta[property="og:video"]', 'meta[property="og:video:url"]',
    'meta[property="og:video:secure_url"]', 'meta[name="twitter:player:stream"]',
  ].map(meta).map((value) => (value ? abs(value) : null)).filter(Boolean);
  return {
    isTopFrame: window.top === window,
    title: meta('meta[property="og:title"]') || document.title || null,
    image: abs(meta('meta[property="og:image"]') || ''),
    metaVideos,
    videos,
  };
})()`;

function httpUrl(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 4096) {
        return null;
    }
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:'
            ? url.toString()
            : null;
    } catch {
        return null;
    }
}

function finite(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function text(value: unknown): string | null {
    return typeof value === 'string' && value.trim()
        ? value.trim().slice(0, MAX_TEXT)
        : null;
}

function urls(value: unknown, limit: number): string[] {
    return Array.isArray(value)
        ? value
              .slice(0, limit)
              .map(httpUrl)
              .filter((url): url is string => url !== null)
        : [];
}

function parseVideo(value: unknown): FrameVideoElement | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const raw = value as Record<string, unknown>;
    const duration = finite(raw['duration']);
    return {
        srcs: urls(raw['srcs'], MAX_SOURCES),
        poster: httpUrl(raw['poster']),
        x: finite(raw['x']),
        y: finite(raw['y']),
        width: Math.max(0, finite(raw['width'])),
        height: Math.max(0, finite(raw['height'])),
        loop: raw['loop'] === true,
        muted: raw['muted'] === true,
        durationSeconds: duration > 0 ? duration : null,
        videoHeight: Math.max(0, Math.round(finite(raw['videoHeight']))),
    };
}

export function parseFrameVideoReport(
    value: unknown,
    frameUrl: string
): FrameVideoReport | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const raw = value as Record<string, unknown>;
    const videos = Array.isArray(raw['videos'])
        ? raw['videos']
              .slice(0, MAX_VIDEOS)
              .map(parseVideo)
              .filter((video): video is FrameVideoElement => video !== null)
        : [];
    return {
        frameUrl,
        isTopFrame: raw['isTopFrame'] === true,
        title: text(raw['title']),
        image: httpUrl(raw['image']),
        metaVideos: urls(raw['metaVideos'], MAX_SOURCES),
        videos,
    };
}
