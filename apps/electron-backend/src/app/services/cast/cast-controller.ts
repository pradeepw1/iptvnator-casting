import type {
    CastControlCommand,
    CastDevice,
    CastMediaRequest,
    CastSession,
} from '@iptvnator/shared/interfaces';
import {
    InvalidCastMediaError,
    normalizeCastMediaRequest,
} from './cast-media-payload';
import { CastStartError } from './cast-receiver-session';
import {
    discoverReceivers,
    type ReceiverRecord,
    startReceiverSession,
} from './receiver-discovery';
import type { ReceiverSession, ReceiverSessionDeps } from './receiver-session';

export interface CastControllerDeps {
    readonly broadcast: (session: CastSession | null) => void;
    readonly discover?: () => Promise<ReceiverRecord[]>;
    readonly startSession?: (
        device: ReceiverRecord,
        media: CastMediaRequest,
        deps: ReceiverSessionDeps
    ) => Promise<ReceiverSession>;
}

const TERMINAL_STATUSES = new Set(['ended', 'error']);

function errorSession(
    device: Pick<ReceiverRecord, 'id' | 'name'> | undefined,
    media: Pick<CastMediaRequest, 'isLive' | 'title'> | undefined,
    error: CastSession['error']
): CastSession {
    return {
        deviceId: device?.id ?? '',
        deviceName: device?.name ?? '',
        status: 'error',
        error,
        isLive: media?.isLive ?? false,
        title: media?.title,
        positionSeconds: 0,
        durationSeconds: null,
        volume: 1,
        muted: false,
        canSeek: false,
        canSetVolume: false,
    };
}

/** Validates an untrusted renderer command. */
export function parseCastControlCommand(
    value: unknown
): CastControlCommand | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const raw = value as Record<string, unknown>;
    const finite = (input: unknown): input is number =>
        typeof input === 'number' && Number.isFinite(input);
    switch (raw['type']) {
        case 'play':
        case 'pause':
            return { type: raw['type'] };
        case 'seek':
            return finite(raw['seconds'])
                ? { type: 'seek', seconds: raw['seconds'] }
                : null;
        case 'volume':
            return finite(raw['level'])
                ? { type: 'volume', level: raw['level'] }
                : null;
        case 'mute':
            return typeof raw['muted'] === 'boolean'
                ? { type: 'mute', muted: raw['muted'] }
                : null;
        default:
            return null;
    }
}

/**
 * Main-process owner of casting: the device list from the latest discovery
 * and at most one active receiver session. The renderer refers to devices
 * by id only, so it can never make the main process connect to an
 * arbitrary host.
 */
export class CastController {
    private readonly devices = new Map<string, ReceiverRecord>();
    private discovery: Promise<CastDevice[]> | null = null;
    private session: ReceiverSession | null = null;
    private lastSnapshot: CastSession | null = null;
    private generation = 0;

    constructor(private readonly deps: CastControllerDeps) {}

    discoverDevices(): Promise<CastDevice[]> {
        this.discovery ??= (this.deps.discover ?? discoverReceivers)()
            .then((receivers) => {
                this.devices.clear();
                for (const receiver of receivers) {
                    this.devices.set(receiver.id, receiver);
                }
                return receivers.map(({ id, kind, name, model }) => ({
                    id,
                    kind,
                    name,
                    ...(model ? { model } : {}),
                }));
            })
            .catch(() => [] as CastDevice[])
            .finally(() => {
                this.discovery = null;
            });
        return this.discovery;
    }

    getSession(): CastSession | null {
        return this.lastSnapshot;
    }

    /** Resolves with the session state; failures resolve as `status: 'error'`. */
    async start(deviceId: unknown, rawMedia: unknown): Promise<CastSession> {
        const device =
            typeof deviceId === 'string'
                ? this.devices.get(deviceId)
                : undefined;
        let media: CastMediaRequest;
        try {
            media = normalizeCastMediaRequest(rawMedia);
        } catch (error) {
            if (error instanceof InvalidCastMediaError) {
                return errorSession(device, undefined, 'load-failed');
            }
            throw error;
        }
        if (!device) {
            return this.publish(
                errorSession(undefined, media, 'device-not-found')
            );
        }

        const previous = this.session;
        this.session = null;
        if (previous?.snapshot.deviceId === device.id) {
            // Relaunching the running receiver app replaces its media.
            previous.dispose();
        } else {
            previous?.stop();
        }

        const generation = ++this.generation;
        const start = this.deps.startSession ?? startReceiverSession;
        try {
            const session = await start(device, media, {
                onUpdate: (snapshot) => {
                    if (generation === this.generation) {
                        this.handleUpdate(snapshot);
                    }
                },
            });
            if (generation !== this.generation) {
                // Another start() replaced this one while it was loading.
                session.dispose();
                return session.snapshot;
            }
            if (!TERMINAL_STATUSES.has(session.snapshot.status)) {
                this.session = session;
            }
            return session.snapshot;
        } catch (error) {
            const code =
                error instanceof CastStartError ? error.code : 'launch-failed';
            const failed = errorSession(device, media, code);
            return generation === this.generation
                ? this.publish(failed)
                : failed;
        }
    }

    control(rawCommand: unknown): void {
        const command = parseCastControlCommand(rawCommand);
        if (command && this.session) {
            this.session.control(command);
        }
    }

    stop(): void {
        this.generation += 1;
        this.session?.stop();
        this.session = null;
        this.publish(null);
    }

    /** App shutdown: leave the TV playing, just drop the connection. */
    dispose(): void {
        this.generation += 1;
        this.session?.dispose();
        this.session = null;
    }

    private handleUpdate(snapshot: CastSession): void {
        this.publish(snapshot);
        if (TERMINAL_STATUSES.has(snapshot.status)) {
            this.session = null;
        }
    }

    private publish<T extends CastSession | null>(session: T): T {
        this.lastSnapshot = session;
        this.deps.broadcast(session);
        return session;
    }
}
