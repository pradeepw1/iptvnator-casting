import { EventEmitter } from 'node:events';
import type * as tls from 'node:tls';
import type { CastJsonMessage, CastPayload } from './cast-connection';
import {
    CastFrameReader,
    encodeCastFrame,
    type CastMessage,
} from './cast-message.codec';

/** In-memory TLS socket: records written frames, lets tests inject replies. */
export class FakeCastSocket extends EventEmitter {
    readonly written: CastMessage[] = [];
    destroyed = false;
    ended = false;
    private readonly reader = new CastFrameReader();

    write(chunk: Buffer): boolean {
        this.written.push(...this.reader.push(chunk));
        return true;
    }

    end(): this {
        this.ended = true;
        return this;
    }

    destroy(): this {
        this.destroyed = true;
        return this;
    }

    /** Payloads written so far, parsed. */
    payloads(): Array<CastPayload & { requestId?: number }> {
        return this.written.map((frame) =>
            JSON.parse(frame.payloadUtf8 ?? '{}')
        );
    }

    receive(
        namespace: string,
        payload: Record<string, unknown>,
        sourceId = 'receiver-0'
    ): void {
        this.emit(
            'data',
            encodeCastFrame({
                sourceId,
                destinationId: 'sender-0',
                namespace,
                payloadUtf8: JSON.stringify(payload),
            })
        );
    }

    asTlsConnect(): (options: tls.ConnectionOptions) => tls.TLSSocket {
        return () => {
            queueMicrotask(() => this.emit('secureConnect'));
            return this as unknown as tls.TLSSocket;
        };
    }
}

/** Connection double for session tests: records sends, replays replies. */
export class FakeCastConnection {
    readonly sent: Array<{
        namespace: string;
        destinationId: string;
        payload: CastPayload;
    }> = [];
    readonly connected: string[] = [];
    isClosed = false;
    /** Reply produced for each request; return undefined to leave it pending. */
    respond: (
        namespace: string,
        payload: CastPayload
    ) => CastJsonMessage | Error | undefined = () => undefined;
    private readonly messageListeners = new Set<(m: CastJsonMessage) => void>();
    private readonly closeListeners = new Set<(error?: Error) => void>();

    connectTo(destinationId: string): void {
        this.connected.push(destinationId);
    }

    request(
        namespace: string,
        destinationId: string,
        payload: CastPayload
    ): Promise<CastJsonMessage> {
        this.sent.push({ namespace, destinationId, payload });
        const reply = this.respond(namespace, payload);
        if (reply instanceof Error) {
            return Promise.reject(reply);
        }
        if (reply) {
            this.deliver(reply);
            return Promise.resolve(reply);
        }
        return new Promise(() => undefined);
    }

    deliver(message: CastJsonMessage): void {
        for (const listener of [...this.messageListeners]) {
            listener(message);
        }
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
        if (this.isClosed) {
            return;
        }
        this.isClosed = true;
        for (const listener of this.closeListeners) {
            listener(error);
        }
    }

    sentTypes(): string[] {
        return this.sent.map((entry) => entry.payload.type);
    }
}

export function castReply(
    namespace: string,
    payload: Record<string, unknown> & { type: string },
    sourceId = 'receiver-0'
): CastJsonMessage {
    return { namespace, sourceId, destinationId: 'sender-0', payload };
}
