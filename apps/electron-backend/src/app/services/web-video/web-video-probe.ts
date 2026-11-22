import type {
    WebVideoCastability,
    WebVideoKind,
} from '@iptvnator/shared/interfaces';
import {
    assertRemoteUrlAllowed,
    isPrivateNetworkUrlAccessAllowed,
} from '../../events/url-safety';
import {
    type ManifestSummary,
    parseDashManifest,
    parseHlsPlaylist,
} from './web-video-manifest';

export interface WebVideoProbe extends ManifestSummary {
    readonly castability: WebVideoCastability;
    readonly sizeBytes: number | null;
}

export interface WebVideoProbeDeps {
    readonly fetch?: typeof fetch;
    /** Rejects loopback/private targets; injectable for tests. */
    readonly validate?: (url: string) => Promise<URL>;
    readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 4_000;
const MAX_REDIRECTS = 3;
const MAX_MANIFEST_BYTES = 512 * 1024;
/** What a Chromecast sends; servers treat Node's default agent as a bot. */
const RECEIVER_USER_AGENT =
    'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/114.0.0.0 Safari/537.36 CrKey/1.56.500000';
/** Statuses a receiver gets when a stream needs the page's cookies/Referer. */
const REFUSED_STATUSES = new Set([401, 403, 410, 451]);

const EMPTY: ManifestSummary = {
    isLive: null,
    durationSeconds: null,
    height: null,
    variantCount: null,
    variantUrls: [],
    embeddedAds: false,
    drm: false,
};

function unknown(): WebVideoProbe {
    return { ...EMPTY, castability: 'unknown', sizeBytes: null };
}

function defaultValidate(url: string): Promise<URL> {
    return assertRemoteUrlAllowed(url, {
        allowPrivateNetworks: isPrivateNetworkUrlAccessAllowed(),
    });
}

/**
 * Fetches the way a receiver would: no cookies, no Referer. Every redirect
 * hop is validated, so a page cannot steer the main process to a private
 * address.
 */
async function receiverFetch(
    rawUrl: string,
    init: RequestInit,
    deps: Required<WebVideoProbeDeps>
): Promise<{ response: Response; url: string }> {
    let current = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        await deps.validate(current);
        const response = await deps.fetch(current, {
            ...init,
            headers: { 'User-Agent': RECEIVER_USER_AGENT, ...init.headers },
            redirect: 'manual',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            signal: AbortSignal.timeout(deps.timeoutMs),
        });
        const location = response.headers.get('location');
        if (response.status < 300 || response.status >= 400 || !location) {
            return { response, url: current };
        }
        await response.body?.cancel();
        current = new URL(location, current).toString();
    }
    throw new Error('Too many redirects');
}

async function readLimited(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) {
        return '';
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        chunks.push(value);
        received += value.byteLength;
        if (received >= MAX_MANIFEST_BYTES) {
            await reader.cancel();
            break;
        }
    }
    return Buffer.concat(chunks).toString('utf8');
}

function refusedOrUnknown(status: number): WebVideoProbe {
    return {
        ...EMPTY,
        castability: REFUSED_STATUSES.has(status) ? 'needs-headers' : 'unknown',
        sizeBytes: null,
    };
}

async function probeManifest(
    url: string,
    kind: 'hls' | 'dash',
    deps: Required<WebVideoProbeDeps>
): Promise<WebVideoProbe> {
    const { response, url: finalUrl } = await receiverFetch(
        url,
        { method: 'GET' },
        deps
    );
    if (!response.ok) {
        await response.body?.cancel();
        return refusedOrUnknown(response.status);
    }
    const cors = response.headers.has('access-control-allow-origin');
    const text = await readLimited(response);
    let summary =
        kind === 'hls'
            ? parseHlsPlaylist(text, finalUrl)
            : parseDashManifest(text);

    // A master playlist carries quality but not length: read one variant.
    if (kind === 'hls' && summary.variantUrls.length > 0) {
        try {
            const variant = await receiverFetch(
                summary.variantUrls[0],
                { method: 'GET' },
                deps
            );
            if (variant.response.ok) {
                const media = parseHlsPlaylist(
                    await readLimited(variant.response),
                    variant.url
                );
                summary = {
                    ...summary,
                    isLive: media.isLive,
                    durationSeconds: media.durationSeconds,
                    embeddedAds: summary.embeddedAds || media.embeddedAds,
                };
            } else {
                await variant.response.body?.cancel();
            }
        } catch {
            // Quality alone is still worth showing.
        }
    }

    const castability: WebVideoCastability = summary.drm
        ? 'drm'
        : cors
          ? 'likely'
          : 'no-cors';
    return { ...summary, castability, sizeBytes: null };
}

async function probeProgressive(
    url: string,
    deps: Required<WebVideoProbeDeps>
): Promise<WebVideoProbe> {
    const { response } = await receiverFetch(
        url,
        { method: 'GET', headers: { Range: 'bytes=0-1' } },
        deps
    );
    await response.body?.cancel();
    if (!response.ok) {
        return refusedOrUnknown(response.status);
    }
    if (/^text\//i.test(response.headers.get('content-type') ?? '')) {
        return unknown();
    }
    const range = response.headers.get('content-range');
    const total = range
        ? Number(range.split('/')[1])
        : Number(response.headers.get('content-length'));
    return {
        ...EMPTY,
        castability: 'likely',
        sizeBytes: Number.isFinite(total) && total > 2 ? total : null,
    };
}

function resolveDeps(deps: WebVideoProbeDeps): Required<WebVideoProbeDeps> {
    return {
        fetch: deps.fetch ?? fetch,
        validate: deps.validate ?? defaultValidate,
        timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
}

/**
 * The content type a link answers with, or `null` when it cannot be read.
 * Lets a pasted `…/File:Clip.webm` web page be told from the file itself.
 */
export async function fetchContentType(
    url: string,
    deps: WebVideoProbeDeps = {}
): Promise<string | null> {
    try {
        const { response } = await receiverFetch(
            url,
            { method: 'GET', headers: { Range: 'bytes=0-1' } },
            resolveDeps(deps)
        );
        await response.body?.cancel();
        return response.ok ? response.headers.get('content-type') : null;
    } catch {
        return null;
    }
}

/** Never rejects: a probe that cannot finish reports `unknown`. */
export async function probeWebVideo(
    url: string,
    kind: WebVideoKind,
    deps: WebVideoProbeDeps = {}
): Promise<WebVideoProbe> {
    const resolved = resolveDeps(deps);
    try {
        if (kind === 'hls' || kind === 'dash') {
            return await probeManifest(url, kind, resolved);
        }
        return await probeProgressive(url, resolved);
    } catch {
        return unknown();
    }
}
