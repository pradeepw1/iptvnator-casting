import {
    hostMatches,
    isSegmentUrl,
    isUnsupportedSite,
    mediaKindFromContentType,
    mediaKindFromUrl,
    qualityFromUrl,
    sourceKey,
} from './web-video-media';

const url = (value: string) => new URL(value);

describe('web video media detection', () => {
    it.each([
        ['https://cdn.example.com/live/master.m3u8?token=1', 'hls'],
        ['https://cdn.example.com/vod/manifest.mpd', 'dash'],
        ['https://cdn.example.com/movie.MP4', 'mp4'],
        ['https://cdn.example.com/clip.webm', 'webm'],
        ['https://cdn.example.com/seg-001.ts', 'segment'],
        ['https://cdn.example.com/chunk-stream0-00012.m4s', 'segment'],
        ['https://cdn.example.com/v/seg-12.mp4', 'segment'],
        ['https://cdn.example.com/v/chunk-0-00001.3x1080p.vp9.webm', 'segment'],
        ['https://cdn.example.com/v/init-1.3x1080p.vp9.webm', 'segment'],
        ['https://cdn.example.com/v/init.mp4', 'segment'],
        ['https://media.example.com/videoplayback', 'segment'],
        ['https://cdn.example.com/movie.mp4?range=0-1000', 'segment'],
        ['https://cdn.example.com/watch', null],
    ])('%s -> %s', (value, expected) => {
        expect(mediaKindFromUrl(url(value))).toBe(expected);
    });

    it('keeps ordinary file names that merely contain chunk-like words', () => {
        expect(
            isSegmentUrl(url('https://cdn.example.com/initial-release.mp4'))
        ).toBe(false);
        expect(
            isSegmentUrl(url('https://cdn.example.com/segmented-story.webm'))
        ).toBe(false);
    });

    it.each([
        ['application/vnd.apple.mpegurl', 'hls'],
        ['application/x-mpegURL; charset=utf-8', 'hls'],
        ['application/dash+xml', 'dash'],
        ['video/mp4', 'mp4'],
        ['video/webm', 'webm'],
        ['video/mp2t', 'segment'],
        ['audio/mp4', 'segment'],
        ['video/x-flv', 'other'],
        ['text/html', null],
        [undefined, null],
    ])('content type %p -> %p', (value, expected) => {
        expect(mediaKindFromContentType(value)).toBe(expected);
    });

    it('matches hosts by whole labels', () => {
        expect(hostMatches('ad.doubleclick.net', 'doubleclick.net')).toBe(true);
        expect(hostMatches('doubleclick.net', 'doubleclick.net')).toBe(true);
        expect(hostMatches('notdoubleclick.net', 'doubleclick.net')).toBe(
            false
        );
    });

    it('turns away sites that need their own cast integration', () => {
        expect(
            isUnsupportedSite(url('https://www.youtube.com/watch?v=x'))
        ).toBe(true);
        expect(isUnsupportedSite(url('https://youtu.be/x'))).toBe(true);
        expect(isUnsupportedSite(url('https://video.example.com/watch'))).toBe(
            false
        );
    });

    it.each([
        ['https://cdn.example.com/clip.1080p.vp9.webm', 1080],
        ['https://cdn.example.com/hls/720p/index.m3u8', 720],
        ['https://cdn.example.com/Movie%20480p.mp4', 480],
        ['https://cdn.example.com/1080/clip.mp4', null],
        ['https://cdn.example.com/10800p.mp4', null],
    ])('reads the quality of %s', (value, expected) => {
        expect(qualityFromUrl(url(value))).toBe(expected);
    });

    it('merges URLs that differ only by fragment', () => {
        expect(sourceKey(url('https://cdn.example.com/a.mp4?x=1#t=10'))).toBe(
            'https://cdn.example.com/a.mp4?x=1'
        );
    });
});
