import { inject, type Provider, type Signal, type Type } from '@angular/core';
import type { ResolvedPortalPlayback } from '@iptvnator/shared/interfaces';
import { resolvePlayerCastMedia } from './player-cast-media';
import { PlayerCastController } from './player-cast.controller';

/** What a player view exposes for casting. */
export interface PlayerCastPlaybackHost {
    readonly resolvedPlayback: Signal<ResolvedPortalPlayback | null>;
    readonly resolvedIsLive: Signal<boolean>;
}

/**
 * Provides `PlayerCastController` for a player view, offering the view's
 * resolved playback. The view is looked up lazily, when the controls first
 * inject the controller, so the view itself must not inject it.
 */
export function providePlayerCast(
    host: () => Type<PlayerCastPlaybackHost>
): Provider {
    return {
        provide: PlayerCastController,
        useFactory: () => {
            const cast = new PlayerCastController();
            const view = inject(host());
            cast.bindMedia(() =>
                resolvePlayerCastMedia(
                    view.resolvedPlayback(),
                    view.resolvedIsLive()
                )
            );
            return cast;
        },
    };
}
