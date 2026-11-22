import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RuntimeCapabilitiesService } from '@iptvnator/services';
import type {
    CastBridgeApi,
    CastControlCommand,
    CastMediaRequest,
    CastSession,
    ResolvedPortalPlayback,
} from '@iptvnator/shared/interfaces';
import type { PlayerCastMedia } from './player-cast-media';
import { PlayerCastController } from './player-cast.controller';
import { providePlayerCast } from './player-cast.providers';

const session: CastSession = {
    deviceId: 'device-1',
    deviceName: 'Living Room TV',
    status: 'playing',
    isLive: false,
    positionSeconds: 0,
    durationSeconds: 3600,
    volume: 1,
    muted: false,
    canSeek: true,
    canSetVolume: true,
};

function media(url: string, isLive = false): PlayerCastMedia {
    return {
        request: { url, title: 'Example', isLive },
        needsCustomHeaders: false,
    };
}

function installBridge(initial: CastSession | null = null) {
    let listener: ((value: CastSession | null) => void) | undefined;
    const bridge: jest.Mocked<Required<CastBridgeApi>> = {
        castDiscoverDevices: jest.fn(async () => [
            {
                id: 'device-1',
                kind: 'chromecast' as const,
                name: 'Living Room TV',
            },
        ]),
        castGetSession: jest.fn(async () => initial),
        castStart: jest.fn<Promise<CastSession>, [string, CastMediaRequest]>(
            async (deviceId) => ({ ...session, deviceId })
        ),
        castControl: jest.fn<Promise<void>, [CastControlCommand]>(
            async () => undefined
        ),
        castStop: jest.fn(async () => undefined),
        onCastSessionUpdate: jest.fn((callback) => {
            listener = callback;
            return jest.fn();
        }),
        castFindWebVideos: jest.fn(),
        castCancelWebVideoScan: jest.fn(async () => undefined),
    };
    (window as unknown as { electron: unknown }).electron = bridge;
    return { bridge, push: (value: CastSession | null) => listener?.(value) };
}

function createController(supportsCasting = true) {
    TestBed.configureTestingModule({
        providers: [
            PlayerCastController,
            {
                provide: RuntimeCapabilitiesService,
                useValue: { supportsCasting },
            },
        ],
    });
    return TestBed.inject(PlayerCastController);
}

describe('PlayerCastController', () => {
    afterEach(() => {
        delete (window as unknown as { electron?: unknown }).electron;
        TestBed.resetTestingModule();
    });

    it('stays inert when the runtime cannot cast', () => {
        const { bridge } = installBridge();
        const controller = createController(false);
        controller.bindMedia(() => media('https://stream.example.com/a.m3u8'));

        expect(controller.available()).toBe(false);
        expect(bridge.onCastSessionUpdate).not.toHaveBeenCalled();
    });

    it('is available once media is bound', () => {
        installBridge();
        const controller = createController();
        expect(controller.available()).toBe(false);

        controller.bindMedia(() => media('https://stream.example.com/a.m3u8'));
        expect(controller.available()).toBe(true);
    });

    it('lists devices from discovery', async () => {
        installBridge();
        const controller = createController();

        await controller.discover();
        expect(controller.devices()).toEqual([
            { id: 'device-1', kind: 'chromecast', name: 'Living Room TV' },
        ]);
        expect(controller.discovering()).toBe(false);
    });

    it('casts VOD from the local position and live from the live edge', async () => {
        const { bridge } = installBridge();
        const controller = createController();
        controller.bindMedia(() =>
            media('https://stream.example.com/movie.mp4')
        );

        await controller.castTo('device-1', 754);
        expect(bridge.castStart).toHaveBeenLastCalledWith('device-1', {
            url: 'https://stream.example.com/movie.mp4',
            title: 'Example',
            isLive: false,
            startTime: 754,
        });
        expect(controller.active()).toBe(true);

        controller.bindMedia(() =>
            media('https://stream.example.com/live.m3u8', true)
        );
        await controller.castTo('device-1', 754);
        expect(bridge.castStart.mock.calls.at(-1)?.[1]).not.toHaveProperty(
            'startTime'
        );
    });

    it('follows session updates pushed by the main process', async () => {
        const { push } = installBridge();
        const controller = createController();

        push(session);
        expect(controller.active()).toBe(true);
        expect(controller.statusCard()?.titleKey).toBe('CAST.PLAYING_ON');

        push({ ...session, status: 'error', error: 'connection-lost' });
        expect(controller.active()).toBe(false);
        expect(controller.error()).toBe('connection-lost');

        controller.dismissError();
        expect(controller.session()).toBeNull();
    });

    it('sends transport commands only while a session is active', () => {
        const { bridge, push } = installBridge();
        const controller = createController();

        controller.togglePlay();
        expect(bridge.castControl).not.toHaveBeenCalled();

        push(session);
        controller.togglePlay();
        push({ ...session, status: 'paused' });
        controller.togglePlay();
        controller.seekTo(30);
        controller.setVolume(0.5);
        expect(
            bridge.castControl.mock.calls.map(([command]) => command)
        ).toEqual([
            { type: 'pause' },
            { type: 'play' },
            { type: 'seek', seconds: 30 },
            { type: 'volume', level: 0.5 },
        ]);
    });

    it('sends channel switches to the TV it is casting to', async () => {
        const { bridge } = installBridge();
        const controller = createController();
        const source = signal(
            media('https://stream.example.com/one.m3u8', true)
        );
        controller.bindMedia(() => source());

        await controller.castTo('device-1');
        TestBed.tick();
        expect(bridge.castStart).toHaveBeenCalledTimes(1);

        source.set(media('https://stream.example.com/two.m3u8', true));
        TestBed.tick();
        expect(bridge.castStart).toHaveBeenCalledTimes(2);
        expect(bridge.castStart.mock.calls[1][1].url).toBe(
            'https://stream.example.com/two.m3u8'
        );
    });

    it('adopts a cast that was already running without replacing it', async () => {
        const { bridge, push } = installBridge();
        const controller = createController();
        controller.bindMedia(() =>
            media('https://stream.example.com/other.m3u8', true)
        );

        push(session);
        TestBed.tick();
        expect(bridge.castStart).not.toHaveBeenCalled();
    });

    it('offers the host view playback through providePlayerCast', () => {
        installBridge();
        class FakePlayerView {
            readonly resolvedPlayback = signal<ResolvedPortalPlayback | null>({
                streamUrl: 'https://stream.example.com/live/index.m3u8',
                title: 'Example News',
            });
            readonly resolvedIsLive = signal(true);
        }
        TestBed.configureTestingModule({
            providers: [
                FakePlayerView,
                providePlayerCast(() => FakePlayerView),
                {
                    provide: RuntimeCapabilitiesService,
                    useValue: { supportsCasting: true },
                },
            ],
        });
        const controller = TestBed.inject(PlayerCastController);
        const view = TestBed.inject(FakePlayerView);

        expect(controller.media()?.request).toMatchObject({
            url: 'https://stream.example.com/live/index.m3u8',
            isLive: true,
        });
        view.resolvedPlayback.set({ streamUrl: 'blob:local', title: 'Local' });
        expect(controller.available()).toBe(false);
    });

    it('stops through the main process', () => {
        const { bridge } = installBridge();
        createController().stop();
        expect(bridge.castStop).toHaveBeenCalled();
    });
});
