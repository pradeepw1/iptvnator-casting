import {
    ChangeDetectionStrategy,
    Component,
    computed,
    input,
    viewChild,
} from '@angular/core';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenu, MatMenuModule } from '@angular/material/menu';
import type { CastDevice } from '@iptvnator/shared/interfaces';
import {
    MenuItemRadioCheckDirective,
    MenuItemRadioDirective,
} from '@iptvnator/ui/components';
import { TranslatePipe } from '@ngx-translate/core';
import type { PlayerCastController } from './player-cast.controller';

/**
 * Device picker behind the controls bar's cast button. The button stays in
 * the controls template (it shares the bar's styles) and opens `menu()`.
 */
@Component({
    selector: 'app-player-cast-menu',
    templateUrl: './player-cast-menu.component.html',
    imports: [
        MatDividerModule,
        MatIconModule,
        MatMenuModule,
        MenuItemRadioCheckDirective,
        MenuItemRadioDirective,
        TranslatePipe,
    ],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlayerCastMenuComponent {
    readonly cast = input.required<PlayerCastController>();
    /** Local playback position, used as the VOD start time on the TV. */
    readonly positionSeconds = input(0);
    readonly menu = viewChild.required(MatMenu);

    readonly activeDeviceId = computed(() =>
        this.cast().active() ? (this.cast().session()?.deviceId ?? null) : null
    );
    readonly needsCustomHeaders = computed(
        () => this.cast().media()?.needsCustomHeaders ?? false
    );

    /** Called by the trigger's `menuOpened`: every opening searches anew. */
    opened(): void {
        void this.cast().discover();
    }

    search(event: Event): void {
        // Keep the menu open so the refreshed list appears in place.
        event.stopPropagation();
        void this.cast().discover();
    }

    castTo(device: CastDevice): void {
        if (device.id !== this.activeDeviceId()) {
            void this.cast().castTo(device.id, this.positionSeconds());
        }
    }
}
