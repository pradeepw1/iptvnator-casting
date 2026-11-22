import { EventEmitter } from 'node:events';
import type * as dgram from 'node:dgram';
import { discoverRokuDevices } from './roku-discovery';
import {
    parseRokuDeviceInfo,
    parseRokuMediaPlayer,
    RokuControlBlockedError,
    RokuEcpClient,
    rokuVideoFormat,
} from './roku-ecp-client';
import { encodeRokuSearch, rokuEndpointFromResponse } from './roku-ssdp';

const RESPONSE = [
    'HTTP/1.1 200 OK',
    'Cache-Control: max-age=3600',
    'ST: roku:ecp',
    'Location: http://192.0.2.18:8060/',
    'USN: uuid:roku:ecp:X00800ABC123',
    '',
    '',
].join('\r\n');

describe('Roku SSDP', () => {
    it('searches for roku:ecp', () => {
        const text = encodeRokuSearch().toString('ascii');
        expect(text.startsWith('M-SEARCH * HTTP/1.1\r\n')).toBe(true);
        expect(text).toContain('ST: roku:ecp\r\n');
        expect(text).toContain('MAN: "ssdp:discover"');
        expect(text.endsWith('\r\n\r\n')).toBe(true);
    });

    it('reads the endpoint and serial of an answer', () => {
        expect(rokuEndpointFromResponse(RESPONSE, '192.0.2.18')).toEqual({
            id: 'roku:X00800ABC123',
            host: '192.0.2.18',
            port: 8060,
        });
    });

    it('never follows a LOCATION that points away from the responder', () => {
        const spoofed = RESPONSE.replace(
            'http://192.0.2.18:8060/',
            'http://203.0.113.9:9999/'
        );
        expect(rokuEndpointFromResponse(spoofed, '192.0.2.18')).toMatchObject({
            host: '192.0.2.18',
            port: 8060,
        });
    });

    it('ignores answers from other UPnP devices', () => {
        expect(
            rokuEndpointFromResponse(
                RESPONSE.replace(/roku:ecp/g, 'upnp:rootdevice'),
                '192.0.2.18'
            )
        ).toBeNull();
    });
});

describe('Roku ECP parsing', () => {
    it('reads the name the user gave the device', () => {
        expect(
            parseRokuDeviceInfo(`<?xml version="1.0"?><device-info>
                <model-name>Example TV</model-name>
                <is-tv>true</is-tv>
                <friendly-device-name>Roku TV</friendly-device-name>
                <user-device-name>Living Room</user-device-name>
            </device-info>`)
        ).toEqual({ name: 'Living Room', model: 'Example TV', isTv: true });
    });

    it('reads playback state, progress and the playing channel', () => {
        expect(
            parseRokuMediaPlayer(`<?xml version="1.0"?>
                <player error="false" state="play">
                  <plugin bandwidth="1 bps" id="15985" name="Play on Roku"/>
                  <format audio="aac" container="hls" video="mpeg4_10b"/>
                  <position>3504 ms</position>
                  <duration>634000 ms</duration>
                  <is_live>false</is_live>
                </player>`)
        ).toEqual({
            state: 'play',
            error: false,
            channelId: '15985',
            positionSeconds: 3.504,
            durationSeconds: 634,
            isLive: false,
        });
        expect(
            parseRokuMediaPlayer('<player error="true" state="none"/>')
        ).toMatchObject({
            state: 'none',
            error: true,
            channelId: null,
            positionSeconds: null,
        });
    });

    it.each([
        [
            {
                url: 'https://cdn.example.com/a',
                isLive: false,
                contentType: 'application/x-mpegURL',
            },
            'hls',
        ],
        [{ url: 'https://cdn.example.com/a.mpd', isLive: false }, 'dash'],
        [{ url: 'https://cdn.example.com/a.mkv', isLive: false }, 'mkv'],
        [{ url: 'https://cdn.example.com/a.mp4', isLive: false }, 'mp4'],
        [{ url: 'https://cdn.example.com/live/1', isLive: true }, 'hls'],
        [{ url: 'https://cdn.example.com/movie/1', isLive: false }, null],
    ])('picks the video format for %p', (media, format) => {
        expect(rokuVideoFormat(media)).toBe(format);
    });
});

describe('RokuEcpClient', () => {
    function client(status = 200, body = '') {
        const fetchImpl = jest.fn<Promise<Response>, [URL, RequestInit?]>(
            async () => new Response(body, { status })
        );
        return {
            fetchImpl,
            ecp: new RokuEcpClient(
                'http://192.0.2.18:8060/',
                fetchImpl as unknown as typeof fetch
            ),
        };
    }

    it('opens a URL in Play on Roku with its title, format and poster', async () => {
        const { fetchImpl, ecp } = client();
        await ecp.playUrl({
            url: 'https://cdn.example.com/hls/master.m3u8?token=a&b=1',
            title: 'Example Feature',
            thumbnail: 'https://img.example.com/p.jpg',
            isLive: false,
        });

        const [target, init] = fetchImpl.mock.calls[0];
        expect(init.method).toBe('POST');
        expect(target.pathname).toBe('/input/15985');
        expect(Object.fromEntries(target.searchParams)).toEqual({
            t: 'v',
            u: 'https://cdn.example.com/hls/master.m3u8?token=a&b=1',
            videoName: 'Example Feature',
            videoFormat: 'hls',
            k: 'https://img.example.com/p.jpg',
        });
    });

    it('sends remote keys', async () => {
        const { fetchImpl, ecp } = client();
        await ecp.keypress('Play');
        expect(String(fetchImpl.mock.calls[0][0])).toBe(
            'http://192.0.2.18:8060/keypress/Play'
        );
    });

    it('reports a device that refuses control', async () => {
        const { ecp } = client(403);
        await expect(ecp.mediaPlayer()).rejects.toBeInstanceOf(
            RokuControlBlockedError
        );
    });

    it('reports other failures as plain errors', async () => {
        const { ecp } = client(500);
        await expect(ecp.keypress('Home')).rejects.not.toBeInstanceOf(
            RokuControlBlockedError
        );
    });
});

class FakeSsdpSocket extends EventEmitter {
    readonly sent: Buffer[] = [];
    closed = false;
    constructor(private readonly answers: Array<[string, string]>) {
        super();
    }
    bind(_port: number, _address: string | undefined, callback: () => void) {
        queueMicrotask(callback);
        return this;
    }
    setMulticastInterface() {
        return undefined;
    }
    send(packet: Buffer) {
        this.sent.push(packet);
        if (this.sent.length === 1) {
            for (const [text, address] of this.answers) {
                queueMicrotask(() =>
                    this.emit('message', Buffer.from(text), {
                        address,
                        port: 8060,
                    })
                );
            }
        }
    }
    close() {
        this.closed = true;
    }
}

describe('discoverRokuDevices', () => {
    it('lists each Roku once, by its own name, and falls back to the address', async () => {
        const second = RESPONSE.replace(/192\.0\.2\.18/g, '192.0.2.98').replace(
            'X00800ABC123',
            'YH00XYZ'
        );
        const sockets: FakeSsdpSocket[] = [];
        const devices = await discoverRokuDevices({
            timeoutMs: 20,
            listInterfaceAddresses: () => ['192.0.2.2'],
            createSocket: () => {
                const socket = new FakeSsdpSocket([
                    [RESPONSE, '192.0.2.18'],
                    [RESPONSE, '192.0.2.18'],
                    [second, '192.0.2.98'],
                ]);
                sockets.push(socket);
                return socket as unknown as dgram.Socket;
            },
            describe: async (endpoint) => {
                if (endpoint.host === '192.0.2.98') throw new Error('blocked');
                return { name: 'Living Room', model: 'Example TV' };
            },
        });

        expect(devices).toEqual([
            {
                id: 'roku:X00800ABC123',
                name: 'Living Room',
                model: 'Example TV',
                host: '192.0.2.18',
                port: 8060,
            },
            {
                id: 'roku:YH00XYZ',
                name: 'Roku (192.0.2.98)',
                model: undefined,
                host: '192.0.2.98',
                port: 8060,
            },
        ]);
        expect(sockets[0].closed).toBe(true);
    });
});
