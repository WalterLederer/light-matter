import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  output,
  signal
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { CaptionComponent } from '@light-matter/ui';
import { ExifTags, FileInfo, thumbnailDimensions } from 'internal-api';
import { DatePipe, DecimalPipe } from '@angular/common';
import { ExifService } from '../../../ipc/exif';
import { GalleryViewMode } from '../../../gallery/components/images/images.component.types';
import { distinctUntilChanged, Subscription } from 'rxjs';
import { DevicePixelRatioService } from '../../../system/services/device-pixel-ratio/device-pixel-ratio.service';
import { ThumbnailLoaderService } from '../../../system/services/thumbnail-loader/thumbnail-loader.service';
import { thumbUrl } from '../../../viewer/utils/image-url';

@Component({
  selector: 'app-thumbnail',
  imports: [
    CaptionComponent,
    DatePipe,
    DecimalPipe
  ],
  templateUrl: './thumbnail.component.html',
  styleUrl: './thumbnail.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[style.--fit]': 'fit()',
    '[class.view-tiles]': "viewMode() === 'tiles'",
    '[class.view-details]': "viewMode() === 'details'",
    '(mouseenter)': 'hovered.emit(image())',
    '(mouseleave)': 'hovered.emit(null)'
  }
})
export class ThumbnailComponent implements OnDestroy {
  /* DI */
  private readonly devicePixelRatioService = inject(DevicePixelRatioService);

  private readonly thumbnailLoader = inject(ThumbnailLoaderService);

  private readonly elementRef = inject(ElementRef);

  private readonly exif = inject(ExifService);

  /* Inputs/outputs */
  readonly image = input.required<FileInfo>();

  readonly viewMode = input<GalleryViewMode>('thumbnails');

  readonly clicked = output<FileInfo>();

  readonly hovered = output<FileInfo | null>();

  /* State */
  private readonly pixelRatio = toSignal(
    this.devicePixelRatioService
      .pixelRatio()
      .pipe(distinctUntilChanged())
  );

  readonly url = computed(() => {
    const image = this.image();
    const pixelRatio = this.pixelRatio() || 1;
    const maxPreview = thumbnailDimensions.large;
    return thumbUrl(image.path, maxPreview.width / pixelRatio, maxPreview.height / pixelRatio);
  });

  readonly isLoading = signal<boolean>(true);

  readonly isVisible = signal<boolean>(false);

  readonly hasError = signal<boolean>(false);

  readonly imageTags = signal<ExifTags | null>(null);

  readonly imageDimensions = computed(() => {
    const tags = this.imageTags();
    const width = Number(tags?.ImageWidth);
    const height = Number(tags?.ImageHeight);
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? `${width.toLocaleString()} × ${height.toLocaleString()}`
      : '—';
  });

  private infoRequest = 0;

  protected readonly fit = signal('cover');

  private loaderSubscription: Subscription | null = null;

  private intersectionObserver: IntersectionObserver | null = null;

  /* Constructor */
  constructor() {
    effect(() => {
      const image = this.image();
      if (!this.isVisible() || this.viewMode() === 'thumbnails') return;
      const request = ++this.infoRequest;
      void this.exif.read(image.path).then(result => {
        if (request !== this.infoRequest || this.image().path !== image.path) return;
        this.imageTags.set(result.success ? result.data : null);
      }).catch(() => {
        if (request === this.infoRequest) this.imageTags.set(null);
      });
    });

    effect(() => {
      this.hasError.set(false);
      this.isLoading.set(true);

      if (!this.isVisible()) {
        return;
      }

      this.loaderSubscription?.unsubscribe();

      this.loaderSubscription = this.thumbnailLoader
        .add(this.url())
        .subscribe({
          next: success => this.hasError.set(!success),
          complete: () => this.isLoading.set(false)
        });
    });

    this.intersectionObserver = new IntersectionObserver(entries => {
      if (entries.length === 0 || entries[0].intersectionRatio <= 0) {
        return;
      }

      this.intersectionObserver?.disconnect();
      this.isVisible.set(true);
    });

    this.intersectionObserver.observe(this.elementRef.nativeElement);
  }

  ngOnDestroy() {
    this.infoRequest++;
    this.intersectionObserver?.disconnect();
    this.loaderSubscription?.unsubscribe();
  }
}
