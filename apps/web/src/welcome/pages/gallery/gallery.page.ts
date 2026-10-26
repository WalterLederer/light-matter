import { Dialog } from '@angular/cdk/dialog';
import { CdkMenu, CdkMenuItem } from '@angular/cdk/menu';
import { AsyncPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import {
  ActionButtonComponent,
  ConfirmationDialogComponent,
  IconComponent,
  OverlayService,
  PopupMenuComponent,
  SidePanelComponent,
  TextComponent,
  ToolbarComponent,
  TreeComponent,
  TreeLoadRequest,
  TreeNode,
  VerticalStackComponent
} from '@light-matter/ui';
import { CacheInfo, defaultThumbnailSize, FileInfo, SortDirection, SortType, ThumbnailSize } from 'internal-api';
import { ImageGridComponent } from '../../../gallery/components/image-grid/image-grid.component';
import { GalleryLocations } from '../../../gallery/services/gallery-locations/gallery-locations';
import { GalleryState } from '../../../gallery/services/gallery-state/gallery-state';
import { defaultSortMode, treeNode } from '../../../gallery/services/gallery-state/gallery-state.types';
import { Dialogs } from '../../../ipc/dialogs';
import { ProcessManager } from '../../../ipc/process-manager';
import { CacheManager } from '../../../ipc/cache-manager';
import { Configuration } from '../../../system/services/configuration/configuration';
import { take } from 'rxjs';
import { SettingsDialogComponent } from '../../../settings/components/settings-dialog/settings-dialog.component';
import { DefaultPipe } from '../../../system/pipes/default/default.pipe';
import { ImageView } from '../../../viewer/pages/image-view/image-view';
import { ViewNavigator } from '../../../viewer/services/view-navigator/view-navigator';

@Component({
  selector: 'app-gallery',
  imports: [
    AsyncPipe,
    ImageGridComponent,
    SidePanelComponent,
    TreeComponent,
    ActionButtonComponent,
    CdkMenu,
    CdkMenuItem,
    IconComponent,
    PopupMenuComponent,
    TextComponent,
    DefaultPipe,
    VerticalStackComponent,
    ToolbarComponent
  ],
  templateUrl: './gallery.page.html',
  styleUrl: './gallery.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GalleryPage {
  /* DI */
  private readonly galleryState = inject(GalleryState);

  private readonly processManager = inject(ProcessManager);

  private readonly cacheManager = inject(CacheManager);

  private readonly configuration = inject(Configuration);

  private readonly dialogs = inject(Dialogs);

  private readonly dialog = inject(Dialog);

  private readonly galleryLocations = inject(GalleryLocations);

  readonly router = inject(Router);

  readonly viewNavigator = inject(ViewNavigator);

  readonly overlayService = inject(OverlayService);

  protected readonly tree = viewChild.required(TreeComponent);

  protected readonly defaultSortMode = defaultSortMode();

  protected readonly defaultThumbnailSize = defaultThumbnailSize;

  protected readonly controlsSidebarVisible = signal(true);
  protected readonly generalSections = signal<Record<string, boolean>>({ cache: true, locations: true, debug: true });
  protected readonly generalSectionExpanded = (key: string): boolean => this.generalSections()[key] === true;
  protected readonly toggleGeneralSection = (key: string): void => {
    const sections = { ...this.generalSections(), [key]: !this.generalSectionExpanded(key) };
    this.generalSections.set(sections);
    this.configuration.updateSystemConfig({ gallerySidebarSections: sections });
  };
  protected readonly toggleControlsSidebar = (): void => this.controlsSidebarVisible.update(value => !value);
  protected readonly debugImageSwitching = signal(this.readDebugImageSwitching());
  protected readonly cacheInfo = signal<CacheInfo>({ path: '', entries: 0, bytes: 0, fullSize: { entries: 0, bytes: 0 }, thumbnails: { entries: 0, bytes: 0 } });
  protected readonly configPath = signal('');
  protected readonly generalSettingsError = signal<string | null>(null);
  private readDebugImageSwitching(): boolean { try { return globalThis.localStorage.getItem('light-matter.debugImageSwitching') === 'true'; } catch { return false; } }
  protected readonly setDebugImageSwitching = (enabled: boolean): void => { this.debugImageSwitching.set(enabled); try { globalThis.localStorage.setItem('light-matter.debugImageSwitching', String(enabled)); } catch { /* session-only fallback */ } };
  protected readonly refreshGeneralSettings = async (): Promise<void> => {
    try { this.cacheInfo.set(await this.cacheManager.cacheInfo()); this.configPath.set((await this.processManager.getSystemPaths()).appConfig); this.generalSettingsError.set(null); }
    catch (error) { this.generalSettingsError.set(error instanceof Error ? error.message : String(error)); }
  };
  protected readonly openCacheFolder = async (): Promise<void> => { const error = await this.cacheManager.openCacheFolder(); if (error) this.generalSettingsError.set(error); };
  protected readonly openConfigFile = async (): Promise<void> => { const error = await this.processManager.openConfigFile(); if (error) this.generalSettingsError.set(error); };

  /* State */
  readonly galleryRoot$ = this.galleryState.galleryRoot();

  readonly selectedLocation$ = this.galleryState.selectedLocation();

  readonly images$ = this.galleryState.images();

  readonly sortMode$ = this.galleryState.sortMode();

  readonly thumbSize$ = this.galleryState.thumbSize();

  constructor() {
    this.configuration.config().pipe(take(1)).subscribe(config => {
      this.generalSections.set({ cache: true, locations: true, debug: true, ...config.system.gallerySidebarSections });
    });
    void this.refreshGeneralSettings();
    this.processManager.getAppVersion()
      .then(version => this.processManager.setWindowTitle(`Light Matter - ${version}`))
      .catch(() => undefined);
  }

  /* Event handlers */
  protected readonly onSortByChange = (value: SortType) => this.galleryState.changeSorting({ sortBy: value });

  protected readonly onSortDirChange = (value: SortDirection) => this.galleryState.changeSorting({ sortDir: value });

  protected readonly onThumbSizeChange = (value: ThumbnailSize) => this.galleryState.changeThumbnailSize(value);

  protected readonly onAddLocation = async () => {
    const result = await this.dialogs.openFolder();

    if (result.success) {
      this.galleryLocations.addLocation(result.data);
    }
  };

  protected readonly onRemoveLocation = async (data: TreeNode<string>) =>
    ConfirmationDialogComponent
      .open(
        this.dialog,
        {
          title: 'Confirm location removal',
          description: `Are you sure you want to remove "${data.id}" from gallery locations?`
        }
      )
      .subscribe(() => this.galleryLocations.removeLocation(data.id));

  protected readonly openSettings = () => SettingsDialogComponent.open(this.dialog);

  protected readonly loadTreeNode = async (state: TreeLoadRequest<string>) => {
    const result = await this.galleryState.getDirContents(state.node.id);
    const node = structuredClone(state.node);

    if (result.success) {
      node.children = result.data.map(location => treeNode(location.path, true));
    }

    this.tree().updateNode(node);
  };

  protected readonly selectLocation = (node: TreeNode<string>) =>
    this.galleryState
      .navigateTo(node.id)
      .subscribe();

  protected readonly onImageSelected = (file: FileInfo) =>
    this.viewNavigator
      .selectImage(file.path)
      .subscribe(() => this.overlayService.show(ImageView));
}
