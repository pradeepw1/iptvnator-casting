import {
    computed,
    DestroyRef,
    effect,
    inject,
    Injectable,
    signal,
    untracked,
} from '@angular/core';
import { RuntimeCapabilitiesService } from '@iptvnator/services';
import type {
    CastControlCommand,
    CastDevice,
    CastErrorCode,
    CastSession,
} from '@iptvnator/shared/interfaces';
import { isCastSessionActive, type PlayerCastMedia } from './player-cast-media';
import { resolvePlayerCastStatusCard } from './player-cast-status';

/**
 * Renderer half of casting, scoped to one player view. The main process owns
 * the receiver connection, so the session outlives this controller: leaving
 * the player keeps the TV playing, and the next player view picks the
 * session up again.
 */
@Injectable()
export class PlayerCastController {
    readonly supported = inject(RuntimeCapabilitiesService).supportsCasting;

    private readonly mediaSource = signal<() => PlayerCastMedia | null>(
        () => null
    );
    readonly media = computed(() => this.mediaSource()());
    readonly available = computed(() => this.supported && !!this.media());

    readonly devices = signal<readonly CastDevice[]>([]);
    readonly discovering = signal(false);
    readonly session = signal<CastSession | null>(null);
    readonly active = computed(() => isCastSessionActive(this.session()));
    readonly error = computed<CastErrorCode | null>(() => {
        const session = this.session();
        return session?.status === 'error'
            ? (session.error ?? 'load-failed')
            : null;
    });

    readonly statusCard = computed(() =>
        resolvePlayerCastStatusCard(this.session())
    );

    /** URL this view last sent (or adopted from a running session). */
    private castUrl: string | null = null;
    /** Set once anything newer than the startup snapshot has arrived. */
    private sessionKnown = false;

    constructor() {
        if (!this.supported) {
            return;
        }
        const unsubscribe = window.electron?.onCastSessionUpdate?.((session) =>
            this.applySession(session)
        );
        // The snapshot may resolve after a push or a local cast; never let
        // it overwrite newer state.
        void window.electron?.castGetSession?.().then((session) => {
            if (!this.sessionKnown) {
                this.session.set(session);
            }
        });
        inject(DestroyRef).onDestroy(() => unsubscribe?.());

        // Channel and episode switches follow the TV while casting. A view
        // that opens during someone else's cast adopts it without hijacking.
        effect(() => {
            const media = this.media();
            const active = this.active();
            untracked(() => this.followMedia(media, active));
        });
    }

    bindMedia(source: () => PlayerCastMedia | null): void {
        this.mediaSource.set(source);
    }

    async discover(): Promise<void> {
        if (!this.supported || this.discovering()) {
            return;
        }
        this.discovering.set(true);
        try {
            this.devices.set(
                (await window.electron?.castDiscoverDevices?.()) ?? []
            );
        } catch {
            this.devices.set([]);
        } finally {
            this.discovering.set(false);
        }
    }

    /** Casts the current media, resuming VOD at the local position. */
    async castTo(deviceId: string, positionSeconds = 0): Promise<void> {
        const media = this.media();
        if (!this.supported || !media) {
            return;
        }
        const { request } = media;
        this.castUrl = request.url;
        const session = await window.electron?.castStart?.(deviceId, {
            ...request,
            ...(!request.isLive && positionSeconds > 0
                ? { startTime: positionSeconds }
                : {}),
        });
        if (session) {
            this.applySession(session);
        }
    }

    stop(): void {
        this.castUrl = null;
        void window.electron?.castStop?.();
    }

    /** Clears a failed attempt's card; an active session is untouched. */
    dismissError(): void {
        if (this.session()?.status === 'error') {
            this.applySession(null);
        }
    }

    togglePlay(): void {
        this.control({
            type: this.session()?.status === 'paused' ? 'play' : 'pause',
        });
    }

    seekTo(seconds: number): void {
        this.control({ type: 'seek', seconds });
    }

    setVolume(level: number): void {
        this.control({ type: 'volume', level });
    }

    private applySession(session: CastSession | null): void {
        this.sessionKnown = true;
        this.session.set(session);
    }

    private control(command: CastControlCommand): void {
        if (this.active()) {
            void window.electron?.castControl?.(command);
        }
    }

    private followMedia(media: PlayerCastMedia | null, active: boolean): void {
        if (!active || !media || media.request.url === this.castUrl) {
            return;
        }
        if (this.castUrl === null) {
            this.castUrl = media.request.url;
            return;
        }
        const deviceId = this.session()?.deviceId;
        if (deviceId) {
            void this.castTo(deviceId);
        }
    }
}
