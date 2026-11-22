import { effect, inject, untracked } from '@angular/core';
import type { PlayerController } from '../player-controls/player-controls.model';
import { createCastAwarePlayerController } from './cast-aware-player-controller';
import { PlayerCastController } from './player-cast.controller';

/** The controls' controller, plus the cast controller when one is provided. */
export type CastAwarePlayerController = PlayerController & {
    readonly cast?: PlayerCastController;
};

/**
 * Input transform for the shared controls' `controller`. Under a player view
 * that provides `PlayerCastController` (see `providePlayerCast`), it wraps
 * the engine controller so every control drives the TV while casting, and
 * keeps the engine paused meanwhile so the stream is not heard twice. Other
 * hosts get their controller back unchanged.
 *
 * Call it from a field initializer: it needs an injection context.
 */
export function withCasting(): (
    controller: PlayerController
) => CastAwarePlayerController {
    const cast = inject(PlayerCastController, { optional: true });
    if (!cast) {
        return (controller) => controller;
    }
    // A plain field, not a signal: input transforms run while the parent
    // renders, where signal writes are not allowed. Engine controllers are
    // component-scoped, so the bound engine does not change under one
    // controls instance; the effect tracks its state once it has run.
    let engine: PlayerController | null = null;
    effect(() => {
        const local = engine;
        if (cast.active() && local?.state().status === 'playing') {
            untracked(() => local.commands.togglePlay());
        }
    });
    return (controller) => {
        engine = controller;
        return { ...createCastAwarePlayerController(controller, cast), cast };
    };
}
