import { NgTemplateOutlet } from '@angular/common';
import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    inject,
    signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import type {
    WebVideoScanResult,
    WebVideoSource,
} from '@iptvnator/shared/interfaces';
import {
    DialogFooterDirective,
    DialogShellComponent,
} from '@iptvnator/ui/components';
import { TranslatePipe } from '@ngx-translate/core';
import type { PlayerCastMedia } from '../player-cast-media';
import { PlayerCastController } from '../player-cast.controller';
import {
    castMediaForWebVideo,
    toWebVideoSourceView,
    WEB_VIDEO_ERROR_KEYS,
} from './web-video-source-view';

type ScanState = 'idle' | 'scanning' | 'done';

/**
 * "Cast a web video": paste a page or stream link, pick one of the videos
 * the page loads (ads listed apart), pick a TV, cast. The page is opened
 * offscreen by the main process; this dialog only shows the result.
 */
@Component({
    selector: 'app-web-video-cast-dialog',
    templateUrl: './web-video-cast-dialog.component.html',
    styleUrl: './web-video-cast-dialog.component.scss',
    imports: [
        DialogFooterDirective,
        DialogShellComponent,
        MatButtonModule,
        MatDialogModule,
        MatFormFieldModule,
        MatIconModule,
        MatInputModule,
        MatProgressBarModule,
        MatSelectModule,
        NgTemplateOutlet,
        TranslatePipe,
    ],
    providers: [PlayerCastController],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WebVideoCastDialogComponent {
    protected readonly cast = inject(PlayerCastController);

    readonly link = signal('');
    readonly state = signal<ScanState>('idle');
    readonly result = signal<WebVideoScanResult | null>(null);
    readonly selectedId = signal<string | null>(null);
    readonly showAds = signal(false);
    readonly chosenDeviceId = signal<string | null>(null);
    /** Only what was actually cast, so picking another row never recasts. */
    private readonly castMedia = signal<PlayerCastMedia | null>(null);

    readonly sources = computed(() => this.result()?.sources ?? []);
    /** Kind of the picked TV: warnings depend on what it can play. */
    readonly receiverKind = computed(
        () =>
            this.cast.devices().find((device) => device.id === this.deviceId())
                ?.kind ?? null
    );
    readonly videos = computed(() =>
        this.sources()
            .filter((source) => source.verdict === 'video')
            .map((source, index) =>
                toWebVideoSourceView(source, index === 0, this.receiverKind())
            )
    );
    readonly ads = computed(() =>
        this.sources()
            .filter((source) => source.verdict === 'ad')
            .map((source) =>
                toWebVideoSourceView(source, false, this.receiverKind())
            )
    );
    readonly errorKey = computed(() => {
        const error = this.result()?.error;
        return error && error !== 'cancelled'
            ? WEB_VIDEO_ERROR_KEYS[error]
            : null;
    });
    readonly selected = computed<WebVideoSource | null>(
        () =>
            this.sources().find((source) => source.id === this.selectedId()) ??
            null
    );
    /** The chosen TV, else the one already casting, else the only one. */
    readonly deviceId = computed(() => {
        const devices = this.cast.devices();
        const chosen = this.chosenDeviceId();
        if (chosen && devices.some((device) => device.id === chosen))
            return chosen;
        const active = this.cast.active()
            ? this.cast.session()?.deviceId
            : null;
        if (active && devices.some((device) => device.id === active))
            return active;
        return devices.length === 1 ? devices[0].id : null;
    });
    readonly selectedDeviceName = computed(
        () =>
            this.cast.devices().find((device) => device.id === this.deviceId())
                ?.name ?? ''
    );
    readonly canCast = computed(
        () =>
            !!this.selected() &&
            !!this.deviceId() &&
            this.state() !== 'scanning'
    );

    constructor() {
        this.cast.bindMedia(() => this.castMedia());
        void this.cast.discover();
        inject(DestroyRef).onDestroy(() => {
            if (this.state() === 'scanning') {
                void window.electron?.castCancelWebVideoScan?.();
            }
        });
    }

    async find(): Promise<void> {
        const link = this.link().trim();
        if (!link || this.state() === 'scanning') return;
        this.state.set('scanning');
        this.result.set(null);
        this.selectedId.set(null);
        this.showAds.set(false);
        try {
            const result = await window.electron?.castFindWebVideos?.(link);
            if (result?.error === 'cancelled') {
                this.state.set('idle');
                return;
            }
            this.result.set(result ?? null);
            // Preselect the best match; an ad is never preselected.
            const best = result?.sources.find(
                (source) => source.verdict === 'video'
            );
            this.selectedId.set(best?.id ?? null);
            this.state.set('done');
        } catch {
            this.result.set({
                pageUrl: link,
                title: null,
                thumbnail: null,
                sources: [],
                error: 'load-failed',
            });
            this.state.set('done');
        }
    }

    cancel(): void {
        void window.electron?.castCancelWebVideoScan?.();
    }

    async castSelected(): Promise<void> {
        const source = this.selected();
        const result = this.result();
        const deviceId = this.deviceId();
        if (!source || !result || !deviceId) return;
        this.castMedia.set(castMediaForWebVideo(source, result));
        await this.cast.castTo(deviceId);
    }
}
