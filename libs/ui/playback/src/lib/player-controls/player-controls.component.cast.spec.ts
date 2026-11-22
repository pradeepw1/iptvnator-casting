import { signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { CastSession } from '@iptvnator/shared/interfaces';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { PlayerCastController } from '../cast/player-cast.controller';
import type { PlayerCastMedia } from '../cast/player-cast-media';
import { resolvePlayerCastStatusCard } from '../cast/player-cast-status';
import {
    DEFAULT_PLAYER_CAPABILITIES,
    createEmptyControlsState,
} from './player-controls-defaults';
import { PlayerControlsComponent } from './player-controls.component';
import type {
    PlayerController,
    PlayerControlsCommands,
    PlayerControlsState,
} from './player-controls.model';

const playing: CastSession = {
    deviceId: 'device-1',
    deviceName: 'Living Room TV',
    status: 'playing',
    isLive: false,
    positionSeconds: 600,
    durationSeconds: 3600,
    volume: 0.5,
    muted: false,
    canSeek: true,
    canSetVolume: true,
};

/** Signal-backed stand-in for the injectable controller. */
class FakeCastController {
    readonly media: WritableSignal<PlayerCastMedia | null> = signal({
        request: { url: 'https://stream.example.com/movie.mp4', isLive: false },
        needsCustomHeaders: false,
    });
    readonly session: WritableSignal<CastSession | null> = signal(null);
    readonly available = signal(true);
    readonly active = signal(false);
    readonly devices = signal([]);
    readonly discovering = signal(false);
    readonly statusCard = signal(resolvePlayerCastStatusCard(null));
    readonly togglePlay = jest.fn();
    readonly seekTo = jest.fn();
    readonly setVolume = jest.fn();
    readonly discover = jest.fn(async () => undefined);
    readonly castTo = jest.fn(async () => undefined);
    readonly stop = jest.fn();
    readonly dismissError = jest.fn();

    setSession(session: CastSession | null): void {
        this.session.set(session);
        this.active.set(!!session && session.status !== 'error');
        this.statusCard.set(resolvePlayerCastStatusCard(session));
    }
}

function createHost() {
    const state: WritableSignal<PlayerControlsState> = signal({
        ...createEmptyControlsState(),
        status: 'playing',
        positionSeconds: 42,
        durationSeconds: 3600,
        volume: 1,
    });
    const commands = {
        togglePlay: jest.fn(),
        seekTo: jest.fn(),
        seekBy: jest.fn(),
        setVolume: jest.fn(),
    } as unknown as jest.Mocked<PlayerControlsCommands>;
    const controller: PlayerController = {
        capabilities: signal({
            ...DEFAULT_PLAYER_CAPABILITIES,
            seek: true,
            volume: true,
        }),
        state,
        commands,
    };
    return { controller, state, commands };
}

describe('PlayerControlsComponent casting', () => {
    let fixture: ComponentFixture<PlayerControlsComponent>;
    let cast: FakeCastController;
    let host: ReturnType<typeof createHost>;

    const castButton = () =>
        fixture.nativeElement.querySelector(
            '[data-test-id="player-controls-cast-button"]'
        ) as HTMLButtonElement | null;
    const statusCard = () =>
        fixture.nativeElement.querySelector(
            '[data-test-id="player-cast-status"]'
        ) as HTMLElement | null;

    async function render(withCast = true) {
        cast = new FakeCastController();
        host = createHost();
        await TestBed.configureTestingModule({
            imports: [PlayerControlsComponent, TranslateModule.forRoot()],
            providers: withCast
                ? [{ provide: PlayerCastController, useValue: cast }]
                : [],
        }).compileComponents();
        const translate = TestBed.inject(TranslateService);
        translate.setTranslation('en', {
            CAST: {
                CAST: 'Cast to TV',
                STOP: 'Stop casting',
                PLAYING_ON: 'Playing on {{device}}',
                FAILED: "Couldn't play on {{device}}",
                ERROR_UNREACHABLE: "The device didn't respond.",
            },
            CLOSE: 'Close',
        });
        translate.use('en');
        fixture = TestBed.createComponent(PlayerControlsComponent);
        fixture.componentRef.setInput('controller', host.controller);
        fixture.detectChanges();
    }

    afterEach(() => TestBed.resetTestingModule());

    it('shows no cast button on hosts without a cast controller', async () => {
        await render(false);
        expect(castButton()).toBeNull();
    });

    it('shows the cast button only when the media can be cast', async () => {
        await render();
        expect(castButton()?.getAttribute('aria-label')).toBe('Cast to TV');

        cast.available.set(false);
        fixture.detectChanges();
        expect(castButton()).toBeNull();
    });

    it('drives the TV and pauses local playback once casting starts', async () => {
        await render();
        cast.setSession(playing);
        fixture.detectChanges();
        TestBed.tick();

        expect(host.commands.togglePlay).toHaveBeenCalledTimes(1);
        expect(statusCard()?.textContent).toContain(
            'Playing on Living Room TV'
        );
        expect(castButton()?.textContent).toContain('cast_connected');

        const controls = fixture.componentInstance;
        expect(controls.controller().state().positionSeconds).toBe(600);
        controls.controller().commands.togglePlay();
        expect(cast.togglePlay).toHaveBeenCalled();
        expect(host.commands.togglePlay).toHaveBeenCalledTimes(1);
    });

    it('stops casting from the status card', async () => {
        await render();
        cast.setSession(playing);
        fixture.detectChanges();

        (statusCard()?.querySelector('button') as HTMLButtonElement).click();
        expect(cast.stop).toHaveBeenCalled();
    });

    it('explains a failed cast and lets the user dismiss it', async () => {
        await render();
        cast.setSession({
            ...playing,
            status: 'error',
            error: 'device-unreachable',
        });
        fixture.detectChanges();

        expect(statusCard()?.textContent).toContain(
            "Couldn't play on Living Room TV"
        );
        expect(statusCard()?.textContent).toContain(
            "The device didn't respond."
        );
        (statusCard()?.querySelector('button') as HTMLButtonElement).click();
        expect(cast.dismissError).toHaveBeenCalled();
        expect(cast.stop).not.toHaveBeenCalled();
    });
});
