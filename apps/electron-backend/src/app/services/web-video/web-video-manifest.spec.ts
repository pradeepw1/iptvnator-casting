import {
    parseDashManifest,
    parseHlsPlaylist,
    parseIsoDuration,
} from './web-video-manifest';

const BASE = 'https://cdn.example.com/hls/master.m3u8';

describe('parseHlsPlaylist', () => {
    it('reads variants and the tallest resolution of a master playlist', () => {
        const summary = parseHlsPlaylist(
            [
                '#EXTM3U',
                '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"',
                '360p/index.m3u8',
                '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
                '',
                'https://cdn2.example.com/1080p/index.m3u8',
            ].join('\n'),
            BASE
        );

        expect(summary).toMatchObject({
            height: 1080,
            variantCount: 2,
            variantUrls: [
                'https://cdn.example.com/hls/360p/index.m3u8',
                'https://cdn2.example.com/1080p/index.m3u8',
            ],
            isLive: null,
        });
    });

    it('sums a finished media playlist', () => {
        expect(
            parseHlsPlaylist(
                '#EXTM3U\n#EXTINF:6.0,\na.ts\n#EXTINF:6.5,\nb.ts\n#EXT-X-ENDLIST\n',
                BASE
            )
        ).toMatchObject({ isLive: false, durationSeconds: 13 });
    });

    it('treats a playlist without an end as live', () => {
        expect(
            parseHlsPlaylist('#EXTM3U\n#EXTINF:6,\na.ts\n', BASE)
        ).toMatchObject({ isLive: true, durationSeconds: null });
    });

    it('spots ads stitched into the stream', () => {
        expect(
            parseHlsPlaylist(
                '#EXTM3U\n#EXT-X-CUE-OUT:30\n#EXTINF:6,\nad.ts\n#EXT-X-CUE-IN\n',
                BASE
            ).embeddedAds
        ).toBe(true);
        expect(
            parseHlsPlaylist(
                '#EXTM3U\n#EXT-X-DATERANGE:ID="a",CLASS="com.apple.hls.interstitial"\n',
                BASE
            ).embeddedAds
        ).toBe(true);
    });
});

describe('parseDashManifest', () => {
    it('reads duration and the tallest representation', () => {
        expect(
            parseDashManifest(`<?xml version="1.0"?>
                <MPD type="static" mediaPresentationDuration="PT10M34.6S">
                  <Period><AdaptationSet>
                    <Representation id="1" height="480"/>
                    <Representation id="2" height="1080"/>
                  </AdaptationSet></Period>
                </MPD>`)
        ).toMatchObject({
            isLive: false,
            durationSeconds: 635,
            height: 1080,
            variantCount: 2,
            drm: false,
        });
    });

    it('flags live and DRM-protected manifests', () => {
        const summary = parseDashManifest(
            '<MPD type="dynamic"><ContentProtection schemeIdUri="urn:x"/></MPD>'
        );
        expect(summary).toMatchObject({
            isLive: true,
            durationSeconds: null,
            drm: true,
        });
    });
});

describe('parseIsoDuration', () => {
    it.each([
        ['PT1H2M3S', 3723],
        ['PT45.4S', 45],
        ['P1DT1S', 86_401],
        ['PT0S', null],
        ['soon', null],
        [null, null],
    ])('%p -> %p', (value, expected) => {
        expect(parseIsoDuration(value)).toBe(expected);
    });
});
