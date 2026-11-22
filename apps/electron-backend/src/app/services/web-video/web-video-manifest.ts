/**
 * Small, tolerant readers for HLS playlists and DASH manifests: enough to
 * label a stream (quality, length, live) and to spot stitched-in ads or DRM.
 */

export interface ManifestSummary {
    readonly isLive: boolean | null;
    readonly durationSeconds: number | null;
    readonly height: number | null;
    readonly variantCount: number | null;
    /** Absolute URLs of the variant playlists of an HLS master playlist. */
    readonly variantUrls: readonly string[];
    readonly embeddedAds: boolean;
    readonly drm: boolean;
}

const HLS_AD_MARKERS =
    /#EXT-X-CUE-OUT|#EXT-OATCLS-SCTE35|#EXT-X-SCTE35|com\.apple\.hls\.interstitial/i;

function resolve(uri: string, base: string): string | null {
    try {
        return new URL(uri, base).toString();
    } catch {
        return null;
    }
}

function attribute(line: string, name: string): string | null {
    const match = new RegExp(`(?:^|[:,])${name}=("[^"]*"|[^,]*)`, 'i').exec(
        line
    );
    return match ? match[1].replace(/^"|"$/g, '') : null;
}

export function parseHlsPlaylist(
    text: string,
    baseUrl: string
): ManifestSummary {
    const lines = text.split(/\r?\n/).map((line) => line.trim());
    const embeddedAds = HLS_AD_MARKERS.test(text);
    const drm = false;
    const variantUrls: string[] = [];
    let height: number | null = null;

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.startsWith('#EXT-X-STREAM-INF')) {
            continue;
        }
        const resolution = attribute(line, 'RESOLUTION');
        const rows = Number(resolution?.split('x')[1]);
        if (Number.isFinite(rows) && rows > 0) {
            height = Math.max(height ?? 0, rows);
        }
        const uri = lines
            .slice(index + 1)
            .find((next) => next && !next.startsWith('#'));
        const absolute = uri ? resolve(uri, baseUrl) : null;
        if (absolute) {
            variantUrls.push(absolute);
        }
    }

    if (variantUrls.length > 0) {
        return {
            isLive: null,
            durationSeconds: null,
            height,
            variantCount: variantUrls.length,
            variantUrls,
            embeddedAds,
            drm,
        };
    }

    let duration = 0;
    for (const line of lines) {
        if (line.startsWith('#EXTINF:')) {
            duration += Number.parseFloat(line.slice(8)) || 0;
        }
    }
    const ended =
        /#EXT-X-ENDLIST/.test(text) || /#EXT-X-PLAYLIST-TYPE:VOD/i.test(text);
    return {
        isLive: !ended,
        durationSeconds: ended && duration > 0 ? Math.round(duration) : null,
        height: null,
        variantCount: null,
        variantUrls: [],
        embeddedAds,
        drm,
    };
}

/** ISO 8601 durations as DASH writes them, e.g. `PT1H2M3.5S`. */
export function parseIsoDuration(value: string | null): number | null {
    const match = value
        ? /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
              value.trim()
          )
        : null;
    if (!match) {
        return null;
    }
    const [, days, hours, minutes, seconds] = match.map((part) =>
        part === undefined ? 0 : Number(part)
    );
    const total = days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
    return total > 0 ? Math.round(total) : null;
}

export function parseDashManifest(text: string): ManifestSummary {
    const mpd = /<MPD\b[^>]*>/i.exec(text)?.[0] ?? '';
    const isLive = /\btype\s*=\s*"dynamic"/i.test(mpd);
    const duration = parseIsoDuration(
        /\bmediaPresentationDuration\s*=\s*"([^"]+)"/i.exec(mpd)?.[1] ?? null
    );
    const heights = [
        ...text.matchAll(/<Representation\b[^>]*\bheight\s*=\s*"(\d+)"/gi),
    ]
        .map((match) => Number(match[1]))
        .filter((value) => value > 0);
    return {
        isLive,
        durationSeconds: isLive ? null : duration,
        height: heights.length > 0 ? Math.max(...heights) : null,
        variantCount: heights.length > 0 ? heights.length : null,
        variantUrls: [],
        embeddedAds: false,
        drm: /<ContentProtection\b/i.test(text),
    };
}
