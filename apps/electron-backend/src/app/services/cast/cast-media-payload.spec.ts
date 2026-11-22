import {
    buildCastLoadPayload,
    inferCastContentType,
    InvalidCastMediaError,
    normalizeCastMediaRequest,
    parseCastableUrl,
} from './cast-media-payload';

describe('cast media payload', () => {
    it.each([
        [
            'http://stream.example.com/live/index.m3u8?token=1',
            false,
            'application/x-mpegURL',
        ],
        ['https://stream.example.com/movie.MP4', false, 'video/mp4'],
        [
            'https://stream.example.com/manifest.mpd',
            true,
            'application/dash+xml',
        ],
        ['http://stream.example.com/channel.ts', true, 'video/mp2t'],
        [
            'http://stream.example.com/live/user/1234',
            true,
            'application/x-mpegURL',
        ],
        ['http://stream.example.com/movie/user/1234', false, 'video/mp4'],
    ])('infers %s (live=%s) as %s', (url, isLive, expected) => {
        expect(inferCastContentType(new URL(url), isLive)).toBe(expected);
    });

    it.each([
        'file:///tmp/video.mp4',
        'blob:http://localhost:4200/123',
        'http://localhost:8080/stream.m3u8',
        'http://127.0.0.1/stream.m3u8',
        'http://[::1]/stream.m3u8',
        'not a url',
        '',
        42,
    ])('rejects %p as a cast source', (value) => {
        expect(() => parseCastableUrl(value)).toThrow(InvalidCastMediaError);
    });

    it('accepts LAN and public http(s) URLs', () => {
        expect(parseCastableUrl('http://192.168.1.20:8000/a.m3u8').host).toBe(
            '192.168.1.20:8000'
        );
        expect(parseCastableUrl('https://stream.example.com/a').protocol).toBe(
            'https:'
        );
    });

    it('normalizes untrusted renderer requests', () => {
        expect(
            normalizeCastMediaRequest({
                url: 'https://stream.example.com/movie.mp4',
                title: '  A Movie  ',
                thumbnail: 'file:///etc/passwd',
                isLive: false,
                startTime: 42,
                extra: 'ignored',
            })
        ).toEqual({
            url: 'https://stream.example.com/movie.mp4',
            title: 'A Movie',
            thumbnail: undefined,
            isLive: false,
            contentType: undefined,
            startTime: 42,
        });
    });

    it('drops resume positions for live streams and invalid values', () => {
        const live = normalizeCastMediaRequest({
            url: 'https://stream.example.com/live.m3u8',
            isLive: true,
            startTime: 30,
        });
        const invalid = normalizeCastMediaRequest({
            url: 'https://stream.example.com/movie.mp4',
            isLive: false,
            startTime: Number.NaN,
        });

        expect(live.startTime).toBeUndefined();
        expect(invalid.startTime).toBeUndefined();
    });

    it('builds a Default Media Receiver LOAD message', () => {
        expect(
            buildCastLoadPayload(
                {
                    url: 'https://stream.example.com/movie.mp4',
                    title: 'A Movie',
                    thumbnail: 'https://img.example.com/poster.jpg',
                    isLive: false,
                    startTime: 90,
                },
                'session-1'
            )
        ).toEqual({
            type: 'LOAD',
            sessionId: 'session-1',
            autoplay: true,
            currentTime: 90,
            media: {
                contentId: 'https://stream.example.com/movie.mp4',
                contentUrl: 'https://stream.example.com/movie.mp4',
                contentType: 'video/mp4',
                streamType: 'BUFFERED',
                metadata: {
                    metadataType: 0,
                    title: 'A Movie',
                    images: [{ url: 'https://img.example.com/poster.jpg' }],
                },
            },
        });
    });

    it('marks live streams and honours an explicit content type', () => {
        const payload = buildCastLoadPayload(
            {
                url: 'https://stream.example.com/live/1',
                isLive: true,
                contentType: 'video/mp2t',
            },
            'session-1'
        );

        expect(payload['media']).toMatchObject({
            contentType: 'video/mp2t',
            streamType: 'LIVE',
            metadata: { metadataType: 0 },
        });
        expect(payload['currentTime']).toBe(0);
    });
});
