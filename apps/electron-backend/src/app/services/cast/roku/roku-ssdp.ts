/**
 * SSDP (UPnP discovery) for Roku devices: an `M-SEARCH` for `roku:ecp` and a
 * parser for the HTTP-over-UDP answers, which carry the device's External
 * Control Protocol base URL.
 */

export const SSDP_ADDRESS = '239.255.255.250';
export const SSDP_PORT = 1900;
export const ROKU_ECP_PORT = 8060;

export interface RokuEndpoint {
    /** Stable per device: the serial number from the USN. */
    readonly id: string;
    readonly host: string;
    readonly port: number;
}

export function encodeRokuSearch(): Buffer {
    return Buffer.from(
        [
            'M-SEARCH * HTTP/1.1',
            `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
            'MAN: "ssdp:discover"',
            'ST: roku:ecp',
            'MX: 2',
            '',
            '',
        ].join('\r\n'),
        'ascii'
    );
}

export function parseSsdpHeaders(text: string): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const line of text.split(/\r?\n/).slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) {
            headers[line.slice(0, colon).trim().toLowerCase()] = line
                .slice(colon + 1)
                .trim();
        }
    }
    return headers;
}

/**
 * The endpoint a `roku:ecp` answer points at. The answer must come from the
 * host it names: a spoofed `LOCATION` elsewhere falls back to the
 * responder's own address and the standard port, so a reply can never steer
 * the main process to an arbitrary host.
 */
export function rokuEndpointFromResponse(
    text: string,
    sourceAddress: string
): RokuEndpoint | null {
    const headers = parseSsdpHeaders(text);
    const usn = headers['usn'] ?? '';
    if (!/roku:ecp/i.test(`${headers['st'] ?? ''} ${usn}`)) {
        return null;
    }
    let port = ROKU_ECP_PORT;
    try {
        const location = new URL(headers['location'] ?? '');
        if (location.hostname === sourceAddress && location.port) {
            port = Number(location.port);
        }
    } catch {
        // Keep the standard port.
    }
    const serial = /roku:ecp:([\w-]+)/i.exec(usn)?.[1];
    return {
        id: `roku:${serial ?? sourceAddress}`,
        host: sourceAddress,
        port,
    };
}
