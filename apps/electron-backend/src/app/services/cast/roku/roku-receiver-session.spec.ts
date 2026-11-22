import type { CastSession } from '@iptvnator/shared/interfaces';
import { CastStartError } from '../cast-receiver-session';
import {
    RokuControlBlockedError,
    type RokuEcpClient,
    type RokuPlayerState,
} from './roku-ecp-client';
import { RokuReceiverSession } from './roku-receiver-session';

const device = {
    id: 'roku:X1',
    name: 'Living Room',
    host: '192.0.2.18',
    port: 8060,
};
const media = {
    url: 'https://cdn.example.com/hls/master.m3u8',
    title: 'Example',
    isLive: false,
};

function player(overrides: Partial<RokuPlayerState> = {}): RokuPlayerState {
    return {
        state: 'play',
        error: false,
        channelId: '15985',
        positionSeconds: 12,
        durationSeconds: 600,
        isLive: false,
        ...overrides,
    };
}

function fakeClient() {
    return {
        playUrl: jest.fn(async () => undefined),
        keypress: jest.fn(async () => undefined),
        mediaPlayer: jest.fn(async () => player()),
        deviceInfo: jest.fn(),
    };
}

async function start(client = fakeClient()) {
    const updates: CastSession[] = [];
    const session = await RokuReceiverSession.start(device, media, {
        onUpdate: (snapshot) => updates.push(snapshot),
        client: client as unknown as RokuEcpClient,
        pollIntervalMs: 1_000,
    });
    return { session, updates, client };
}

describe('RokuReceiverSession', () => {
    beforeEach(() =>
        jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] })
    );
    afterEach(() => jest.useRealTimers());

    const tick = async () => {
        jest.advanceTimersByTime(1_000);
        await Promise.resolve();
        await Promise.resolve();
    };

    it('opens the URL and declares no seek or absolute volume', async () => {
        const { session, client, updates } = await start();

        expect(client.playUrl).toHaveBeenCalledWith(media);
        expect(updates.map((update) => update.status)).toEqual([
            'connecting',
            'loading',
        ]);
        expect(session.snapshot).toMatchObject({
            deviceName: 'Living Room',
            canSeek: false,
            canSetVolume: false,
        });
        session.dispose();
    });

    it('follows the media player', async () => {
        const { session, client } = await start();
        await tick();
        expect(session.snapshot).toMatchObject({
            status: 'playing',
            positionSeconds: 12,
            durationSeconds: 600,
        });

        client.mediaPlayer.mockResolvedValue(player({ state: 'pause' }));
        await tick();
        expect(session.snapshot.status).toBe('paused');
        session.dispose();
    });

    it('toggles with the Play key only when the state differs', async () => {
        const { session, client } = await start();
        await tick();

        session.control({ type: 'play' });
        expect(client.keypress).not.toHaveBeenCalled();
        session.control({ type: 'pause' });
        session.control({ type: 'seek', seconds: 30 });
        session.control({ type: 'volume', level: 0.5 });
        expect(client.keypress.mock.calls).toEqual([['Play']]);
        session.dispose();
    });

    it('ends when playback stops or another channel takes over', async () => {
        const { session, client, updates } = await start();
        await tick();
        client.mediaPlayer.mockResolvedValue(
            player({ state: 'play', channelId: '12' })
        );
        await tick();

        expect(updates.at(-1)?.status).toBe('ended');
        session.dispose();
    });

    it('waits through the start-up gap before calling it ended', async () => {
        const client = fakeClient();
        client.mediaPlayer.mockResolvedValue(
            player({ state: 'none', channelId: null })
        );
        const { session } = await start(client);
        await tick();
        await tick();

        expect(session.snapshot.status).toBe('loading');
        session.dispose();
    });

    it('reports streams the TV cannot play', async () => {
        const client = fakeClient();
        client.mediaPlayer.mockResolvedValue(
            player({ error: true, state: 'none' })
        );
        const { updates } = await start(client);
        await tick();

        expect(updates.at(-1)).toMatchObject({
            status: 'error',
            error: 'load-failed',
        });
    });

    it('explains a TV that refuses control', async () => {
        const client = fakeClient();
        client.playUrl.mockRejectedValue(new RokuControlBlockedError());

        await expect(start(client)).rejects.toMatchObject({
            code: 'control-blocked',
        });
    });

    it('reports an unreachable TV', async () => {
        const client = fakeClient();
        client.playUrl.mockRejectedValue(new Error('EHOSTUNREACH'));

        await expect(start(client)).rejects.toEqual(expect.any(CastStartError));
    });

    it('keeps an optimistic state when the TV plays but hides its status', async () => {
        const client = fakeClient();
        client.mediaPlayer.mockRejectedValue(new RokuControlBlockedError());
        const { session } = await start(client);
        await tick();

        expect(session.snapshot.status).toBe('playing');
        session.control({ type: 'pause' });
        expect(session.snapshot.status).toBe('paused');
        expect(client.keypress).toHaveBeenCalledWith('Play');
        await tick();
        expect(client.mediaPlayer).toHaveBeenCalledTimes(1);
        session.dispose();
    });

    it('reports a lost connection once the TV stops answering', async () => {
        const { session, client, updates } = await start();
        await tick();
        client.mediaPlayer.mockRejectedValue(new Error('EHOSTDOWN'));
        for (let poll = 0; poll < 4; poll += 1) await tick();
        expect(session.snapshot.status).toBe('playing');

        await tick();
        expect(updates.at(-1)).toMatchObject({
            status: 'error',
            error: 'connection-lost',
        });
        const calls = client.mediaPlayer.mock.calls.length;
        await tick();
        expect(client.mediaPlayer).toHaveBeenCalledTimes(calls);
    });

    it('forgives a single missed poll', async () => {
        const { session, client } = await start();
        client.mediaPlayer.mockRejectedValueOnce(new Error('timeout'));
        await tick();
        await tick();
        expect(session.snapshot.status).toBe('playing');
        session.dispose();
    });

    it('stops by going home', async () => {
        const { session, client } = await start();
        session.stop();
        expect(client.keypress).toHaveBeenCalledWith('Home');
        session.control({ type: 'pause' });
        expect(client.keypress).toHaveBeenCalledTimes(1);
    });
});
