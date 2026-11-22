import type { WebVideoKind } from '@iptvnator/shared/interfaces';
import type { VideoElementEvidence } from './web-video-ad-classifier';
import type {
    FrameVideoElement,
    FrameVideoReport,
} from './web-video-dom-report';
import { mediaKindFromUrl, sourceKey } from './web-video-media';
import type { PageObservation } from './web-video-page-scanner';

export interface WebVideoCandidate {
    readonly key: string;
    readonly url: URL;
    readonly kind: WebVideoKind;
    readonly frameUrl: URL | null;
    readonly element:
        | (VideoElementEvidence & {
              durationSeconds: number | null;
              videoHeight: number;
          })
        | null;
    readonly fromPageMetadata: boolean;
    readonly sizeBytes: number | null;
}

/** Keeps the list readable and the probing bounded. */
export const MAX_CANDIDATES = 20;

function parse(value: string | null | undefined): URL | null {
    if (!value) return null;
    try {
        return new URL(value);
    } catch {
        return null;
    }
}

function area(video: FrameVideoElement): number {
    return video.width * video.height;
}

function toEvidence(video: FrameVideoElement | undefined) {
    return video
        ? {
              width: video.width,
              height: video.height,
              loop: video.loop,
              muted: video.muted,
              durationSeconds: video.durationSeconds,
              videoHeight: video.videoHeight,
          }
        : null;
}

/**
 * The element playing a stream: one listing its URL, else, for adaptive
 * streams played through MSE (the element only shows a `blob:` URL), the
 * largest video in the frame that requested it.
 */
function elementFor(
    url: URL,
    kind: WebVideoKind,
    frame: FrameVideoReport | undefined
) {
    if (!frame) return null;
    const href = url.toString();
    const direct = frame.videos.find((video) => video.srcs.includes(href));
    if (direct) return toEvidence(direct);
    if (kind !== 'hls' && kind !== 'dash') return null;
    return toEvidence([...frame.videos].sort((a, b) => area(b) - area(a))[0]);
}

function priority(candidate: WebVideoCandidate): number {
    if (candidate.fromPageMetadata || candidate.element) return 0;
    if (candidate.kind === 'hls' || candidate.kind === 'dash') return 1;
    return 2;
}

/**
 * Merges the network requests, `<video>` sources and metadata tags of a scan
 * into one list of distinct streams, most informative first.
 */
export function gatherWebVideoCandidates(
    observation: PageObservation
): WebVideoCandidate[] {
    const frames = observation.frames;
    const topFrame = frames.find((frame) => frame.isTopFrame);
    const frameFor = (frameUrl: string | null) =>
        frameUrl
            ? frames.find((frame) => frame.frameUrl === frameUrl)
            : topFrame;
    const merged = new Map<string, WebVideoCandidate>();

    const add = (
        rawUrl: string,
        kind: WebVideoKind | null,
        extra: Partial<Omit<WebVideoCandidate, 'key' | 'url' | 'kind'>>
    ) => {
        const url = parse(rawUrl);
        const detected = url ? mediaKindFromUrl(url) : null;
        if (!url || detected === 'segment') return;
        const key = sourceKey(url);
        const previous = merged.get(key);
        const resolvedKind = kind ?? detected ?? previous?.kind ?? 'other';
        merged.set(key, {
            key,
            url,
            kind:
                previous && previous.kind !== 'other'
                    ? previous.kind
                    : resolvedKind,
            frameUrl: previous?.frameUrl ?? extra.frameUrl ?? null,
            element: previous?.element ?? extra.element ?? null,
            fromPageMetadata: !!(
                previous?.fromPageMetadata || extra.fromPageMetadata
            ),
            sizeBytes: previous?.sizeBytes ?? extra.sizeBytes ?? null,
        });
    };

    for (const request of observation.requests) {
        const url = parse(request.url);
        if (!url) continue;
        add(request.url, request.kind, {
            frameUrl: parse(request.frameUrl),
            element: elementFor(url, request.kind, frameFor(request.frameUrl)),
            sizeBytes: request.sizeBytes,
        });
    }
    for (const frame of frames) {
        for (const video of frame.videos) {
            for (const src of video.srcs) {
                add(src, null, {
                    frameUrl: parse(frame.frameUrl),
                    element: toEvidence(video),
                });
            }
        }
        for (const meta of frame.metaVideos) {
            add(meta, null, {
                frameUrl: parse(frame.frameUrl),
                fromPageMetadata: true,
            });
        }
    }

    return [...merged.values()]
        .sort((a, b) => priority(a) - priority(b))
        .slice(0, MAX_CANDIDATES);
}
