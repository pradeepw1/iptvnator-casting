import { TestBed } from '@angular/core/testing';
import { RuntimeCapabilitiesService } from '@iptvnator/services';
import { LazyMatDialog } from '@iptvnator/ui/components/lazy-dialog';
import { WebVideoCastLauncher } from './web-video-cast.launcher';

class FakeDialogComponent {}

function setup(supportsWebVideoCasting: boolean) {
    const open = jest.fn();
    TestBed.configureTestingModule({
        providers: [
            {
                provide: RuntimeCapabilitiesService,
                useValue: { supportsWebVideoCasting },
            },
            {
                provide: LazyMatDialog,
                useValue: { resolve: async () => ({ open }) },
            },
        ],
    });
    const launcher = TestBed.inject(WebVideoCastLauncher);
    launcher.loadDialog = async () =>
        ({ WebVideoCastDialogComponent: FakeDialogComponent }) as never;
    return { launcher, open };
}

describe('WebVideoCastLauncher', () => {
    afterEach(() => TestBed.resetTestingModule());

    it('opens the dialog at the list width', async () => {
        const { launcher, open } = setup(true);
        await launcher.open();

        expect(launcher.supported).toBe(true);
        expect(open).toHaveBeenCalledWith(
            FakeDialogComponent,
            expect.objectContaining({ width: '560px', autoFocus: 'dialog' })
        );
    });

    it('does nothing where casting is unavailable', async () => {
        const { launcher, open } = setup(false);
        await launcher.open();

        expect(launcher.supported).toBe(false);
        expect(open).not.toHaveBeenCalled();
    });

    it('survives a failed chunk load', async () => {
        const { launcher, open } = setup(true);
        launcher.loadDialog = () => Promise.reject(new Error('offline'));
        const error = jest
            .spyOn(console, 'error')
            .mockImplementation(() => undefined);

        await expect(launcher.open()).resolves.toBeUndefined();
        expect(open).not.toHaveBeenCalled();
        error.mockRestore();
    });
});
