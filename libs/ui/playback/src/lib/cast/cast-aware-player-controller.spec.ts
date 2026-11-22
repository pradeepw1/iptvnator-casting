import { signal } from '@angular/core';
import type { CastSession } from '@iptvnator/shared/interfaces';
import {
    createEmptyControlsState,
    DEFAULT_PLAYER_CAPABILITIES,
} from '../player-controls/player-controls-defaults';
import type {
    PlayerController,
    PlayerControlsCommands,
} from '../player-controls/player-controls.model';
import {
    type CastControlsTarget,
    createCastAwarePlayerController,
} from './cast-aware-player-controller';

const castSession: CastSession = {
    deviceId: 'device-1',
    deviceName: 'Living Room TV',
    status: 'playing',
    isLive: false,
    positionSeconds: 120,
    durationSeconds: 3600,
    volume: 0.3,
    muted: false,
    canSeek: true,
    canSetVolume: true,
};

function createHost(): PlayerController & {
    commands: jest.Mocked<PlayerControlsCommands>;
} {
    return {
        capabilities: signal({
            ...DEFAULT_PLAYER_CAPABILITIES,
            seek: true,
            volume: true,
            audioTracks: true,
            subtitles: true,
            pictureInPicture: true,
            fullscreen: true,
            recording: true,
        }),
        state: signal({
            ...createEmptyControlsState(),
            status: 'paused',
            positionSeconds: 10,
            durationSeconds: 3600,
            volume: 0.8,
        }),
        commands: {
            togglePlay: jest.fn(),
            seekTo: jest.fn(),
            seekBy: jest.fn(),
            setVolume: jest.fn(),
            setAudioTrack: jest.fn(),
            setSubtitleTrack: jest.fn(),
            addExternalSubtitleFile: jest.fn(),
            setSubtitleDelay: jest.fn(),
            setSubtitleStyle: jest.fn(),
            setQualityLevel: jest.fn(),
            setPlaybackSpeed: jest.fn(),
            setAspectRatio: jest.fn(),
            toggleRecording: jest.fn(),
            togglePictureInPicture: jest.fn(),
            jumpToLiveEdge: jest.fn(),
        },
    };
}

function createCast(session: CastSession | null) {
    const current = signal(session);
    const target: CastControlsTarget & {
        togglePlay: jest.Mock;
        seekTo: jest.Mock;
        setVolume: jest.Mock;
    } = {
        session: current,
        active: signal(session !== null),
        togglePlay: jest.fn(),
        seekTo: jest.fn(),
        setVolume: jest.fn(),
    };
    return { target, current };
}

describe('createCastAwarePlayerController', () => {
    it('passes the engine through when nothing is casting', () => {
        const host = createHost();
        const { target } = createCast(null);
        const controller = createCastAwarePlayerController(host, target);

        expect(controller.state()).toEqual(host.state());
        expect(controller.capabilities()).toEqual(host.capabilities());
        controller.commands.togglePlay();
        controller.commands.seekBy(10);
        controller.commands.setVolume(0.5);
        expect(host.commands.togglePlay).toHaveBeenCalled();
        expect(host.commands.seekBy).toHaveBeenCalledWith(10);
        expect(host.commands.setVolume).toHaveBeenCalledWith(0.5);
        expect(target.togglePlay).not.toHaveBeenCalled();
    });

    it('shows the TV state and hides local-only features while casting', () => {
        const host = createHost();
        const { target } = createCast(castSession);
        const controller = createCastAwarePlayerController(host, target);

        expect(controller.state()).toMatchObject({
            status: 'playing',
            positionSeconds: 120,
            durationSeconds: 3600,
            volume: 0.3,
            canSeek: true,
            canPictureInPicture: false,
        });
        expect(controller.capabilities()).toMatchObject({
            seek: true,
            volume: true,
            fullscreen: true,
            audioTracks: false,
            subtitles: false,
            pictureInPicture: false,
            recording: false,
        });
    });

    it('routes transport and volume to the TV while casting', () => {
        const host = createHost();
        const { target } = createCast(castSession);
        const controller = createCastAwarePlayerController(host, target);

        controller.commands.togglePlay();
        controller.commands.seekTo(300);
        controller.commands.seekBy(-200);
        controller.commands.setVolume(0.6);

        expect(target.togglePlay).toHaveBeenCalled();
        expect(target.seekTo).toHaveBeenNthCalledWith(1, 300);
        expect(target.seekTo).toHaveBeenNthCalledWith(2, 0);
        expect(target.setVolume).toHaveBeenCalledWith(0.6);
        expect(host.commands.togglePlay).not.toHaveBeenCalled();
        expect(host.commands.setVolume).not.toHaveBeenCalled();
    });

    it('treats live casts as unseekable and muted receivers as silent', () => {
        const host = createHost();
        const { target } = createCast({
            ...castSession,
            isLive: true,
            durationSeconds: null,
            muted: true,
        });
        const controller = createCastAwarePlayerController(host, target);

        expect(controller.capabilities().seek).toBe(false);
        expect(controller.state()).toMatchObject({
            isLive: true,
            canSeek: false,
            volume: 0,
        });
    });

    it('hides seek and volume for receivers without them (Roku)', () => {
        const host = createHost();
        const { target } = createCast({
            ...castSession,
            canSeek: false,
            canSetVolume: false,
        });
        const controller = createCastAwarePlayerController(host, target);

        expect(controller.capabilities()).toMatchObject({
            seek: false,
            volume: false,
            fullscreen: true,
        });
        expect(controller.state().canSeek).toBe(false);
    });

    it('maps receiver states onto player states', () => {
        const host = createHost();
        const { target, current } = createCast(castSession);
        const controller = createCastAwarePlayerController(host, target);

        current.set({ ...castSession, status: 'connecting' });
        expect(controller.state().status).toBe('loading');
        current.set({ ...castSession, status: 'buffering' });
        expect(controller.state()).toMatchObject({
            status: 'playing',
            stalled: true,
        });
        current.set({ ...castSession, status: 'paused' });
        expect(controller.state().status).toBe('paused');
    });

    it('keeps forwarding engine-only commands to the engine', () => {
        const host = createHost();
        const { target } = createCast(castSession);
        const controller = createCastAwarePlayerController(host, target);

        controller.commands.setAudioTrack(2);
        controller.commands.jumpToLiveEdge();
        expect(host.commands.setAudioTrack).toHaveBeenCalledWith(2);
        expect(host.commands.jumpToLiveEdge).toHaveBeenCalled();
    });
});
