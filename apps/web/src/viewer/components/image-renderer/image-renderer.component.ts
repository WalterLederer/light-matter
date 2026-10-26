import { AsyncPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  OnInit,
  output,
  signal,
  viewChild
} from '@angular/core';
import { IconComponent } from '@light-matter/ui';
import { fromEvent, take } from 'rxjs';
import { DefaultPipe } from '../../../system/pipes/default/default.pipe';
import { MainImageBrightnessRenderer, WebGpuDiagnosticPatternRenderer, WebGpuHdrDiagnosticPatternRenderer } from './main-image-brightness-renderer';
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
export class ImageRendererComponent implements OnInit, OnDestroy {
  /* DI */
  private readonly imagePositioningService = inject(ImagePositioningService);

  /* Inputs */
  readonly url = input.required<string>();

  readonly debugImageSwitching = input(false);

  readonly comparisonMode = input<'hdr' | 'sdr' | 'side-by-side' | 'stacked' | 'dual-side-by-side' | 'dual-stacked'>('hdr');

  readonly comparisonSplit = input(50);

  /** Display brightness for the main image; 1 leaves it unchanged. */
  readonly displayBrightness = input(1);

  /** Rendering path for brightness changes to the SDR main image. */
  readonly brightnessRendererMode = input<'css' | 'webgpu'>('webgpu');

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

  readonly pixelDebugChange = output<string>();

  readonly loadingChange = output<boolean>();

  readonly debugSwitchingPhase = output<string>();

  readonly loadDuration = output<number>();

  readonly decodeDuration = output<number | null>();

  readonly totalDuration = output<number | null>();

  readonly loadError = output<void>();

  readonly comparisonSplitChange = output<number>();

  readonly comparisonSplitCommit = output<number>();

  /* State */
  protected readonly displayUrl = signal<string | null>(null);

  protected readonly isLoading = signal(false);

  private readonly pixelCanvas = document.createElement('canvas');

  private readonly mainImageBrightnessRenderer = new MainImageBrightnessRenderer('sdr');
  private readonly mainHdrBrightnessRenderer = new MainImageBrightnessRenderer('hdr');
  // Independent diagnostic renderer: keeps the test overlay isolated from the main canvas.
  private readonly sdrDiagnosticRenderer = new MainImageBrightnessRenderer('sdr', false);
  private readonly hdrDiagnosticRenderer = new MainImageBrightnessRenderer('hdr', true);
  private readonly hdrLinearImageDiagnosticRenderer = new MainImageBrightnessRenderer('hdr', true, 'srgb-linear');
  protected readonly hdrLinearImageDiagnosticError = signal<string | null>(null);
  private readonly hdrPatternRenderer = new WebGpuDiagnosticPatternRenderer();
  private readonly hdrOutputPatternRenderer = new WebGpuHdrDiagnosticPatternRenderer('srgb');
  private readonly hdrLinearOutputPatternRenderer = new WebGpuHdrDiagnosticPatternRenderer('srgb-linear');
  protected readonly hdrOutputPatternError = signal<string | null>(null);
  protected readonly hdrLinearOutputPatternError = signal<string | null>(null);
  protected readonly hdrPatternError = signal<string | null>(null);
  protected readonly hdrDiagnosticError = signal<string | null>(null);
  private gpuRenderRequest = 0;
  protected readonly gpuBrightnessReady = signal(false);
  protected readonly gpuBrightnessFailed = signal(false);
  protected readonly gpuHdrBrightnessReady = signal(false);
  protected readonly gpuHdrBrightnessFailed = signal(false);

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

    // Keep the source image visible until the GPU canvas has completed a frame.
    // The canvas remains in the compositor tree (visibility/opacity, not display:none)
    // so its WebGPU surface is initialized before it replaces the source image.
    effect(() => {
      const url = this.displayUrl();
      const brightness = this.displayBrightness();
      const mode = this.brightnessRendererMode();
      const comparison = this.comparisonMode();
      const request = ++this.gpuRenderRequest;
      this.gpuBrightnessReady.set(false);
      this.gpuBrightnessFailed.set(false);
      this.gpuHdrBrightnessReady.set(false);
      this.gpuHdrBrightnessFailed.set(false);

      if (url === null || mode !== 'webgpu') return;

      const renderSdr = brightness !== 1 && comparison !== 'hdr';
      const renderHdr = comparison !== 'sdr';
      queueMicrotask(() => {
        if (request !== this.gpuRenderRequest) return;
        if (renderSdr) void this.renderMainImageBrightness(request, url, brightness);
        if (renderHdr) {
          // The diagnostic must run at normal brightness too; it is independent
          // of the optional brightness-adjustment pass.
          // Keep experimental diagnostic canvases out of the normal HDR path.
          if (brightness !== 1) void this.renderMainHdrBrightness(request, url, brightness);
        }
      });
    });

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

  ngOnInit() {
    if (this.debugImageSwitching()) this.debugSwitchingPhase.emit('renderer lifecycle: created');
  }

  ngOnDestroy() {
    if (this.debugImageSwitching()) this.debugSwitchingPhase.emit('renderer lifecycle: destroyed');
    this.gpuRenderRequest++;
    this.mainImageBrightnessRenderer.dispose();
    this.mainHdrBrightnessRenderer.dispose();
    this.sdrDiagnosticRenderer.dispose();
    this.hdrDiagnosticRenderer.dispose();
    this.hdrLinearImageDiagnosticRenderer.dispose();
    this.hdrPatternRenderer.dispose();
    this.hdrOutputPatternRenderer.dispose();
    this.hdrLinearOutputPatternRenderer.dispose();
    this.imagePositioningService.removeViewport();
  }

  private readonly renderMainImageBrightness = async (request: number, url: string, brightness: number, attempt = 0): Promise<void> => {
    if (request !== this.gpuRenderRequest || this.displayUrl() !== url) return;
    const surface = this.viewportRef()?.nativeElement;
    const image = surface?.querySelector<HTMLImageElement>('img.sdr-image');
    const canvas = surface?.querySelector<HTMLCanvasElement>('canvas.sdr-gpu-image');
    if (!image || !canvas || !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      if (attempt < 30) requestAnimationFrame(() => {
        void this.renderMainImageBrightness(request, url, brightness, attempt + 1);
      });
      return;
    }
    try {
      await this.mainImageBrightnessRenderer.render(canvas, image, brightness);
      if (request === this.gpuRenderRequest && this.displayUrl() === url) this.gpuBrightnessReady.set(true);
    } catch (error) {
      console.error('Main-image SDR WebGPU brightness render failed:', error);
      if (request === this.gpuRenderRequest && this.displayUrl() === url) this.gpuBrightnessFailed.set(true);
    }
  };

  private readonly renderHdrPattern = async (request: number, attempt = 0): Promise<void> => {
    if (request !== this.gpuRenderRequest) return;
    const canvas = this.viewportRef()?.nativeElement.querySelector<HTMLCanvasElement>('canvas.hdr-copy-diagnostic-pattern');
    if (!canvas) {
      if (attempt < 30) requestAnimationFrame(() => void this.renderHdrPattern(request, attempt + 1));
      return;
    }
    try {
      await this.hdrPatternRenderer.render(canvas);
      if (request === this.gpuRenderRequest) this.hdrPatternError.set(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.hdrPatternError.set(message);
      console.error('HDR diagnostic GPU test pattern failed:', error);
    }
  };

  private readonly renderHdrOutputPattern = async (request: number, attempt = 0): Promise<void> => {
    if (request !== this.gpuRenderRequest) return;
    const canvas = this.viewportRef()?.nativeElement.querySelector<HTMLCanvasElement>('canvas.hdr-output-diagnostic-pattern');
    if (!canvas) {
      if (attempt < 30) requestAnimationFrame(() => void this.renderHdrOutputPattern(request, attempt + 1));
      return;
    }
    try {
      await this.hdrOutputPatternRenderer.render(canvas);
      if (request === this.gpuRenderRequest) this.hdrOutputPatternError.set(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.hdrOutputPatternError.set(message);
      console.error('HDR output diagnostic pattern failed:', error);
    }
  };

  private readonly renderHdrLinearOutputPattern = async (request: number, attempt = 0): Promise<void> => {
    if (request !== this.gpuRenderRequest) return;
    const canvas = this.viewportRef()?.nativeElement.querySelector<HTMLCanvasElement>('canvas.hdr-linear-output-diagnostic-pattern');
    if (!canvas) {
      if (attempt < 30) requestAnimationFrame(() => void this.renderHdrLinearOutputPattern(request, attempt + 1));
      return;
    }
    try {
      await this.hdrLinearOutputPatternRenderer.render(canvas);
      if (request === this.gpuRenderRequest) this.hdrLinearOutputPatternError.set(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.hdrLinearOutputPatternError.set(message);
      console.error('HDR linear output diagnostic pattern failed:', error);
    }
  };

  private readonly renderSdrDiagnostic = async (request: number, url: string, attempt = 0): Promise<void> => {
    if (request !== this.gpuRenderRequest || this.displayUrl() !== url) return;
    const surface = this.viewportRef()?.nativeElement;
    const image = surface?.querySelector<HTMLImageElement>('img.hdr-image');
    const diagnosticCanvas = surface?.querySelector<HTMLCanvasElement>('canvas.hdr-copy-diagnostic-sdr-canvas');
    if (!image || !diagnosticCanvas || !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      if (attempt < 30) requestAnimationFrame(() => {
        void this.renderSdrDiagnostic(request, url, attempt + 1);
      });
      return;
    }

    try {
      await this.sdrDiagnosticRenderer.render(diagnosticCanvas, image, 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.hdrDiagnosticError.set('SDR-Texturtest: ' + message);
      console.error('SDR copy diagnostic render failed:', error);
    }
  };
  private readonly renderHdrDiagnostic = async (request: number, url: string, attempt = 0): Promise<void> => {
    if (request !== this.gpuRenderRequest || this.displayUrl() !== url) return;
    const surface = this.viewportRef()?.nativeElement;
    const image = surface?.querySelector<HTMLImageElement>('img.hdr-image');
    const diagnosticCanvas = surface?.querySelector<HTMLCanvasElement>('canvas.hdr-copy-diagnostic-canvas');
    if (!image || !diagnosticCanvas || !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      if (attempt < 30) requestAnimationFrame(() => {
        void this.renderHdrDiagnostic(request, url, attempt + 1);
      });
      return;
    }

    try {
      await this.hdrDiagnosticRenderer.render(diagnosticCanvas, image, 1);
      if (request === this.gpuRenderRequest && this.displayUrl() === url) this.hdrDiagnosticError.set(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.hdrDiagnosticError.set(message);
      console.error('HDR copy diagnostic render failed:', error);
    }
  };

  private readonly renderHdrLinearImageDiagnostic = async (request: number, url: string, attempt = 0): Promise<void> => {
    if (request !== this.gpuRenderRequest || this.displayUrl() !== url) return;
    const surface = this.viewportRef()?.nativeElement;
    const image = surface?.querySelector<HTMLImageElement>('img.hdr-image');
    const canvas = surface?.querySelector<HTMLCanvasElement>('canvas.hdr-linear-image-diagnostic-canvas');
    if (!image || !canvas || !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      if (attempt < 30) requestAnimationFrame(() => {
        void this.renderHdrLinearImageDiagnostic(request, url, attempt + 1);
      });
      return;
    }
    try {
      await this.hdrLinearImageDiagnosticRenderer.render(canvas, image, 1);
      if (request === this.gpuRenderRequest && this.displayUrl() === url) this.hdrLinearImageDiagnosticError.set(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.hdrLinearImageDiagnosticError.set(message);
      console.error('HDR image srgb-linear diagnostic render failed:', error);
    }
  };

  private readonly renderMainHdrBrightness = async (request: number, url: string, brightness: number, attempt = 0): Promise<void> => {
    if (request !== this.gpuRenderRequest || this.displayUrl() !== url) return;
    const surface = this.viewportRef()?.nativeElement;
    const image = surface?.querySelector<HTMLImageElement>('img.hdr-image');
    const canvas = surface?.querySelector<HTMLCanvasElement>('canvas.hdr-gpu-image');
    if (!image || !canvas || !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      if (attempt < 30) requestAnimationFrame(() => {
        void this.renderMainHdrBrightness(request, url, brightness, attempt + 1);
      });
      return;
    }
    try {
      await this.mainHdrBrightnessRenderer.render(canvas, image, brightness);
      if (request === this.gpuRenderRequest && this.displayUrl() === url) this.gpuHdrBrightnessReady.set(true);
    } catch (error) {
      console.error('Main-image HDR WebGPU brightness render failed:', error);
      if (request === this.gpuRenderRequest && this.displayUrl() === url) this.gpuHdrBrightnessFailed.set(true);
    }
  };

  protected readonly onMouseDown = (event: MouseEvent) => this.imagePositioningService.startPanning(event);

  protected readonly onSurfaceMouseMove = (event: MouseEvent) => {
    const surface = this.viewportRef()?.nativeElement;
    const target = event.target;
    const images = surface?.querySelectorAll<HTMLImageElement>('.comparison-image:not(.hidden-variant)');
    const targetImage = target instanceof HTMLImageElement &&
      target.matches('.comparison-image:not(.hidden-variant)')
      ? target
      : null;
    const imageElement = targetImage ?? (images === undefined
      ? null
      : Array.from(images).find(image => {
          const bounds = image.getBoundingClientRect();
          return event.clientX >= bounds.left && event.clientX < bounds.right &&
            event.clientY >= bounds.top && event.clientY < bounds.bottom;
        }) ?? null);

    const targetDescription = target instanceof HTMLElement
      ? `${target.tagName.toLowerCase()}.${String(target.className).replace(/\\s+/g, '.').slice(0, 48)}`
      : String(target);
    const imageDescription = imageElement === null
      ? 'none'
      : `${imageElement.className} ${imageElement.naturalWidth}x${imageElement.naturalHeight} complete=${imageElement.complete}`;

    if (imageElement === null) {
      this.pixelDebugChange.emit(`move target=${targetDescription}; images=${images?.length ?? 0}; image=none`);
      this.pixelColorChange.emit(null);
      return;
    }

    const sourceWidth = imageElement.naturalWidth;
    const sourceHeight = imageElement.naturalHeight;
    const bounds = imageElement.getBoundingClientRect();

    if (this.pixelContext === null) {
      this.pixelDebugChange.emit(`move target=${targetDescription}; image=${imageDescription}; canvas=NONE`);
      this.pixelColorChange.emit(null);
      return;
    }

    if (sourceWidth <= 0 || sourceHeight <= 0 || bounds.width <= 0 || bounds.height <= 0) {
      this.pixelDebugChange.emit(`move target=${targetDescription}; image=${imageDescription}; bounds=${Math.round(bounds.width)}x${Math.round(bounds.height)}`);
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
      this.pixelDebugChange.emit(`move image=${imageDescription}; outside x=${x} y=${y}; scale=${scale.toFixed(3)}`);
      this.pixelColorChange.emit(null);
      return;
    }

    try {
      this.pixelContext.clearRect(0, 0, 1, 1);
      // Sample the exact source pixel explicitly; negative destination offsets can
      // be misleading when the displayed image is zoomed or transformed.
      this.pixelContext.drawImage(imageElement, x, y, 1, 1, 0, 0, 1, 1);
      const pixel = this.pixelContext.getImageData(0, 0, 1, 1).data;
      const rgb = { r: pixel[0], g: pixel[1], b: pixel[2] };
      this.pixelDebugChange.emit(`OK ${imageElement.classList.contains('sdr-image') ? 'SDR' : 'HDR'} x=${x} y=${y} rgb=${rgb.r},${rgb.g},${rgb.b}`);
      this.pixelColorChange.emit(rgb);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pixelDebugChange.emit(`CANVAS ERROR: ${message.slice(0, 90)}`);
      this.pixelColorChange.emit(null);
    }
  };

  protected readonly onSurfaceMouseLeave = () => { this.pixelDebugChange.emit('mouseleave'); this.pixelColorChange.emit(null); };

  /* Misc */
  private readonly preloadImage = async (url: string) => {
    const loadId = ++this.loadId;
    const startedAt = performance.now();
    this.debugLoadStartedAt = startedAt;
    this.debugTargetUrl = url;

    // Pause before changing loading state so we can tell whether the flicker
    // starts in navigation/selection or only after the renderer reacts to loading.
    await this.debugPause('preload: start (before loading state)', loadId);
    if (loadId !== this.loadId) return;

    this.isLoading.set(true);
    this.loadingChange.emit(true);

    const image = new Image();
    // Allow pixel reads from the app's custom protocol; the protocol handler sends ACAO.
    image.crossOrigin = 'anonymous';

    fromEvent(image, 'load')
      .pipe(take(1))
      .subscribe(() => this.onImageLoad(image, loadId, startedAt));

    fromEvent(image, 'error')
      .pipe(take(1))
      .subscribe(() => this.onImageError(loadId));

    image.src = url;
    await this.debugPause('preload: image.src assigned', loadId);
  };

  private loadId = 0;

  private debugLoadStartedAt = 0;

  private debugTargetUrl = '';

  private readonly debugUrlLabel = (url: string | null): string => {
    if (url === null) return 'null';
    // Keep the status readout compact while retaining enough of the URL to identify a file.
    const cleanUrl = url.replace(/^atom:\/\/app\/raw\?image=/, '');
    return cleanUrl.length > 72 ? `…${cleanUrl.slice(-69)}` : cleanUrl;
  };

  private readonly debugGeometry = (): string => {
    const surface = this.viewportRef()?.nativeElement;
    if (surface === undefined) return 'surface=none';

    const surfaceBounds = surface.getBoundingClientRect();
    const images = Array.from(surface.querySelectorAll<HTMLImageElement>('.comparison-image'));
    const imageStates = images.map(image => {
      const bounds = image.getBoundingClientRect();
      return `${image.classList.contains('hdr-image') ? 'HDR' : 'SDR'}:${image.naturalWidth}x${image.naturalHeight},${Math.round(bounds.left)},${Math.round(bounds.top)},${Math.round(bounds.width)}x${Math.round(bounds.height)},complete=${image.complete}`;
    }).join('|') || 'images=none';

    return `surface=${Math.round(surfaceBounds.left)},${Math.round(surfaceBounds.top)},${Math.round(surfaceBounds.width)}x${Math.round(surfaceBounds.height)}; ${imageStates}`;
  };

  // Several image-loading callbacks can overlap (for example, assigning src and
  // receiving the browser load event). Serialize debug pauses so each phase is
  // visible for the full interval instead of being overwritten by another callback.
  private debugPauseQueue: Promise<void> = Promise.resolve();

  private readonly debugPause = (phase: string, loadId: number): Promise<void> => {
    if (!this.debugImageSwitching()) return Promise.resolve();

    const pause = this.debugPauseQueue.then(async () => {
      if (loadId !== this.loadId || !this.debugImageSwitching()) return;
      const elapsedMs = Math.round(performance.now() - this.debugLoadStartedAt);
      const displayedUrl = this.displayUrl();
      this.debugSwitchingPhase.emit(
        `${phase} · #${loadId} · ${elapsedMs}ms · shown=${this.debugUrlLabel(displayedUrl)} · target=${this.debugUrlLabel(this.debugTargetUrl)} · ${this.debugGeometry()}`
      );
      await new Promise<void>(resolve => setTimeout(resolve, 1000));
    });

    // Keep the queue usable even if a future phase callback unexpectedly fails.
    this.debugPauseQueue = pause.catch(() => undefined);
    return pause;
  };

  private readonly onImageLoad = async (image: HTMLImageElement, loadId: number, startedAt: number) => {
    if (loadId !== this.loadId) {
      return;
    }

    await this.debugPause('load: browser load event', loadId);
    if (loadId !== this.loadId) return;
    this.isLoading.set(false);
    this.loadingChange.emit(false);

    const dimensions = { width: image.naturalWidth, height: image.naturalHeight };
    this.pixelCanvas.width = 1;
    this.pixelCanvas.height = 1;
    this.pixelContext = this.pixelCanvas.getContext('2d', { willReadFrequently: true });
    this.pixelColorChange.emit(null);
    this.displayUrl.set(image.src);
    await this.debugPause('display: displayUrl updated', loadId);
    if (loadId !== this.loadId) return;
    this.imagePositioningService.setImageDimensions(dimensions);
    await this.debugPause('layout: image dimensions updated', loadId);
    if (loadId !== this.loadId) return;
    this.dimensions.emit(dimensions);
    this.loadDuration.emit((performance.now() - startedAt) / 1000);

    await this.debugPause('decode: start', loadId);
    if (loadId !== this.loadId) return;
    const decodeStartedAt = performance.now();
    image.decode()
      .then(async () => {
        if (loadId === this.loadId) {
          await this.debugPause('decode: completed', loadId);
          if (loadId !== this.loadId) return;
          const completedAt = performance.now();
          this.decodeDuration.emit((completedAt - decodeStartedAt) / 1000);
          // Total time is elapsed wall-clock time from preloadImage() starting
          // until the image.decode() promise settles. It is not Load + Decode + Convert:
          // conversion may already be included in the load/request interval.
          this.totalDuration.emit((completedAt - startedAt) / 1000);
        }
      })
      .catch(async () => {
        if (loadId === this.loadId) {
          await this.debugPause('decode: failed', loadId);
          if (loadId !== this.loadId) return;
          const completedAt = performance.now();
          this.decodeDuration.emit(null);
          // If decode rejects, still report elapsed time through the settled decode
          // attempt. The displayed Decode time remains unavailable in that case.
          this.totalDuration.emit((completedAt - startedAt) / 1000);
        }
      });
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
