import {
    classifyWebVideo,
    isAdHost,
    type WebVideoEvidence,
} from './web-video-ad-classifier';

function evidence(overrides: Partial<WebVideoEvidence> = {}): WebVideoEvidence {
    return {
        url: new URL('https://cdn.example.com/movies/feature.mp4'),
        kind: 'mp4',
        frameUrl: new URL('https://www.example.com/watch'),
        element: null,
        fromPageMetadata: false,
        isLive: null,
        durationSeconds: null,
        variantCount: null,
        sizeBytes: null,
        ...overrides,
    };
}

const mainPlayer = { width: 960, height: 540, loop: false, muted: false };

describe('classifyWebVideo', () => {
    it('recognises well-known video ad hosts', () => {
        expect(isAdHost('s0.2mdn.net')).toBe(true);
        expect(isAdHost('pubads.g.doubleclick.net')).toBe(true);
        expect(isAdHost('imasdk.googleapis.com')).toBe(true);
        expect(isAdHost('cdn.example.com')).toBe(false);
    });

    it('calls a clip from an ad server inside an ad frame an ad', () => {
        const result = classifyWebVideo(
            evidence({
                url: new URL('https://s0.2mdn.net/videoplayback/clip.mp4'),
                frameUrl: new URL(
                    'https://pubads.g.doubleclick.net/frame.html'
                ),
                element: { width: 300, height: 250, loop: false, muted: true },
                durationSeconds: 15,
            })
        );

        expect(result.verdict).toBe('ad');
        expect(result.signals.slice(0, 2)).toEqual(['ad-network', 'ad-frame']);
    });

    it('calls a VAST-tag media URL an ad', () => {
        expect(
            classifyWebVideo(
                evidence({
                    url: new URL(
                        'https://media.example.net/vast/preroll/clip.mp4?correlator=1'
                    ),
                })
            ).verdict
        ).toBe('ad');
    });

    it('keeps the page player and its adaptive stream as the video', () => {
        const result = classifyWebVideo(
            evidence({
                url: new URL('https://cdn.example.com/hls/master.m3u8'),
                kind: 'hls',
                element: mainPlayer,
                variantCount: 4,
                durationSeconds: 5_400,
            })
        );

        expect(result.verdict).toBe('video');
        expect(result.signals).toEqual([
            'long-form',
            'main-player',
            'adaptive',
        ]);
    });

    it('trusts a live stream even when served from an ad-looking path', () => {
        expect(
            classifyWebVideo(
                evidence({
                    url: new URL('https://cdn.example.com/ads/live/index.m3u8'),
                    kind: 'hls',
                    isLive: true,
                    element: mainPlayer,
                })
            ).verdict
        ).toBe('video');
    });

    it('does not call a short clip or a looping banner an ad on its own', () => {
        expect(
            classifyWebVideo(evidence({ durationSeconds: 20 })).verdict
        ).toBe('video');
        expect(
            classifyWebVideo(
                evidence({
                    element: {
                        width: 1280,
                        height: 120,
                        loop: true,
                        muted: true,
                    },
                })
            ).verdict
        ).toBe('video');
    });

    it('needs whole path tokens, so words like "load" or "header" pass', () => {
        expect(
            classifyWebVideo(
                evidence({
                    url: new URL('https://cdn.example.com/download/header.mp4'),
                })
            ).signals
        ).not.toContain('ad-path');
        expect(
            classifyWebVideo(
                evidence({
                    url: new URL('https://cdn.example.com/ad/clip.mp4'),
                })
            ).signals
        ).toContain('ad-path');
    });

    it('treats big files as long-form content', () => {
        expect(
            classifyWebVideo(evidence({ sizeBytes: 300 * 1024 * 1024 })).signals
        ).toContain('long-form');
    });
});
