import type { WebVideoKind } from '@iptvnator/shared/interfaces';

/** A stream worth listing, or a chunk of one that is not. */
export type ObservedMediaKind = WebVideoKind | 'segment';

const KIND_BY_EXTENSION: Readonly<Record<string, ObservedMediaKind>> = {
    m3u8: 'hls',
    mpd: 'dash',
    mp4: 'mp4',
    m4v: 'mp4',
    mov: 'mp4',
    webm: 'webm',
    mkv: 'other',
    ogv: 'other',
    ts: 'segment',
    m4s: 'segment',
    cmfv: 'segment',
    cmfa: 'segment',
    aac: 'segment',
    m4a: 'segment',
    vtt: 'segment',
    webvtt: 'segment',
    key: 'segment',
};

const KIND_BY_CONTENT_TYPE: Readonly<Record<string, ObservedMediaKind>> = {
    'application/vnd.apple.mpegurl': 'hls',
    'application/x-mpegurl': 'hls',
    'audio/mpegurl': 'hls',
    'audio/x-mpegurl': 'hls',
    'application/dash+xml': 'dash',
    'video/mp4': 'mp4',
    'video/quicktime': 'mp4',
    'video/x-m4v': 'mp4',
    'video/webm': 'webm',
    'video/x-matroska': 'other',
    'video/mp2t': 'segment',
    'video/iso.segment': 'segment',
};

/**
 * fMP4/WebM chunks such as `seg-12.mp4`, `chunk-0-00001.webm`, `fragment7.mp4`
 * and DASH init segments such as `init-1.webm` or `init.mp4`.
 */
const NUMBERED_CHUNK =
    /(?:^|[/_.-])(?:(?:seg(?:ment)?|chunk|frag(?:ment)?)[-_]?\d+|init(?=[-_.\d]))/i;

const UNSUPPORTED_SITES = ['youtube.com', 'youtu.be', 'youtube-nocookie.com'];

function lastPathSegment(url: URL): string {
    return url.pathname.split('/').pop() ?? '';
}

function extensionOf(url: URL): string {
    const segment = lastPathSegment(url);
    const dot = segment.lastIndexOf('.');
    return dot > 0 ? segment.slice(dot + 1).toLowerCase() : '';
}

export function hostMatches(host: string, suffix: string): boolean {
    const normalized = host.toLowerCase();
    return normalized === suffix || normalized.endsWith(`.${suffix}`);
}

/**
 * Byte-range and numbered chunk requests belong to a stream that is listed
 * through its manifest (or not at all); casting a chunk would play seconds.
 */
export function isSegmentUrl(url: URL): boolean {
    if (
        url.searchParams.has('range') ||
        /\/videoplayback$/.test(url.pathname)
    ) {
        return true;
    }
    const kind = KIND_BY_EXTENSION[extensionOf(url)];
    if (kind === 'segment') {
        return true;
    }
    return (
        (kind === 'mp4' || kind === 'webm') &&
        NUMBERED_CHUNK.test(lastPathSegment(url))
    );
}

export function mediaKindFromUrl(url: URL): ObservedMediaKind | null {
    if (isSegmentUrl(url)) {
        return 'segment';
    }
    return KIND_BY_EXTENSION[extensionOf(url)] ?? null;
}

export function mediaKindFromContentType(
    value: string | undefined
): ObservedMediaKind | null {
    const type = value?.split(';')[0].trim().toLowerCase();
    if (!type) {
        return null;
    }
    const known = KIND_BY_CONTENT_TYPE[type];
    if (known) {
        return known;
    }
    if (type.startsWith('audio/')) {
        return 'segment';
    }
    return type.startsWith('video/') ? 'other' : null;
}

/**
 * Sites whose players hand out short-lived, split audio/video URLs that a
 * receiver cannot play; their own apps cast them properly.
 */
export function isUnsupportedSite(url: URL): boolean {
    return UNSUPPORTED_SITES.some((site) => hostMatches(url.hostname, site));
}

const QUALITY_TOKEN =
    /(?:^|[^\d])(4320|2160|1440|1080|720|576|540|480|360|240|144)p(?:[^\da-z]|$)/i;

/** Height named in a URL, e.g. `clip.1080p.vp9.webm` or `/720p/index.m3u8`. */
export function qualityFromUrl(url: URL): number | null {
    const match = QUALITY_TOKEN.exec(decodeURIComponent(url.pathname));
    return match ? Number(match[1]) : null;
}

/** Identity used to merge the same stream seen in several places. */
export function sourceKey(url: URL): string {
    return `${url.origin}${url.pathname}${url.search}`;
}
