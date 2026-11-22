import type { CastMediaRequest } from '@iptvnator/shared/interfaces';
import type { CastPayload } from './cast-connection';

/** Google's Default Media Receiver application. */
export const DEFAULT_MEDIA_RECEIVER_APP_ID = 'CC1AD845';

const HLS_CONTENT_TYPE = 'application/x-mpegURL';

const CONTENT_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
    m3u8: HLS_CONTENT_TYPE,
    m3u: HLS_CONTENT_TYPE,
    mpd: 'application/dash+xml',
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    ts: 'video/mp2t',
    mp3: 'audio/mpeg',
    aac: 'audio/aac',
    m4a: 'audio/mp4',
};

const MAX_TITLE_LENGTH = 512;

export class InvalidCastMediaError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidCastMediaError';
    }
}

function isLoopbackHost(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return (
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host === '::1' ||
        /^127\./.test(host)
    );
}

/**
 * Accepts only absolute http(s) URLs the receiver can fetch by itself. A
 * loopback URL would point the TV at its own address, so it is rejected.
 */
export function parseCastableUrl(value: unknown): URL {
    if (typeof value !== 'string' || value.length === 0) {
        throw new InvalidCastMediaError('Missing media URL');
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new InvalidCastMediaError('Malformed media URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new InvalidCastMediaError('Only http(s) media can be cast');
    }
    if (isLoopbackHost(url.hostname)) {
        throw new InvalidCastMediaError('Loopback media cannot be cast');
    }
    return url;
}

/**
 * Picks the MIME type from the path extension. Extensionless live URLs
 * (common for IPTV providers) are assumed to be HLS: the Default Media
 * Receiver cannot play raw MPEG-TS anyway, so that is the only live
 * format with a chance to work.
 */
export function inferCastContentType(url: URL, isLive: boolean): string {
    const lastSegment = url.pathname.split('/').pop() ?? '';
    const dot = lastSegment.lastIndexOf('.');
    const extension = dot >= 0 ? lastSegment.slice(dot + 1).toLowerCase() : '';
    const known = CONTENT_TYPES_BY_EXTENSION[extension];
    if (known) {
        return known;
    }
    return isLive ? HLS_CONTENT_TYPE : 'video/mp4';
}

function optionalText(value: unknown, limit: number): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, limit) : undefined;
}

/** Validates a renderer-supplied request into a normalized one. */
export function normalizeCastMediaRequest(value: unknown): CastMediaRequest {
    if (!value || typeof value !== 'object') {
        throw new InvalidCastMediaError('Missing media request');
    }
    const raw = value as Record<string, unknown>;
    const url = parseCastableUrl(raw['url']);
    const isLive = raw['isLive'] === true;
    const startTime = raw['startTime'];
    let thumbnail: string | undefined;
    try {
        thumbnail = parseCastableUrl(raw['thumbnail']).toString();
    } catch {
        thumbnail = undefined;
    }
    return {
        url: url.toString(),
        isLive,
        title: optionalText(raw['title'], MAX_TITLE_LENGTH),
        thumbnail,
        contentType: optionalText(raw['contentType'], 128),
        startTime:
            !isLive &&
            typeof startTime === 'number' &&
            Number.isFinite(startTime) &&
            startTime > 0
                ? startTime
                : undefined,
    };
}

/** Builds the media-namespace LOAD message for the Default Media Receiver. */
export function buildCastLoadPayload(
    media: CastMediaRequest,
    sessionId: string
): CastPayload {
    const url = new URL(media.url);
    const metadata: Record<string, unknown> = { metadataType: 0 };
    if (media.title) {
        metadata['title'] = media.title;
    }
    if (media.thumbnail) {
        metadata['images'] = [{ url: media.thumbnail }];
    }
    return {
        type: 'LOAD',
        sessionId,
        autoplay: true,
        currentTime: media.startTime ?? 0,
        media: {
            contentId: media.url,
            contentUrl: media.url,
            contentType:
                media.contentType ?? inferCastContentType(url, media.isLive),
            streamType: media.isLive ? 'LIVE' : 'BUFFERED',
            metadata,
        },
    };
}
