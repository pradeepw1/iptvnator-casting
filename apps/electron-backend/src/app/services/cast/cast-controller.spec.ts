import type { CastSession } from '@iptvnator/shared/interfaces';
import { CastController, parseCastControlCommand } from './cast-controller';
import type { CastReceiverSession } from './cast-receiver-session';
import { CastStartError } from './cast-receiver-session';

const livingRoom = {
    kind: 'chromecast' as const,
    id: 'device-1',
    name: 'Living Room TV',
    model: 'Chromecast',
    host: '192.0.2.10',
    port: 8009,
};
const bedroom = {
    ...livingRoom,
    kind: 'roku' as const,
    id: 'device-2',
    name: 'Bedroom',
    model: undefined,
};
const media = { url: 'https://stream.example.com/live.m3u8', isLive: true };

function fakeSession(
    deviceId: string,
    status: CastSession['status'] = 'playing'
) {
    return {
        snapshot: { deviceId, status } as CastSession,
        control: jest.fn(),
        stop: jest.fn(),
        dispose: jest.fn(),
    };
}

function createController(
    startSession: jest.Mock = jest.fn(
        async (device: { id: string }) =>
            fakeSession(device.id) as unknown as CastReceiverSession
    )
) {
    const broadcast = jest.fn();
    const controller = new CastController({
        broadcast,
        discover: async () => [livingRoom, bedroom],
        startSession,
    });
    return { controller, broadcast, startSession };
}

describe('CastController', () => {
    it('lists discovered devices without their network addresses', async () => {
        const { controller } = createController();

        await expect(controller.discoverDevices()).resolves.toEqual([
            {
                id: 'device-1',
                kind: 'chromecast',
                name: 'Living Room TV',
                model: 'Chromecast',
            },
            { id: 'device-2', kind: 'roku', name: 'Bedroom' },
        ]);
    });

    it('shares one discovery between concurrent callers', async () => {
        const discover = jest.fn(async () => [livingRoom]);
        const controller = new CastController({
            broadcast: jest.fn(),
            discover,
        });

        await Promise.all([
            controller.discoverDevices(),
            controller.discoverDevices(),
        ]);
        expect(discover).toHaveBeenCalledTimes(1);
    });

    it('refuses devices that discovery did not return', async () => {
        const { controller, broadcast, startSession } = createController();

        await expect(
            controller.start('192.0.2.66', media)
        ).resolves.toMatchObject({
            status: 'error',
            error: 'device-not-found',
        });
        expect(startSession).not.toHaveBeenCalled();
        expect(broadcast).toHaveBeenCalledWith(
            expect.objectContaining({ error: 'device-not-found' })
        );
    });

    it('refuses invalid media without connecting', async () => {
        const { controller, startSession } = createController();
        await controller.discoverDevices();

        await expect(
            controller.start('device-1', {
                url: 'file:///etc/hosts',
                isLive: false,
            })
        ).resolves.toMatchObject({ status: 'error', error: 'load-failed' });
        expect(startSession).not.toHaveBeenCalled();
    });

    it('starts a session on a discovered device and forwards its updates', async () => {
        const { controller, broadcast, startSession } = createController();
        await controller.discoverDevices();

        await controller.start('device-1', media);
        const deps = startSession.mock.calls[0][2];
        deps.onUpdate({
            deviceId: 'device-1',
            status: 'playing',
        } as CastSession);

        expect(startSession.mock.calls[0][0]).toBe(livingRoom);
        expect(broadcast).toHaveBeenLastCalledWith(
            expect.objectContaining({ status: 'playing' })
        );
        expect(controller.getSession()).toMatchObject({ status: 'playing' });
    });

    it('replaces media on the same device and stops the old device otherwise', async () => {
        const sessions: ReturnType<typeof fakeSession>[] = [];
        const { controller } = createController(
            jest.fn(async (device: { id: string }) => {
                const session = fakeSession(device.id);
                sessions.push(session);
                return session as unknown as CastReceiverSession;
            })
        );
        await controller.discoverDevices();

        await controller.start('device-1', media);
        await controller.start('device-1', media);
        expect(sessions[0].dispose).toHaveBeenCalled();
        expect(sessions[0].stop).not.toHaveBeenCalled();

        await controller.start('device-2', media);
        expect(sessions[1].stop).toHaveBeenCalled();
    });

    it('ignores updates from a session that was replaced', async () => {
        const { controller, broadcast, startSession } = createController();
        await controller.discoverDevices();
        await controller.start('device-1', media);
        await controller.start('device-2', media);
        broadcast.mockClear();

        startSession.mock.calls[0][2].onUpdate({
            status: 'ended',
        } as CastSession);
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('turns start failures into an error session', async () => {
        const { controller } = createController(
            jest.fn(async () => {
                throw new CastStartError('device-unreachable', 'offline');
            })
        );
        await controller.discoverDevices();

        await expect(
            controller.start('device-1', media)
        ).resolves.toMatchObject({
            deviceName: 'Living Room TV',
            status: 'error',
            error: 'device-unreachable',
        });
    });

    it('forwards valid commands and stops with a null broadcast', async () => {
        const session = fakeSession('device-1');
        const { controller, broadcast } = createController(
            jest.fn(async () => session as unknown as CastReceiverSession)
        );
        await controller.discoverDevices();
        await controller.start('device-1', media);

        controller.control({ type: 'seek', seconds: 10 });
        controller.control({ type: 'seek', seconds: 'soon' });
        controller.stop();

        expect(session.control).toHaveBeenCalledTimes(1);
        expect(session.stop).toHaveBeenCalled();
        expect(broadcast).toHaveBeenLastCalledWith(null);
        expect(controller.getSession()).toBeNull();
    });
});

describe('parseCastControlCommand', () => {
    it.each([
        [{ type: 'play' }, { type: 'play' }],
        [{ type: 'pause', extra: 1 }, { type: 'pause' }],
        [
            { type: 'seek', seconds: 5 },
            { type: 'seek', seconds: 5 },
        ],
        [
            { type: 'volume', level: 0.5 },
            { type: 'volume', level: 0.5 },
        ],
        [
            { type: 'mute', muted: true },
            { type: 'mute', muted: true },
        ],
        [{ type: 'seek', seconds: Infinity }, null],
        [{ type: 'volume' }, null],
        [{ type: 'mute', muted: 'yes' }, null],
        [{ type: 'launch' }, null],
        ['play', null],
        [null, null],
    ])('parses %p', (input, expected) => {
        expect(parseCastControlCommand(input)).toEqual(expected);
    });
});
