import type {
    CastControlCommand,
    CastMediaRequest,
    CastSession,
    CastSessionStatus,
} from '@iptvnator/shared/interfaces';
import { CastStartError } from '../cast-receiver-session';
import type { CastServiceRecord } from '../mdns.codec';
import type { ReceiverSession, ReceiverSessionDeps } from '../receiver-session';
import {
    PLAY_ON_ROKU_CHANNEL,
    RokuControlBlockedError,
    RokuEcpClient,
    type RokuPlayerState,
} from './roku-ecp-client';

export interface RokuReceiverSessionDeps extends ReceiverSessionDeps {
    readonly client?: RokuEcpClient;
    readonly pollIntervalMs?: number;
}

const POLL_INTERVAL_MS = 1_000;
/** How long "nothing playing yet" still counts as starting up. */
const STARTUP_GRACE_MS = 20_000;
const STOPPED_STATES = new Set(['stop', 'close', 'none']);
/** Unanswered polls in a row before the device counts as gone. */
const MAX_FAILED_POLLS = 5;

/**
 * A cast to a Roku through its External Control Protocol: the URL opens in
 * the built-in "Play on Roku" channel and the media player is polled for
 * progress. ECP has no absolute seek or volume, so the session declares
 * neither; play/pause maps to the Play key, which toggles.
 *
 * A device whose "Control by mobile apps" access is Limited refuses the
 * commands (`control-blocked`). If it plays but refuses status queries, the
 * session keeps an optimistic state without progress.
 */
export class RokuReceiverSession implements ReceiverSession {
    private state: CastSession;
    private poller: NodeJS.Timeout | null = null;
    private finished = false;
    private sawPlayback = false;
    private statusHidden = false;
    private failedPolls = 0;
    private readonly startedAt = Date.now();

    private constructor(
        private readonly client: RokuEcpClient,
        device: CastServiceRecord,
        media: CastMediaRequest,
        private readonly deps: RokuReceiverSessionDeps
    ) {
        this.state = {
            deviceId: device.id,
            deviceName: device.name,
            status: 'connecting',
            isLive: media.isLive,
            title: media.title,
            positionSeconds: 0,
            durationSeconds: null,
            volume: 1,
            muted: false,
            canSeek: false,
            canSetVolume: false,
        };
    }

    static async start(
        device: CastServiceRecord,
        media: CastMediaRequest,
        deps: RokuReceiverSessionDeps
    ): Promise<RokuReceiverSession> {
        const client =
            deps.client ??
            new RokuEcpClient(`http://${device.host}:${device.port}/`);
        const session = new RokuReceiverSession(client, device, media, deps);
        session.emit({});
        try {
            await client.playUrl(media);
        } catch (error) {
            session.dispose();
            throw error instanceof RokuControlBlockedError
                ? new CastStartError('control-blocked', 'Roku refused control')
                : new CastStartError(
                      'device-unreachable',
                      'Roku did not answer'
                  );
        }
        session.emit({ status: 'loading' });
        session.startPolling();
        return session;
    }

    get snapshot(): CastSession {
        return this.state;
    }

    control(command: CastControlCommand): void {
        if (this.finished) return;
        const playing =
            this.state.status === 'playing' ||
            this.state.status === 'buffering';
        const toggles =
            (command.type === 'pause' && playing) ||
            (command.type === 'play' && this.state.status === 'paused');
        if (!toggles) return;
        void this.client.keypress('Play').catch(() => undefined);
        if (this.statusHidden) {
            this.emit({
                status: command.type === 'pause' ? 'paused' : 'playing',
            });
        }
    }

    /** Leaves the player for the home screen, which ends playback. */
    stop(): void {
        if (!this.finished) {
            void this.client.keypress('Home').catch(() => undefined);
        }
        this.dispose();
    }

    dispose(): void {
        this.finished = true;
        this.stopPolling();
    }

    private stopPolling(): void {
        if (this.poller) {
            clearInterval(this.poller);
            this.poller = null;
        }
    }

    private startPolling(): void {
        this.poller = setInterval(
            () => void this.poll(),
            this.deps.pollIntervalMs ?? POLL_INTERVAL_MS
        );
        this.poller.unref?.();
    }

    private async poll(): Promise<void> {
        let player: RokuPlayerState;
        try {
            player = await this.client.mediaPlayer();
        } catch (error) {
            if (this.finished) return;
            if (error instanceof RokuControlBlockedError) {
                // Playback works but progress is not shared: stop asking.
                this.statusHidden = true;
                this.stopPolling();
                this.emit({ status: 'playing' });
            } else if (++this.failedPolls >= MAX_FAILED_POLLS) {
                // Switched off or off the network: stop claiming playback.
                this.emit({ status: 'error', error: 'connection-lost' });
                this.dispose();
            }
            return;
        }
        this.failedPolls = 0;
        if (!this.finished) this.apply(player);
    }

    private apply(player: RokuPlayerState): void {
        const otherChannel =
            player.channelId !== null &&
            player.channelId !== PLAY_ON_ROKU_CHANNEL;
        if (player.error) {
            this.emit({ status: 'error', error: 'load-failed' });
            this.dispose();
            return;
        }
        const stopped = STOPPED_STATES.has(player.state) || otherChannel;
        if (stopped) {
            if (
                this.sawPlayback ||
                Date.now() - this.startedAt > STARTUP_GRACE_MS
            ) {
                this.emit({ status: 'ended' });
                this.dispose();
            }
            return;
        }
        const status = this.mapState(player.state);
        this.sawPlayback ||= status === 'playing' || status === 'paused';
        this.emit({
            status,
            positionSeconds:
                player.positionSeconds ?? this.state.positionSeconds,
            durationSeconds:
                player.isLive === true
                    ? null
                    : (player.durationSeconds ?? this.state.durationSeconds),
            isLive: player.isLive ?? this.state.isLive,
        });
    }

    private mapState(state: string): CastSessionStatus {
        switch (state) {
            case 'play':
                return 'playing';
            case 'pause':
                return 'paused';
            default:
                return this.sawPlayback ? 'buffering' : 'loading';
        }
    }

    private emit(patch: Partial<CastSession>): void {
        this.state = { ...this.state, ...patch };
        this.deps.onUpdate(this.state);
    }
}
