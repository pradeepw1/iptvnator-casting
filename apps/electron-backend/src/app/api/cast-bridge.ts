import {
    CAST_CANCEL_WEB_VIDEO_SCAN,
    CAST_CONTROL,
    CAST_DISCOVER_DEVICES,
    CAST_FIND_WEB_VIDEOS,
    CAST_GET_SESSION,
    CAST_SESSION_UPDATE,
    CAST_START,
    CAST_STOP,
    type CastBridgeApi,
    type CastControlCommand,
    type CastMediaRequest,
    type CastSession,
} from '@iptvnator/shared/interfaces';
import { ipcRenderer, type IpcRendererEvent } from 'electron';

/**
 * Preload half of `cast.events.ts` and `web-video.events.ts`, spread into
 * `window.electron`.
 */
export const castBridge: Required<CastBridgeApi> = {
    castDiscoverDevices: () => ipcRenderer.invoke(CAST_DISCOVER_DEVICES),
    castGetSession: () => ipcRenderer.invoke(CAST_GET_SESSION),
    castStart: (deviceId: string, media: CastMediaRequest) =>
        ipcRenderer.invoke(CAST_START, deviceId, media),
    castControl: (command: CastControlCommand) =>
        ipcRenderer.invoke(CAST_CONTROL, command),
    castStop: () => ipcRenderer.invoke(CAST_STOP),
    castFindWebVideos: (pageUrl: string) =>
        ipcRenderer.invoke(CAST_FIND_WEB_VIDEOS, pageUrl),
    castCancelWebVideoScan: () =>
        ipcRenderer.invoke(CAST_CANCEL_WEB_VIDEO_SCAN),
    onCastSessionUpdate: (callback: (session: CastSession | null) => void) => {
        const handler = (
            _event: IpcRendererEvent,
            session: CastSession | null
        ) => callback(session);
        ipcRenderer.on(CAST_SESSION_UPDATE, handler);
        return () => ipcRenderer.off(CAST_SESSION_UPDATE, handler);
    },
};
