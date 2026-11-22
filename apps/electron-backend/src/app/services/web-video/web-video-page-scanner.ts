import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { WebVideoKind } from '@iptvnator/shared/interfaces';
import {
    session as electronSession,
    type WebContents,
    WebContentsView,
    type WebFrameMain,
} from 'electron';
import {
    isLocalHostname,
    isPrivateNetworkUrlAccessAllowed,
    isPrivateOrReservedIp,
} from '../../events/url-safety';
import {
    COLLECT_VIDEOS_SCRIPT,
    type FrameVideoReport,
    parseFrameVideoReport,
} from './web-video-dom-report';
import {
    mediaKindFromContentType,
    mediaKindFromUrl,
    sourceKey,
} from './web-video-media';

export interface ObservedMediaRequest {
    readonly url: string;
    readonly kind: WebVideoKind;
    readonly frameUrl: string | null;
    readonly status: number | null;
    readonly sizeBytes: number | null;
}

export interface PageObservation {
    readonly finalUrl: string;
    readonly title: string | null;
    readonly thumbnail: string | null;
    readonly requests: readonly ObservedMediaRequest[];
    readonly frames: readonly FrameVideoReport[];
}

export class WebPageScanError extends Error {
    constructor(readonly code: 'load-failed' | 'cancelled') {
        super(`Web page scan ${code}`);
        this.name = 'WebPageScanError';
    }
}

export interface WebPageScanOptions {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly settleMs?: number;
}

const VIEWPORT = { x: 0, y: 0, width: 1280, height: 720 };
/**
 * An unattached view renders at 0×0, which hides lazy players and leaves
 * nothing to click; device emulation gives the page a desktop viewport.
 * It must be applied once the document exists: before the first load it
 * stalls the navigation.
 */
const EMULATION: Electron.Parameters = {
    screenPosition: 'desktop',
    screenSize: { width: VIEWPORT.width, height: VIEWPORT.height },
    viewPosition: { x: 0, y: 0 },
    deviceScaleFactor: 1,
    viewSize: { width: VIEWPORT.width, height: VIEWPORT.height },
    scale: 1,
};
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SETTLE_MS = 3_500;
/** Players often start a beat after `load`; never stop sooner than this. */
const MIN_AFTER_LOAD_MS = 2_500;
/** Without any stream by then, click the player once to start it. */
const CLICK_AFTER_LOAD_MS = 1_500;
const POLL_MS = 250;
const FRAME_SCRIPT_TIMEOUT_MS = 2_000;
const MAX_REQUESTS = 60;
const ERR_ABORTED = -3;
/** Pages, frames and code: never streams, whatever their path says. */
const DOCUMENT_TYPES = new Set([
    'mainFrame',
    'subFrame',
    'script',
    'stylesheet',
]);

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

function isHttpUrl(value: string): boolean {
    return /^https?:\/\//i.test(value);
}

/** The scan must not reach this machine or, by default, the LAN. */
function isBlockedHost(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (isLocalHostname(host)) {
        return true;
    }
    return (
        isIP(host) !== 0 &&
        isPrivateOrReservedIp(host) &&
        !isPrivateNetworkUrlAccessAllowed()
    );
}

function frameUrlOf(frame: WebFrameMain | null | undefined): string | null {
    try {
        return frame?.url || null;
    } catch {
        // The frame navigated or was destroyed after it made the request.
        return null;
    }
}

function header(
    headers: Record<string, string[]> | undefined,
    name: string
): string | undefined {
    const key = Object.keys(headers ?? {}).find(
        (candidate) => candidate.toLowerCase() === name
    );
    return key ? headers?.[key]?.[0] : undefined;
}

async function runInFrame(
    frame: WebFrameMain
): Promise<FrameVideoReport | null> {
    try {
        const raw = await Promise.race([
            frame.executeJavaScript(COLLECT_VIDEOS_SCRIPT),
            delay(FRAME_SCRIPT_TIMEOUT_MS).then(() => null),
        ]);
        return parseFrameVideoReport(raw, frameUrlOf(frame) ?? '');
    } catch {
        return null;
    }
}

/**
 * Opens `pageUrl` in a muted, offscreen view with its own in-memory session
 * and records the video streams it loads. Popups, downloads, permission
 * prompts, dialogs, images, fonts, stream segments and requests to this
 * machine are refused; once loaded, the page cannot navigate away.
 */
export async function scanWebPage(
    pageUrl: string,
    options: WebPageScanOptions = {}
): Promise<PageObservation> {
    const ses = electronSession.fromPartition(
        `web-video-scan-${randomUUID()}`,
        {
            cache: false,
        }
    );
    ses.setPermissionRequestHandler((_wc, _permission, done) => done(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (event) => event.preventDefault());

    const requests = new Map<string, ObservedMediaRequest>();
    let lastFindingAt = 0;
    const record = (entry: ObservedMediaRequest) => {
        let key: string;
        try {
            key = sourceKey(new URL(entry.url));
        } catch {
            return;
        }
        const previous = requests.get(key);
        if (!previous && requests.size >= MAX_REQUESTS) {
            return;
        }
        requests.set(key, {
            ...entry,
            frameUrl: entry.frameUrl ?? previous?.frameUrl ?? null,
            status: entry.status ?? previous?.status ?? null,
            sizeBytes: entry.sizeBytes ?? previous?.sizeBytes ?? null,
        });
        if (!previous) {
            lastFindingAt = Date.now();
        }
    };

    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, done) => {
        let url: URL;
        try {
            url = new URL(details.url);
        } catch {
            done({ cancel: true });
            return;
        }
        if (DOCUMENT_TYPES.has(details.resourceType)) {
            done(isBlockedHost(url.hostname) ? { cancel: true } : {});
            return;
        }
        const kind = mediaKindFromUrl(url);
        if (
            isBlockedHost(url.hostname) ||
            details.resourceType === 'image' ||
            details.resourceType === 'font' ||
            kind === 'segment'
        ) {
            done({ cancel: true });
            return;
        }
        if (kind) {
            record({
                url: details.url,
                kind,
                frameUrl: frameUrlOf(details.frame),
                status: null,
                sizeBytes: null,
            });
        }
        done({});
    });
    ses.webRequest.onResponseStarted({ urls: ['*://*/*'] }, (details) => {
        if (DOCUMENT_TYPES.has(details.resourceType)) return;
        const type = header(details.responseHeaders, 'content-type');
        const byType = mediaKindFromContentType(type);
        // A typed non-media answer (HTML, JSON, XML) is not a stream, even
        // under a `.mp4`-looking path; untyped answers keep the path's word.
        if (type && !byType && !/octet-stream/i.test(type)) return;
        const kind = byType ?? mediaKindFromUrl(new URL(details.url));
        if (!kind || kind === 'segment' || details.statusCode >= 400) {
            return;
        }
        const length = Number(
            header(details.responseHeaders, 'content-length')
        );
        record({
            url: details.url,
            kind,
            frameUrl: frameUrlOf(details.frame),
            status: details.statusCode,
            sizeBytes: Number.isFinite(length) && length > 0 ? length : null,
        });
    });

    const view = new WebContentsView({
        webPreferences: {
            session: ses,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: false,
            offscreen: true,
            backgroundThrottling: false,
            autoplayPolicy: 'no-user-gesture-required',
            disableDialogs: true,
            spellcheck: false,
        },
    });
    const wc = view.webContents;
    view.setBounds(VIEWPORT);

    try {
        return await drivePage(wc, pageUrl, ses.getUserAgent(), {
            options,
            requests,
            lastFindingAt: () => lastFindingAt,
            markFinding: () => (lastFindingAt = Date.now()),
        });
    } finally {
        ses.webRequest.onBeforeRequest(null);
        ses.webRequest.onResponseStarted(null);
        if (!wc.isDestroyed()) {
            wc.close();
        }
        void ses.clearStorageData().catch(() => undefined);
    }
}

interface DriveState {
    readonly options: WebPageScanOptions;
    readonly requests: Map<string, ObservedMediaRequest>;
    readonly lastFindingAt: () => number;
    readonly markFinding: () => void;
}

async function drivePage(
    wc: WebContents,
    pageUrl: string,
    userAgent: string,
    state: DriveState
): Promise<PageObservation> {
    const { signal } = state.options;
    const timeoutMs = state.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const settleMs = state.options.settleMs ?? DEFAULT_SETTLE_MS;
    let loadedAt = 0;
    let failed = false;
    let clicked = false;
    let frames: FrameVideoReport[] = [];

    wc.setAudioMuted(true);
    wc.setFrameRate(5);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guard = (event: Electron.Event, url: string) => {
        if (loadedAt > 0 || !isHttpUrl(url)) event.preventDefault();
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('dom-ready', () => wc.enableDeviceEmulation(EMULATION));
    wc.on('did-finish-load', () => {
        loadedAt ||= Date.now();
    });
    wc.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
        if (isMainFrame && code !== ERR_ABORTED && loadedAt === 0)
            failed = true;
    });

    // A browser user agent: some sites refuse the default Electron one.
    const browserAgent = userAgent.replace(
        /\s(?:Electron|iptvnator)\/\S+/gi,
        ''
    );
    void wc
        .loadURL(pageUrl, { userAgent: browserAgent })
        .catch(() => undefined);

    const collect = async () => {
        const reports = await Promise.all(
            wc.mainFrame.framesInSubtree.map((frame) => runInFrame(frame))
        );
        frames = reports.filter(
            (report): report is FrameVideoReport => !!report
        );
        if (frames.some((frame) => frame.videos.length > 0))
            state.markFinding();
    };

    const started = Date.now();
    let collectedOnce = false;
    for (;;) {
        if (signal?.aborted) throw new WebPageScanError('cancelled');
        if (failed && state.requests.size === 0)
            throw new WebPageScanError('load-failed');
        const now = Date.now();
        if (now - started >= timeoutMs) break;
        if (loadedAt > 0) {
            if (!collectedOnce) {
                collectedOnce = true;
                await collect();
            }
            if (
                !clicked &&
                state.requests.size === 0 &&
                now - loadedAt >= CLICK_AFTER_LOAD_MS
            ) {
                clicked = true;
                clickPlayer(wc, frames);
                state.markFinding();
            }
            const quietFor = now - Math.max(state.lastFindingAt(), loadedAt);
            if (now - loadedAt >= MIN_AFTER_LOAD_MS && quietFor >= settleMs)
                break;
        }
        await delay(POLL_MS);
    }
    if (loadedAt === 0 && state.requests.size === 0) {
        throw new WebPageScanError('load-failed');
    }
    await collect();

    const main = frames.find((frame) => frame.isTopFrame);
    return {
        finalUrl: wc.getURL() || pageUrl,
        title: main?.title ?? (wc.getTitle() || null),
        thumbnail: main?.image ?? null,
        requests: [...state.requests.values()],
        frames,
    };
}

/**
 * Clicks whatever covers the biggest top-frame video (or the viewport
 * centre), once, to start click-to-play players. Offscreen views do not take
 * synthetic mouse input, so the click is dispatched from inside the page.
 */
function clickPlayer(
    wc: WebContents,
    frames: readonly FrameVideoReport[]
): void {
    const target = frames
        .filter((frame) => frame.isTopFrame)
        .flatMap((frame) => frame.videos)
        .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const x = Math.round(
        target ? target.x + target.width / 2 : VIEWPORT.width / 2
    );
    const y = Math.round(
        target ? target.y + target.height / 2 : VIEWPORT.height / 2
    );
    void wc.mainFrame
        .executeJavaScript(
            `(() => { const el = document.elementFromPoint(${x}, ${y}); if (el && typeof el.click === 'function') el.click(); })()`
        )
        .catch(() => undefined);
}
