import { computed, type Signal } from '@angular/core';
import type { CastSession } from '@iptvnator/shared/interfaces';
import type {
    PlayerController,
    PlayerControlsCapabilities,
    PlayerControlsCommands,
    PlayerControlsState,
    PlayerStatus,
} from '../player-controls/player-controls.model';

/** The slice of `PlayerCastController` the controls need. */
export interface CastControlsTarget {
    readonly active: Signal<boolean>;
    readonly session: Signal<CastSession | null>;
    togglePlay(): void;
    seekTo(seconds: number): void;
    setVolume(level: number): void;
}

/** Local-only features are hidden while the picture is on the TV. */
const LOCAL_ONLY_CAPABILITIES: Partial<PlayerControlsCapabilities> = {
    audioTracks: false,
    subtitles: false,
    externalSubtitles: false,
    subtitleDelay: false,
    subtitleStyle: false,
    qualityLevels: false,
    playbackSpeed: false,
    aspectRatio: false,
    recording: false,
    pictureInPicture: false,
    streamStats: false,
    liveEdge: false,
};

function toPlayerStatus(status: CastSession['status']): PlayerStatus {
    switch (status) {
        case 'connecting':
        case 'loading':
            return 'loading';
        case 'buffering':
        case 'playing':
            return 'playing';
        default:
            return status;
    }
}

/**
 * Wraps an engine controller so that, while a cast session is active, the
 * shared controls show and drive the TV: transport, timeline and volume go
 * to the receiver, local-only menus are hidden. Without a session the engine
 * controller passes through unchanged.
 */
export function createCastAwarePlayerController(
    base: PlayerController,
    cast: CastControlsTarget
): PlayerController {
    const castSession = computed(() => (cast.active() ? cast.session() : null));

    const capabilities = computed<PlayerControlsCapabilities>(() => {
        const session = castSession();
        const local = base.capabilities();
        return session
            ? {
                  ...local,
                  ...LOCAL_ONLY_CAPABILITIES,
                  seek: session.canSeek && !session.isLive,
                  volume: session.canSetVolume,
              }
            : local;
    });

    const state = computed<PlayerControlsState>(() => {
        const session = castSession();
        const local = base.state();
        if (!session) {
            return local;
        }
        return {
            ...local,
            status: toPlayerStatus(session.status),
            statusMessage: '',
            stalled: session.status === 'buffering',
            positionSeconds: session.positionSeconds,
            durationSeconds: session.durationSeconds,
            isLive: session.isLive,
            canSeek:
                session.canSeek &&
                !session.isLive &&
                session.durationSeconds !== null,
            volume: session.muted ? 0 : session.volume,
            pictureInPictureActive: false,
            canPictureInPicture: false,
        };
    });

    const local = () => base.commands;
    const casting = () => castSession() !== null;
    const commands: PlayerControlsCommands = {
        togglePlay: () =>
            casting() ? cast.togglePlay() : local().togglePlay(),
        seekTo: (seconds) =>
            casting() ? cast.seekTo(seconds) : local().seekTo(seconds),
        seekBy: (delta) =>
            casting()
                ? cast.seekTo(Math.max(0, state().positionSeconds + delta))
                : local().seekBy(delta),
        setVolume: (value) =>
            casting() ? cast.setVolume(value) : local().setVolume(value),
        setAudioTrack: (id) => local().setAudioTrack(id),
        setSubtitleTrack: (id) => local().setSubtitleTrack(id),
        addExternalSubtitleFile: () => local().addExternalSubtitleFile(),
        setSubtitleDelay: (seconds) => local().setSubtitleDelay(seconds),
        setSubtitleStyle: (style) => local().setSubtitleStyle(style),
        setQualityLevel: (id) => local().setQualityLevel(id),
        setPlaybackSpeed: (speed) => local().setPlaybackSpeed(speed),
        setAspectRatio: (value) => local().setAspectRatio(value),
        toggleRecording: () => local().toggleRecording(),
        togglePictureInPicture: () => local().togglePictureInPicture(),
        jumpToLiveEdge: () => local().jumpToLiveEdge(),
    };

    return {
        capabilities,
        state,
        commands,
        ...(base.streamStats ? { streamStats: base.streamStats } : {}),
    };
}
