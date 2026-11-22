import type {
    CastMediaRequest,
    CastReceiverKind,
} from '@iptvnator/shared/interfaces';
import { discoverCastDevices } from './cast-discovery';
import { CastReceiverSession } from './cast-receiver-session';
import type { CastServiceRecord } from './mdns.codec';
import type { ReceiverSession, ReceiverSessionDeps } from './receiver-session';
import { discoverRokuDevices } from './roku/roku-discovery';
import { RokuReceiverSession } from './roku/roku-receiver-session';

/** A discovered receiver: where it is and which protocol it speaks. */
export interface ReceiverRecord extends CastServiceRecord {
    readonly kind: CastReceiverKind;
}

/**
 * Searches for Google Cast and Roku receivers at the same time. One family
 * failing (a busy port, a blocked socket) never hides the other.
 */
export async function discoverReceivers(): Promise<ReceiverRecord[]> {
    const [chromecasts, rokus] = await Promise.all([
        discoverCastDevices().catch(() => []),
        discoverRokuDevices().catch(() => []),
    ]);
    return [
        ...chromecasts.map((device) => ({
            ...device,
            kind: 'chromecast' as const,
        })),
        ...rokus.map((device) => ({ ...device, kind: 'roku' as const })),
    ].sort((left, right) => left.name.localeCompare(right.name));
}

/** Starts a session with the protocol the receiver speaks. */
export function startReceiverSession(
    device: ReceiverRecord,
    media: CastMediaRequest,
    deps: ReceiverSessionDeps
): Promise<ReceiverSession> {
    return device.kind === 'roku'
        ? RokuReceiverSession.start(device, media, deps)
        : CastReceiverSession.start(device, media, deps);
}
