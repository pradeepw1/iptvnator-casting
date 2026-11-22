import {
    CAST_SERVICE_NAME,
    encodeCastServiceQuery,
    extractCastServices,
    parseMdnsResponse,
} from './mdns.codec';

/** Builds a synthetic mDNS response; `names` use real label encoding. */
class PacketBuilder {
    private readonly bytes: number[] = [];
    private readonly offsets = new Map<string, number>();

    constructor(questions: number, answers: number, additionals: number) {
        this.bytes.push(
            0,
            0,
            0x84,
            0,
            0,
            questions,
            0,
            answers,
            0,
            0,
            0,
            additionals
        );
    }

    name(name: string): this {
        const labels = name.split('.');
        for (let index = 0; index < labels.length; index += 1) {
            const suffix = labels.slice(index).join('.');
            const known = this.offsets.get(suffix);
            if (known !== undefined) {
                this.bytes.push(0xc0 | (known >> 8), known & 0xff);
                return this;
            }
            this.offsets.set(suffix, this.bytes.length);
            const label = Buffer.from(labels[index], 'utf8');
            this.bytes.push(label.length, ...label);
        }
        this.bytes.push(0);
        return this;
    }

    question(name: string): this {
        return this.name(name).raw(0, 12, 0, 1);
    }

    record(name: string, type: number, data: (builder: this) => void): this {
        this.name(name).raw(0, type, 0x80, 1, 0, 0, 0x11, 0x94);
        const lengthAt = this.bytes.length;
        this.raw(0, 0);
        const start = this.bytes.length;
        data(this);
        const length = this.bytes.length - start;
        this.bytes[lengthAt] = length >> 8;
        this.bytes[lengthAt + 1] = length & 0xff;
        return this;
    }

    txt(entries: string[]): this {
        for (const entry of entries) {
            const text = Buffer.from(entry, 'utf8');
            this.bytes.push(text.length, ...text);
        }
        return this;
    }

    raw(...values: number[]): this {
        this.bytes.push(...values);
        return this;
    }

    build(): Buffer {
        return Buffer.from(this.bytes);
    }
}

const INSTANCE = `Chromecast-0123abcd.${CAST_SERVICE_NAME}`;
const HOST = '0123abcd.local';

function castResponse(txt: string[]): Buffer {
    return new PacketBuilder(1, 1, 3)
        .question(CAST_SERVICE_NAME)
        .record(CAST_SERVICE_NAME, 12, (b) => b.name(INSTANCE))
        .record(INSTANCE, 33, (b) => b.raw(0, 0, 0, 0, 0x1f, 0x49).name(HOST))
        .record(INSTANCE, 16, (b) => b.txt(txt))
        .record(HOST, 1, (b) => b.raw(192, 0, 2, 44))
        .build();
}

describe('mDNS codec', () => {
    it('encodes a PTR query for the Cast service', () => {
        const query = encodeCastServiceQuery();
        expect(query.readUInt16BE(4)).toBe(1);
        expect(query.subarray(12).toString('latin1')).toContain('_googlecast');
        expect(query.readUInt16BE(query.length - 4)).toBe(12);
    });

    it('parses compressed PTR, SRV, TXT and A records', () => {
        const records = parseMdnsResponse(
            castResponse([
                'id=abc123',
                'fn=Living Room TV',
                'md=Chromecast',
                'ca=201221',
            ])
        );

        expect(records).toEqual([
            {
                type: 'PTR',
                name: CAST_SERVICE_NAME,
                target: INSTANCE.toLowerCase(),
            },
            {
                type: 'SRV',
                name: INSTANCE.toLowerCase(),
                port: 8009,
                target: HOST,
            },
            {
                type: 'TXT',
                name: INSTANCE.toLowerCase(),
                entries: {
                    id: 'abc123',
                    fn: 'Living Room TV',
                    md: 'Chromecast',
                    ca: '201221',
                },
            },
            { type: 'A', name: HOST, address: '192.0.2.44' },
        ]);
    });

    it('joins records into a Cast device', () => {
        const records = parseMdnsResponse(
            castResponse([
                'id=abc123',
                'fn=Living Room TV',
                'md=Chromecast',
                'ca=201221',
            ])
        );

        expect(extractCastServices(records, '192.0.2.99')).toEqual([
            {
                id: 'abc123',
                name: 'Living Room TV',
                model: 'Chromecast',
                host: '192.0.2.44',
                port: 8009,
            },
        ]);
    });

    it('falls back to the responder address and instance name', () => {
        const records = parseMdnsResponse(castResponse([])).filter(
            (record) => record.type !== 'A'
        );

        expect(extractCastServices(records, '192.0.2.99')).toEqual([
            {
                id: INSTANCE.toLowerCase(),
                name: 'chromecast-0123abcd',
                model: undefined,
                host: '192.0.2.99',
                port: 8009,
            },
        ]);
    });

    it('skips audio-only receivers', () => {
        const records = parseMdnsResponse(
            castResponse(['id=speaker', 'ca=2052'])
        );
        expect(extractCastServices(records, '192.0.2.99')).toEqual([]);
    });

    it('returns no records for malformed or looping packets', () => {
        expect(parseMdnsResponse(Buffer.from([0, 0, 0x84]))).toEqual([]);
        expect(
            parseMdnsResponse(castResponse(['id=x']).subarray(0, 40))
        ).toEqual([]);

        const loop = Buffer.from([
            0,
            0,
            0x84,
            0,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0, // one answer
            0xc0,
            12, // name pointing at itself
        ]);
        expect(parseMdnsResponse(loop)).toEqual([]);
    });
});
