import { inject, Injectable } from '@angular/core';
import { RuntimeCapabilitiesService } from '@iptvnator/services';
import { LazyMatDialog } from '@iptvnator/ui/components/lazy-dialog';
import { dialogSize } from '@iptvnator/ui/dialog/dialog-size';

/**
 * Opens "Cast a web video". The dialog and Material's dialog module load on
 * first use, so the header can offer the action without either on its path.
 */
@Injectable({ providedIn: 'root' })
export class WebVideoCastLauncher {
    private readonly lazyDialog = inject(LazyMatDialog);
    private readonly runtime = inject(RuntimeCapabilitiesService);

    /** The dynamic import; a field so specs can substitute it. */
    loadDialog = () => import('./web-video-cast-dialog.component');

    get supported(): boolean {
        return this.runtime.supportsWebVideoCasting;
    }

    async open(): Promise<void> {
        if (!this.supported) {
            return;
        }
        try {
            const [dialog, module] = await Promise.all([
                this.lazyDialog.resolve(),
                this.loadDialog(),
            ]);
            dialog.open(module.WebVideoCastDialogComponent, {
                ...dialogSize('md'),
                autoFocus: 'dialog',
            });
        } catch (error) {
            console.error('Could not open the web video cast dialog:', error);
        }
    }
}
