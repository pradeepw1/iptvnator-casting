import { UnsafeUrlError } from '../../events/url-safety';
import { gatherWebVideoCandidates } from './web-video-candidates';
import {
    parseFrameVideoReport,
    type FrameVideoReport,
} from './web-video-dom-report';
import { findWebVideos } from './web-video-finder';
import {
    type PageObservation,
    WebPageScanError,
} from './web-video-page-scanner';
import type { WebVideoProbe } from './web-video-probe';

const PAGE = 'https://www.example.com/watch/42';

function probe(overrides: Partial<WebVideoProbe> = {}): WebVideoProbe {
    return {
        castability: 'likely',
        sizeBytes: null,
        isLive: null,
        durationSeconds: null,
        height: null,
        variantCount: null,
        variantUrls: [],
        embeddedAds: false,
        drm: false,
        ...overrides,
    };
}

function frame(overrides: Partial<FrameVideoReport> = {}): FrameVideoReport {
    return {
        frameUrl: PAGE,
        isTopFrame: true,
        title: 'Example Feature',
        image: 'https://img.example.com/poster.jpg',
        metaVideos: [],
        videos: [],
        ...overrides,
    };
}

const player = {
    srcs: [],
    poster: null,
    x: 0,
    y: 0,
    width: 960,
    height: 540,
    loop: false,
    muted: false,
    durationSeconds: null,
    videoHeight: 0,
};

/** A page with the movie (HLS), its variant, a banner loop and an ad. */
const observation: PageObservation = {
    finalUrl: PAGE,
    title: 'Example Feature',
    thumbnail: 'https://img.example.com/poster.jpg',
    requests: [
        {
            url: 'https://cdn.example.com/hls/master.m3u8',
            kind: 'hls',
            frameUrl: PAGE,
            status: 200,
            sizeBytes: null,
        },
        {
            url: 'https://cdn.example.com/hls/720p.m3u8',
            kind: 'hls',
            frameUrl: PAGE,
            status: 200,
            sizeBytes: null,
        },
        {
            url: 'https://s0.2mdn.net/videoplayback/clip.mp4',
            kind: 'mp4',
            frameUrl: 'https://pubads.g.doubleclick.net/frame.html',
            status: 200,
            sizeBytes: 900_000,
        },
    ],
    frames: [
        frame({
            videos: [
                player,
                {
                    ...player,
                    srcs: ['https://www.example.com/banner.mp4'],
                    width: 1280,
                    height: 100,
                    loop: true,
                    muted: true,
                },
            ],
        }),
        frame({
            frameUrl: 'https://pubads.g.doubleclick.net/frame.html',
            isTopFrame: false,
            title: null,
            image: null,
            videos: [
                {
                    ...player,
                    srcs: ['https://s0.2mdn.net/videoplayback/clip.mp4'],
                    width: 300,
                    height: 250,
                    durationSeconds: 15,
                },
            ],
        }),
    ],
};

const probes: Record<string, WebVideoProbe> = {
    'https://cdn.example.com/hls/master.m3u8': probe({
        height: 1080,
        variantCount: 3,
        variantUrls: ['https://cdn.example.com/hls/720p.m3u8'],
        durationSeconds: 5_400,
        isLive: false,
    }),
    'https://s0.2mdn.net/videoplayback/clip.mp4': probe({ sizeBytes: 900_000 }),
};

function deps(overrides: Parameters<typeof findWebVideos>[1] = {}) {
    return {
        validate: async (value: string) => new URL(value),
        contentType: async () => 'text/html',
        scan: jest.fn(async () => observation),
        probe: jest.fn(async (url: string) => probes[url] ?? probe()),
        ...overrides,
    };
}

describe('findWebVideos', () => {
    it('lists the main video first, drops variant playlists, and puts ads last', async () => {
        const result = await findWebVideos(PAGE, deps());

        expect(result).toMatchObject({
            pageUrl: PAGE,
            title: 'Example Feature',
            thumbnail: 'https://img.example.com/poster.jpg',
        });
        expect(
            result.sources.map((source) => [source.url, source.verdict])
        ).toEqual([
            ['https://cdn.example.com/hls/master.m3u8', 'video'],
            ['https://www.example.com/banner.mp4', 'video'],
            ['https://s0.2mdn.net/videoplayback/clip.mp4', 'ad'],
        ]);
        expect(result.sources[0]).toMatchObject({
            kind: 'hls',
            height: 1080,
            durationSeconds: 5_400,
            castability: 'likely',
            signals: ['long-form', 'main-player', 'adaptive'],
        });
    });

    it('accepts links without a scheme', async () => {
        const scan = jest.fn(async () => observation);
        await findWebVideos('www.example.com/watch/42', deps({ scan }));
        expect(scan).toHaveBeenCalledWith(PAGE, expect.anything());
    });

    it('casts a pasted stream URL without opening a page', async () => {
        const scan = jest.fn(async () => observation);
        const result = await findWebVideos(
            'https://cdn.example.com/live/index.m3u8',
            deps({
                scan,
                contentType: async () => 'application/vnd.apple.mpegurl',
            })
        );

        expect(scan).not.toHaveBeenCalled();
        expect(result.sources).toHaveLength(1);
        expect(result.sources[0]).toMatchObject({
            kind: 'hls',
            verdict: 'video',
        });
    });

    it('opens a page whose path only looks like a file', async () => {
        const scan = jest.fn(async () => observation);
        await findWebVideos(
            'https://commons.example.org/wiki/File:Clip.webm',
            deps({ scan, contentType: async () => 'text/html; charset=utf-8' })
        );
        expect(scan).toHaveBeenCalled();
    });

    it.each([
        ['', 'invalid-url'],
        ['javascript:alert(1)', 'invalid-url'],
        ['file:///etc/hosts', 'invalid-url'],
        [42, 'invalid-url'],
        ['https://www.youtube.com/watch?v=abc', 'unsupported-site'],
    ])('rejects %p as %s', async (value, error) => {
        const scan = jest.fn(async () => observation);
        await expect(
            findWebVideos(value, deps({ scan }))
        ).resolves.toMatchObject({
            error,
            sources: [],
        });
        expect(scan).not.toHaveBeenCalled();
    });

    it('refuses private-network pages', async () => {
        const result = await findWebVideos(
            'http://192.168.1.1/',
            deps({
                validate: async () => {
                    throw new UnsafeUrlError('private');
                },
            })
        );
        expect(result.error).toBe('blocked-url');
    });

    it('reports scan failures and empty pages', async () => {
        await expect(
            findWebVideos(
                PAGE,
                deps({
                    scan: jest.fn(async () =>
                        Promise.reject(new WebPageScanError('load-failed'))
                    ),
                })
            )
        ).resolves.toMatchObject({ error: 'load-failed' });
        await expect(
            findWebVideos(
                PAGE,
                deps({
                    scan: jest.fn(async () =>
                        Promise.reject(new WebPageScanError('cancelled'))
                    ),
                })
            )
        ).resolves.toMatchObject({ error: 'cancelled' });
        await expect(
            findWebVideos(
                PAGE,
                deps({
                    scan: jest.fn(async () => ({
                        ...observation,
                        requests: [],
                        frames: [],
                    })),
                })
            )
        ).resolves.toMatchObject({
            error: 'no-video',
            title: 'Example Feature',
        });
    });

    it('reports a scan cancelled while probing', async () => {
        const controller = new AbortController();
        const result = await findWebVideos(
            PAGE,
            deps({
                signal: controller.signal,
                probe: jest.fn(async () => {
                    controller.abort();
                    return probe();
                }),
            })
        );
        expect(result.error).toBe('cancelled');
    });
});

describe('gatherWebVideoCandidates', () => {
    it('merges a stream seen as request, element source and metadata', () => {
        const url = 'https://cdn.example.com/movie.mp4';
        const candidates = gatherWebVideoCandidates({
            ...observation,
            requests: [
                {
                    url,
                    kind: 'mp4',
                    frameUrl: PAGE,
                    status: 200,
                    sizeBytes: 5_000,
                },
            ],
            frames: [
                frame({
                    metaVideos: [url],
                    videos: [{ ...player, srcs: [url] }],
                }),
            ],
        });

        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({
            kind: 'mp4',
            fromPageMetadata: true,
            sizeBytes: 5_000,
            element: { width: 960, height: 540 },
        });
    });

    it('skips chunk URLs exposed by players', () => {
        const candidates = gatherWebVideoCandidates({
            ...observation,
            requests: [],
            frames: [
                frame({
                    videos: [
                        {
                            ...player,
                            srcs: ['https://cdn.example.com/seg-1.ts'],
                        },
                    ],
                }),
            ],
        });
        expect(candidates).toEqual([]);
    });
});

describe('parseFrameVideoReport', () => {
    it('keeps only well-formed http(s) data from the page', () => {
        expect(
            parseFrameVideoReport(
                {
                    isTopFrame: true,
                    title: '  Example  ',
                    image: 'javascript:alert(1)',
                    metaVideos: [
                        'https://cdn.example.com/a.mp4',
                        'data:video/mp4,AA',
                        7,
                    ],
                    videos: [
                        {
                            srcs: [
                                'blob:https://www.example.com/1',
                                'https://cdn.example.com/a.mp4',
                            ],
                            width: 'wide',
                            height: 540,
                            loop: 'yes',
                            duration: Infinity,
                            videoHeight: 1080.4,
                        },
                        null,
                    ],
                },
                PAGE
            )
        ).toEqual({
            frameUrl: PAGE,
            isTopFrame: true,
            title: 'Example',
            image: null,
            metaVideos: ['https://cdn.example.com/a.mp4'],
            videos: [
                {
                    srcs: ['https://cdn.example.com/a.mp4'],
                    poster: null,
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 540,
                    loop: false,
                    muted: false,
                    durationSeconds: null,
                    videoHeight: 1080,
                },
            ],
        });
        expect(parseFrameVideoReport('nope', PAGE)).toBeNull();
    });
});
