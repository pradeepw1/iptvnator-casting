import type {
    CastControlCommand,
    CastSession,
} from '@iptvnator/shared/interfaces';

/**
 * One cast to one receiver, whatever its protocol. `stop()` ends playback on
 * the device; `dispose()` only detaches this app and leaves the TV playing.
 */
export interface ReceiverSession {
    readonly snapshot: CastSession;
    control(command: CastControlCommand): void;
    stop(): void;
    dispose(): void;
}

export interface ReceiverSessionDeps {
    readonly onUpdate: (session: CastSession) => void;
}
