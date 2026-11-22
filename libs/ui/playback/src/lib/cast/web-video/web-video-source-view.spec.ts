import type { WebVideoSource } from '@iptvnator/shared/interfaces';
import {
    castMediaForWebVideo,
    formatSize,
    toWebVideoSourceView,
} from './web-video-source-view';

const source: WebVideoSource = {
    id: 'source-1',
    url: 'https://cdn.example.com/hls/master.m3u8',
    kind: 'hls',
    verdict: 'video',
    signals: ['long-form', 'main-player', 'adaptive'],
    host: 'cdn.example.com',
    isLive: false,
    durationSeconds: 5_430,
    height: 1080,
    variantCount: 4,
    sizeBytes: null,
    castability: 'likely',
    embeddedAds: false,
};

describe('web video source view', () => {
    it('labels a main video', () => {
        expect(toWebVideoSourceView(source, true)).toEqual({
            id: 'source-1',
            icon: 'movie',
            quality: '1080p',
            format: 'HLS',
            duration: '1:30:30',
            live: false,
            host: 'cdn.example.com',
            size: null,
            warningKey: null,
            reasonKey: null,
            embeddedAds: false,
            best: true,
            ad: false,
        });
    });

    it('labels live streams without a duration', () => {
        expect(
            toWebVideoSourceView(
                { ...source, isLive: true, durationSeconds: null },
                false
            )
        ).toMatchObject({ icon: 'live_tv', live: true, duration: null });
    });

    it('explains ads by their strongest reason', () => {
        expect(
            toWebVideoSourceView(
                {
                    ...source,
                    kind: 'mp4',
                    verdict: 'ad',
                    signals: ['ad-frame', 'short-clip'],
                    sizeBytes: 2 * 1024 * 1024,
                },
                false
            )
        ).toMatchObject({
            icon: 'campaign',
            format: 'MP4',
            reasonKey: 'CAST.WEB.REASON_AD_FRAME',
            size: '2 MB',
            ad: true,
        });
    });

    it.each([
        ['needs-headers', 'CAST.WEB.WARN_HEADERS'],
        ['no-cors', 'CAST.WEB.WARN_CORS'],
        ['drm', 'CAST.WEB.WARN_DRM'],
        ['unknown', null],
    ] as const)('warns about %s', (castability, key) => {
        expect(
            toWebVideoSourceView({ ...source, castability }, false).warningKey
        ).toBe(key);
    });

    it('drops the CORS warning for a Roku, which plays streams natively', () => {
        const noCors = { ...source, castability: 'no-cors' as const };
        expect(
            toWebVideoSourceView(noCors, false, 'roku').warningKey
        ).toBeNull();
        expect(
            toWebVideoSourceView(noCors, false, 'chromecast').warningKey
        ).toBe('CAST.WEB.WARN_CORS');
        expect(
            toWebVideoSourceView(
                { ...source, castability: 'drm' },
                false,
                'roku'
            ).warningKey
        ).toBe('CAST.WEB.WARN_DRM');
    });

    it.each([
        [null, null],
        [0, null],
        [500_000, '<1 MB'],
        [96_645_673, '92 MB'],
        [3 * 1024 ** 3, '3.0 GB'],
    ])('formats %p bytes as %p', (bytes, expected) => {
        expect(formatSize(bytes)).toBe(expected);
    });

    it('builds the receiver request for a picked source', () => {
        expect(
            castMediaForWebVideo(
                { ...source, castability: 'needs-headers' },
                {
                    title: 'Example Feature',
                    thumbnail: 'https://img.example.com/p.jpg',
                }
            )
        ).toEqual({
            request: {
                url: 'https://cdn.example.com/hls/master.m3u8',
                title: 'Example Feature',
                thumbnail: 'https://img.example.com/p.jpg',
                isLive: false,
                contentType: 'application/x-mpegURL',
            },
            needsCustomHeaders: true,
        });
        expect(
            castMediaForWebVideo(
                { ...source, kind: 'other' },
                { title: null, thumbnail: null }
            ).request
        ).toMatchObject({
            title: 'cdn.example.com',
            contentType: undefined,
            thumbnail: undefined,
        });
    });
});
