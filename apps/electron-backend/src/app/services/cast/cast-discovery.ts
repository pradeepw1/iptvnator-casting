import * as dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';
import {
    type CastServiceRecord,
    encodeCastServiceQuery,
    extractCastServices,
    MDNS_ADDRESS,
    MDNS_PORT,
    parseMdnsResponse,
} from './mdns.codec';

export interface CastDiscoveryOptions {
    /** How long to collect answers. */
    readonly timeoutMs?: number;
    /** Injectable for tests. */
    readonly createSocket?: () => dgram.Socket;
    readonly listInterfaceAddresses?: () => string[];
}

const DEFAULT_TIMEOUT_MS = 2_500;
/** Multicast is lossy; one repeat catches most dropped first queries. */
const REQUERY_DELAY_MS = 900;

export function listIpv4InterfaceAddresses(): string[] {
    return Object.values(networkInterfaces())
        .flat()
        .filter(
            (entry): entry is NonNullable<typeof entry> =>
                !!entry && entry.family === 'IPv4' && !entry.internal
        )
        .map((entry) => entry.address);
}

function bindSocket(socket: dgram.Socket, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        socket.once('error', onError);
        socket.bind(port, () => {
            socket.off('error', onError);
            resolve();
        });
    });
}

/**
 * Sends a `_googlecast._tcp` query on every IPv4 interface and collects the
 * receivers that answer before the timeout. Binds to the mDNS port (shared
 * with the OS responder) to hear multicast answers; when that port is not
 * available it falls back to an ephemeral port, where receivers answer the
 * query by unicast instead.
 */
export async function discoverCastDevices(
    options: CastDiscoveryOptions = {}
): Promise<CastServiceRecord[]> {
    const createSocket =
        options.createSocket ??
        (() => dgram.createSocket({ type: 'udp4', reuseAddr: true }));
    const addresses = (
        options.listInterfaceAddresses ?? listIpv4InterfaceAddresses
    )();
    const found = new Map<string, CastServiceRecord>();

    let socket = createSocket();
    try {
        await bindSocket(socket, MDNS_PORT);
    } catch {
        socket.close();
        socket = createSocket();
        await bindSocket(socket, 0);
    }
    socket.on('error', () => undefined);
    socket.on('message', (packet, remote) => {
        const records = parseMdnsResponse(packet);
        for (const service of extractCastServices(records, remote.address)) {
            found.set(service.id, service);
        }
    });

    for (const address of addresses) {
        try {
            socket.addMembership(MDNS_ADDRESS, address);
        } catch {
            // Already joined, or the interface cannot do multicast.
        }
    }
    try {
        socket.setMulticastTTL(255);
    } catch {
        // Not fatal: the default TTL still reaches the local link.
    }

    const query = encodeCastServiceQuery();
    const sendQuery = () => {
        const targets = addresses.length > 0 ? addresses : [undefined];
        for (const address of targets) {
            try {
                if (address) {
                    socket.setMulticastInterface(address);
                }
                socket.send(query, MDNS_PORT, MDNS_ADDRESS);
            } catch {
                // An interface that went away between listing and sending.
            }
        }
    };

    sendQuery();
    const requery = setTimeout(sendQuery, REQUERY_DELAY_MS);
    await new Promise((resolve) =>
        setTimeout(resolve, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    );
    clearTimeout(requery);
    socket.close();

    return [...found.values()].sort((left, right) =>
        left.name.localeCompare(right.name)
    );
}
