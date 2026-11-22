import { PlaylistSwitcherComponent } from '@iptvnator/playlist/shared/ui';
import {
    ChangeDetectionStrategy,
    Component,
    input,
    output,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { WebVideoCastLauncher } from '@iptvnator/ui/playback/web-video-cast';
import { TranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { WorkspaceShellHeaderComponent } from './workspace-shell-header.component';

@Component({
    selector: 'app-playlist-switcher',
    template: '',
    changeDetection: ChangeDetectionStrategy.Eager,
    standalone: true,
})
class MockPlaylistSwitcherComponent {
    readonly currentTitle = input.required<string>();
    readonly subtitle = input('');
    readonly addPlaylistRequested = output<void>();
}

describe('WorkspaceShellHeaderComponent cast action', () => {
    let fixture: ComponentFixture<WorkspaceShellHeaderComponent>;
    const launcher = { supported: true, open: jest.fn() };

    async function render(supported: boolean) {
        launcher.supported = supported;
        launcher.open.mockClear();
        await TestBed.configureTestingModule({
            imports: [WorkspaceShellHeaderComponent, NoopAnimationsModule],
            providers: [
                { provide: WebVideoCastLauncher, useValue: launcher },
                {
                    provide: TranslateService,
                    useValue: {
                        instant: (key: string) => key,
                        get: (key: string) => of(key),
                        stream: (key: string) => of(key),
                        onLangChange: of(null),
                        onTranslationChange: of(null),
                        onDefaultLangChange: of(null),
                        currentLang: 'en',
                        defaultLang: 'en',
                    },
                },
            ],
        })
            .overrideComponent(WorkspaceShellHeaderComponent, {
                remove: { imports: [PlaylistSwitcherComponent] },
                add: { imports: [MockPlaylistSwitcherComponent] },
            })
            .compileComponents();
        fixture = TestBed.createComponent(WorkspaceShellHeaderComponent);
        fixture.componentRef.setInput('playlistTitle', 'Playlist A');
        fixture.componentRef.setInput('isElectron', true);
        fixture.detectChanges();
    }

    const button = () =>
        fixture.nativeElement.querySelector(
            '[data-test-id="header-cast-web-video"]'
        ) as HTMLButtonElement | null;

    afterEach(() => TestBed.resetTestingModule());

    it('opens "Cast a web video" from the global actions', async () => {
        await render(true);

        expect(button()?.getAttribute('aria-label')).toBe('CAST.WEB.TITLE');
        button()?.click();
        expect(launcher.open).toHaveBeenCalledTimes(1);
    });

    it('is absent where the runtime cannot cast', async () => {
        await render(false);
        expect(button()).toBeNull();
    });
});
