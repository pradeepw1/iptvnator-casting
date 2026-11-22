import {
    CAST_MAX_MESSAGE_BYTES,
    CastFrameReader,
    CastProtocolError,
    decodeCastMessage,
    encodeCastFrame,
    encodeCastMessage,
} from './cast-message.codec';

const message = {
    sourceId: 'sender-0',
    destinationId: 'receiver-0',
    namespace: 'urn:x-cast:com.google.cast.tp.heartbeat',
    payloadUtf8: '{"type":"PING"}',
};

describe('cast message codec', () => {
    it('encodes the protobuf fields in order with a string payload', () => {
        const bytes = encodeCastMessage({
            sourceId: 'a',
            destinationId: 'b',
            namespace: 'c',
            payloadUtf8: 'd',
        });

        expect([...bytes]).toEqual([
            0x08,
            0x00, // protocol_version = CASTV2_1_0
            0x12,
            0x01,
            0x61, // source_id = "a"
            0x1a,
            0x01,
            0x62, // destination_id = "b"
            0x22,
            0x01,
            0x63, // namespace = "c"
            0x28,
            0x00, // payload_type = STRING
            0x32,
            0x01,
            0x64, // payload_utf8 = "d"
        ]);
    });

    it('round-trips text and binary payloads', () => {
        expect(decodeCastMessage(encodeCastMessage(message))).toEqual({
            ...message,
            payloadBinary: undefined,
        });

        const binary = Uint8Array.from([0, 1, 2, 255]);
        const decoded = decodeCastMessage(
            encodeCastMessage({ ...message, payloadBinary: binary })
        );
        expect(decoded.payloadUtf8).toBeUndefined();
        expect([...(decoded.payloadBinary ?? [])]).toEqual([0, 1, 2, 255]);
    });

    it('encodes multi-byte lengths and unicode text', () => {
        const payloadUtf8 = JSON.stringify({ title: 'Ünïcødé '.repeat(40) });
        expect(
            decodeCastMessage(encodeCastMessage({ ...message, payloadUtf8 }))
                .payloadUtf8
        ).toBe(payloadUtf8);
    });

    it('skips unknown fields of every wire type', () => {
        const known = encodeCastMessage(message);
        const unknown = Buffer.from([
            0x40,
            0x96,
            0x01, // field 8 varint
            0x49,
            1,
            2,
            3,
            4,
            5,
            6,
            7,
            8, // field 9 fixed64
            0x52,
            0x02,
            0x78,
            0x79, // field 10 length-delimited
            0x5d,
            1,
            2,
            3,
            4, // field 11 fixed32
        ]);

        expect(
            decodeCastMessage(Buffer.concat([unknown, known])).namespace
        ).toBe(message.namespace);
    });

    it('rejects truncated messages', () => {
        const bytes = encodeCastMessage(message);
        expect(() => decodeCastMessage(bytes.subarray(0, 6))).toThrow(
            CastProtocolError
        );
    });

    it('prefixes frames with a big-endian length', () => {
        const frame = encodeCastFrame(message);
        expect(frame.readUInt32BE(0)).toBe(frame.length - 4);
    });

    it('reassembles frames split across arbitrary chunks', () => {
        const frames = Buffer.concat([
            encodeCastFrame(message),
            encodeCastFrame({ ...message, payloadUtf8: '{"type":"PONG"}' }),
        ]);
        const reader = new CastFrameReader();
        const received = [];
        for (let offset = 0; offset < frames.length; offset += 3) {
            received.push(...reader.push(frames.subarray(offset, offset + 3)));
        }

        expect(received.map((frame) => frame.payloadUtf8)).toEqual([
            '{"type":"PING"}',
            '{"type":"PONG"}',
        ]);
    });

    it('refuses frames above the receiver size limit', () => {
        const header = Buffer.alloc(4);
        header.writeUInt32BE(CAST_MAX_MESSAGE_BYTES + 1, 0);
        expect(() => new CastFrameReader().push(header)).toThrow(
            CastProtocolError
        );
        expect(() =>
            encodeCastFrame({
                ...message,
                payloadUtf8: 'x'.repeat(CAST_MAX_MESSAGE_BYTES),
            })
        ).toThrow(CastProtocolError);
    });
});
