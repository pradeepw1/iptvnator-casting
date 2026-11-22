import type {
    CastReceiverKind,
    WebVideoKind,
    WebVideoScanError,
    WebVideoScanResult,
    WebVideoSignal,
    WebVideoSource,
} from '@iptvnator/shared/interfaces';
import { formatTime } from '../../player-controls/controls-format.utils';
import type { PlayerCastMedia } from '../player-cast-media';

/** One row of the source list, display-ready. */
export interface WebVideoSourceView {
    readonly id: string;
    readonly icon: string;
    /** "1080p"; null when unknown. */
    readonly quality: string | null;
    /** Technical format name, not translated; null means generic video. */
    readonly format: string | null;
    readonly duration: string | null;
    readonly live: boolean;
    readonly host: string;
    readonly size: string | null;
    /** Why the TV may fail to play it. */
    readonly warningKey: string | null;
    /** Why an ad was judged an ad. */
    readonly reasonKey: string | null;
    readonly embeddedAds: boolean;
    readonly best: boolean;
    readonly ad: boolean;
}

const FORMAT_NAMES: Readonly<Record<WebVideoKind, string | null>> = {
    hls: 'HLS',
    dash: 'DASH',
    mp4: 'MP4',
    webm: 'WebM',
    other: null,
};

const CONTENT_TYPES: Readonly<Record<WebVideoKind, string | undefined>> = {
    hls: 'application/x-mpegURL',
    dash: 'application/dash+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    other: undefined,
};

const WARNING_KEYS: Readonly<
    Record<WebVideoSource['castability'], string | null>
> = {
    likely: null,
    unknown: null,
    'needs-headers': 'CAST.WEB.WARN_HEADERS',
    'no-cors': 'CAST.WEB.WARN_CORS',
    drm: 'CAST.WEB.WARN_DRM',
};

const AD_REASON_KEYS: Partial<Record<WebVideoSignal, string>> = {
    'ad-network': 'CAST.WEB.REASON_AD_NETWORK',
    'ad-frame': 'CAST.WEB.REASON_AD_FRAME',
    'ad-path': 'CAST.WEB.REASON_AD_PATH',
    'short-clip': 'CAST.WEB.REASON_SHORT',
    'background-loop': 'CAST.WEB.REASON_LOOP',
};

export const WEB_VIDEO_ERROR_KEYS: Readonly<
    Record<Exclude<WebVideoScanError, 'cancelled'>, string>
> = {
    'invalid-url': 'CAST.WEB.ERROR_INVALID',
    'blocked-url': 'CAST.WEB.ERROR_BLOCKED',
    'unsupported-site': 'CAST.WEB.ERROR_UNSUPPORTED',
    'load-failed': 'CAST.WEB.ERROR_LOAD',
    'no-video': 'CAST.WEB.ERROR_NO_VIDEO',
};

export function formatSize(bytes: number | null): string | null {
    if (!bytes || bytes <= 0) {
        return null;
    }
    const megabytes = bytes / (1024 * 1024);
    if (megabytes >= 1024) {
        return `${(megabytes / 1024).toFixed(1)} GB`;
    }
    return megabytes >= 1 ? `${Math.round(megabytes)} MB` : '<1 MB';
}

/**
 * `receiver` is the TV picked for casting: a Roku plays streams natively, so
 * a missing CORS header, which blocks a Chromecast, is no warning for it.
 */
export function toWebVideoSourceView(
    source: WebVideoSource,
    best: boolean,
    receiver: CastReceiverKind | null = null
): WebVideoSourceView {
    const live = source.isLive === true;
    const ad = source.verdict === 'ad';
    const corsIrrelevant =
        receiver === 'roku' && source.castability === 'no-cors';
    return {
        id: source.id,
        icon: ad ? 'campaign' : live ? 'live_tv' : 'movie',
        quality: source.height ? `${source.height}p` : null,
        format: FORMAT_NAMES[source.kind],
        duration:
            !live && source.durationSeconds
                ? formatTime(source.durationSeconds)
                : null,
        live,
        host: source.host,
        size: formatSize(source.sizeBytes),
        warningKey: corsIrrelevant ? null : WARNING_KEYS[source.castability],
        reasonKey: ad
            ? (source.signals
                  .map((signal) => AD_REASON_KEYS[signal])
                  .find((key) => !!key) ?? null)
            : null,
        embeddedAds: source.embeddedAds,
        best,
        ad,
    };
}

/** What the cast controller sends to the receiver for a picked source. */
export function castMediaForWebVideo(
    source: WebVideoSource,
    result: Pick<WebVideoScanResult, 'title' | 'thumbnail'>
): PlayerCastMedia {
    return {
        request: {
            url: source.url,
            title: result.title ?? source.host,
            thumbnail: result.thumbnail ?? undefined,
            isLive: source.isLive === true,
            contentType: CONTENT_TYPES[source.kind],
        },
        needsCustomHeaders: source.castability === 'needs-headers',
    };
}
