import {
    CAST_CANCEL_WEB_VIDEO_SCAN,
    CAST_FIND_WEB_VIDEOS,
} from '@iptvnator/shared/interfaces';
import { ipcMain } from 'electron';
import { findWebVideos } from '../services/web-video/web-video-finder';

let activeScan: AbortController | null = null;

/**
 * IPC owner for "Cast a web video". One scan at a time: a new request or a
 * cancel aborts the previous one. Page and stream URLs are never logged.
 */
export function registerWebVideoEvents(): void {
    ipcMain.handle(CAST_FIND_WEB_VIDEOS, async (_event, pageUrl: unknown) => {
        activeScan?.abort();
        const scan = new AbortController();
        activeScan = scan;
        try {
            return await findWebVideos(pageUrl, { signal: scan.signal });
        } finally {
            if (activeScan === scan) {
                activeScan = null;
            }
        }
    });
    ipcMain.handle(CAST_CANCEL_WEB_VIDEO_SCAN, () => {
        activeScan?.abort();
        activeScan = null;
    });
}

export function shutdownWebVideoScans(): void {
    activeScan?.abort();
    activeScan = null;
}
