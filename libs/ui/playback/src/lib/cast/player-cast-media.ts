import type {
    CastMediaRequest,
    CastSession,
    ResolvedPortalPlayback,
} from '@iptvnator/shared/interfaces';

/** What the player view offers for casting. */
export interface PlayerCastMedia {
    readonly request: CastMediaRequest;
    /**
     * The receiver fetches the stream itself and cannot send the playlist's
     * custom User-Agent/Referer/Origin, so such streams may fail on the TV.
     */
    readonly needsCustomHeaders: boolean;
}

const ACTIVE_STATUSES: ReadonlySet<CastSession['status']> = new Set([
    'connecting',
    'loading',
    'buffering',
    'playing',
    'paused',
]);

export function isCastSessionActive(session: CastSession | null): boolean {
    return !!session && ACTIVE_STATUSES.has(session.status);
}

/** Mirrors the backend rule: http(s) only, and never a loopback host. */
export function isCastableUrl(value: string | null | undefined): boolean {
    if (!value) {
        return false;
    }
    try {
        const url = new URL(value);
        const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        return (
            (url.protocol === 'http:' || url.protocol === 'https:') &&
            host !== 'localhost' &&
            !host.endsWith('.localhost') &&
            host !== '::1' &&
            !/^127\./.test(host)
        );
    } catch {
        return false;
    }
}

/**
 * Builds the cast offer for the current playback. DRM-protected streams and
 * local or blob sources cannot be played by the Default Media Receiver.
 */
export function resolvePlayerCastMedia(
    playback: ResolvedPortalPlayback | null,
    isLive: boolean
): PlayerCastMedia | null {
    if (!playback || playback.drm || !isCastableUrl(playback.streamUrl)) {
        return null;
    }
    const thumbnail = playback.thumbnail ?? undefined;
    const headers = Object.values(playback.headers ?? {}).some(
        (value) => !!value?.trim()
    );
    return {
        request: {
            url: playback.streamUrl,
            title: playback.title || undefined,
            thumbnail: isCastableUrl(thumbnail) ? thumbnail : undefined,
            isLive,
        },
        needsCustomHeaders:
            headers ||
            !!playback.userAgent?.trim() ||
            !!playback.referer?.trim() ||
            !!playback.origin?.trim(),
    };
}
