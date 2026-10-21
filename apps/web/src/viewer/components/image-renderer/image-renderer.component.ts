import { AsyncPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  output,
  signal,
  viewChild
} from '@angular/core';
import { IconComponent } from '@light-matter/ui';
import { fromEvent, take } from 'rxjs';
import { DefaultPipe } from '../../../system/pipes/default/default.pipe';
import { PxPipe } from '../../../system/pipes/px/px-pipe';
import { ImagePositioningService } from '../../services/image-positioning/image-positioning.service';
import {
  defaultImagePositioningResult,
  ImageDimensions
} from '../../services/image-positioning/image-positioning.types';

@Component({
  selector: 'app-image-renderer',
  imports: [
    PxPipe,
    AsyncPipe,
    DefaultPipe,
    IconComponent
  ],
  templateUrl: './image-renderer.component.html',
  styleUrl: './image-renderer.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ImageRendererComponent implements OnDestroy {
  /* DI */
  private readonly imagePositioningService = inject(ImagePositioningService);

  /* Inputs */
  readonly url = input.required<string>();

  readonly comparisonMode = input<'hdr' | 'sdr' | 'side-by-side' | 'stacked' | 'dual-side-by-side'>('hdr');

  readonly comparisonSplit = input(50);

  protected readonly sdrClip = () => {
    const mode = this.comparisonMode();
    const split = Math.max(1, Math.min(99, this.comparisonSplit()));
    if (mode === 'side-by-side') return `inset(0 ${100 - split}% 0 0)`;
    if (mode === 'stacked') return `inset(0 0 ${100 - split}% 0)`;
    return 'inset(0 0 0 0)';
  };

  protected readonly hdrClip = () => {
    const mode = this.comparisonMode();
    const split = Math.max(1, Math.min(99, this.comparisonSplit()));
    if (mode === 'side-by-side') return `inset(0 0 0 ${split}%)`;
    if (mode === 'stacked') return `inset(${split}% 0 0 0)`;
    return 'inset(0 0 0 0)';
  };

  /* Outputs */
  readonly dimensions = output<ImageDimensions>();

  readonly pixelColorChange = output<{ r: number; g: number; b: number } | null>();

  readonly loadingChange = output<boolean>();

  readonly loadDuration = output<number>();

  readonly loadError = output<void>();

  readonly comparisonSplitChange = output<number>();

  readonly comparisonSplitCommit = output<number>();

  /* State */
  protected readonly displayUrl = signal<string | null>(null);

  protected readonly isLoading = signal(false);

  private readonly pixelCanvas = document.createElement('canvas');

  private pixelContext: CanvasRenderingContext2D | null = null;

  protected readonly viewportRef = viewChild<unknown, ElementRef<HTMLDivElement>>('surface', { read: ElementRef });

  protected readonly imageLocation$ = this.imagePositioningService.imageLocation();

  protected readonly defaultImageLocation = defaultImagePositioningResult();

  /* Constructor */
  constructor() {
    effect(() => {
      const surface = this.viewportRef();

      if (surface === undefined) {
        return;
      }

      this.imagePositioningService.setViewport(surface.nativeElement);
    });

    effect(() => this.preloadImage(this.url()));
  }

  /* Events */
  private splitPointerActive = false;

  protected readonly onSurfaceClick = (event: MouseEvent) => {
    const mode = this.comparisonMode();
    if (mode !== 'side-by-side' && mode !== 'stacked') {
      return;
    }

    if ((event.target as HTMLElement | null)?.closest('.comparison-split-handle')) {
      return;
    }

    const split = this.getSplitFromPointer(event.clientX, event.clientY);
    if (split !== null) {
      this.comparisonSplitChange.emit(split);
      this.comparisonSplitCommit.emit(split);
    }
  };

  protected readonly onSplitPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.splitPointerActive = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.updateSplitFromPointer(event);
  };

  protected readonly onSplitPointerMove = (event: PointerEvent) => {
    if (!this.splitPointerActive || event.buttons === 0) {
      return;
    }

    this.updateSplitFromPointer(event);
  };

  protected readonly onSplitPointerUp = (event: PointerEvent) => {
    if (!this.splitPointerActive) {
      return;
    }

    const split = this.getSplitFromPointer(event.clientX, event.clientY);
    this.splitPointerActive = false;
    if (split !== null) {
      this.comparisonSplitChange.emit(split);
      this.comparisonSplitCommit.emit(split);
    }
  };

  private readonly updateSplitFromPointer = (event: PointerEvent) => {
    const split = this.getSplitFromPointer(event.clientX, event.clientY);
    if (split !== null) {
      this.comparisonSplitChange.emit(split);
    }
  };

  private readonly getSplitFromPointer = (clientX: number, clientY: number): number | null => {
    const mode = this.comparisonMode();
    const surface = this.viewportRef()?.nativeElement;
    const image = surface?.querySelector<HTMLImageElement>('.hdr-image');
    const bounds = image?.getBoundingClientRect();

    if (bounds === undefined || bounds.width <= 0 || bounds.height <= 0) {
      return null;
    }

    const position = mode === 'side-by-side'
      ? (clientX - bounds.left) / bounds.width
      : (clientY - bounds.top) / bounds.height;

    return Math.max(1, Math.min(99, Math.round(position * 100)));
  };

  ngOnDestroy() {
    this.imagePositioningService.removeViewport();
  }

  protected readonly onMouseDown = (event: MouseEvent) => this.imagePositioningService.startPanning(event);

  protected readonly onSurfaceMouseMove = (event: MouseEvent) => {
    const surface = this.viewportRef()?.nativeElement;
    const images = surface?.querySelectorAll<HTMLImageElement>('.comparison-image:not(.hidden-variant)');
    const imageElement = images === undefined
      ? null
      : Array.from(images).find(image => {
          const bounds = image.getBoundingClientRect();
          return event.clientX >= bounds.left && event.clientX < bounds.right &&
            event.clientY >= bounds.top && event.clientY < bounds.bottom;
        }) ?? null;
    const sourceWidth = imageElement?.naturalWidth ?? 0;
    const sourceHeight = imageElement?.naturalHeight ?? 0;
    const bounds = imageElement?.getBoundingClientRect();

    if (imageElement === null || this.pixelContext === null || bounds === undefined ||
        sourceWidth <= 0 || sourceHeight <= 0 || bounds.width <= 0 || bounds.height <= 0) {
      this.pixelColorChange.emit(null);
      return;
    }

    // Account for object-fit: contain in the dual SDR/HDR layout, as well as zoom and pan.
    const scale = Math.min(bounds.width / sourceWidth, bounds.height / sourceHeight);
    const renderedWidth = sourceWidth * scale;
    const renderedHeight = sourceHeight * scale;
    const left = bounds.left + (bounds.width - renderedWidth) / 2;
    const top = bounds.top + (bounds.height - renderedHeight) / 2;
    const x = Math.floor((event.clientX - left) / scale);
    const y = Math.floor((event.clientY - top) / scale);

    if (x < 0 || y < 0 || x >= sourceWidth || y >= sourceHeight) {
      this.pixelColorChange.emit(null);
      return;
    }

    try {
      const pixel = this.pixelContext.getImageData(x, y, 1, 1).data;
      this.pixelColorChange.emit({ r: pixel[0], g: pixel[1], b: pixel[2] });
    } catch {
      // Some custom-protocol or protected images may disallow canvas readback.
      this.pixelColorChange.emit(null);
    }
  };

  protected readonly onSurfaceMouseLeave = () => this.pixelColorChange.emit(null);

  /* Misc */
  private readonly preloadImage = (url: string) => {
    const loadId = ++this.loadId;
    const startedAt = performance.now();
    this.isLoading.set(true);
    this.loadingChange.emit(true);

    const image = new Image();

    fromEvent(image, 'load')
      .pipe(take(1))
      .subscribe(() => this.onImageLoad(image, loadId, startedAt));

    fromEvent(image, 'error')
      .pipe(take(1))
      .subscribe(() => this.onImageError(loadId));

    image.src = url;
  };

  private loadId = 0;

  private readonly onImageLoad = (image: HTMLImageElement, loadId: number, startedAt: number) => {
    if (loadId !== this.loadId) {
      return;
    }

    this.isLoading.set(false);
    this.loadingChange.emit(false);

    const dimensions = { width: image.naturalWidth, height: image.naturalHeight };
    this.pixelCanvas.width = dimensions.width;
    this.pixelCanvas.height = dimensions.height;
    this.pixelContext = this.pixelCanvas.getContext('2d', { willReadFrequently: true });
    this.pixelContext?.drawImage(image, 0, 0);
    this.pixelColorChange.emit(null);
    this.displayUrl.set(image.src);
    this.imagePositioningService.setImageDimensions(dimensions);
    this.dimensions.emit(dimensions);
    this.loadDuration.emit((performance.now() - startedAt) / 1000);
  };

  private readonly onImageError = (loadId: number) => {
    if (loadId !== this.loadId) {
      return;
    }

    this.isLoading.set(false);
    this.loadingChange.emit(false);
    this.loadError.emit();
  };
}
