/**
 * "Cast a web video": the main process opens a pasted page in an isolated,
 * offscreen browser view, collects the video streams the page loads, tells
 * ads apart from the main video and checks whether a receiver can fetch each
 * stream on its own.
 */

export const CAST_FIND_WEB_VIDEOS = 'CAST:FIND_WEB_VIDEOS';
export const CAST_CANCEL_WEB_VIDEO_SCAN = 'CAST:CANCEL_WEB_VIDEO_SCAN';

export type WebVideoKind = 'hls' | 'dash' | 'mp4' | 'webm' | 'other';

export type WebVideoVerdict = 'video' | 'ad';

/**
 * Whether a receiver, which sends no cookies or Referer, can fetch the
 * stream: `needs-headers` when the server refused such a request, `no-cors`
 * when an HLS/DASH server sends no CORS header, `drm` for protected DASH.
 */
export type WebVideoCastability =
    'likely' | 'needs-headers' | 'no-cors' | 'drm' | 'unknown';

/** Evidence behind a verdict, strongest first. */
export type WebVideoSignal =
    | 'ad-network'
    | 'ad-frame'
    | 'ad-path'
    | 'short-clip'
    | 'background-loop'
    | 'main-player'
    | 'page-metadata'
    | 'adaptive'
    | 'long-form'
    | 'live';

export interface WebVideoSource {
    readonly id: string;
    readonly url: string;
    readonly kind: WebVideoKind;
    readonly verdict: WebVideoVerdict;
    readonly signals: readonly WebVideoSignal[];
    readonly host: string;
    readonly isLive: boolean | null;
    readonly durationSeconds: number | null;
    /** Tallest rendition (HLS/DASH) or element height. */
    readonly height: number | null;
    readonly variantCount: number | null;
    readonly sizeBytes: number | null;
    readonly castability: WebVideoCastability;
    /** HLS cue or interstitial markers: ads are stitched into the stream. */
    readonly embeddedAds: boolean;
}

export type WebVideoScanError =
    | 'invalid-url'
    | 'blocked-url'
    | 'unsupported-site'
    | 'load-failed'
    | 'no-video'
    | 'cancelled';

export interface WebVideoScanResult {
    readonly pageUrl: string;
    readonly title: string | null;
    readonly thumbnail: string | null;
    /** Likely videos first (best match leading), ads last. */
    readonly sources: readonly WebVideoSource[];
    readonly error?: WebVideoScanError;
}

/** Preload methods owned by `web-video.events.ts`. */
export interface WebVideoBridgeApi {
    castFindWebVideos?: (pageUrl: string) => Promise<WebVideoScanResult>;
    castCancelWebVideoScan?: () => Promise<void>;
}
