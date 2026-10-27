import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CaptureMonitor, CaptureTarget, CaptureWindow } from 'internal-api';
import { filter, firstValueFrom, take } from 'rxjs';
import { CaptureService } from '../../../ipc/capture';
import { GalleryState } from '../../../gallery/services/gallery-state/gallery-state';
import { ViewNavigator } from '../../../viewer/services/view-navigator/view-navigator';

@Component({
  selector: 'app-capture-panel',
  templateUrl: './capture-panel.component.html',
  styleUrl: './capture-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CapturePanelComponent {
  private readonly captureService = inject(CaptureService);
  private readonly galleryState = inject(GalleryState);
  private readonly viewNavigator = inject(ViewNavigator);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly expanded = signal(true);
  protected readonly monitors = signal<CaptureMonitor[]>([]);
  protected readonly windows = signal<CaptureWindow[]>([]);
  protected readonly selectedTarget = signal('monitor:1');
  protected readonly destinationFolder = signal('');
  protected readonly loadingSources = signal(false);
  protected readonly capturing = signal(false);
  protected readonly status = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly selectedLabel = computed(() => {
    const value = this.selectedTarget();
    if (value.startsWith('monitor:')) {
      const index = Number(value.slice('monitor:'.length));
      const monitor = this.monitors().find(item => item.index === index);
      return monitor ? `Monitor ${monitor.index} · ${monitor.width} × ${monitor.height}` : 'Monitor';
    }
    const handle = Number(value.slice('window:'.length));
    const window = this.windows().find(item => item.handle === handle);
    return window ? window.title : 'Application window';
  });

  constructor() {
    this.galleryState.selectedLocation()
      .pipe(
        filter((path): path is string => path !== null && path.length > 0),
        take(1),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(path => {
        if (!this.destinationFolder()) this.destinationFolder.set(path);
      });

    void this.loadSources();
  }

  protected readonly loadSources = async (): Promise<void> => {
    this.loadingSources.set(true);
    this.error.set(null);
    try {
      const sources = await this.captureService.listSources();
      this.monitors.set(sources.monitors);
      this.windows.set(sources.windows);
      if (!sources.monitors.some(monitor => this.selectedTarget() === `monitor:${monitor.index}`) &&
          !sources.windows.some(window => this.selectedTarget() === `window:${window.handle}`)) {
        const firstMonitor = sources.monitors[0];
        const firstWindow = sources.windows[0];
        this.selectedTarget.set(firstMonitor ? `monitor:${firstMonitor.index}` : firstWindow ? `window:${firstWindow.handle}` : '');
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loadingSources.set(false);
    }
  };

  protected readonly chooseFolder = async (): Promise<void> => {
    const folder = await this.captureService.chooseFolder(this.destinationFolder() || undefined);
    if (folder) {
      this.destinationFolder.set(folder);
      this.error.set(null);
    }
  };

  private selectedCaptureTarget(): CaptureTarget | null {
    const value = this.selectedTarget();
    const separator = value.indexOf(':');
    if (separator < 0) return null;
    const kind = value.slice(0, separator);
    const id = Number(value.slice(separator + 1));
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    if (kind === 'monitor') return { kind: 'monitor', index: id };
    if (kind === 'window') return { kind: 'window', handle: id };
    return null;
  }

  protected readonly captureNow = async (): Promise<void> => {
    const target = this.selectedCaptureTarget();
    const folder = this.destinationFolder();
    if (!target) {
      this.error.set('Select a monitor or application window.');
      return;
    }
    if (!folder) {
      this.error.set('Choose a destination folder first.');
      return;
    }

    this.capturing.set(true);
    this.error.set(null);
    this.status.set('Capturing HDR frame…');
    try {
      const result = await this.captureService.capture(target, folder);
      // Refresh the folder from disk so the capture appears in the gallery and
      // becomes part of the current image-navigation sequence immediately.
      await firstValueFrom(this.galleryState.navigateTo(folder).pipe(take(1)));
      await firstValueFrom(this.viewNavigator.selectImage(result.path).pipe(take(1)));
      this.status.set(`Saved ${result.width} × ${result.height} HDR · ${result.path}`);
    } catch (error) {
      this.status.set('');
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.capturing.set(false);
    }
  };
}
