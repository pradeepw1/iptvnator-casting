import { CAST_NAMESPACE, CastConnection } from './cast-connection';
import { FakeCastSocket } from './cast.test-helpers';

async function openConnection(socket = new FakeCastSocket()) {
    const connection = await CastConnection.open({
        host: '192.0.2.10',
        port: 8009,
        heartbeatIntervalMs: 1_000,
        requestTimeoutMs: 2_000,
        connect: socket.asTlsConnect(),
    });
    return { connection, socket };
}

describe('CastConnection', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it('connects to the platform receiver without verifying its certificate', async () => {
        const connect = jest.fn(new FakeCastSocket().asTlsConnect());
        const connection = await CastConnection.open({
            host: '192.0.2.10',
            port: 8009,
            connect,
        });

        expect(connect).toHaveBeenCalledWith({
            host: '192.0.2.10',
            port: 8009,
            rejectUnauthorized: false,
        });
        connection.close();
    });

    it('opens the receiver virtual connection first', async () => {
        const { connection, socket } = await openConnection();

        expect(socket.written[0]).toMatchObject({
            sourceId: 'sender-0',
            destinationId: 'receiver-0',
            namespace: CAST_NAMESPACE.connection,
        });
        expect(socket.payloads()[0]).toEqual({ type: 'CONNECT' });
        connection.close();
    });

    it('rejects when the socket fails before TLS is established', async () => {
        const socket = new FakeCastSocket();
        await expect(
            CastConnection.open({
                host: '192.0.2.10',
                port: 8009,
                connect: () => {
                    queueMicrotask(() =>
                        socket.emit('error', new Error('refused'))
                    );
                    return socket as never;
                },
            })
        ).rejects.toThrow('refused');
    });

    it('matches replies to requests by requestId', async () => {
        const { connection, socket } = await openConnection();
        const first = connection.request(
            CAST_NAMESPACE.receiver,
            'receiver-0',
            {
                type: 'GET_STATUS',
            }
        );
        const second = connection.request(
            CAST_NAMESPACE.receiver,
            'receiver-0',
            {
                type: 'GET_STATUS',
            }
        );
        const [, firstSent, secondSent] = socket.payloads();

        socket.receive(CAST_NAMESPACE.receiver, {
            type: 'RECEIVER_STATUS',
            requestId: secondSent.requestId,
            order: 2,
        });
        socket.receive(CAST_NAMESPACE.receiver, {
            type: 'RECEIVER_STATUS',
            requestId: firstSent.requestId,
            order: 1,
        });

        await expect(first).resolves.toMatchObject({ payload: { order: 1 } });
        await expect(second).resolves.toMatchObject({ payload: { order: 2 } });
        connection.close();
    });

    it('answers receiver pings and sends its own heartbeat', async () => {
        jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
        const { connection, socket } = await openConnection();
        socket.receive(CAST_NAMESPACE.heartbeat, { type: 'PING' });
        jest.advanceTimersByTime(1_000);

        expect(socket.payloads().map((payload) => payload.type)).toEqual([
            'CONNECT',
            'PONG',
            'PING',
        ]);
        connection.close();
    });

    it('closes and rejects pending requests when the device goes silent', async () => {
        jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
        const { connection, socket } = await openConnection();
        const onClose = jest.fn();
        connection.onClose(onClose);
        const pending = connection.request(
            CAST_NAMESPACE.receiver,
            'receiver-0',
            { type: 'GET_STATUS' },
            60_000
        );

        jest.advanceTimersByTime(4_000);

        await expect(pending).rejects.toThrow('stopped responding');
        expect(onClose).toHaveBeenCalledWith(expect.any(Error));
        expect(socket.destroyed).toBe(true);
        expect(connection.isClosed).toBe(true);
    });

    it('times out requests that never get a reply', async () => {
        jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
        const { connection } = await openConnection();
        const pending = connection.request(CAST_NAMESPACE.media, 'web-1', {
            type: 'LOAD',
        });
        jest.advanceTimersByTime(2_000);

        await expect(pending).rejects.toThrow('LOAD timed out');
        connection.close();
    });

    it('closes when the receiver closes the virtual connection', async () => {
        const { connection, socket } = await openConnection();
        socket.receive(CAST_NAMESPACE.connection, { type: 'CLOSE' });

        expect(connection.isClosed).toBe(true);
        expect(() =>
            connection.send(CAST_NAMESPACE.receiver, 'receiver-0', {
                type: 'X',
            })
        ).toThrow('closed');
    });

    it('ignores malformed payloads and drops the stream on oversized frames', async () => {
        const { connection, socket } = await openConnection();
        const listener = jest.fn();
        connection.onMessage(listener);
        socket.receive(CAST_NAMESPACE.receiver, { noType: true });
        expect(listener).not.toHaveBeenCalled();

        socket.emit('data', Buffer.from([0xff, 0xff, 0xff, 0xff]));
        expect(connection.isClosed).toBe(true);
    });

    it('flushes queued frames on a graceful close', async () => {
        const { connection, socket } = await openConnection();
        connection.close();

        expect(socket.ended).toBe(true);
    });
});
