import * as dgram from 'node:dgram';
import type { CastServiceRecord } from '../mdns.codec';
import { listIpv4InterfaceAddresses } from '../cast-discovery';
import { RokuEcpClient } from './roku-ecp-client';
import {
    encodeRokuSearch,
    type RokuEndpoint,
    rokuEndpointFromResponse,
    SSDP_ADDRESS,
    SSDP_PORT,
} from './roku-ssdp';

export interface RokuDiscoveryOptions {
    readonly timeoutMs?: number;
    readonly createSocket?: () => dgram.Socket;
    readonly listInterfaceAddresses?: () => string[];
    /** Reads a device's display name; injectable for tests. */
    readonly describe?: (endpoint: RokuEndpoint) => Promise<{
        name: string | null;
        model: string | null;
    }>;
}

const DEFAULT_TIMEOUT_MS = 2_500;
const RESEND_DELAY_MS = 800;

function describeOverEcp(endpoint: RokuEndpoint) {
    return new RokuEcpClient(
        `http://${endpoint.host}:${endpoint.port}/`,
        fetch,
        2_000
    ).deviceInfo();
}

/** Sends one search per interface; answers arrive by unicast. */
function searchOn(
    address: string | undefined,
    options: RokuDiscoveryOptions,
    found: Map<string, RokuEndpoint>
): Promise<void> {
    const socket = (
        options.createSocket ?? (() => dgram.createSocket('udp4'))
    )();
    const query = encodeRokuSearch();
    return new Promise((resolve) => {
        const finish = () => {
            try {
                socket.close();
            } catch {
                // Already closed after an error.
            }
            resolve();
        };
        socket.on('error', finish);
        socket.on('message', (packet, remote) => {
            const endpoint = rokuEndpointFromResponse(
                packet.toString('latin1'),
                remote.address
            );
            if (endpoint) found.set(endpoint.id, endpoint);
        });
        socket.bind(0, address, () => {
            const send = () => {
                try {
                    if (address) socket.setMulticastInterface(address);
                    socket.send(query, SSDP_PORT, SSDP_ADDRESS);
                } catch {
                    // The interface went away; the timeout still ends it.
                }
            };
            send();
            setTimeout(send, RESEND_DELAY_MS);
            setTimeout(finish, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        });
    });
}

/**
 * Finds Roku players and TVs and names them as the user did on the device.
 * A device that will not describe itself is still listed, by address.
 */
export async function discoverRokuDevices(
    options: RokuDiscoveryOptions = {}
): Promise<CastServiceRecord[]> {
    const addresses = (
        options.listInterfaceAddresses ?? listIpv4InterfaceAddresses
    )();
    const found = new Map<string, RokuEndpoint>();
    const targets = addresses.length > 0 ? addresses : [undefined];
    await Promise.all(
        targets.map((address) => searchOn(address, options, found))
    );

    const describe = options.describe ?? describeOverEcp;
    const devices = await Promise.all(
        [...found.values()].map(async (endpoint) => {
            const info = await describe(endpoint).catch(() => null);
            return {
                id: endpoint.id,
                name: info?.name || `Roku (${endpoint.host})`,
                model: info?.model ?? undefined,
                host: endpoint.host,
                port: endpoint.port,
            };
        })
    );
    return devices.sort((left, right) => left.name.localeCompare(right.name));
}
