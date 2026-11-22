import type { CastErrorCode, CastSession } from '@iptvnator/shared/interfaces';

/** The card the controls show over the picture while it is on the TV. */
export interface PlayerCastStatusCard {
    readonly titleKey: string;
    readonly device: string;
    readonly messageKey: string | null;
    readonly failed: boolean;
}

const ERROR_MESSAGE_KEYS: Readonly<Record<CastErrorCode, string>> = {
    'device-not-found': 'CAST.ERROR_UNREACHABLE',
    'device-unreachable': 'CAST.ERROR_UNREACHABLE',
    'launch-failed': 'CAST.ERROR_LOAD',
    'load-failed': 'CAST.ERROR_LOAD',
    'connection-lost': 'CAST.ERROR_LOST',
    'control-blocked': 'CAST.ERROR_ROKU_BLOCKED',
};

export function resolvePlayerCastStatusCard(
    session: CastSession | null
): PlayerCastStatusCard | null {
    if (!session) {
        return null;
    }
    const device = session.deviceName;
    switch (session.status) {
        case 'connecting':
        case 'loading':
            return {
                titleKey: 'CAST.CONNECTING',
                device,
                messageKey: null,
                failed: false,
            };
        case 'buffering':
        case 'playing':
        case 'paused':
            return {
                titleKey: 'CAST.PLAYING_ON',
                device,
                messageKey: null,
                failed: false,
            };
        case 'error':
            return {
                titleKey: 'CAST.FAILED',
                device,
                messageKey: ERROR_MESSAGE_KEYS[session.error ?? 'load-failed'],
                failed: true,
            };
        default:
            return null;
    }
}
