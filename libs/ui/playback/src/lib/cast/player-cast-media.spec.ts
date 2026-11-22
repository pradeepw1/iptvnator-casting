import type {
    CastSession,
    ResolvedPortalPlayback,
} from '@iptvnator/shared/interfaces';
import {
    isCastableUrl,
    isCastSessionActive,
    resolvePlayerCastMedia,
} from './player-cast-media';
import { resolvePlayerCastStatusCard } from './player-cast-status';

const playback: ResolvedPortalPlayback = {
    streamUrl: 'https://stream.example.com/live/index.m3u8',
    title: 'Example News',
    thumbnail: 'https://img.example.com/logo.png',
};

describe('resolvePlayerCastMedia', () => {
    it('offers http(s) playback with its metadata', () => {
        expect(resolvePlayerCastMedia(playback, true)).toEqual({
            request: {
                url: 'https://stream.example.com/live/index.m3u8',
                title: 'Example News',
                thumbnail: 'https://img.example.com/logo.png',
                isLive: true,
            },
            needsCustomHeaders: false,
        });
    });

    it.each([
        ['DRM-protected', { drm: { type: 'clearkey' } }],
        ['blob', { streamUrl: 'blob:http://localhost:4200/abc' }],
        ['local file', { streamUrl: 'file:///Users/example/movie.mp4' }],
        ['loopback', { streamUrl: 'http://127.0.0.1:8080/live.m3u8' }],
    ])('does not offer %s playback', (_label, overrides) => {
        expect(
            resolvePlayerCastMedia(
                { ...playback, ...overrides } as ResolvedPortalPlayback,
                false
            )
        ).toBeNull();
    });

    it('drops unusable thumbnails but still casts', () => {
        expect(
            resolvePlayerCastMedia(
                { ...playback, thumbnail: 'data:image/png;base64,AA' },
                false
            )?.request.thumbnail
        ).toBeUndefined();
    });

    it.each([
        [{ userAgent: 'ExamplePlayer/1.0' }],
        [{ referer: 'https://portal.example.com/' }],
        [{ origin: 'https://portal.example.com' }],
        [{ headers: { Authorization: 'Bearer example' } }],
    ])('flags streams that need custom headers: %p', (overrides) => {
        expect(
            resolvePlayerCastMedia({ ...playback, ...overrides }, true)
                ?.needsCustomHeaders
        ).toBe(true);
    });

    it('ignores blank header values', () => {
        expect(
            resolvePlayerCastMedia(
                { ...playback, userAgent: '  ', headers: { Referer: '' } },
                true
            )?.needsCustomHeaders
        ).toBe(false);
    });
});

describe('isCastableUrl', () => {
    it.each([
        ['http://192.168.1.20/live.m3u8', true],
        ['https://stream.example.com/a.mp4', true],
        ['http://localhost/a.m3u8', false],
        ['http://app.localhost/a.m3u8', false],
        ['http://[::1]/a.m3u8', false],
        ['ftp://stream.example.com/a.mp4', false],
        ['', false],
        [null, false],
    ])('%p -> %p', (url, expected) => {
        expect(isCastableUrl(url)).toBe(expected);
    });
});

describe('cast session status', () => {
    const session: CastSession = {
        deviceId: 'device-1',
        deviceName: 'Living Room TV',
        status: 'playing',
        isLive: true,
        positionSeconds: 0,
        durationSeconds: null,
        volume: 1,
        muted: false,
        canSeek: true,
        canSetVolume: true,
    };

    it('treats only live receiver states as active', () => {
        expect(isCastSessionActive(null)).toBe(false);
        expect(isCastSessionActive(session)).toBe(true);
        expect(isCastSessionActive({ ...session, status: 'connecting' })).toBe(
            true
        );
        expect(isCastSessionActive({ ...session, status: 'ended' })).toBe(
            false
        );
        expect(isCastSessionActive({ ...session, status: 'error' })).toBe(
            false
        );
    });

    it('builds the controls card for each state', () => {
        expect(resolvePlayerCastStatusCard(null)).toBeNull();
        expect(
            resolvePlayerCastStatusCard({ ...session, status: 'ended' })
        ).toBeNull();
        expect(
            resolvePlayerCastStatusCard({ ...session, status: 'loading' })
        ).toEqual({
            titleKey: 'CAST.CONNECTING',
            device: 'Living Room TV',
            messageKey: null,
            failed: false,
        });
        expect(
            resolvePlayerCastStatusCard({ ...session, status: 'paused' })
        ).toMatchObject({
            titleKey: 'CAST.PLAYING_ON',
        });
        expect(
            resolvePlayerCastStatusCard({
                ...session,
                status: 'error',
                error: 'device-unreachable',
            })
        ).toEqual({
            titleKey: 'CAST.FAILED',
            device: 'Living Room TV',
            messageKey: 'CAST.ERROR_UNREACHABLE',
            failed: true,
        });
        expect(
            resolvePlayerCastStatusCard({ ...session, status: 'error' })
                ?.messageKey
        ).toBe('CAST.ERROR_LOAD');
        expect(
            resolvePlayerCastStatusCard({
                ...session,
                status: 'error',
                error: 'control-blocked',
            })?.messageKey
        ).toBe('CAST.ERROR_ROKU_BLOCKED');
    });
});
