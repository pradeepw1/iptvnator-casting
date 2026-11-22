import type { WebVideoBridgeApi } from './web-video.interface';

/**
 * Casting contracts shared by the Electron backend, the preload bridge and the
 * renderer. Two receiver families: Google Cast (Chromecast, Google TV), whose
 * protocol the backend speaks itself because Electron does not ship Chrome's
 * Cast sender API, and Roku, driven through its External Control Protocol.
 */

/** IPC channel names. Push-only updates use `CAST_SESSION_UPDATE`. */
export const CAST_DISCOVER_DEVICES = 'CAST:DISCOVER_DEVICES';
export const CAST_GET_SESSION = 'CAST:GET_SESSION';
export const CAST_START = 'CAST:START';
export const CAST_CONTROL = 'CAST:CONTROL';
export const CAST_STOP = 'CAST:STOP';
export const CAST_SESSION_UPDATE = 'CAST:SESSION_UPDATE';

export type CastReceiverKind = 'chromecast' | 'roku';

/**
 * A receiver found on the local network. `id` is an opaque backend handle:
 * the renderer can only cast to devices the backend discovered itself.
 */
export interface CastDevice {
    readonly id: string;
    readonly kind: CastReceiverKind;
    readonly name: string;
    readonly model?: string;
}

export type CastSessionStatus =
    | 'connecting'
    | 'loading'
    | 'buffering'
    | 'playing'
    | 'paused'
    | 'ended'
    | 'error';

export type CastErrorCode =
    | 'device-not-found'
    | 'device-unreachable'
    | 'launch-failed'
    | 'load-failed'
    | 'connection-lost'
    /** A Roku whose "Control by mobile apps" access refuses the command. */
    | 'control-blocked';

export interface CastSession {
    readonly deviceId: string;
    readonly deviceName: string;
    readonly status: CastSessionStatus;
    readonly isLive: boolean;
    readonly title?: string;
    readonly positionSeconds: number;
    readonly durationSeconds: number | null;
    /** Receiver volume, 0..1. */
    readonly volume: number;
    readonly muted: boolean;
    /** Whether the receiver can jump to a position (Roku cannot). */
    readonly canSeek: boolean;
    /** Whether the receiver takes an absolute volume (Roku does not). */
    readonly canSetVolume: boolean;
    readonly error?: CastErrorCode;
}

export interface CastMediaRequest {
    /** Must be an http(s) URL the receiver can reach on its own. */
    readonly url: string;
    readonly title?: string;
    readonly thumbnail?: string;
    readonly isLive: boolean;
    /** VOD resume position in seconds. */
    readonly startTime?: number;
    /** Overrides the MIME type inferred from the URL. */
    readonly contentType?: string;
}

export type CastControlCommand =
    | { readonly type: 'play' }
    | { readonly type: 'pause' }
    | { readonly type: 'seek'; readonly seconds: number }
    | { readonly type: 'volume'; readonly level: number }
    | { readonly type: 'mute'; readonly muted: boolean };

/**
 * Preload methods owned by `cast.events.ts`. They are optional on
 * `ElectronBridgeApi` so renderer code must go through the
 * `supportsCasting` runtime capability instead of a generic bridge check.
 */
export interface CastBridgeApi extends WebVideoBridgeApi {
    castDiscoverDevices?: () => Promise<CastDevice[]>;
    castGetSession?: () => Promise<CastSession | null>;
    castStart?: (
        deviceId: string,
        media: CastMediaRequest
    ) => Promise<CastSession>;
    castControl?: (command: CastControlCommand) => Promise<void>;
    castStop?: () => Promise<void>;
    onCastSessionUpdate?: (
        callback: (session: CastSession | null) => void
    ) => () => void;
}
