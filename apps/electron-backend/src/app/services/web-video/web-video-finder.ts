import type {
    WebVideoKind,
    WebVideoScanError,
    WebVideoScanResult,
    WebVideoSource,
} from '@iptvnator/shared/interfaces';
import {
    assertRemoteUrlAllowed,
    isPrivateNetworkUrlAccessAllowed,
} from '../../events/url-safety';
import { classifyWebVideo } from './web-video-ad-classifier';
import {
    gatherWebVideoCandidates,
    type WebVideoCandidate,
} from './web-video-candidates';
import {
    isUnsupportedSite,
    mediaKindFromContentType,
    mediaKindFromUrl,
    qualityFromUrl,
    sourceKey,
} from './web-video-media';
import {
    type PageObservation,
    scanWebPage,
    type WebPageScanOptions,
    WebPageScanError,
} from './web-video-page-scanner';
import {
    fetchContentType,
    probeWebVideo,
    type WebVideoProbe,
} from './web-video-probe';

export interface WebVideoFinderDeps {
    readonly scan?: (
        url: string,
        options: WebPageScanOptions
    ) => Promise<PageObservation>;
    readonly probe?: (
        url: string,
        kind: WebVideoKind
    ) => Promise<WebVideoProbe>;
    readonly validate?: (url: string) => Promise<URL>;
    readonly contentType?: (url: string) => Promise<string | null>;
    readonly signal?: AbortSignal;
}

const PROBE_CONCURRENCY = 4;
const CASTABILITY_ORDER = [
    'likely',
    'unknown',
    'no-cors',
    'needs-headers',
    'drm',
];

function failure(
    pageUrl: string,
    error: WebVideoScanError
): WebVideoScanResult {
    return { pageUrl, title: null, thumbnail: null, sources: [], error };
}

/**
 * A pasted link is a stream itself when its path says so and the server does
 * not answer with a web page (`/wiki/File:Clip.webm` is a page). An
 * unreadable answer keeps the path's word: such streams often need headers.
 */
async function directMediaKind(
    url: URL,
    contentType: (url: string) => Promise<string | null>
): Promise<WebVideoKind | null> {
    const byPath = mediaKindFromUrl(url);
    if (!byPath || byPath === 'segment') return null;
    const type = await contentType(url.toString());
    if (type === null) return byPath;
    const byType = mediaKindFromContentType(type);
    if (byType && byType !== 'segment') return byType;
    return /octet-stream/i.test(type) ? byPath : null;
}

/** Accepts `example.com/watch` as well as full http(s) URLs. */
function parsePageUrl(value: unknown): URL | null {
    if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
        return null;
    }
    const trimmed = value.trim();
    const withScheme = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
        ? trimmed
        : `https://${trimmed}`;
    try {
        const url = new URL(withScheme);
        return url.protocol === 'http:' || url.protocol === 'https:'
            ? url
            : null;
    } catch {
        return null;
    }
}

async function mapLimited<T, R>(
    items: readonly T[],
    limit: number,
    run: (item: T) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await run(items[index]);
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, worker)
    );
    return results;
}

interface ScoredSource {
    readonly source: WebVideoSource;
    readonly score: number;
}

function toSource(
    candidate: WebVideoCandidate,
    probe: WebVideoProbe,
    index: number
): ScoredSource {
    const durationSeconds =
        probe.durationSeconds ?? candidate.element?.durationSeconds ?? null;
    const sizeBytes = probe.sizeBytes ?? candidate.sizeBytes;
    const classification = classifyWebVideo({
        url: candidate.url,
        kind: candidate.kind,
        frameUrl: candidate.frameUrl,
        element: candidate.element,
        fromPageMetadata: candidate.fromPageMetadata,
        isLive: probe.isLive,
        durationSeconds,
        variantCount: probe.variantCount,
        sizeBytes,
    });
    return {
        score: classification.score,
        source: {
            id: `source-${index + 1}`,
            url: candidate.url.toString(),
            kind: candidate.kind,
            verdict: classification.verdict,
            signals: classification.signals,
            host: candidate.url.hostname,
            isLive: probe.isLive,
            durationSeconds,
            height:
                probe.height ??
                (candidate.element?.videoHeight || null) ??
                qualityFromUrl(candidate.url),
            variantCount: probe.variantCount,
            sizeBytes,
            castability: probe.castability,
            embeddedAds: probe.embeddedAds,
        },
    };
}

/** Main videos first (most confident, castable, sharpest, longest), ads last. */
export function rankWebVideoSources(
    scored: readonly ScoredSource[]
): WebVideoSource[] {
    return [...scored]
        .sort(
            ({ source: a, score: left }, { source: b, score: right }) =>
                Number(a.verdict === 'ad') - Number(b.verdict === 'ad') ||
                left - right ||
                CASTABILITY_ORDER.indexOf(a.castability) -
                    CASTABILITY_ORDER.indexOf(b.castability) ||
                (b.height ?? 0) - (a.height ?? 0) ||
                (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0)
        )
        .map(({ source }) => source);
}

/**
 * Finds the videos behind a pasted link. A direct stream URL is probed as
 * is; a web page is opened offscreen first. Never rejects.
 */
export async function findWebVideos(
    rawUrl: unknown,
    deps: WebVideoFinderDeps = {}
): Promise<WebVideoScanResult> {
    const url = parsePageUrl(rawUrl);
    if (!url)
        return failure(typeof rawUrl === 'string' ? rawUrl : '', 'invalid-url');
    const pageUrl = url.toString();
    if (isUnsupportedSite(url)) return failure(pageUrl, 'unsupported-site');
    const validate =
        deps.validate ??
        ((value: string) =>
            assertRemoteUrlAllowed(value, {
                allowPrivateNetworks: isPrivateNetworkUrlAccessAllowed(),
            }));
    try {
        await validate(pageUrl);
    } catch {
        return failure(pageUrl, 'blocked-url');
    }

    const direct = await directMediaKind(
        url,
        deps.contentType ?? fetchContentType
    );
    let observation: PageObservation;
    if (direct) {
        observation = {
            finalUrl: pageUrl,
            title: null,
            thumbnail: null,
            requests: [
                {
                    url: pageUrl,
                    kind: direct,
                    frameUrl: null,
                    status: null,
                    sizeBytes: null,
                },
            ],
            frames: [],
        };
    } else {
        try {
            observation = await (deps.scan ?? scanWebPage)(pageUrl, {
                signal: deps.signal,
            });
        } catch (error) {
            const code =
                error instanceof WebPageScanError ? error.code : 'load-failed';
            return failure(pageUrl, code);
        }
    }

    const candidates = gatherWebVideoCandidates(observation);
    const base = {
        pageUrl: observation.finalUrl,
        title: observation.title,
        thumbnail: observation.thumbnail,
    };
    if (candidates.length === 0)
        return { ...base, sources: [], error: 'no-video' };

    const probe = deps.probe ?? probeWebVideo;
    const probes = await mapLimited(
        candidates,
        PROBE_CONCURRENCY,
        (candidate) => probe(candidate.url.toString(), candidate.kind)
    );
    if (deps.signal?.aborted) return failure(pageUrl, 'cancelled');

    // Variant playlists are listed through their master playlist.
    const variants = new Set(
        probes.flatMap((result) =>
            result.variantUrls.map((variant) => sourceKey(new URL(variant)))
        )
    );
    const sources = candidates
        .map((candidate, index) => ({ candidate, probe: probes[index] }))
        .filter(({ candidate }) => !variants.has(candidate.key))
        .map(({ candidate, probe: result }, index) =>
            toSource(candidate, result, index)
        );

    return { ...base, sources: rankWebVideoSources(sources) };
}
