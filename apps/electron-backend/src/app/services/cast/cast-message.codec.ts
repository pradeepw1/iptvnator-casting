/**
 * Minimal codec for the Cast V2 `CastMessage` protobuf and its framing.
 *
 * Every message on a Cast channel is a 4-byte big-endian length followed by
 * one serialized `extensions.api.cast_channel.CastMessage`:
 *
 *   1 protocol_version  enum   (CASTV2_1_0 = 0)
 *   2 source_id         string
 *   3 destination_id    string
 *   4 namespace         string
 *   5 payload_type      enum   (STRING = 0, BINARY = 1)
 *   6 payload_utf8      string
 *   7 payload_binary    bytes
 *
 * Only these seven fields exist, so a hand-written codec avoids pulling a
 * protobuf runtime into the main process.
 */

/** Receivers reject larger messages; a bigger frame means a broken stream. */
export const CAST_MAX_MESSAGE_BYTES = 64 * 1024;

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

const PAYLOAD_TYPE_STRING = 0;
const PAYLOAD_TYPE_BINARY = 1;

export interface CastMessage {
    readonly sourceId: string;
    readonly destinationId: string;
    readonly namespace: string;
    readonly payloadUtf8?: string;
    readonly payloadBinary?: Uint8Array;
}

export class CastProtocolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CastProtocolError';
    }
}

function encodeVarint(value: number, out: number[]): void {
    let remaining = value;
    while (remaining > 0x7f) {
        out.push((remaining % 0x80) | 0x80);
        remaining = Math.floor(remaining / 0x80);
    }
    out.push(remaining);
}

function encodeBytesField(field: number, bytes: Uint8Array, out: number[]) {
    encodeVarint((field << 3) | WIRE_LENGTH_DELIMITED, out);
    encodeVarint(bytes.length, out);
    for (const byte of bytes) {
        out.push(byte);
    }
}

function encodeVarintField(field: number, value: number, out: number[]) {
    encodeVarint((field << 3) | WIRE_VARINT, out);
    encodeVarint(value, out);
}

export function encodeCastMessage(message: CastMessage): Buffer {
    const out: number[] = [];
    const utf8 = (text: string) => Buffer.from(text, 'utf8');
    encodeVarintField(1, 0, out);
    encodeBytesField(2, utf8(message.sourceId), out);
    encodeBytesField(3, utf8(message.destinationId), out);
    encodeBytesField(4, utf8(message.namespace), out);
    if (message.payloadBinary) {
        encodeVarintField(5, PAYLOAD_TYPE_BINARY, out);
        encodeBytesField(7, message.payloadBinary, out);
    } else {
        encodeVarintField(5, PAYLOAD_TYPE_STRING, out);
        encodeBytesField(6, utf8(message.payloadUtf8 ?? ''), out);
    }
    return Buffer.from(out);
}

/** Serializes one message with its length prefix, ready for the socket. */
export function encodeCastFrame(message: CastMessage): Buffer {
    const body = encodeCastMessage(message);
    if (body.length > CAST_MAX_MESSAGE_BYTES) {
        throw new CastProtocolError('Cast message exceeds the size limit');
    }
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    return Buffer.concat([header, body]);
}

class ProtobufReader {
    private offset = 0;

    constructor(private readonly bytes: Uint8Array) {}

    get done(): boolean {
        return this.offset >= this.bytes.length;
    }

    varint(): number {
        let result = 0;
        let multiplier = 1;
        for (let index = 0; index < 8; index += 1) {
            if (this.offset >= this.bytes.length) {
                throw new CastProtocolError('Truncated varint');
            }
            const byte = this.bytes[this.offset++];
            result += (byte & 0x7f) * multiplier;
            if ((byte & 0x80) === 0) {
                return result;
            }
            multiplier *= 0x80;
        }
        throw new CastProtocolError('Varint is too long');
    }

    lengthDelimited(): Uint8Array {
        const length = this.varint();
        const end = this.offset + length;
        if (end > this.bytes.length) {
            throw new CastProtocolError('Truncated field');
        }
        const slice = this.bytes.subarray(this.offset, end);
        this.offset = end;
        return slice;
    }

    skip(wireType: number): void {
        switch (wireType) {
            case WIRE_VARINT:
                this.varint();
                return;
            case WIRE_FIXED64:
                this.advance(8);
                return;
            case WIRE_LENGTH_DELIMITED:
                this.lengthDelimited();
                return;
            case WIRE_FIXED32:
                this.advance(4);
                return;
            default:
                throw new CastProtocolError('Unsupported wire type');
        }
    }

    private advance(count: number): void {
        if (this.offset + count > this.bytes.length) {
            throw new CastProtocolError('Truncated field');
        }
        this.offset += count;
    }
}

export function decodeCastMessage(bytes: Uint8Array): CastMessage {
    const reader = new ProtobufReader(bytes);
    const text = (value: Uint8Array) => Buffer.from(value).toString('utf8');
    let sourceId = '';
    let destinationId = '';
    let namespace = '';
    let payloadUtf8: string | undefined;
    let payloadBinary: Uint8Array | undefined;

    while (!reader.done) {
        const tag = reader.varint();
        const field = Math.floor(tag / 8);
        const wireType = tag & 0x07;
        const isBytes = wireType === WIRE_LENGTH_DELIMITED;
        if (field === 2 && isBytes) {
            sourceId = text(reader.lengthDelimited());
        } else if (field === 3 && isBytes) {
            destinationId = text(reader.lengthDelimited());
        } else if (field === 4 && isBytes) {
            namespace = text(reader.lengthDelimited());
        } else if (field === 6 && isBytes) {
            payloadUtf8 = text(reader.lengthDelimited());
        } else if (field === 7 && isBytes) {
            payloadBinary = Uint8Array.from(reader.lengthDelimited());
        } else {
            reader.skip(wireType);
        }
    }

    return { sourceId, destinationId, namespace, payloadUtf8, payloadBinary };
}

/**
 * Reassembles length-prefixed frames from arbitrary TCP chunk boundaries.
 * Throws `CastProtocolError` for an oversized frame; the caller must then
 * drop the connection because the stream can no longer be resynchronized.
 */
export class CastFrameReader {
    private buffer: Buffer = Buffer.alloc(0);

    push(chunk: Buffer): CastMessage[] {
        this.buffer =
            this.buffer.length === 0
                ? chunk
                : Buffer.concat([this.buffer, chunk]);
        const messages: CastMessage[] = [];
        while (this.buffer.length >= 4) {
            const length = this.buffer.readUInt32BE(0);
            if (length > CAST_MAX_MESSAGE_BYTES) {
                throw new CastProtocolError(
                    'Cast frame exceeds the size limit'
                );
            }
            if (this.buffer.length < 4 + length) {
                break;
            }
            messages.push(
                decodeCastMessage(this.buffer.subarray(4, 4 + length))
            );
            this.buffer = this.buffer.subarray(4 + length);
        }
        return messages;
    }
}
