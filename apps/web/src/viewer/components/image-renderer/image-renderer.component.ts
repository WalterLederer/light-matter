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

  readonly comparisonMode = input<'hdr' | 'sdr' | 'side-by-side' | 'stacked'>('hdr');

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

  readonly loadingChange = output<boolean>();

  readonly loadDuration = output<number>();

  readonly loadError = output<void>();

  readonly comparisonSplitChange = output<number>();

  readonly comparisonSplitCommit = output<number>();

  /* State */
  protected readonly displayUrl = signal<string | null>(null);

  protected readonly isLoading = signal(false);

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
