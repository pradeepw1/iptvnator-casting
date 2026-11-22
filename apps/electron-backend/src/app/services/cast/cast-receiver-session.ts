import type {
    CastControlCommand,
    CastErrorCode,
    CastMediaRequest,
    CastSession,
    CastSessionStatus,
} from '@iptvnator/shared/interfaces';
import {
    CAST_NAMESPACE,
    CAST_RECEIVER_ID,
    CastConnection,
    type CastConnectionOptions,
    type CastJsonMessage,
} from './cast-connection';
import {
    buildCastLoadPayload,
    DEFAULT_MEDIA_RECEIVER_APP_ID,
} from './cast-media-payload';
import type { CastServiceRecord } from './mdns.codec';
import type { ReceiverSession, ReceiverSessionDeps } from './receiver-session';

const LAUNCH_TIMEOUT_MS = 15_000;
/** The receiver fetches the manifest before answering LOAD. */
const LOAD_TIMEOUT_MS = 30_000;
const STATUS_POLL_INTERVAL_MS = 1_000;
const LOAD_ERROR_TYPES = new Set([
    'LOAD_FAILED',
    'LOAD_CANCELLED',
    'INVALID_REQUEST',
    'ERROR',
]);

export class CastStartError extends Error {
    constructor(
        readonly code: CastErrorCode,
        message: string
    ) {
        super(message);
        this.name = 'CastStartError';
    }
}

export interface CastReceiverSessionDeps extends ReceiverSessionDeps {
    readonly openConnection?: (
        options: CastConnectionOptions
    ) => Promise<CastConnection>;
    readonly statusPollIntervalMs?: number;
}

interface ReceiverApplication {
    readonly appId?: string;
    readonly sessionId?: string;
    readonly transportId?: string;
}

function findApplication(message: CastJsonMessage): ReceiverApplication | null {
    const status = message.payload['status'] as
        { applications?: ReceiverApplication[] } | undefined;
    return (
        status?.applications?.find(
            (app) => app.appId === DEFAULT_MEDIA_RECEIVER_APP_ID
        ) ?? null
    );
}

function mapPlayerState(
    state: unknown,
    idleReason: unknown
): CastSessionStatus {
    switch (state) {
        case 'PLAYING':
            return 'playing';
        case 'PAUSED':
            return 'paused';
        case 'BUFFERING':
            return 'buffering';
        case 'LOADING':
            return 'loading';
        default:
            return idleReason === 'ERROR' ? 'error' : 'ended';
    }
}

/**
 * One cast of one stream to one receiver, using Google's Default Media
 * Receiver. Owns the connection: `stop()` ends the receiver app, `dispose()`
 * only detaches this sender and leaves the TV playing.
 */
export class CastReceiverSession implements ReceiverSession {
    private state: CastSession;
    private transportId = '';
    private appSessionId = '';
    private mediaSessionId: number | null = null;
    private poller: NodeJS.Timeout | null = null;
    private finished = false;

    private constructor(
        private readonly connection: CastConnection,
        device: CastServiceRecord,
        media: CastMediaRequest,
        private readonly deps: CastReceiverSessionDeps
    ) {
        this.state = {
            deviceId: device.id,
            deviceName: device.name,
            status: 'connecting',
            isLive: media.isLive,
            title: media.title,
            positionSeconds: media.startTime ?? 0,
            durationSeconds: null,
            volume: 1,
            muted: false,
            canSeek: !media.isLive,
            canSetVolume: true,
        };
    }

    static async start(
        device: CastServiceRecord,
        media: CastMediaRequest,
        deps: CastReceiverSessionDeps
    ): Promise<CastReceiverSession> {
        const open = deps.openConnection ?? CastConnection.open;
        let connection: CastConnection;
        try {
            connection = await open({ host: device.host, port: device.port });
        } catch {
            throw new CastStartError(
                'device-unreachable',
                'Could not connect to the Cast device'
            );
        }
        const session = new CastReceiverSession(
            connection,
            device,
            media,
            deps
        );
        try {
            await session.launchAndLoad(media);
        } catch (error) {
            // Stop the launched receiver so the TV does not sit on the
            // Cast splash screen after a stream it could not load.
            session.stop();
            throw error;
        }
        return session;
    }

    get snapshot(): CastSession {
        return this.state;
    }

    control(command: CastControlCommand): void {
        if (this.finished) {
            return;
        }
        switch (command.type) {
            case 'play':
            case 'pause':
                this.sendMedia({ type: command.type.toUpperCase() });
                return;
            case 'seek':
                if (!this.state.isLive) {
                    this.sendMedia({
                        type: 'SEEK',
                        currentTime: Math.max(0, command.seconds),
                    });
                }
                return;
            case 'volume':
                this.sendReceiver({
                    type: 'SET_VOLUME',
                    volume: { level: Math.min(1, Math.max(0, command.level)) },
                });
                return;
            case 'mute':
                this.sendReceiver({
                    type: 'SET_VOLUME',
                    volume: { muted: command.muted },
                });
                return;
        }
    }

    /** Ends playback on the TV and closes the connection. */
    stop(): void {
        if (!this.finished && this.appSessionId) {
            this.sendReceiver({ type: 'STOP', sessionId: this.appSessionId });
        }
        this.dispose();
    }

    /** Detaches without touching the TV. Safe to call repeatedly. */
    dispose(): void {
        this.finished = true;
        if (this.poller) {
            clearInterval(this.poller);
            this.poller = null;
        }
        this.connection.close();
    }

    private async launchAndLoad(media: CastMediaRequest): Promise<void> {
        this.connection.onMessage((message) => this.handleMessage(message));
        this.connection.onClose(() => this.handleClose());
        this.emit({});

        const app = await this.launchReceiver();
        this.transportId = app.transportId ?? '';
        this.appSessionId = app.sessionId ?? '';
        this.connection.connectTo(this.transportId);
        this.emit({ status: 'loading' });

        let reply: CastJsonMessage;
        try {
            reply = await this.connection.request(
                CAST_NAMESPACE.media,
                this.transportId,
                buildCastLoadPayload(media, this.appSessionId),
                LOAD_TIMEOUT_MS
            );
        } catch {
            throw new CastStartError('load-failed', 'The TV did not load');
        }
        if (LOAD_ERROR_TYPES.has(reply.payload.type)) {
            throw new CastStartError(
                'load-failed',
                'The TV rejected the stream'
            );
        }
        this.startPolling();
    }

    private async launchReceiver(): Promise<ReceiverApplication> {
        const launched = new Promise<ReceiverApplication>((resolve, reject) => {
            const timer = setTimeout(
                () =>
                    reject(
                        new CastStartError('launch-failed', 'Launch timeout')
                    ),
                LAUNCH_TIMEOUT_MS
            );
            const unsubscribe = this.connection.onMessage((message) => {
                const app =
                    message.payload.type === 'RECEIVER_STATUS'
                        ? findApplication(message)
                        : null;
                if (message.payload.type === 'LAUNCH_ERROR') {
                    clearTimeout(timer);
                    unsubscribe();
                    reject(new CastStartError('launch-failed', 'Launch error'));
                } else if (app?.transportId && app.sessionId) {
                    clearTimeout(timer);
                    unsubscribe();
                    resolve(app);
                }
            });
        });
        this.connection
            .request(
                CAST_NAMESPACE.receiver,
                CAST_RECEIVER_ID,
                { type: 'LAUNCH', appId: DEFAULT_MEDIA_RECEIVER_APP_ID },
                LAUNCH_TIMEOUT_MS
            )
            .catch(() => undefined);
        return launched;
    }

    private startPolling(): void {
        const interval =
            this.deps.statusPollIntervalMs ?? STATUS_POLL_INTERVAL_MS;
        this.poller = setInterval(() => {
            if (
                this.state.status === 'playing' ||
                this.state.status === 'buffering'
            ) {
                this.sendMedia({ type: 'GET_STATUS' });
            }
        }, interval);
        this.poller.unref?.();
    }

    private handleMessage(message: CastJsonMessage): void {
        const { payload } = message;
        if (payload.type === 'RECEIVER_STATUS') {
            this.applyReceiverStatus(message);
        } else if (
            payload.type === 'MEDIA_STATUS' &&
            message.sourceId === this.transportId
        ) {
            this.applyMediaStatus(payload['status']);
        }
    }

    private applyReceiverStatus(message: CastJsonMessage): void {
        const status = message.payload['status'] as
            { volume?: { level?: number; muted?: boolean } } | undefined;
        const volume = status?.volume;
        const patch: { volume?: number; muted?: boolean } = {};
        if (typeof volume?.level === 'number') patch.volume = volume.level;
        if (typeof volume?.muted === 'boolean') patch.muted = volume.muted;
        const app = findApplication(message);
        if (this.appSessionId && app?.sessionId !== this.appSessionId) {
            // The app was stopped from the TV or replaced by another sender.
            this.emit({ ...patch, status: 'ended' });
            this.dispose();
            return;
        }
        this.emit(patch);
    }

    private applyMediaStatus(value: unknown): void {
        const entry = Array.isArray(value) ? value[0] : undefined;
        if (!entry || typeof entry !== 'object') {
            return;
        }
        const status = entry as Record<string, unknown>;
        if (typeof status['mediaSessionId'] === 'number') {
            this.mediaSessionId = status['mediaSessionId'];
        }
        const media = status['media'] as { duration?: unknown } | undefined;
        const next = mapPlayerState(
            status['playerState'],
            status['idleReason']
        );
        this.emit({
            status: next,
            error: next === 'error' ? 'load-failed' : undefined,
            positionSeconds:
                typeof status['currentTime'] === 'number'
                    ? status['currentTime']
                    : this.state.positionSeconds,
            durationSeconds:
                !this.state.isLive &&
                typeof media?.duration === 'number' &&
                media.duration > 0
                    ? media.duration
                    : this.state.durationSeconds,
        });
    }

    private handleClose(): void {
        if (!this.finished) {
            this.emit({ status: 'error', error: 'connection-lost' });
            this.dispose();
        }
    }

    private sendMedia(payload: { type: string } & Record<string, unknown>) {
        if (this.mediaSessionId === null || this.connection.isClosed) {
            return;
        }
        this.connection
            .request(CAST_NAMESPACE.media, this.transportId, {
                ...payload,
                mediaSessionId: this.mediaSessionId,
            })
            .catch(() => undefined);
    }

    private sendReceiver(payload: { type: string } & Record<string, unknown>) {
        if (this.connection.isClosed) {
            return;
        }
        this.connection
            .request(CAST_NAMESPACE.receiver, CAST_RECEIVER_ID, payload)
            .catch(() => undefined);
    }

    private emit(patch: Partial<CastSession>): void {
        this.state = { ...this.state, ...patch };
        this.deps.onUpdate(this.state);
    }
}
