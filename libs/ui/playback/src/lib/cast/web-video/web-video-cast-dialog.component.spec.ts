import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { RuntimeCapabilitiesService } from '@iptvnator/services';
import type {
    CastBridgeApi,
    CastControlCommand,
    CastMediaRequest,
    CastSession,
    WebVideoScanResult,
    WebVideoSource,
} from '@iptvnator/shared/interfaces';
import { TranslateModule } from '@ngx-translate/core';
import { WebVideoCastDialogComponent } from './web-video-cast-dialog.component';

function source(overrides: Partial<WebVideoSource>): WebVideoSource {
    return {
        id: 'source-1',
        url: 'https://cdn.example.com/hls/master.m3u8',
        kind: 'hls',
        verdict: 'video',
        signals: ['main-player'],
        host: 'cdn.example.com',
        isLive: false,
        durationSeconds: 5_400,
        height: 1080,
        variantCount: 3,
        sizeBytes: null,
        castability: 'likely',
        embeddedAds: false,
        ...overrides,
    };
}

const scan: WebVideoScanResult = {
    pageUrl: 'https://www.example.com/watch/42',
    title: 'Example Feature',
    thumbnail: 'https://img.example.com/poster.jpg',
    sources: [
        source({}),
        source({
            id: 'source-2',
            url: 'https://cdn.example.com/trailer.mp4',
            kind: 'mp4',
            height: 720,
        }),
        source({
            id: 'source-3',
            url: 'https://s0.2mdn.net/clip.mp4',
            kind: 'mp4',
            verdict: 'ad',
            signals: ['ad-network'],
            host: 's0.2mdn.net',
        }),
    ],
};

const playing: CastSession = {
    deviceId: 'tv-1',
    deviceName: 'Living Room TV',
    status: 'playing',
    isLive: false,
    positionSeconds: 0,
    durationSeconds: 5_400,
    volume: 1,
    muted: false,
    canSeek: true,
    canSetVolume: true,
};

function installBridge(result: WebVideoScanResult = scan) {
    const bridge: jest.Mocked<Required<CastBridgeApi>> = {
        castDiscoverDevices: jest.fn(async () => [
            { id: 'tv-1', kind: 'roku' as const, name: 'Living Room TV' },
        ]),
        castGetSession: jest.fn(async () => null),
        castStart: jest.fn<Promise<CastSession>, [string, CastMediaRequest]>(
            async () => playing
        ),
        castControl: jest.fn<Promise<void>, [CastControlCommand]>(
            async () => undefined
        ),
        castStop: jest.fn(async () => undefined),
        onCastSessionUpdate: jest.fn<
            () => void,
            [(session: CastSession | null) => void]
        >(() => () => undefined),
        castFindWebVideos: jest.fn<Promise<WebVideoScanResult>, [string]>(
            async () => result
        ),
        castCancelWebVideoScan: jest.fn(async () => undefined),
    };
    (window as unknown as { electron: unknown }).electron = bridge;
    return bridge;
}

describe('WebVideoCastDialogComponent', () => {
    let fixture: ComponentFixture<WebVideoCastDialogComponent>;
    let bridge: ReturnType<typeof installBridge>;

    const query = (selector: string) =>
        fixture.nativeElement.querySelectorAll(
            selector
        ) as NodeListOf<HTMLElement>;

    async function render(result?: WebVideoScanResult) {
        bridge = installBridge(result);
        await TestBed.configureTestingModule({
            imports: [
                WebVideoCastDialogComponent,
                TranslateModule.forRoot(),
                NoopAnimationsModule,
            ],
            providers: [
                { provide: MatDialogRef, useValue: { close: jest.fn() } },
                {
                    provide: RuntimeCapabilitiesService,
                    useValue: {
                        supportsCasting: true,
                        supportsWebVideoCasting: true,
                    },
                },
            ],
        }).compileComponents();
        fixture = TestBed.createComponent(WebVideoCastDialogComponent);
        fixture.detectChanges();
        await fixture.whenStable();
    }

    async function findVideos(link = 'https://www.example.com/watch/42') {
        const input = query(
            '[data-test-id="web-video-link"]'
        )[0] as HTMLInputElement;
        input.value = link;
        input.dispatchEvent(new Event('input'));
        fixture.detectChanges();
        (
            query('[data-test-id="web-video-find"]')[0] as HTMLButtonElement
        ).click();
        await fixture.whenStable();
        fixture.detectChanges();
    }

    afterEach(() => {
        delete (window as unknown as { electron?: unknown }).electron;
        TestBed.resetTestingModule();
    });

    it('lists the videos, best match selected, with ads tucked away', async () => {
        await render();
        await findVideos();

        expect(bridge.castFindWebVideos).toHaveBeenCalledWith(
            'https://www.example.com/watch/42'
        );
        const rows = query('[data-test-id="web-video-source"]');
        expect(rows).toHaveLength(2);
        expect(rows[0].textContent).toContain('1080p');
        expect(rows[0].textContent).toContain('CAST.WEB.BEST_MATCH');
        expect(
            (rows[0].querySelector('input') as HTMLInputElement).checked
        ).toBe(true);

        (
            query(
                '[data-test-id="web-video-ads-toggle"]'
            )[0] as HTMLButtonElement
        ).click();
        fixture.detectChanges();
        const withAds = query('[data-test-id="web-video-source"]');
        expect(withAds).toHaveLength(3);
        expect(withAds[2].textContent).toContain('CAST.WEB.REASON_AD_NETWORK');
        expect(
            (withAds[2].querySelector('input') as HTMLInputElement).checked
        ).toBe(false);
    });

    it('casts the picked source to the only TV found', async () => {
        await render();
        await findVideos();
        const rows = query('[data-test-id="web-video-source"]');
        (rows[1].querySelector('input') as HTMLInputElement).click();
        fixture.detectChanges();

        (
            query('[data-test-id="web-video-cast"]')[0] as HTMLButtonElement
        ).click();
        await fixture.whenStable();
        fixture.detectChanges();

        expect(bridge.castStart).toHaveBeenCalledWith('tv-1', {
            url: 'https://cdn.example.com/trailer.mp4',
            title: 'Example Feature',
            thumbnail: 'https://img.example.com/poster.jpg',
            isLive: false,
            contentType: 'video/mp4',
        });
        expect(
            query('[data-test-id="web-video-cast-status"]')[0].textContent
        ).toContain('CAST.PLAYING_ON');
    });

    it('keeps Cast disabled until there is a video to cast', async () => {
        await render();
        expect(
            (query('[data-test-id="web-video-cast"]')[0] as HTMLButtonElement)
                .disabled
        ).toBe(true);
    });

    it('explains why nothing was found', async () => {
        await render({ ...scan, sources: [], error: 'no-video' });
        await findVideos();

        expect(
            query('[data-test-id="web-video-error"]')[0].textContent
        ).toContain('CAST.WEB.ERROR_NO_VIDEO');
        expect(query('[data-test-id="web-video-source"]')).toHaveLength(0);
    });

    it('cancels a running scan when the dialog closes', async () => {
        await render();
        bridge.castFindWebVideos.mockImplementation(
            () => new Promise(() => undefined)
        );
        const input = query(
            '[data-test-id="web-video-link"]'
        )[0] as HTMLInputElement;
        input.value = 'www.example.com/watch/42';
        input.dispatchEvent(new Event('input'));
        fixture.detectChanges();
        (
            query('[data-test-id="web-video-find"]')[0] as HTMLButtonElement
        ).click();
        fixture.detectChanges();

        expect(bridge.castFindWebVideos).toHaveBeenCalledWith(
            'www.example.com/watch/42'
        );
        fixture.destroy();
        expect(bridge.castCancelWebVideoScan).toHaveBeenCalled();
    });
});
