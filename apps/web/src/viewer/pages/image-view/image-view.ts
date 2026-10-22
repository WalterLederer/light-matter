import { Dialog } from '@angular/cdk/dialog';
import { AsyncPipe, DecimalPipe, DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import {
  ActionButtonComponent,
  ConfirmationDialogComponent,
  IconComponent,
  InfoOverlayComponent,
  OverlayService,
  SliderComponent,
  TextComponent,
  ToolMenuComponent
} from '@light-matter/ui';
import { Desktop, ExifTags, ImageHistogram } from 'internal-api';
import { catchError, distinctUntilChanged, filter, from, fromEvent, map, of, startWith, switchMap, take, tap } from 'rxjs';
import { ExifService } from '../../../ipc/exif';
import { HistogramService } from '../../../ipc/histogram';
import { ProcessManager } from '../../../ipc/process-manager';
import { VerticalDivider } from '../../../system/components/vertical-divider/vertical-divider';
import { DefaultPipe } from '../../../system/pipes/default/default.pipe';
import { Configuration } from '../../../system/services/configuration/configuration';
import { Keyboard } from '../../../system/services/keyboard/keyboard';
import { ExifInfoComponent } from '../../components/exif-info/exif-info.component';
import { ImageRendererComponent } from '../../components/image-renderer/image-renderer.component';
import { imageDynamicRange } from '../../utils/image-dynamic-range';
import { ImagePositioningService } from '../../services/image-positioning/image-positioning.service';
import {
  defaultImagePositioningResult,
  ImageDimensions
} from '../../services/image-positioning/image-positioning.types';
import { ViewNavigator } from '../../services/view-navigator/view-navigator';

@Component({
  selector: 'app-image-view',
  imports: [
    AsyncPipe,
    ImageRendererComponent,
    ToolMenuComponent,
    ActionButtonComponent,
    IconComponent,
    VerticalDivider,
    TextComponent,
    DefaultPipe,
    SliderComponent,
    ReactiveFormsModule,
    DecimalPipe,
    InfoOverlayComponent,
    ExifInfoComponent
  ],
  templateUrl: './image-view.html',
  styleUrl: './image-view.scss',
  host: { '[class.decoding]': 'isDecoding()' },
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ImageView {
  /* DI */
  protected readonly viewNavigator = inject(ViewNavigator);

  private readonly keyboard = inject(Keyboard);

  private readonly destroyRef = inject(DestroyRef);

  private readonly document = inject(DOCUMENT);

  private readonly exif = inject(ExifService);

  private readonly histogram = inject(HistogramService);

  private readonly processManager = inject(ProcessManager);

  private appTitleSuffix = '';

  private readonly imagePositioningService = inject(ImagePositioningService);

  private readonly overlayService = inject(OverlayService);

  private readonly dialog = inject(Dialog);

  private readonly configuration = inject(Configuration);

  private readonly readStoredBoolean = (key: string, fallback: boolean): boolean => {
    try {
      const value = this.document.defaultView?.localStorage.getItem(`light-matter.${key}`);
      return value === null || value === undefined ? fallback : value === 'true';
    } catch {
      return fallback;
    }
  };

  private readonly storeBoolean = (key: string, value: boolean): void => {
    try {
      this.document.defaultView?.localStorage.setItem(`light-matter.${key}`, String(value));
    } catch {
      // Preferences remain usable for the current session if storage is unavailable.
    }
  };

  /* State */
  protected readonly selectedImage$ = this.viewNavigator.selectedImage();

  protected readonly hasPrevious$ = this.viewNavigator.hasPrevious();

  protected readonly hasNext$ = this.viewNavigator.hasNext();

  protected readonly imagePosition$ = this.viewNavigator.imagePosition();

  protected readonly imageLocation$ = this.imagePositioningService.imageLocation();

  protected readonly defaultImageLocation = defaultImagePositioningResult();

  protected readonly imageDimensions = signal<ImageDimensions>({ width: 0, height: 0 });

  protected readonly pixelColor = signal<{ r: number; g: number; b: number } | null>(null);

  protected readonly pixelDebug = signal('waiting for mouse movement');

  protected readonly isDecoding = signal(false);

  protected readonly debugImageSwitching = signal(this.readDebugImageSwitching());

  protected readonly debugSwitchingPhase = signal<string | null>(null);

  protected readonly debugSwitchingTrace = signal<string[]>([]);

  private debugTraceStartedAt = 0;

  private readonly traceDebugSwitching = (event: string): void => {
    if (!this.debugImageSwitching()) return;
    if (this.debugTraceStartedAt === 0) this.debugTraceStartedAt = performance.now();
    const elapsed = Math.round(performance.now() - this.debugTraceStartedAt);
    const trace = [...this.debugSwitchingTrace(), `${elapsed}ms ${event}`].slice(-5);
    this.debugSwitchingTrace.set(trace);
  };

  private readDebugImageSwitching(): boolean {
    try { return this.document.defaultView?.localStorage.getItem('light-matter.debugImageSwitching') === 'true'; }
    catch { return false; }
  }

  protected readonly onDebugSwitchingPhase = (phase: string): void => {
    if (this.debugImageSwitching()) {
      this.debugSwitchingPhase.set(phase);
      this.traceDebugSwitching(`renderer ${phase.split(' · ')[0]}`);
    }
  };

  protected readonly loadDuration = signal<number | null>(null);

  protected readonly imageDecodeDuration = signal<number | null>(null);

  protected readonly imageTotalDuration = signal<number | null>(null);

  protected readonly conversionDuration = signal<number | null>(null);
  protected readonly fullSizeFromCache = signal<boolean | null>(null);

  private conversionRequestId = 0;

  protected readonly onImageLoadingChange = (loading: boolean): void => {
    this.isDecoding.set(loading);
    this.loadDuration.set(null);
    this.imageDecodeDuration.set(null);
    this.imageTotalDuration.set(null);
    this.conversionRequestId++;
    this.conversionDuration.set(null);
    this.fullSizeFromCache.set(null);
    this.imageLoadFailed.set(false);
  };

  protected readonly imageLoadFailed = signal(false);

  protected readonly loupeEnabled = signal(false);

  private readonly readStoredLoupeShape = (): 'circular' | 'small-circular' | 'circular-detail' | 'rectangular' | 'ruler' | 'vertical-ruler' => {
    try {
      const stored = this.document.defaultView?.localStorage.getItem('light-matter.loupeShape');
      if (stored === 'circular' || stored === 'small-circular' || stored === 'circular-detail' || stored === 'rectangular' || stored === 'ruler' || stored === 'vertical-ruler') return stored;
      return this.readStoredBoolean('loupeCircular', false) ? 'circular' : 'rectangular';
    } catch {
      return 'rectangular';
    }
  };

  protected readonly loupeShape = signal<'circular' | 'small-circular' | 'circular-detail' | 'rectangular' | 'ruler' | 'vertical-ruler'>(this.readStoredLoupeShape());

  protected readonly locationInfoExpanded = signal(this.readStoredBoolean('locationInfoExpanded', true));

  protected readonly loupeCapturePending = signal(false);

  protected readonly loupeCaptureError = signal<string | null>(null);

  protected readonly loupeSample = signal<{
    width: number; height: number; x: number; y: number; radius: number;
    center: { r: number; g: number; b: number; rHex: string; gHex: string; bHex: string; color: string };
    pixels: Array<{ x: number; y: number; color: string }>;
  } | null>(null);

  protected readonly loupePixelSize = signal(24);

  /** Relative display brightness for the magnified image; 1 means unchanged. */
  protected readonly loupeBrightness = signal(1);

  protected readonly loupeBrightnessIndicatorOpacity = computed(() =>
    Math.min(1, Math.abs(this.loupeBrightness() - 1) / 1.5)
  );

  protected readonly loupeLedAngles = Array.from({ length: 16 }, (_, index) => index * 22.5);

  /** LED centers distributed along the four sides of the rectangular loupe. */
  protected readonly loupeLedRectPositions = Array.from({ length: 20 }, (_, index) => {
    const perEdge = 5;
    const edge = Math.floor(index / perEdge);
    const offset = 18 + (index % perEdge) * 61;
    if (edge === 0) return { x: offset, y: 9 };
    if (edge === 1) return { x: 271, y: offset };
    if (edge === 2) return { x: 262 - (index % perEdge) * 61, y: 271 };
    return { x: 9, y: 262 - (index % perEdge) * 61 };
  });

  protected readonly loupeSourcePoint = signal({ x: 0, y: 0 });

  protected readonly loupeCaptureGeometry = signal<{ width: number; height: number; x: number; y: number; windowWidth: number; windowHeight: number } | null>(null);

  protected readonly loupePosition = signal({ x: 24, y: 80 });

  private readonly lastMousePosition = signal<{ clientX: number; clientY: number; screenX: number; screenY: number } | null>(null);

  private loupeCaptureRequest = 0;

  private loupeSampleRequest = 0;

  private get desktop(): Desktop | undefined {
    return (this.document.defaultView as (Window & { desktop?: Desktop }) | null)?.desktop;
  }

  protected readonly comparisonMode = signal<'hdr' | 'sdr' | 'side-by-side' | 'stacked' | 'dual-side-by-side' | 'dual-stacked'>('hdr');

  protected readonly comparisonSplit = signal(50);

  protected readonly imageBitDepth = signal<string | null>(null);

  protected readonly imageTags = signal<ExifTags | null>(null);

  protected readonly histogramVisible = signal(false);

  protected readonly histogramLoading = signal(false);

  protected readonly histogramData = signal<ImageHistogram | null>(null);

  protected readonly histogramHoverStatus = signal<string | null>(null);

  protected readonly histogramError = signal(false);

  protected readonly histogramErrorMessage = signal('Histogram could not be calculated.');

  private histogramRequestId = 0;

  protected readonly histogramPaths = computed(() => {
    const data = this.histogramData();
    if (data === null) {
      return {
        linear: { white: '', red: '', green: '', blue: '', maximumCount: 1 },
        logarithmic: { white: '', red: '', green: '', blue: '', maximumCount: 1 },
        linearBoundary: 256,
        logarithmicBoundary: 256,
        linearYTicks: [],
        logarithmicYTicks: []
      };
    }

    const makePaths = (curves: typeof data.linear) => {
      const maximumCount = Math.max(1, ...curves.white, ...curves.red, ...curves.green, ...curves.blue);
      const makePath = (bins: number[]) => bins.map((count, index) => {
        const x = (index + 0.5) / bins.length * 256;
        // Logarithmic Y scale reveals low-frequency bins without changing counts.
        const y = 148 - Math.log1p(count) / Math.log1p(maximumCount) * 140;
        return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
      }).join(' ');
      return {
        white: makePath(curves.white),
        red: makePath(curves.red),
        green: makePath(curves.green),
        blue: makePath(curves.blue),
        maximumCount
      };
    };

    const linearBoundary = Math.max(0, Math.min(256, 100 / data.maximumNits * 256));
    const logarithmicBoundary = Math.max(0, Math.min(256,
      Math.log(100 / data.minimumLogNits) /
      Math.log(data.maximumNits / data.minimumLogNits) * 256
    ));

    const linearPaths = makePaths(data.linear);
    const logarithmicPaths = makePaths(data.logarithmic);

    return {
      linear: linearPaths,
      logarithmic: logarithmicPaths,
      linearBoundary,
      logarithmicBoundary,
      linearYTicks: this.makeLogarithmicYTicks(linearPaths.maximumCount),
      logarithmicYTicks: this.makeLogarithmicYTicks(logarithmicPaths.maximumCount)
    };
  });

  private makeLogarithmicYTicks(maximumCount: number): Array<{ value: number; y: number }> {
    const maximumExponent = Math.floor(Math.log10(Math.max(1, maximumCount)));
    const ticks: Array<{ value: number; y: number }> = [];
    for (let exponent = 0; exponent <= maximumExponent; exponent++) {
      const value = Math.pow(10, exponent);
      if (value <= maximumCount) {
        ticks.push({
          value,
          y: 148 - Math.log1p(value) / Math.log1p(Math.max(1, maximumCount)) * 140
        });
      }
    }
    return ticks;
  }

  protected readonly onHistogramMouseMove = (event: MouseEvent) => {
    const data = this.histogramData();
    const svg = event.currentTarget as SVGSVGElement | null;
    const bounds = svg?.getBoundingClientRect();

    if (data === null || bounds === undefined || bounds.width === 0) {
      return;
    }

    const isLogarithmic = svg?.dataset['scale'] === 'logarithmic';
    const position = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const bin = Math.min(127, Math.floor(position * 128));
    const nits = isLogarithmic
      ? data.minimumLogNits * Math.pow(data.maximumNits / data.minimumLogNits, (bin + 0.5) / 128)
      : data.maximumNits * (bin + 0.5) / 128;
    const curves = isLogarithmic ? data.logarithmic : data.linear;
    const formatCount = (value: number) => new Intl.NumberFormat().format(value);
    const formatNits = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
    const scaleName = isLogarithmic ? 'Log' : 'Linear';

    this.histogramHoverStatus.set(
      `${scaleName} ≈ ${formatNits(nits)} cd/m² · White ${formatCount(curves.white[bin] ?? 0)} · R ${formatCount(curves.red[bin] ?? 0)} · G ${formatCount(curves.green[bin] ?? 0)} · B ${formatCount(curves.blue[bin] ?? 0)}`
    );
  };

  protected readonly onHistogramMouseLeave = () => this.histogramHoverStatus.set(null);

  protected readonly imageDynamicRange = imageDynamicRange;

  protected readonly exifVisible = signal(false);

  protected readonly exifState = signal<false | ExifTags>(false);


  protected readonly zoomSlider = new FormControl(100, { nonNullable: true });

  private readonly readStoredLoupeZoom = (): number => {
    try {
      const stored = Number(this.document.defaultView?.localStorage.getItem('light-matter.loupeZoom'));
      return Number.isFinite(stored) && stored >= 0.1 && stored <= 64 ? stored : 16;
    } catch {
      return 16;
    }
  };

  protected readonly loupeSlider = new FormControl(this.readStoredLoupeZoom(), { nonNullable: true });

  protected readonly isFullScreen = toSignal(
    fromEvent(this.document, 'fullscreenchange')
      .pipe(
        takeUntilDestroyed(),
        map(() => this.document.fullscreenElement !== null),
        startWith(this.document.fullscreenElement !== null)
      )
  );

  protected readonly zoomConfig = this.configuration.constants().imageZoom;

  /* Constructor */
  constructor() {
    this.processManager.getAppVersion()
      .then(version => {
        this.appTitleSuffix = version;
        this.selectedImage$.pipe(take(1)).subscribe(image => {
          this.processManager.setWindowTitle(this.makeWindowTitle(image?.path)).catch(() => undefined);
        });
      })
      .catch(() => undefined);

    this.configuration.config()
      .pipe(take(1), takeUntilDestroyed())
      .subscribe(config => {
        this.histogramVisible.set(config.system.histogramVisible === true);
        this.comparisonMode.set(config.system.comparisonMode ?? 'hdr');
        this.comparisonSplit.set(config.system.comparisonSplit ?? 50);
        this.exifVisible.set(config.system.exifVisible === true);
        if (this.exifVisible()) {
          this.exifState.set(this.imageTags() ?? false);
        }
        if (this.histogramVisible()) {
          this.selectedImage$
            .pipe(take(1), filter(image => image !== null))
            .subscribe(image => this.loadHistogram(image.path));
        }
      });

    this.selectedImage$
      .pipe(takeUntilDestroyed())
      .subscribe(image => {
        this.debugSelectedImagePath = image?.path ?? 'none';
        this.traceDebugSwitching(`selected ${image?.path?.split(/[\\/]/).pop() ?? 'none'}`);
        this.processManager.setWindowTitle(this.makeWindowTitle(image?.path)).catch(() => undefined);
        if (this.debugImageSwitching()) {
          this.debugSwitchingPhase.set(`navigation: selected=${image?.path ?? 'none'} · animation=disabled`);
        }
      });

    this.destroyRef.onDestroy(() => {
      this.loupeCaptureRequest++;
      this.loupeSampleRequest++;
      this.desktop?.Loupe.release().catch(() => undefined);
    });

    this.trackKeyboard();

    this.selectedImage$
      .pipe(
        filter(image => image !== null),
        map(image => image.path),
        distinctUntilChanged(),
        tap(() => {
          // Keep the previous image's metadata until the new image's EXIF read
          // completes. Clearing it here can temporarily classify a gain-map JPEG
          // as SDR, switching the renderer's comparison mode during navigation
          // while the previous image is still on screen.
          this.pixelColor.set(null);
        }),
        tap(path => {
          if (this.histogramVisible()) {
            this.loadHistogram(path);
          }
        }),
        switchMap(path => from(this.exif.read(path)).pipe(
          map(response => response.success ? response.data : null),
          catchError(() => of(null))
        )),
        takeUntilDestroyed()
      )
      .subscribe(tags => {
        this.imageTags.set(tags);
        this.imageBitDepth.set(tags === null ? null : this.getBitDepth(tags));
        if (this.exifVisible()) {
          this.exifState.set(tags ?? false);
        }
      });

    this.loupePixelSize.set(this.loupeSlider.value);
    this.loupeSlider
      .valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe(value => {
        this.loupePixelSize.set(value);
        try {
          this.document.defaultView?.localStorage.setItem('light-matter.loupeZoom', String(value));
        } catch {
          // The zoom remains usable for the current session if storage is unavailable.
        }
      });

    this.zoomSlider
      .valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe(value => this.imagePositioningService.setZoom(value / 100));
  }

  /* Event handlers */
  protected readonly toggleFullScreen = async () => {
    if (this.document.fullscreenElement === null && this.loupeEnabled()) {
      await this.toggleLoupe(false);
    }
    if (this.document.fullscreenElement !== null) {
      await this.document.exitFullscreen();
    } else {
      await this.document.documentElement.requestFullscreen();
    }
  };

  protected readonly setComparisonMode = (mode: 'hdr' | 'sdr' | 'side-by-side' | 'stacked' | 'dual-side-by-side' | 'dual-stacked') => {
    this.comparisonMode.set(mode);
    this.configuration.updateSystemConfig({ comparisonMode: mode });
  };

  protected readonly cycleComparisonMode = () => {
    this.selectedImage$
      .pipe(take(1), filter(image => image !== null))
      .subscribe(image => {
        if (imageDynamicRange(image.path, this.imageTags(), this.imageBitDepth()) !== 'HDR') {
          this.setComparisonMode('sdr');
          return;
        }

        const modes = ['hdr', 'sdr', 'side-by-side', 'stacked', 'dual-side-by-side', 'dual-stacked'] as const;
        const currentIndex = modes.indexOf(this.comparisonMode());
        this.setComparisonMode(modes[(currentIndex + 1) % modes.length]);
      });
  };

  protected readonly previewComparisonSplit = (value: string | number) => {
    this.comparisonSplit.set(Math.max(1, Math.min(99, Number(value) || 50)));
  };

  protected readonly setComparisonSplit = (value: string | number) => {
    const split = Math.max(1, Math.min(99, Number(value) || 50));
    this.comparisonSplit.set(split);
    this.configuration.updateSystemConfig({ comparisonSplit: split });
  };

  protected readonly toggleHistogram = () => {
    if (this.histogramVisible()) {
      this.histogramVisible.set(false);
      this.configuration.updateSystemConfig({ histogramVisible: false });
      this.histogramRequestId++;
      this.histogramLoading.set(false);
      return;
    }

    this.histogramVisible.set(true);
    this.configuration.updateSystemConfig({ histogramVisible: true });
    this.selectedImage$
      .pipe(take(1), filter(image => image !== null))
      .subscribe(image => this.loadHistogram(image.path));
  };

  protected readonly closeHistogram = () => {
    this.histogramVisible.set(false);
    this.configuration.updateSystemConfig({ histogramVisible: false });
    this.histogramRequestId++;
    this.histogramLoading.set(false);
  };

  protected readonly goBack = () => {
    this.processManager.setWindowTitle(this.makeWindowTitle()).catch(() => undefined);
    if (this.viewNavigator.standalone()) {
      this.processManager.quit(0).then();
    } else {
      this.overlayService.hide();
    }
  };

  protected readonly fitToWindow = () => {
    if (!this.loupeEnabled()) {
      this.loupeBrightness.set(1);
      this.imagePositioningService.setZoom('fit');
    }
  };

  protected readonly toggleLoupeShape = () => {
    const shapes = ['circular', 'small-circular', 'circular-detail', 'rectangular', 'ruler', 'vertical-ruler'] as const;

    if (!this.loupeEnabled()) {
      this.loupeShape.set('circular');
      this.storeLoupeShape('circular');
      void this.toggleLoupe(true);
      return;
    }

    const currentIndex = shapes.indexOf(this.loupeShape());
    if (currentIndex === shapes.length - 1) {
      void this.toggleLoupe(false);
      return;
    }

    this.loupeShape.set(shapes[currentIndex + 1]);
    this.storeLoupeShape(shapes[currentIndex + 1]);
  };

  private readonly storeLoupeShape = (value: 'circular' | 'small-circular' | 'circular-detail' | 'rectangular' | 'ruler' | 'vertical-ruler') => {
    try {
      this.document.defaultView?.localStorage.setItem('light-matter.loupeShape', value);
      this.storeBoolean('loupeCircular', value === 'circular' || value === 'small-circular' || value === 'circular-detail');
    } catch {
      // The shape remains usable for the current session if storage is unavailable.
    }
  };

  protected readonly toggleLocationInfo = () => {
    const value = !this.locationInfoExpanded();
    this.locationInfoExpanded.set(value);
    this.storeBoolean('locationInfoExpanded', value);
  };

  protected readonly toggleLoupe = async (enabled: boolean) => {
    this.loupeEnabled.set(enabled);
    this.loupeSample.set(null);
    this.loupeCaptureError.set(null);
    this.loupeSampleRequest++;
    if (!enabled) {
      this.loupeCaptureRequest++;
      this.loupeCapturePending.set(false);
      this.loupeCaptureGeometry.set(null);
      await this.desktop?.Loupe.release().catch(() => undefined);
      return;
    }

    const lastMouse = this.lastMousePosition();
    const view = this.document.defaultView;
    if (lastMouse && view) {
      this.updateLoupeSourcePoint(lastMouse.clientX, lastMouse.clientY);
      const viewWidth = view.innerWidth;
      const viewHeight = view.innerHeight;
      const shape = this.loupeShape();
      const loupeWidth = shape === 'ruler' ? 590 : 310;
      const loupeHeight = (this.locationInfoExpanded() ? 430 : 310) + (shape === 'ruler' ? -180 : shape === 'vertical-ruler' ? 280 : 0);
      const left = lastMouse.clientX > viewWidth - loupeWidth - 24 ? lastMouse.clientX - loupeWidth - 20 : lastMouse.clientX + 20;
      const top = lastMouse.clientY > viewHeight - loupeHeight - 24 ? lastMouse.clientY - loupeHeight - 20 : lastMouse.clientY + 20;
      this.loupePosition.set({ x: Math.max(8, Math.min(viewWidth - loupeWidth - 8, left)), y: Math.max(8, Math.min(viewHeight - loupeHeight - 8, top)) });
    }

    if (!this.isDecoding()) await this.captureLoupeAfterRender();
  };

  private readonly updateLoupeSourcePoint = (clientX: number, clientY: number) => {
    const images = Array.from(this.document.querySelectorAll<HTMLImageElement>('.comparison-image:not(.hidden-variant)'));
    const image = images.find(candidate => {
      const bounds = candidate.getBoundingClientRect();
      return clientX >= bounds.left && clientX < bounds.right &&
        clientY >= bounds.top && clientY < bounds.bottom &&
        candidate.naturalWidth > 0 && candidate.naturalHeight > 0;
    });
    if (!image) return;

    const bounds = image.getBoundingClientRect();
    const scale = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
    const renderedWidth = image.naturalWidth * scale;
    const renderedHeight = image.naturalHeight * scale;
    const imageLeft = bounds.left + (bounds.width - renderedWidth) / 2;
    const imageTop = bounds.top + (bounds.height - renderedHeight) / 2;
    const sourceX = Math.max(0, Math.min(image.naturalWidth - 1, Math.floor((clientX - imageLeft) / scale)));
    const sourceY = Math.max(0, Math.min(image.naturalHeight - 1, Math.floor((clientY - imageTop) / scale)));
    this.loupeSourcePoint.set({ x: sourceX, y: sourceY });
  };

  private readonly sampleLoupeAtPosition = (position: { screenX: number; screenY: number }) => {
    const geometry = this.loupeCaptureGeometry();
    const view = this.document.defaultView;
    if (!geometry || !view || !this.desktop || !this.loupeEnabled()) return;
    const request = ++this.loupeSampleRequest;
    const x = (position.screenX - geometry.x) * geometry.width / geometry.windowWidth;
    const y = (position.screenY - geometry.y) * geometry.height / geometry.windowHeight;
    this.desktop.Loupe.sample(x, y, 5)
      .then(sample => {
        if (request === this.loupeSampleRequest && this.loupeEnabled()) {
          this.loupeSample.set(sample);
          this.loupeCaptureError.set(null);
        }
      })
      .catch(error => {
        if (request === this.loupeSampleRequest && this.loupeEnabled()) {
          this.loupeCaptureError.set(error instanceof Error ? error.message : String(error));
        }
      });
  };

  protected readonly onLoupeMouseMove = (event: MouseEvent) => {
    const position = { clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY };
    this.lastMousePosition.set(position);
    if (!this.loupeEnabled() || this.loupeCapturePending()) return;
    const view = this.document.defaultView;
    const viewWidth = view?.innerWidth ?? 1280;
    const viewHeight = view?.innerHeight ?? 720;
    const shape = this.loupeShape();
    const loupeWidth = shape === 'ruler' ? 590 : 310;
    const loupeHeight = (this.locationInfoExpanded() ? 430 : 310) + (shape === 'ruler' ? -180 : shape === 'vertical-ruler' ? 280 : 0);
    const left = event.clientX > viewWidth - loupeWidth - 24 ? event.clientX - loupeWidth - 20 : event.clientX + 20;
    const top = event.clientY > viewHeight - loupeHeight - 24 ? event.clientY - loupeHeight - 20 : event.clientY + 20;
    this.loupePosition.set({ x: Math.max(8, Math.min(viewWidth - loupeWidth - 8, left)), y: Math.max(8, Math.min(viewHeight - loupeHeight - 8, top)) });

    this.updateLoupeSourcePoint(event.clientX, event.clientY);
    this.sampleLoupeAtPosition(position);
  };

  protected readonly onLoupeMouseLeave = () => {
    this.loupeSampleRequest++;
    this.loupeSample.set(null);
  };

  protected readonly onImageRendered = () => {
    if (this.loupeEnabled() && !this.isDecoding()) void this.captureLoupeAfterRender();
  };

  private readonly captureLoupeAfterRender = async () => {
    const desktop = this.desktop;
    if (!this.loupeEnabled() || !desktop) return;
    const request = ++this.loupeCaptureRequest;
    this.loupeSample.set(null);
    this.loupeCaptureError.set(null);
    this.loupeCapturePending.set(true);
    // Let Angular update the image and hide the loupe overlay before capturing the window.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (!this.loupeEnabled() || request !== this.loupeCaptureRequest) {
      this.loupeCapturePending.set(false);
      return;
    }
    try {
      const geometry = await desktop.Loupe.capture();
      this.loupeCaptureGeometry.set(geometry);
      const lastMouse = this.lastMousePosition();
      if (lastMouse) this.sampleLoupeAtPosition(lastMouse);
    } catch (error) {
      console.error('HDR loupe capture failed:', error);
      this.loupeCaptureGeometry.set(null);
      this.loupeCaptureError.set(error instanceof Error ? error.message : String(error));
      // Keep the visual magnifier enabled; only HDR pixel sampling is unavailable.
    } finally {
      if (request === this.loupeCaptureRequest) this.loupeCapturePending.set(false);
    }
  };

  protected readonly adjustLoupeBrightness = (direction: 1 | -1) => {
    const next = Math.max(0.1, Math.min(3, Number((this.loupeBrightness() + direction * 0.1).toFixed(2))));
    this.loupeBrightness.set(next);
  };

  protected readonly adjustZoom = (direction: 1 | -1) => {
    if (this.loupeEnabled()) {
      this.loupeSlider.setValue(Math.max(0.1, Math.min(64, Number((this.loupeSlider.value * (direction > 0 ? 1.25 : 0.8)).toFixed(2)))));
      return;
    }

    this.imageLocation$
      .pipe(take(1))
      .subscribe(location => {
        const currentZoom = location.zoom === 'fit' ? location.fitZoom : this.zoomSlider.value;
        const zoomStep = Math.min(
          Math.max(
            this.zoomConfig.scroll.minStep,
            Math.round(currentZoom * this.zoomConfig.scroll.coefficient)
          ),
          this.zoomConfig.scroll.maxStep
        );
        const nextZoom = this.calculateWheelZoom(direction > 0 ? -1 : 1, currentZoom, zoomStep);
        this.zoomSlider.setValue(Math.max(this.zoomConfig.min, Math.min(this.zoomConfig.max, nextZoom)));
      });
  };

  protected readonly toggleExifInfo = (path: string) => {
    const exifVisible = !this.exifVisible();
    this.exifVisible.set(exifVisible);
    this.configuration.updateSystemConfig({ exifVisible });
    this.exifState.set(exifVisible ? this.imageTags() ?? false : false);
  };

  private readonly selectedImagePathForDebug = (): string => {
    // selectedImage$ is a stream; use the latest path cached by its subscription below.
    return this.debugSelectedImagePath;
  };

  private debugSelectedImagePath = 'unknown';

  protected readonly prevPhoto = () => this.viewNavigator.previous();

  protected readonly nextPhoto = () => this.viewNavigator.next();

  protected readonly deletePhoto = () => {
    this.selectedImage$
      .pipe(take(1), filter(image => image !== null))
      .subscribe(image =>
        ConfirmationDialogComponent
          .open(this.dialog, {
            title: 'Delete image?',
            description: `Do you want to permanently delete "${image.path}" from disk?`
          })
          .subscribe(async () => {
            const deleted = await this.viewNavigator.deleteImage(image.path);

            if (!deleted) {
              this.document.defaultView?.alert('The image could not be deleted.');
            }
          })
      );
  };


  protected readonly onMouseWheel = (event: WheelEvent) => {
    event.preventDefault();

    if (this.loupeEnabled()) {
      if (event.deltaY !== 0) this.loupeSlider.setValue(Math.max(0.1, Math.min(64, Number((this.loupeSlider.value * (event.deltaY < 0 ? 1.25 : 0.8)).toFixed(2)))));
      return;
    }

    this.imageLocation$
      .pipe(take(1))
      .subscribe(location => {
        const currentZoom = location.zoom === 'fit' ? location.fitZoom : this.zoomSlider.value;

        const zoomStep = Math.min(
          Math.max(
            this.zoomConfig.scroll.minStep,
            Math.round(currentZoom * this.zoomConfig.scroll.coefficient)
          ),
          this.zoomConfig.scroll.maxStep
        );

        this.zoomSlider.setValue(this.calculateWheelZoom(event.deltaY, currentZoom, zoomStep));
      });
  };

  /* Misc */
  private readonly makeWindowTitle = (imagePath?: string): string => {
    const version = this.appTitleSuffix ? ` ${this.appTitleSuffix}` : '';
    const path = imagePath ? ` - ${imagePath}` : '';
    return `Light Matter${version}${path}`;
  };

  private readonly calculateWheelZoom = (deltaY: number, currentZoom: number, zoomStep: number): number => {
    if (deltaY < 0) {
      return Math.min(currentZoom + zoomStep, this.zoomConfig.max);
    }

    if (deltaY > 0) {
      return Math.max(currentZoom - zoomStep, this.zoomConfig.min);
    }

    return currentZoom;
  };

  protected readonly requiresConversion = (path: string): boolean =>
    ['jxr', 'avif', 'heif', 'heic', 'exr', 'hdr', 'tif', 'tiff'].includes(path.split('.').pop()?.toLowerCase() ?? '');

  protected readonly loadConversionDuration = async (path: string) => {
    const requestId = ++this.conversionRequestId;
    this.conversionDuration.set(null);
    if (!this.requiresConversion(path)) return;

    try {
      const response = await fetch('atom://app/conversion-time?image=' + encodeURIComponent(path));
      if (!response.ok || requestId !== this.conversionRequestId) return;
      const result = await response.json() as { durationMs: number | null; fromCache: boolean | null };
      if (requestId === this.conversionRequestId) this.fullSizeFromCache.set(result.fromCache);
      if (requestId === this.conversionRequestId && result.durationMs !== null && Number.isFinite(result.durationMs)) {
        this.conversionDuration.set(result.durationMs / 1000);
      }
    } catch {
      // Conversion timing is diagnostic only; an unavailable endpoint must not affect image viewing.
    }
  };

  protected readonly decoderForPath = (path: string): string => {
    const extension = path.split('.').pop()?.toLowerCase() ?? '';
    if (extension === 'jxr') return 'jpegxr + wasm-vips';
    if (extension === 'avif') return 'wasm-vips / libvips';
    if (extension === 'heif' || extension === 'heic') return 'libheif-js + wasm-vips';
    if (extension === 'exr') return 'exrs';
    if (extension === 'hdr' || extension === 'tif' || extension === 'tiff') return 'wasm-vips / libvips';
    return 'Chromium / Electron';
  };

  private readonly getBitDepth = (tags: ExifTags): string | null => {
    const bits = tags.BitsPerSample ?? tags.BitDepth;
    if (bits !== undefined) {
      return `${bits}-bit`;
    }

    if (tags.ImagePixelDepth !== undefined) {
      return tags.ImagePixelDepth;
    }

    // ExifTool does not consistently populate BitsPerSample/ImagePixelDepth
    // for OpenEXR. Inspect its channel/type metadata before falling back to
    // the format's supported sample types.
    const metadata = tags as Record<string, unknown>;
    const channelInfo = [
      metadata['Channels'],
      metadata['ChannelList'],
      metadata['PixelType'],
      metadata['DataType'],
      metadata['SampleFormat']
    ].filter(value => value !== undefined && value !== null).map(value =>
      Array.isArray(value) ? value.join(' ') : String(value)
    ).join(' ').toLowerCase();

    if (/\bhalf\b/.test(channelInfo)) {
      return '16-bit float (half)';
    }
    if (/\bfloat\b/.test(channelInfo)) {
      return '32-bit float';
    }
    if (/\buint\b|unsigned integer/.test(channelInfo)) {
      return '32-bit unsigned integer';
    }

    if (String(tags.FileType ?? '').toLowerCase() === 'exr' ||
        String(metadata['FileTypeExtension'] ?? '').toLowerCase() === 'exr') {
      return 'Variable: 16-bit half / 32-bit float per channel';
    }

    return null;
  };

  private readonly loadHistogram = (path: string) => {
    const requestId = ++this.histogramRequestId;
    this.histogramData.set(null);
    this.histogramError.set(false);
    this.histogramErrorMessage.set('Histogram could not be calculated.');
    this.histogramLoading.set(true);

    this.histogram.calculate(path)
      .then(result => {
        if (requestId !== this.histogramRequestId) {
          return;
        }

        if (result.success) {
          this.histogramData.set(result.data);
        } else {
          this.histogramErrorMessage.set(result.errorMessage);
          this.histogramError.set(true);
        }
      })
      .catch(error => {
        if (requestId === this.histogramRequestId) {
          this.histogramErrorMessage.set(error instanceof Error ? error.message : String(error));
          this.histogramError.set(true);
        }
      })
      .finally(() => {
        if (requestId === this.histogramRequestId) {
          this.histogramLoading.set(false);
        }
      });
  };

  private readonly trackKeyboard = () =>
    this.keyboard.keyup()
      .pipe(takeUntilDestroyed())
      .subscribe(event => {
        if ((event.shiftKey && event.key !== '+' && event.key !== '_') || event.ctrlKey || event.altKey || event.metaKey) {
          return;
        }

        if (event.key === 'Escape') {
          this.goBack();
          return;
        }

        const target = event.target;
        if (target instanceof HTMLElement && target.matches('input:not([type="checkbox"]), textarea, [contenteditable="true"]')) {
          return;
        }

        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          this.adjustLoupeBrightness(event.key === 'ArrowUp' ? 1 : -1);
          return;
        }

        if (event.key === '+' || event.key === '=' || event.key === 'Add') {
          event.preventDefault();
          this.adjustZoom(1);
          return;
        }

        if (event.key === '-' || event.key === '_' || event.key === 'Subtract') {
          event.preventDefault();
          this.adjustZoom(-1);
          return;
        }

        if (event.key === 'r' || event.key === 'R') {
          this.cycleComparisonMode();
          return;
        }

        if (target instanceof HTMLSelectElement) {
          return;
        }

        if (event.key === 'm' || event.key === 'M') {
          event.preventDefault();
          void this.toggleLoupe(!this.loupeEnabled());
          return;
        }

        if (event.key.toLowerCase() === 's') {
          event.preventDefault();
          this.toggleLoupeShape();
          return;
        }

        if (this.loupeEnabled() && event.key.toLowerCase() === 'l') {
          event.preventDefault();
          this.toggleLocationInfo();
          return;
        }

        switch (event.key.toLowerCase()) {
          case 'i':
          case 'I':
            this.selectedImage$
              .pipe(take(1), filter(image => image !== null))
              .subscribe(image => this.toggleExifInfo(image.path));
            break;

          case 'h':
            this.toggleHistogram();
            break;

          case 'arrowleft':
            event.preventDefault();
            this.traceDebugSwitching('key ArrowLeft');
            this.hasPrevious$
              .pipe(
                take(1),
                filter(flag => flag)
              )
              .subscribe(() => this.prevPhoto());
            break;

          case 'arrowright':
          case ' ':
          case 'spacebar':
            event.preventDefault();
            this.traceDebugSwitching(`key ${event.key}`);
            this.hasNext$
              .pipe(
                take(1),
                filter(flag => flag)
              )
              .subscribe(() => this.nextPhoto());
            break;

          case 'delete':
            event.preventDefault();
            this.deletePhoto();
            break;

          case 'f':
          case 'F':
          case 'F11':
            this.toggleFullScreen().then();
            break;
        }
      });
}
