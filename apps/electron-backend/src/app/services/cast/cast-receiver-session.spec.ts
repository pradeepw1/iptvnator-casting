import type {
    CastMediaRequest,
    CastSession,
} from '@iptvnator/shared/interfaces';
import {
    CAST_NAMESPACE,
    type CastConnection,
    type CastPayload,
} from './cast-connection';
import { CastReceiverSession, CastStartError } from './cast-receiver-session';
import { castReply, FakeCastConnection } from './cast.test-helpers';

const device = {
    id: 'device-1',
    name: 'Living Room TV',
    host: '192.0.2.10',
    port: 8009,
};
const media: CastMediaRequest = {
    url: 'https://stream.example.com/movie.mp4',
    title: 'A Movie',
    isLive: false,
};
const app = {
    appId: 'CC1AD845',
    sessionId: 'app-session',
    transportId: 'web-7',
};

function receiverStatus(extra: Record<string, unknown> = {}) {
    return castReply(CAST_NAMESPACE.receiver, {
        type: 'RECEIVER_STATUS',
        status: { applications: [app], volume: { level: 0.4, muted: false } },
        ...extra,
    });
}

function mediaStatus(status: Record<string, unknown>) {
    return castReply(
        CAST_NAMESPACE.media,
        { type: 'MEDIA_STATUS', status: [{ mediaSessionId: 3, ...status }] },
        app.transportId
    );
}

function happyReceiver(connection: FakeCastConnection) {
    connection.respond = (_namespace: string, payload: CastPayload) => {
        if (payload.type === 'LAUNCH') return receiverStatus();
        if (payload.type === 'LOAD') {
            return mediaStatus({ playerState: 'BUFFERING', currentTime: 0 });
        }
        return undefined;
    };
}

async function startSession(connection = new FakeCastConnection()) {
    const updates: CastSession[] = [];
    const session = await CastReceiverSession.start(device, media, {
        onUpdate: (snapshot) => updates.push(snapshot),
        openConnection: async () => connection as unknown as CastConnection,
    });
    return { session, updates, connection };
}

describe('CastReceiverSession', () => {
    it('launches the Default Media Receiver, connects to it and loads media', async () => {
        const connection = new FakeCastConnection();
        happyReceiver(connection);
        const { session, updates } = await startSession(connection);

        expect(connection.sentTypes()).toEqual(['LAUNCH', 'LOAD']);
        expect(connection.connected).toEqual(['web-7']);
        expect(connection.sent[1]).toMatchObject({
            namespace: CAST_NAMESPACE.media,
            destinationId: 'web-7',
            payload: {
                sessionId: 'app-session',
                media: { contentType: 'video/mp4' },
            },
        });
        expect(updates.map((update) => update.status)).toEqual([
            'connecting',
            'connecting',
            'loading',
            'buffering',
        ]);
        expect(session.snapshot).toMatchObject({
            deviceName: 'Living Room TV',
            volume: 0.4,
            status: 'buffering',
        });
        session.dispose();
    });

    it('maps media status updates into the session snapshot', async () => {
        const connection = new FakeCastConnection();
        happyReceiver(connection);
        const { session } = await startSession(connection);

        connection.deliver(
            mediaStatus({
                playerState: 'PLAYING',
                currentTime: 12.5,
                media: { duration: 5400 },
            })
        );
        expect(session.snapshot).toMatchObject({
            status: 'playing',
            positionSeconds: 12.5,
            durationSeconds: 5400,
        });

        connection.deliver(
            mediaStatus({ playerState: 'IDLE', idleReason: 'FINISHED' })
        );
        expect(session.snapshot.status).toBe('ended');
        session.dispose();
    });

    it('sends transport and volume commands with the media session id', async () => {
        const connection = new FakeCastConnection();
        happyReceiver(connection);
        const { session } = await startSession(connection);

        session.control({ type: 'pause' });
        session.control({ type: 'seek', seconds: 60 });
        session.control({ type: 'volume', level: 2 });
        session.control({ type: 'mute', muted: true });

        expect(connection.sent.slice(2).map((entry) => entry.payload)).toEqual([
            expect.objectContaining({ type: 'PAUSE', mediaSessionId: 3 }),
            expect.objectContaining({
                type: 'SEEK',
                currentTime: 60,
                mediaSessionId: 3,
            }),
            expect.objectContaining({
                type: 'SET_VOLUME',
                volume: { level: 1 },
            }),
            expect.objectContaining({
                type: 'SET_VOLUME',
                volume: { muted: true },
            }),
        ]);
        session.dispose();
    });

    it('ignores seeking on live streams', async () => {
        const connection = new FakeCastConnection();
        happyReceiver(connection);
        const updates: CastSession[] = [];
        const session = await CastReceiverSession.start(
            device,
            { ...media, isLive: true },
            {
                onUpdate: (snapshot) => updates.push(snapshot),
                openConnection: async () =>
                    connection as unknown as CastConnection,
            }
        );

        session.control({ type: 'seek', seconds: 60 });
        expect(connection.sentTypes()).toEqual(['LAUNCH', 'LOAD']);
        session.dispose();
    });

    it('stops the receiver app when the TV rejects the stream', async () => {
        const connection = new FakeCastConnection();
        connection.respond = (_namespace, payload) => {
            if (payload.type === 'LAUNCH') return receiverStatus();
            if (payload.type === 'LOAD') {
                return castReply(
                    CAST_NAMESPACE.media,
                    { type: 'LOAD_FAILED' },
                    'web-7'
                );
            }
            return undefined;
        };

        await expect(startSession(connection)).rejects.toMatchObject({
            code: 'load-failed',
        });
        expect(connection.sent.at(-1)?.payload).toEqual(
            expect.objectContaining({ type: 'STOP', sessionId: 'app-session' })
        );
        expect(connection.isClosed).toBe(true);
    });

    it('reports an unreachable device', async () => {
        await expect(
            CastReceiverSession.start(device, media, {
                onUpdate: () => undefined,
                openConnection: () => Promise.reject(new Error('EHOSTUNREACH')),
            })
        ).rejects.toEqual(expect.any(CastStartError));
    });

    it('ends when the TV stops the app or another sender takes over', async () => {
        const connection = new FakeCastConnection();
        happyReceiver(connection);
        const { session, updates } = await startSession(connection);

        connection.deliver(
            castReply(CAST_NAMESPACE.receiver, {
                type: 'RECEIVER_STATUS',
                status: { volume: { level: 0.4, muted: false } },
            })
        );

        expect(updates.at(-1)?.status).toBe('ended');
        expect(connection.isClosed).toBe(true);
        session.dispose();
    });

    it('reports a lost connection, but not its own stop', async () => {
        const connection = new FakeCastConnection();
        happyReceiver(connection);
        const { updates } = await startSession(connection);
        connection.close(new Error('reset'));
        expect(updates.at(-1)).toMatchObject({
            status: 'error',
            error: 'connection-lost',
        });

        const second = new FakeCastConnection();
        happyReceiver(second);
        const { session, updates: secondUpdates } = await startSession(second);
        session.stop();
        expect(secondUpdates.at(-1)?.status).toBe('buffering');
        expect(second.sentTypes().at(-1)).toBe('STOP');
    });
});
