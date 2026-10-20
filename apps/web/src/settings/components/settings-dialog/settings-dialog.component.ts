import { Dialog, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import {
  ActionButtonComponent,
  DialogComponent,
  TitleComponent
} from '@light-matter/ui';
import { CacheClearResult, CacheInfo, supportedFileFormats } from 'internal-api';
import { CacheManager } from '../../../ipc/cache-manager';
import { ProcessManager } from '../../../ipc/process-manager';
import { ByteSizePipe } from '../../../ui/pipes/byte-size/byte-size.pipe';

@Component({
  selector: 'app-settings-dialog',
  imports: [
    ActionButtonComponent,
    DialogComponent,
    TitleComponent,
    ByteSizePipe
  ],
  templateUrl: './settings-dialog.component.html',
  styleUrl: './settings-dialog.component.scss',
  host: { '[class.busy]': 'isClearing()' },
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SettingsDialogComponent {
  /* DI */
  readonly dialogRef = inject<DialogRef<boolean>>(DialogRef);

  readonly cacheManager = inject(CacheManager);

  private readonly processManager = inject(ProcessManager);

  /* State */
  protected readonly cacheInfo = signal<CacheInfo>({
    path: '',
    entries: 0,
    bytes: 0,
    fullSize: { entries: 0, bytes: 0 },
    thumbnails: { entries: 0, bytes: 0 }
  });

  protected readonly isClearing = signal(false);

  protected readonly devToolsOpen = signal(false);

  protected readonly devToolsLoading = signal(true);

  protected readonly devToolsError = signal<string | null>(null);

  protected readonly lastClearResult = signal<CacheClearResult | null>(null);

  protected readonly clearError = signal<string | null>(null);

  protected readonly openFolderError = signal<string | null>(null);

  protected readonly supportedFormats = supportedFileFormats;

  /* Constructor */
  constructor() {
    this.updateCacheInfo().then();
    this.loadDevToolsSetting().then();
  }

  private readonly loadDevToolsSetting = async () => {
    try {
      this.devToolsOpen.set(await this.processManager.getDevToolsOpen());
    } catch (error) {
      this.devToolsError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.devToolsLoading.set(false);
    }
  };

  protected readonly setDevToolsOpen = async (open: boolean) => {
    if (this.devToolsLoading()) {
      return;
    }

    const previousValue = this.devToolsOpen();
    this.devToolsOpen.set(open);
    this.devToolsError.set(null);

    try {
      await this.processManager.setDevToolsOpen(open);
    } catch (error) {
      this.devToolsOpen.set(previousValue);
      this.devToolsError.set(error instanceof Error ? error.message : String(error));
    }
  };

  /* State modifiers */
  private readonly updateCacheInfo = async () => this.cacheInfo.set(await this.cacheManager.cacheInfo());

  protected readonly openCacheFolder = async () => {
    this.openFolderError.set(null);

    try {
      const error = await this.cacheManager.openCacheFolder();
      if (error) {
        this.openFolderError.set(error);
      }
    } catch (error) {
      this.openFolderError.set(error instanceof Error ? error.message : String(error));
    }
  };

  /* Event handlers */
  protected readonly deleteCache = () => this.clearCache(() => this.cacheManager.clear());

  protected readonly deleteFullSizeCache = () => this.clearCache(() => this.cacheManager.clearFullSize());

  protected readonly deleteThumbnailsCache = () => this.clearCache(() => this.cacheManager.clearThumbnails());

  private readonly clearCache = async (clear: () => Promise<CacheClearResult>) => {
    if (this.isClearing()) {
      return;
    }

    this.isClearing.set(true);
    this.lastClearResult.set(null);
    this.clearError.set(null);

    try {
      const result = await clear();
      await this.updateCacheInfo();
      this.lastClearResult.set(result);
    } catch (error) {
      this.clearError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.isClearing.set(false);
    }
  };

  /* Static methods */
  static readonly open = (dialog: Dialog) => dialog.open(SettingsDialogComponent, {
    width: '1100px',
    maxWidth: '94vw'
  }).closed;
}
