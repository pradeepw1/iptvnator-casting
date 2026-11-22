import * as tls from 'node:tls';
import {
    CastFrameReader,
    encodeCastFrame,
    type CastMessage,
} from './cast-message.codec';

export const CAST_NAMESPACE = {
    connection: 'urn:x-cast:com.google.cast.tp.connection',
    heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
    receiver: 'urn:x-cast:com.google.cast.receiver',
    media: 'urn:x-cast:com.google.cast.media',
} as const;

export const CAST_SENDER_ID = 'sender-0';
export const CAST_RECEIVER_ID = 'receiver-0';

export type CastPayload = { readonly type: string } & Record<string, unknown>;

export interface CastJsonMessage {
    readonly namespace: string;
    readonly sourceId: string;
    readonly destinationId: string;
    readonly payload: CastPayload & { readonly requestId?: number };
}

export interface CastConnectionOptions {
    readonly host: string;
    readonly port: number;
    readonly connectTimeoutMs?: number;
    readonly requestTimeoutMs?: number;
    readonly heartbeatIntervalMs?: number;
    /** Injectable for tests; defaults to `tls.connect`. */
    readonly connect?: (options: tls.ConnectionOptions) => tls.TLSSocket;
}

interface PendingRequest {
    readonly resolve: (message: CastJsonMessage) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
/** Receivers drop a sender after ~3 missed pings; mirror that here. */
const MISSED_HEARTBEATS_BEFORE_CLOSE = 3;

/**
 * One TLS channel to a Cast receiver (port 8009). JSON payloads only; binary
 * payloads (device authentication) are not used by media playback.
 *
 * Receivers present certificates from Google's device CA, which is not in
 * Node's trust store, so the TLS certificate is not verified. Every
 * open-source sender does the same; the device itself was found by mDNS on
 * the local network and only receives a public media URL.
 */
export class CastConnection {
    private readonly reader = new CastFrameReader();
    private readonly pending = new Map<number, PendingRequest>();
    private readonly messageListeners = new Set<(m: CastJsonMessage) => void>();
    private readonly closeListeners = new Set<(error?: Error) => void>();
    private readonly requestTimeoutMs: number;
    private heartbeat: NodeJS.Timeout | null = null;
    private lastInboundAt = Date.now();
    private nextRequestId = 1;
    private closed = false;

    private constructor(
        private readonly socket: tls.TLSSocket,
        options: CastConnectionOptions
    ) {
        this.requestTimeoutMs =
            options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        socket.on('data', (chunk: Buffer) => this.handleData(chunk));
        socket.on('error', (error) => this.close(error));
        socket.on('close', () => this.close());
        this.startHeartbeat(
            options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
        );
        this.connectTo(CAST_RECEIVER_ID);
    }

    static open(options: CastConnectionOptions): Promise<CastConnection> {
        const connect = options.connect ?? tls.connect;
        return new Promise((resolve, reject) => {
            const socket = connect({
                host: options.host,
                port: options.port,
                rejectUnauthorized: false,
            });
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error('Timed out connecting to the Cast device'));
            }, options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
            const onError = (error: Error) => {
                clearTimeout(timer);
                reject(error);
            };
            socket.once('error', onError);
            socket.once('secureConnect', () => {
                clearTimeout(timer);
                socket.off('error', onError);
                resolve(new CastConnection(socket, options));
            });
        });
    }

    get isClosed(): boolean {
        return this.closed;
    }

    /** Opens a virtual connection to a receiver or application transport. */
    connectTo(destinationId: string): void {
        this.send(CAST_NAMESPACE.connection, destinationId, {
            type: 'CONNECT',
        });
    }

    send(namespace: string, destinationId: string, payload: CastPayload): void {
        if (this.closed) {
            throw new Error('Cast connection is closed');
        }
        this.socket.write(
            encodeCastFrame({
                sourceId: CAST_SENDER_ID,
                destinationId,
                namespace,
                payloadUtf8: JSON.stringify(payload),
            })
        );
    }

    /** Sends with a fresh `requestId` and resolves with the matching reply. */
    request(
        namespace: string,
        destinationId: string,
        payload: CastPayload,
        timeoutMs = this.requestTimeoutMs
    ): Promise<CastJsonMessage> {
        const requestId = this.nextRequestId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error(`Cast request ${payload.type} timed out`));
            }, timeoutMs);
            this.pending.set(requestId, { resolve, reject, timer });
            try {
                this.send(namespace, destinationId, { ...payload, requestId });
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(requestId);
                reject(error as Error);
            }
        });
    }

    onMessage(listener: (message: CastJsonMessage) => void): () => void {
        this.messageListeners.add(listener);
        return () => this.messageListeners.delete(listener);
    }

    onClose(listener: (error?: Error) => void): () => void {
        this.closeListeners.add(listener);
        return () => this.closeListeners.delete(listener);
    }

    close(error?: Error): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
            this.heartbeat = null;
        }
        const reason = error ?? new Error('Cast connection closed');
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(reason);
        }
        this.pending.clear();
        if (error) {
            this.socket.destroy();
        } else {
            // Flush queued frames such as a final STOP before closing.
            this.socket.end();
            setTimeout(() => this.socket.destroy(), 1_000).unref?.();
        }
        for (const listener of this.closeListeners) {
            listener(error);
        }
        this.closeListeners.clear();
        this.messageListeners.clear();
    }

    private startHeartbeat(intervalMs: number): void {
        this.heartbeat = setInterval(() => {
            const silentFor = Date.now() - this.lastInboundAt;
            if (silentFor > intervalMs * MISSED_HEARTBEATS_BEFORE_CLOSE) {
                this.close(new Error('Cast device stopped responding'));
                return;
            }
            this.send(CAST_NAMESPACE.heartbeat, CAST_RECEIVER_ID, {
                type: 'PING',
            });
        }, intervalMs);
        this.heartbeat.unref?.();
    }

    private handleData(chunk: Buffer): void {
        this.lastInboundAt = Date.now();
        let frames: CastMessage[];
        try {
            frames = this.reader.push(chunk);
        } catch (error) {
            this.close(error as Error);
            return;
        }
        for (const frame of frames) {
            const message = parseJsonMessage(frame);
            if (message) {
                this.dispatch(message);
            }
        }
    }

    private dispatch(message: CastJsonMessage): void {
        const { namespace, payload } = message;
        if (namespace === CAST_NAMESPACE.heartbeat) {
            if (payload.type === 'PING') {
                this.send(namespace, message.sourceId, { type: 'PONG' });
            }
            return;
        }
        if (
            namespace === CAST_NAMESPACE.connection &&
            payload.type === 'CLOSE'
        ) {
            if (message.sourceId === CAST_RECEIVER_ID) {
                this.close(new Error('Cast device closed the connection'));
                return;
            }
        }
        const requestId = payload.requestId;
        const pending = requestId ? this.pending.get(requestId) : undefined;
        if (pending && requestId) {
            clearTimeout(pending.timer);
            this.pending.delete(requestId);
            pending.resolve(message);
        }
        for (const listener of this.messageListeners) {
            listener(message);
        }
    }
}

function parseJsonMessage(frame: CastMessage): CastJsonMessage | null {
    if (frame.payloadUtf8 === undefined) {
        return null;
    }
    try {
        const payload = JSON.parse(frame.payloadUtf8) as unknown;
        if (
            !payload ||
            typeof payload !== 'object' ||
            typeof (payload as { type?: unknown }).type !== 'string'
        ) {
            return null;
        }
        return {
            namespace: frame.namespace,
            sourceId: frame.sourceId,
            destinationId: frame.destinationId,
            payload: payload as CastJsonMessage['payload'],
        };
    } catch {
        return null;
    }
}
