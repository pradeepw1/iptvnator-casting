import {
    CAST_CONTROL,
    CAST_DISCOVER_DEVICES,
    CAST_GET_SESSION,
    CAST_SESSION_UPDATE,
    CAST_START,
    CAST_STOP,
    type CastSession,
} from '@iptvnator/shared/interfaces';
import { ipcMain } from 'electron';
import App from '../app';
import { CastController } from '../services/cast/cast-controller';

function broadcastCastSession(session: CastSession | null): void {
    if (App.mainWindow && !App.mainWindow.isDestroyed()) {
        App.mainWindow.webContents.send(CAST_SESSION_UPDATE, session);
    }
}

export const castController = new CastController({
    broadcast: broadcastCastSession,
});

/**
 * IPC owner for Google Cast. Payloads are validated in `CastController`;
 * stream URLs are never logged because provider URLs embed credentials.
 */
export function registerCastEvents(): void {
    ipcMain.handle(CAST_DISCOVER_DEVICES, () =>
        castController.discoverDevices()
    );
    ipcMain.handle(CAST_GET_SESSION, () => castController.getSession());
    ipcMain.handle(CAST_START, (_event, deviceId: unknown, media: unknown) =>
        castController.start(deviceId, media)
    );
    ipcMain.handle(CAST_CONTROL, (_event, command: unknown) =>
        castController.control(command)
    );
    ipcMain.handle(CAST_STOP, () => castController.stop());
}

export function shutdownCasting(): void {
    castController.dispose();
}
