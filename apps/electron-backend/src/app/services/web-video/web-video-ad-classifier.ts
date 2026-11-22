import type {
    WebVideoKind,
    WebVideoSignal,
    WebVideoVerdict,
} from '@iptvnator/shared/interfaces';
import { hostMatches } from './web-video-media';

/**
 * Video ad servers, ad CDNs and outstream ad players. A stream served from,
 * or loaded inside a frame from, one of these is an ad.
 */
const AD_HOSTS = [
    '2mdn.net',
    'adform.net',
    'adnxs.com',
    'adsrvr.org',
    'adskeeper.com',
    'adsterra.com',
    'adtelligent.com',
    'advertising.com',
    'amazon-adsystem.com',
    'aniview.com',
    'connatix.com',
    'criteo.com',
    'doubleclick.net',
    'exoclick.com',
    'exosrv.com',
    'freewheel.tv',
    'fwmrm.net',
    'googleadservices.com',
    'googlesyndication.com',
    'imasdk.googleapis.com',
    'innovid.com',
    'juicyads.com',
    'mgid.com',
    'moatads.com',
    'openx.net',
    'outbrain.com',
    'popads.net',
    'primis.tech',
    'propellerads.com',
    'pubmatic.com',
    'rubiconproject.com',
    'serving-sys.com',
    'sizmek.com',
    'smartadserver.com',
    'spotx.tv',
    'spotxchange.com',
    'springserve.com',
    'taboola.com',
    'teads.tv',
    'trafficjunky.net',
    'tremorhub.com',
    'unrulymedia.com',
    'vidoomy.com',
    'yieldmo.com',
];

/** Path tokens of ad creatives; whole tokens only, so `load` or `head` pass. */
const AD_PATH_TOKEN =
    /(?:^|[/_.-])(?:ads?|adserver|adunit|adverts?|advertising|vast|vmap|vpaid|preroll|midroll|postroll|sponsored|commercials?)(?=[/_.-]|$)/i;

/** Ad-request parameters (VAST tags, Google Ad Manager). */
const AD_QUERY =
    /[?&](?:vast|vmap|adunit|ad_type|adtag|iu|correlator|ad_rule)=/i;

const SHORT_CLIP_SECONDS = 45;
const LONG_FORM_SECONDS = 180;
const MAIN_PLAYER_MIN_WIDTH = 320;
const MAIN_PLAYER_MIN_HEIGHT = 180;
const LARGE_FILE_BYTES = 30 * 1024 * 1024;
const AD_THRESHOLD = 3;

export interface VideoElementEvidence {
    readonly width: number;
    readonly height: number;
    readonly loop: boolean;
    readonly muted: boolean;
}

export interface WebVideoEvidence {
    readonly url: URL;
    readonly kind: WebVideoKind;
    /** Frame that requested or rendered the stream, when known. */
    readonly frameUrl: URL | null;
    /** The video element playing this stream, or the largest in its frame. */
    readonly element: VideoElementEvidence | null;
    readonly fromPageMetadata: boolean;
    readonly isLive: boolean | null;
    readonly durationSeconds: number | null;
    readonly variantCount: number | null;
    readonly sizeBytes: number | null;
}

export interface WebVideoClassification {
    readonly verdict: WebVideoVerdict;
    readonly signals: readonly WebVideoSignal[];
    /** Positive leans ad, negative leans main video. */
    readonly score: number;
}

export function isAdHost(host: string): boolean {
    return AD_HOSTS.some((suffix) => hostMatches(host, suffix));
}

function isMainPlayer(element: VideoElementEvidence | null): boolean {
    return (
        !!element &&
        !element.loop &&
        element.width >= MAIN_PLAYER_MIN_WIDTH &&
        element.height >= MAIN_PLAYER_MIN_HEIGHT
    );
}

function isBackgroundLoop(element: VideoElementEvidence | null): boolean {
    return !!element && element.loop && element.muted;
}

/**
 * Scores one stream from where it came from and what it looks like. No
 * single weak hint (a short clip, a looping element) makes an ad on its own;
 * a known ad server or ad frame does.
 */
export function classifyWebVideo(e: WebVideoEvidence): WebVideoClassification {
    const signals: Array<[WebVideoSignal, number]> = [];
    const add = (signal: WebVideoSignal, weight: number) =>
        signals.push([signal, weight]);

    if (isAdHost(e.url.hostname)) add('ad-network', 5);
    if (e.frameUrl && isAdHost(e.frameUrl.hostname)) add('ad-frame', 4);
    if (AD_PATH_TOKEN.test(e.url.pathname) || AD_QUERY.test(e.url.search)) {
        add('ad-path', 3);
    }
    const shortClip =
        e.isLive !== true &&
        e.durationSeconds !== null &&
        e.durationSeconds <= SHORT_CLIP_SECONDS;
    if (shortClip) add('short-clip', 2);
    if (isBackgroundLoop(e.element)) add('background-loop', 2);

    if (isMainPlayer(e.element)) add('main-player', -2);
    if (e.fromPageMetadata) add('page-metadata', -2);
    if ((e.variantCount ?? 0) > 1) add('adaptive', -2);
    if (e.isLive === true) add('live', -3);
    const longForm =
        (e.durationSeconds ?? 0) >= LONG_FORM_SECONDS ||
        (e.sizeBytes ?? 0) >= LARGE_FILE_BYTES;
    if (longForm && e.isLive !== true) add('long-form', -3);

    const score = signals.reduce((total, [, weight]) => total + weight, 0);
    const verdict: WebVideoVerdict = score >= AD_THRESHOLD ? 'ad' : 'video';
    // Lead with the evidence that agrees with the verdict.
    const ordered = [...signals].sort(([, left], [, right]) =>
        verdict === 'ad' ? right - left : left - right
    );
    return { verdict, signals: ordered.map(([signal]) => signal), score };
}
