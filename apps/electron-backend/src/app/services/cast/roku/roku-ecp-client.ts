import type { CastMediaRequest } from '@iptvnator/shared/interfaces';

/** Roku's built-in "Play on Roku" channel, which plays a media URL. */
export const PLAY_ON_ROKU_CHANNEL = '15985';

const DEFAULT_TIMEOUT_MS = 4_000;

/**
 * The device refused the command: its "Control by mobile apps" network
 * access is Limited or Disabled.
 */
export class RokuControlBlockedError extends Error {
    constructor() {
        super('Roku refused the control command');
        this.name = 'RokuControlBlockedError';
    }
}

export interface RokuDeviceInfo {
    readonly name: string | null;
    readonly model: string | null;
    readonly isTv: boolean;
}

export interface RokuPlayerState {
    /** `play`, `pause`, `buffer`, `startup`, `open`, `stop`, `close`, `none`. */
    readonly state: string;
    readonly error: boolean;
    readonly channelId: string | null;
    readonly positionSeconds: number | null;
    readonly durationSeconds: number | null;
    readonly isLive: boolean | null;
}

export type RokuKey = 'Play' | 'Home';

function tag(xml: string, name: string): string | null {
    const match = new RegExp(`<${name}>([^<]*)</${name}>`, 'i').exec(xml);
    return match ? match[1].trim() : null;
}

function milliseconds(value: string | null): number | null {
    const amount = value ? Number.parseInt(value, 10) : Number.NaN;
    return Number.isFinite(amount) && amount > 0 ? amount / 1000 : null;
}

export function parseRokuDeviceInfo(xml: string): RokuDeviceInfo {
    return {
        name: tag(xml, 'user-device-name') || tag(xml, 'friendly-device-name'),
        model: tag(xml, 'model-name'),
        isTv: tag(xml, 'is-tv') === 'true',
    };
}

export function parseRokuMediaPlayer(xml: string): RokuPlayerState {
    const player = /<player\b[^>]*>/i.exec(xml)?.[0] ?? '';
    const live = tag(xml, 'is_live');
    return {
        state: /\bstate="([^"]*)"/i.exec(player)?.[1] ?? 'none',
        error: /\berror="true"/i.test(player),
        channelId: /<plugin\b[^>]*\bid="([^"]*)"/i.exec(xml)?.[1] ?? null,
        positionSeconds: milliseconds(tag(xml, 'position')),
        durationSeconds: milliseconds(tag(xml, 'duration')),
        isLive: live === null ? null : live === 'true',
    };
}

const VIDEO_FORMATS: ReadonlyArray<[RegExp, string]> = [
    [/mpegurl/i, 'hls'],
    [/dash\+xml/i, 'dash'],
    [/mp4|m4v/i, 'mp4'],
    [/quicktime/i, 'mov'],
    [/matroska/i, 'mkv'],
];

const VIDEO_FORMATS_BY_EXTENSION: Readonly<Record<string, string>> = {
    m3u8: 'hls',
    mpd: 'dash',
    mp4: 'mp4',
    m4v: 'mp4',
    mov: 'mov',
    mkv: 'mkv',
};

/** Roku's `videoFormat` hint; omitted when unknown so the player sniffs. */
export function rokuVideoFormat(media: CastMediaRequest): string | null {
    if (media.contentType) {
        const known = VIDEO_FORMATS.find(([pattern]) =>
            pattern.test(media.contentType ?? '')
        );
        if (known) return known[1];
    }
    const path = new URL(media.url).pathname;
    const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    return (
        VIDEO_FORMATS_BY_EXTENSION[extension] ?? (media.isLive ? 'hls' : null)
    );
}

/**
 * External Control Protocol client for one device, at an address the
 * backend found by SSDP itself. Plain HTTP on the local network.
 */
export class RokuEcpClient {
    constructor(
        private readonly baseUrl: string,
        private readonly fetchImpl: typeof fetch = fetch,
        private readonly timeoutMs = DEFAULT_TIMEOUT_MS
    ) {}

    async deviceInfo(): Promise<RokuDeviceInfo> {
        return parseRokuDeviceInfo(await this.read('query/device-info'));
    }

    async mediaPlayer(): Promise<RokuPlayerState> {
        return parseRokuMediaPlayer(await this.read('query/media-player'));
    }

    /** Opens the URL in "Play on Roku", replacing whatever plays there. */
    async playUrl(media: CastMediaRequest): Promise<void> {
        const params = new URLSearchParams({ t: 'v', u: media.url });
        if (media.title) params.set('videoName', media.title);
        const format = rokuVideoFormat(media);
        if (format) params.set('videoFormat', format);
        if (media.thumbnail) params.set('k', media.thumbnail);
        await this.send(`input/${PLAY_ON_ROKU_CHANNEL}?${params.toString()}`);
    }

    async keypress(key: RokuKey): Promise<void> {
        await this.send(`keypress/${key}`);
    }

    private async read(path: string): Promise<string> {
        const response = await this.request(path, 'GET');
        return response.text();
    }

    private async send(path: string): Promise<void> {
        const response = await this.request(path, 'POST');
        await response.body?.cancel();
    }

    private async request(path: string, method: string): Promise<Response> {
        const response = await this.fetchImpl(new URL(path, this.baseUrl), {
            method,
            redirect: 'error',
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.status === 401 || response.status === 403) {
            await response.body?.cancel();
            throw new RokuControlBlockedError();
        }
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Roku answered ${response.status}`);
        }
        return response;
    }
}
