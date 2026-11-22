/**
 * Just enough multicast DNS (RFC 6762/6763) to find Google Cast receivers:
 * one PTR query for `_googlecast._tcp.local` and a tolerant parser for the
 * PTR/SRV/TXT/A records receivers answer with.
 */

export const CAST_SERVICE_NAME = '_googlecast._tcp.local';
export const MDNS_ADDRESS = '224.0.0.251';
export const MDNS_PORT = 5353;

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;
const CLASS_IN = 1;
const HEADER_BYTES = 12;
/** Bounds compression-pointer chains so a hostile packet cannot loop. */
const MAX_NAME_JUMPS = 32;
/** `ca` TXT capability bit for video output. */
const CAST_CAPABILITY_VIDEO_OUT = 1;

export type MdnsRecord =
    | { readonly type: 'PTR'; readonly name: string; readonly target: string }
    | {
          readonly type: 'SRV';
          readonly name: string;
          readonly target: string;
          readonly port: number;
      }
    | {
          readonly type: 'TXT';
          readonly name: string;
          readonly entries: Readonly<Record<string, string>>;
      }
    | { readonly type: 'A'; readonly name: string; readonly address: string };

export interface CastServiceRecord {
    readonly id: string;
    readonly name: string;
    readonly model?: string;
    readonly host: string;
    readonly port: number;
}

export function encodeCastServiceQuery(): Buffer {
    const labels = CAST_SERVICE_NAME.split('.');
    const nameBytes = labels.flatMap((label) => [
        label.length,
        ...Buffer.from(label, 'ascii'),
    ]);
    const header = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    return Buffer.from([...header, ...nameBytes, 0, 0, TYPE_PTR, 0, CLASS_IN]);
}

class DnsReader {
    constructor(private readonly packet: Buffer) {}

    uint16(offset: number): number {
        this.require(offset, 2);
        return this.packet.readUInt16BE(offset);
    }

    /** Returns the decoded name and the offset just past it. */
    name(start: number): { name: string; next: number } {
        const labels: string[] = [];
        let offset = start;
        let next = -1;
        let jumps = 0;
        for (;;) {
            this.require(offset, 1);
            const length = this.packet[offset];
            if (length === 0) {
                offset += 1;
                break;
            }
            if ((length & 0xc0) === 0xc0) {
                if (++jumps > MAX_NAME_JUMPS) {
                    throw new RangeError('mDNS name pointer loop');
                }
                const pointer = this.uint16(offset) & 0x3fff;
                if (next < 0) {
                    next = offset + 2;
                }
                offset = pointer;
                continue;
            }
            this.require(offset + 1, length);
            labels.push(
                this.packet.toString('utf8', offset + 1, offset + 1 + length)
            );
            offset += 1 + length;
        }
        return { name: labels.join('.'), next: next < 0 ? offset : next };
    }

    require(offset: number, length: number): void {
        if (offset < 0 || offset + length > this.packet.length) {
            throw new RangeError('Truncated mDNS packet');
        }
    }
}

function parseTxt(packet: Buffer, start: number, end: number) {
    const entries: Record<string, string> = {};
    let offset = start;
    while (offset < end) {
        const length = packet[offset];
        const text = packet.toString('utf8', offset + 1, offset + 1 + length);
        const separator = text.indexOf('=');
        if (separator > 0) {
            entries[text.slice(0, separator).toLowerCase()] = text.slice(
                separator + 1
            );
        }
        offset += 1 + length;
    }
    return entries;
}

/** Parses answer and additional records; malformed packets yield `[]`. */
export function parseMdnsResponse(packet: Buffer): MdnsRecord[] {
    try {
        const reader = new DnsReader(packet);
        const questions = reader.uint16(4);
        const recordCount =
            reader.uint16(6) + reader.uint16(8) + reader.uint16(10);
        let offset = HEADER_BYTES;
        for (let index = 0; index < questions; index += 1) {
            offset = reader.name(offset).next + 4;
        }
        const records: MdnsRecord[] = [];
        for (let index = 0; index < recordCount; index += 1) {
            const { name, next } = reader.name(offset);
            const type = reader.uint16(next);
            const dataLength = reader.uint16(next + 8);
            const dataStart = next + 10;
            reader.require(dataStart, dataLength);
            const record = readRecord(reader, packet, {
                name: name.toLowerCase(),
                type,
                dataStart,
                dataLength,
            });
            if (record) {
                records.push(record);
            }
            offset = dataStart + dataLength;
        }
        return records;
    } catch {
        return [];
    }
}

function readRecord(
    reader: DnsReader,
    packet: Buffer,
    raw: { name: string; type: number; dataStart: number; dataLength: number }
): MdnsRecord | null {
    const { name, type, dataStart, dataLength } = raw;
    switch (type) {
        case TYPE_PTR:
            return {
                type: 'PTR',
                name,
                target: reader.name(dataStart).name.toLowerCase(),
            };
        case TYPE_SRV:
            return {
                type: 'SRV',
                name,
                port: reader.uint16(dataStart + 4),
                target: reader.name(dataStart + 6).name.toLowerCase(),
            };
        case TYPE_TXT:
            return {
                type: 'TXT',
                name,
                entries: parseTxt(packet, dataStart, dataStart + dataLength),
            };
        case TYPE_A:
            return dataLength === 4
                ? {
                      type: 'A',
                      name,
                      address: [
                          ...packet.subarray(dataStart, dataStart + 4),
                      ].join('.'),
                  }
                : null;
        default:
            return null;
    }
}

/**
 * Joins the records of one response into Cast receivers. `sourceAddress`
 * (the responder's IP) is the fallback when no A record accompanies the SRV.
 * Audio-only receivers are skipped because the player casts video.
 */
export function extractCastServices(
    records: readonly MdnsRecord[],
    sourceAddress: string
): CastServiceRecord[] {
    const find = <T extends MdnsRecord['type']>(type: T, name: string) =>
        records.find(
            (record) => record.type === type && record.name === name
        ) as Extract<MdnsRecord, { type: T }> | undefined;

    const services: CastServiceRecord[] = [];
    for (const record of records) {
        if (record.type !== 'PTR' || record.name !== CAST_SERVICE_NAME) {
            continue;
        }
        const instance = record.target;
        const txt = find('TXT', instance)?.entries ?? {};
        const capabilities = Number.parseInt(txt['ca'] ?? '', 10);
        if (
            Number.isFinite(capabilities) &&
            (capabilities & CAST_CAPABILITY_VIDEO_OUT) === 0
        ) {
            continue;
        }
        const srv = find('SRV', instance);
        const host = (srv && find('A', srv.target)?.address) || sourceAddress;
        services.push({
            id: txt['id'] || instance,
            name: txt['fn'] || instance.split('.')[0],
            model: txt['md'] || undefined,
            host,
            port: srv?.port ?? 8009,
        });
    }
    return services;
}
