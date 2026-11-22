import { UnsafeUrlError } from '../../events/url-safety';
import { fetchContentType, probeWebVideo } from './web-video-probe';

type Route = (init: RequestInit) => Response;

function server(routes: Record<string, Route>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = jest.fn(
        async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            calls.push({ url, init: init ?? {} });
            const route = routes[url];
            return route
                ? route(init ?? {})
                : new Response('missing', { status: 404 });
        }
    ) as unknown as typeof fetch;
    return { fetchImpl, calls };
}

const allow = async (value: string) => new URL(value);
const cors = { 'access-control-allow-origin': '*' };

describe('probeWebVideo', () => {
    it('fetches like a receiver: no cookies, no referrer, receiver agent', async () => {
        const { fetchImpl, calls } = server({
            'https://cdn.example.com/movie.mp4': () =>
                new Response('xx', {
                    status: 206,
                    headers: {
                        'content-type': 'video/mp4',
                        'content-range': 'bytes 0-1/123456789',
                    },
                }),
        });

        const probe = await probeWebVideo(
            'https://cdn.example.com/movie.mp4',
            'mp4',
            {
                fetch: fetchImpl,
                validate: allow,
            }
        );

        expect(probe).toMatchObject({
            castability: 'likely',
            sizeBytes: 123456789,
        });
        expect(calls[0].init).toMatchObject({
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            redirect: 'manual',
            headers: {
                Range: 'bytes=0-1',
                'User-Agent': expect.stringContaining('CrKey'),
            },
        });
    });

    it('reports streams the server refuses without the page context', async () => {
        const { fetchImpl } = server({
            'https://cdn.example.com/movie.mp4': () =>
                new Response('no', { status: 403 }),
        });
        await expect(
            probeWebVideo('https://cdn.example.com/movie.mp4', 'mp4', {
                fetch: fetchImpl,
                validate: allow,
            })
        ).resolves.toMatchObject({ castability: 'needs-headers' });
    });

    it('reads a master playlist and one variant, and checks CORS', async () => {
        const { fetchImpl } = server({
            'https://cdn.example.com/hls/master.m3u8': () =>
                new Response(
                    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\n720p.m3u8\n',
                    { headers: cors }
                ),
            'https://cdn.example.com/hls/720p.m3u8': () =>
                new Response('#EXTM3U\n#EXTINF:600,\na.ts\n#EXT-X-ENDLIST\n', {
                    headers: cors,
                }),
        });

        await expect(
            probeWebVideo('https://cdn.example.com/hls/master.m3u8', 'hls', {
                fetch: fetchImpl,
                validate: allow,
            })
        ).resolves.toMatchObject({
            castability: 'likely',
            height: 720,
            variantCount: 1,
            durationSeconds: 600,
            isLive: false,
        });
    });

    it('flags manifests a receiver cannot read without CORS', async () => {
        const { fetchImpl } = server({
            'https://cdn.example.com/live.m3u8': () =>
                new Response('#EXTM3U\n#EXTINF:6,\na.ts\n'),
        });
        await expect(
            probeWebVideo('https://cdn.example.com/live.m3u8', 'hls', {
                fetch: fetchImpl,
                validate: allow,
            })
        ).resolves.toMatchObject({ castability: 'no-cors', isLive: true });
    });

    it('flags DRM-protected DASH', async () => {
        const { fetchImpl } = server({
            'https://cdn.example.com/a.mpd': () =>
                new Response('<MPD><ContentProtection/></MPD>', {
                    headers: cors,
                }),
        });
        await expect(
            probeWebVideo('https://cdn.example.com/a.mpd', 'dash', {
                fetch: fetchImpl,
                validate: allow,
            })
        ).resolves.toMatchObject({ castability: 'drm' });
    });

    it('follows redirects but validates every hop', async () => {
        const { fetchImpl, calls } = server({
            'https://cdn.example.com/a.mp4': () =>
                new Response(null, {
                    status: 302,
                    headers: { location: 'http://10.0.0.5/a.mp4' },
                }),
        });
        const validate = jest.fn(async (value: string) => {
            if (value.includes('10.0.0.5')) throw new UnsafeUrlError('private');
            return new URL(value);
        });

        await expect(
            probeWebVideo('https://cdn.example.com/a.mp4', 'mp4', {
                fetch: fetchImpl,
                validate,
            })
        ).resolves.toMatchObject({ castability: 'unknown' });
        expect(calls.map((call) => call.url)).toEqual([
            'https://cdn.example.com/a.mp4',
        ]);
    });

    it('does not call an HTML answer a playable file', async () => {
        const { fetchImpl } = server({
            'https://www.example.com/File:clip.webm': () =>
                new Response('<html>', {
                    headers: { 'content-type': 'text/html' },
                }),
        });
        await expect(
            probeWebVideo('https://www.example.com/File:clip.webm', 'webm', {
                fetch: fetchImpl,
                validate: allow,
            })
        ).resolves.toMatchObject({ castability: 'unknown' });
        await expect(
            fetchContentType('https://www.example.com/File:clip.webm', {
                fetch: fetchImpl,
                validate: allow,
            })
        ).resolves.toBe('text/html');
    });

    it('never rejects', async () => {
        const failing = jest.fn(async () => {
            throw new Error('offline');
        }) as unknown as typeof fetch;
        await expect(
            probeWebVideo('https://cdn.example.com/a.m3u8', 'hls', {
                fetch: failing,
                validate: allow,
            })
        ).resolves.toMatchObject({ castability: 'unknown' });
        await expect(
            fetchContentType('https://cdn.example.com/a.m3u8', {
                fetch: failing,
                validate: allow,
            })
        ).resolves.toBeNull();
    });
});
