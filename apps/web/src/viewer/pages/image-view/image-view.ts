import { Dialog } from '@angular/cdk/dialog';
import { AsyncPipe, DecimalPipe, DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, ElementRef, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { ConfirmationDialogComponent, OverlayService, SliderComponent } from '@light-matter/ui';
import { CapturePreview, Desktop, ExifTags, ImageHistogram } from 'internal-api';
import { catchError, distinctUntilChanged, filter, from, fromEvent, map, of, startWith, switchMap, take, tap } from 'rxjs';
import { ExifService } from '../../../ipc/exif';
import { HistogramService } from '../../../ipc/histogram';
import { ProcessManager } from '../../../ipc/process-manager';
import { CacheManager } from '../../../ipc/cache-manager';
import { SettingsPanelComponent } from '../../../settings/components/settings-dialog/settings-dialog.component';
import { Configuration } from '../../../system/services/configuration/configuration';
import { ThemeService } from '../../../system/services/theme/theme.service';
import { Keyboard } from '../../../system/services/keyboard/keyboard';
import { CapturePanelComponent } from '../../../capture/components/capture-panel/capture-panel.component';
import { CapturePreviewStore } from '../../../capture/capture-preview-store';
import { ExifInfoComponent } from '../../components/exif-info/exif-info.component';
import { ImageRendererComponent } from '../../components/image-renderer/image-renderer.component';
import { HdrImageBrightnessRenderer, HdrLoupeRenderer, HdrLoupeRegion } from './hdr-loupe-renderer';
import { imageDynamicRange } from '../../utils/image-dynamic-range';
import { ImagePositioningService } from '../../services/image-positioning/image-positioning.service';
import {
  defaultImagePositioningResult,
  ImageDimensions,
  ImagePositioningResult
} from '../../services/image-positioning/image-positioning.types';
import { ViewNavigator } from '../../services/view-navigator/view-navigator';

const HDR_WEBGPU_BRIGHTNESS_CORRECTION = 0.4;

interface LeafletMap {
  setView(center: [number, number], zoom: number, options?: { animate?: boolean }): LeafletMap;
  fitBounds(bounds: [[number, number], [number, number]], options?: { padding?: [number, number]; maxZoom?: number; animate?: boolean }): LeafletMap;
  getZoom(): number;
  setZoom(zoom: number, options?: { animate?: boolean }): LeafletMap;
  panBy(offset: [number, number], options?: { animate?: boolean }): LeafletMap;
  invalidateSize(options?: { animate?: boolean; pan?: boolean }): LeafletMap;
  on(event: 'zoomend', callback: () => void): LeafletMap;
  remove(): void;
}

interface LeafletPolyline {
  addTo(map: LeafletMap): LeafletPolyline;
  remove(): LeafletPolyline;
  setStyle(style: { opacity?: number }): LeafletPolyline;
}

interface LeafletMarker {
  setLatLng(position: [number, number]): LeafletMarker;
  addTo(map: LeafletMap): LeafletMarker;
}

interface LeafletTileLayer {
  addTo(map: LeafletMap): LeafletTileLayer;
  remove(): LeafletTileLayer;
}

interface LeafletApi {
  map(element: HTMLElement, options?: { zoomControl?: boolean; keyboard?: boolean; minZoom?: number; maxZoom?: number }): LeafletMap;
  tileLayer(url: string, options: { attribution: string; maxZoom: number; maxNativeZoom?: number }): LeafletTileLayer;
  marker(position: [number, number]): LeafletMarker;
  polyline(positions: [number, number][], options?: { color?: string; weight?: number; opacity?: number; lineCap?: string; lineJoin?: string }): LeafletPolyline;
}

let leafletLoadPromise: Promise<LeafletApi> | null = null;

const loadLeaflet = (document: Document): Promise<LeafletApi> => {
  const view = document.defaultView as (Window & { L?: LeafletApi }) | null;
  if (view?.L) return Promise.resolve(view.L);
  if (leafletLoadPromise) return leafletLoadPromise;

  leafletLoadPromise = new Promise<LeafletApi>((resolve, reject) => {
    const cssId = 'light-matter-leaflet-css';
    if (!document.getElementById(cssId)) {
      const link = document.createElement('link');
      link.id = cssId;
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
    }

    const scriptId = 'light-matter-leaflet-script';
    const existing = document.getElementById(scriptId) as HTMLScriptElement | null;
    const script = existing ?? document.createElement('script');
    const finish = (): void => {
      const leaflet = (document.defaultView as (Window & { L?: LeafletApi }) | null)?.L;
      if (leaflet) resolve(leaflet);
      else reject(new Error('Leaflet loaded but its API was not available.'));
    };
    script.addEventListener('load', finish, { once: true });
    script.addEventListener('error', () => {
      script.remove();
      reject(new Error('Could not load the Leaflet map library.'));
    }, { once: true });
    if (!existing) {
      script.id = scriptId;
      script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      script.async = true;
      document.head.appendChild(script);
    }
  }).catch(error => {
    leafletLoadPromise = null;
    throw error;
  });

  return leafletLoadPromise;
};

@Component({
  selector: 'app-image-view',
  imports: [
    AsyncPipe,
    ImageRendererComponent,
    SettingsPanelComponent,
    CapturePanelComponent,
    ReactiveFormsModule,
    SliderComponent,
    DecimalPipe,
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
  protected readonly capturePreviewStore = inject(CapturePreviewStore);
  protected readonly histogramCaptureCanvas = viewChild<ElementRef<HTMLCanvasElement>>('histogramCaptureCanvas');
  protected readonly loupeCapturePreviewCanvas = viewChild<ElementRef<HTMLCanvasElement>>('loupeCapturePreviewCanvas');
  protected readonly loupeShowsCapturePreview = signal(false);
  protected readonly loupeCaptureZoomCanvas = viewChild<ElementRef<HTMLCanvasElement>>('loupeCaptureZoomCanvas');
  private readonly capturePreviewLoupeRenderer = new HdrLoupeRenderer();
  private readonly capturePreviewSwatchRenderer = new HdrLoupeRenderer();
  private capturePreviewSwatchRenderRequest = 0;
  private capturePreviewLoupeRenderRequest = 0;
  private readonly capturePreviewLoupeEffect = effect(() => {
    const enabled = this.loupeShowsCapturePreview();
    const frame = this.capturePreviewStore.frame();
    const mouse = this.lastMousePosition();
    const sourcePoint = this.loupeSourcePoint();
    // Read the viewChild signal as a dependency: the conditional canvas may not
    // exist during the first effect run. When Angular creates it, this effect
    // must run again instead of leaving the initial WebGPU canvas gray.
    const canvas = this.loupeCaptureZoomCanvas();
    // Re-render when the cursor, source frame, canvas, or magnification changes,
    // including slider changes while the cursor is stationary.
    this.loupePixelSize();
    this.loupeSizeScale();
    if (!enabled || !frame || !canvas || !this.loupeEnabled()) return;
    void this.renderCapturePreviewSwatch(frame, sourcePoint);
    const request = ++this.capturePreviewLoupeRenderRequest;
    requestAnimationFrame(() => {
      if (request === this.capturePreviewLoupeRenderRequest) void this.renderCapturePreviewLoupe(frame, request);
    });
  });

  private readonly processManager = inject(ProcessManager);

  private readonly cacheManager = inject(CacheManager);

  private appTitleSuffix = '';

  private readonly imagePositioningService = inject(ImagePositioningService);

  private readonly overlayService = inject(OverlayService);

  private readonly dialog = inject(Dialog);

  private escapePressedWhileDialogOpen = false;

  private readonly configuration = inject(Configuration);

  protected readonly themeService = inject(ThemeService);

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
    if (loading) {
      this.hdrImageAdjustmentRequest++;
      this.hdrImageAdjustmentPending.set(false);
      this.hdrImageAdjustmentRegion = null;
      this.hdrImageAdjustmentReady.set(false);
      this.hdrImageAdjustmentRenderer.dispose();
    }
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

  /** True only while the FP16 capture is successfully rendered through WebGPU. */
  protected readonly hdrLoupeActive = signal(false);

  private readonly hdrLoupeRenderer = new HdrLoupeRenderer();
  private readonly hdrSwatchRenderer = new HdrLoupeRenderer();
  private hdrSwatchRenderRequest = 0;
  private readonly hdrImageAdjustmentRenderer = new HdrImageBrightnessRenderer();
  protected readonly hdrImageAdjustmentPending = signal(false);
  protected readonly hdrImageAdjustmentReady = signal(false);
  protected readonly hdrImageAdjustmentBounds = signal({ left: 0, top: 0, width: 0, height: 0 });
  private hdrImageAdjustmentRegion: HdrLoupeRegion | null = null;
  private hdrImageAdjustmentSdrPixels: Uint8Array | null = null;
  private hdrImageAdjustmentSourceKey = '';
  private hdrImageAdjustmentRequest = 0;
  private hdrImageAdjustmentCapturePromise: Promise<void> | null = null;
  private hdrImageAdjustmentRecaptureQueued = false;

  private readonly readStoredLoupeShape = (): 'circular' | 'rectangular' | 'ruler' | 'vertical-ruler' => {
    try {
      const stored = this.document.defaultView?.localStorage.getItem('light-matter.loupeShape');
      // Removed legacy small-circle and double-circle modes; normalize saved settings.
      if (stored === 'circular' || stored === 'rectangular' || stored === 'ruler' || stored === 'vertical-ruler') return stored;
      return this.readStoredBoolean('loupeCircular', false) ? 'circular' : 'rectangular';
    } catch {
      return 'rectangular';
    }
  };

  protected readonly loupeShape = signal<'circular' | 'rectangular' | 'ruler' | 'vertical-ruler'>(this.readStoredLoupeShape());

  protected readonly loupeCapturePending = signal(false);

  protected readonly loupeCaptureError = signal<string | null>(null);

  protected readonly loupeSample = signal<{
    width: number; height: number; x: number; y: number; radius: number;
    regionWidth: number; regionHeight: number; centerX: number; centerY: number; data: Uint16Array;
    center: { r: number; g: number; b: number; rHex: string; gHex: string; bHex: string; color: string };
    pixels: Array<{ x: number; y: number; color: string }>;
  } | null>(null);

  /** Decode the current center pixel directly from the captured FP16 buffer.
   * This keeps the numeric readout and bars tied to the live capture data,
   * rather than potentially stale convenience fields on the returned sample.
   */
  private readonly renderCapturePreviewSwatch = async (frame: CapturePreview, sourcePoint: { x: number; y: number }): Promise<void> => {
    const request = ++this.capturePreviewSwatchRenderRequest;
    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (request !== this.capturePreviewSwatchRenderRequest || !this.loupeShowsCapturePreview() || !this.loupeEnabled()) return;
      const canvas = this.document.querySelector<HTMLCanvasElement>('.loupe-capture-rgb-swatch-canvas');
      if (!canvas || frame.width <= 0 || frame.height <= 0 || frame.pixels.length < frame.width * frame.height * 4) return;
      const imageSize = this.imageDimensions();
      if (imageSize.width <= 0 || imageSize.height <= 0) return;
      const x = Math.max(0, Math.min(frame.width - 1, Math.floor(sourcePoint.x * frame.width / imageSize.width)));
      const y = Math.max(0, Math.min(frame.height - 1, Math.floor(sourcePoint.y * frame.height / imageSize.height)));
      const offset = (y * frame.width + x) * 4;
      await this.capturePreviewSwatchRenderer.render(canvas, {
        width: 1, height: 1, centerX: 0, centerY: 0,
        data: frame.pixels.slice(offset, offset + 4)
      }, HDR_WEBGPU_BRIGHTNESS_CORRECTION, 1);
    } catch (error) {
      console.warn('Capture preview HDR pixel swatch WebGPU render failed:', error);
    }
  };

  private readonly renderCapturePreviewLoupe = async (frame: CapturePreview, request: number): Promise<void> => {
    const canvas = this.loupeCaptureZoomCanvas()?.nativeElement;
    if (!canvas || request !== this.capturePreviewLoupeRenderRequest || !this.loupeShowsCapturePreview() || !this.loupeEnabled()) return;
    if (frame.width <= 0 || frame.height <= 0 || frame.pixels.length < frame.width * frame.height * 4) return;
    // The preview is compared against the image shown in the viewer, not against
    // the physical desktop coordinates. Map the image-relative loupe source point
    // into the preview frame; equal-sized images therefore use identical x/y pixels.
    const sourcePoint = this.loupeSourcePoint();
    const imageSize = this.imageDimensions();
    if (imageSize.width <= 0 || imageSize.height <= 0) return;
    const centerX = Math.max(0, Math.min(frame.width - 1,
      Math.floor(sourcePoint.x * frame.width / imageSize.width)));
    const centerY = Math.max(0, Math.min(frame.height - 1,
      Math.floor(sourcePoint.y * frame.height / imageSize.height)));

    const outputWidth = Math.max(1, canvas.parentElement?.clientWidth ?? canvas.clientWidth ?? 280);
    const outputHeight = Math.max(1, canvas.parentElement?.clientHeight ?? canvas.clientHeight ?? 180);
    const zoom = this.loupePixelSize() * (this.loupeCaptureGeometry()?.scaleFactor ?? 1) / this.loupeSizeScale();
    const halfWidth = Math.ceil(outputWidth / Math.max(zoom, 0.01) / 2) + 2;
    const halfHeight = Math.ceil(outputHeight / Math.max(zoom, 0.01) / 2) + 2;
    const left = Math.max(0, centerX - halfWidth);
    const top = Math.max(0, centerY - halfHeight);
    const right = Math.min(frame.width, centerX + halfWidth + 1);
    const bottom = Math.min(frame.height, centerY + halfHeight + 1);
    const width = right - left;
    const height = bottom - top;
    if (width <= 0 || height <= 0) return;
    const data = new Uint16Array(width * height * 4);
    for (let row = 0; row < height; row++) {
      const sourceStart = ((top + row) * frame.width + left) * 4;
      data.set(frame.pixels.subarray(sourceStart, sourceStart + width * 4), row * width * 4);
    }
    try {
      await this.capturePreviewLoupeRenderer.render(canvas, {
        width, height, centerX: centerX - left, centerY: centerY - top, data
      }, HDR_WEBGPU_BRIGHTNESS_CORRECTION, zoom);
    } catch (error) {
      console.warn('Capture preview WebGPU magnifier render failed:', error);
    }
  };

  protected readonly loupeCaptureRgb = computed(() => {
    const frame = this.loupeShowsCapturePreview() ? this.capturePreviewStore.frame() : null;
    const sourcePoint = this.loupeSourcePoint();
    const imageSize = this.imageDimensions();
    if (!frame || !imageSize.width || !imageSize.height || frame.pixels.length < frame.width * frame.height * 4) return null;
    // Use the same image-relative mapping as the magnified capture preview.
    // When image and capture frame have equal dimensions, x/y are identical.
    const x = Math.max(0, Math.min(frame.width - 1, Math.floor(sourcePoint.x * frame.width / imageSize.width)));
    const y = Math.max(0, Math.min(frame.height - 1, Math.floor(sourcePoint.y * frame.height / imageSize.height)));
    const offset = (y * frame.width + x) * 4; const bits = [frame.pixels[offset], frame.pixels[offset + 1], frame.pixels[offset + 2]];
    const toFloat = (v: number): number => { const sign = (v & 0x8000) ? -1 : 1; const exponent = (v >>> 10) & 0x1f; const fraction = v & 0x03ff; if (exponent === 0) return sign * Math.pow(2, -14) * fraction / 1024; if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : NaN; return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024); };
    return { x, y, r: toFloat(bits[0]), g: toFloat(bits[1]), b: toFloat(bits[2]), rHex: bits[0].toString(16).padStart(4, '0').toUpperCase(), gHex: bits[1].toString(16).padStart(4, '0').toUpperCase(), bHex: bits[2].toString(16).padStart(4, '0').toUpperCase() };
  });

  /** Compare the main screen sample with the capture preview after the existing 0.5 display-value adjustment. */
  protected readonly loupeRgbDifference = computed(() => {
    const main = this.loupeHdrRgb();
    const capture = this.loupeCaptureRgb();
    if (!main || !capture) return null;
    const compare = (mainValue: number, captureValue: number) => {
      const adjustedCapture = captureValue * 0.5;
      const delta = mainValue - adjustedCapture;
      const denominator = Math.max(Math.abs(mainValue), Math.abs(adjustedCapture));
      return {
        delta,
        percent: denominator < 0.0001 ? null : Math.abs(delta) / denominator * 100
      };
    };
    return {
      r: compare(main.r, capture.r),
      g: compare(main.g, capture.g),
      b: compare(main.b, capture.b)
    };
  });

  protected readonly loupeHdrRgb = computed(() => {
    const sample = this.loupeSample();
    if (!sample || sample.data.length < 4) return null;
    const x = Math.max(0, Math.min(sample.regionWidth - 1, Math.round(sample.centerX)));
    const y = Math.max(0, Math.min(sample.regionHeight - 1, Math.round(sample.centerY)));
    const offset = (y * sample.regionWidth + x) * 4;
    if (offset + 2 >= sample.data.length) return null;

    const toFloat = (bits: number): number => {
      const sign = (bits & 0x8000) ? -1 : 1;
      const exponent = (bits >>> 10) & 0x1f;
      const fraction = bits & 0x03ff;
      if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
      if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : NaN;
      return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
    };
    const rBits = sample.data[offset];
    const gBits = sample.data[offset + 1];
    const bBits = sample.data[offset + 2];
    return {
      r: toFloat(rBits), g: toFloat(gBits), b: toFloat(bBits),
      rHex: rBits.toString(16).padStart(4, '0').toUpperCase(),
      gHex: gBits.toString(16).padStart(4, '0').toUpperCase(),
      bHex: bBits.toString(16).padStart(4, '0').toUpperCase()
    };
  });

  protected readonly loupePixelSize = signal(24);

  /** Overall visual size of the loupe, independent of pixel magnification. */
  protected readonly loupeSizeScale = signal(1);

  /** Independent brightness controls; keyboard input changes only the active view. */
  protected readonly loupeBrightness = signal(1);

  protected readonly mainImageBrightness = signal(1);
  protected readonly imageContrast = signal(1);
  protected readonly imageGamma = signal(1);
  protected readonly redChannelLevel = signal(1);
  protected readonly greenChannelLevel = signal(1);
  protected readonly blueChannelLevel = signal(1);
  protected readonly invertRedChannel = signal(false);
  protected readonly invertGreenChannel = signal(false);
  protected readonly invertBlueChannel = signal(false);
  protected readonly invertAllRgbChannels = signal(false);
  protected readonly colorIntensity = signal(1);
  protected readonly blackPoint = signal(0);
  protected readonly whitePoint = signal(1);
  protected readonly controlsSidebarVisible = signal(this.readControlsSidebarVisible());
  private readControlsSidebarVisible(): boolean {
    try { return this.document.defaultView?.localStorage.getItem('light-matter.imageSidebarVisible') !== 'false'; }
    catch { return true; }
  }
  private readonly readStoredSidebarWidth = (): number => {
    try {
      const stored = Number(this.document.defaultView?.localStorage.getItem('light-matter.imageSidebarWidth'));
      return Number.isFinite(stored) && stored >= 280 ? Math.min(900, stored) : 340;
    } catch {
      return 340;
    }
  };
  protected readonly sidebarWidth = signal(this.readStoredSidebarWidth());
  private sidebarResizeCleanup: (() => void) | null = null;
  protected readonly startSidebarResize = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    this.sidebarResizeCleanup?.();
    const view = this.document.defaultView;
    if (!view) return;
    const startX = event.clientX;
    const startWidth = this.sidebarWidth();
    const onMove = (moveEvent: PointerEvent): void => {
      this.sidebarWidth.set(Math.max(280, Math.min(view.innerWidth * 0.7, startWidth + startX - moveEvent.clientX)));
    };
    const onUp = (): void => {
      view.removeEventListener('pointermove', onMove);
      view.removeEventListener('pointerup', onUp);
      view.removeEventListener('pointercancel', onUp);
      try { view.localStorage.setItem('light-matter.imageSidebarWidth', String(Math.round(this.sidebarWidth()))); } catch { /* Keep the current width for this session. */ }
      this.sidebarResizeCleanup = null;
    };
    view.addEventListener('pointermove', onMove);
    view.addEventListener('pointerup', onUp);
    view.addEventListener('pointercancel', onUp);
    this.sidebarResizeCleanup = onUp;
  };
  protected readonly imageSidebarTabs = [{"id":"general","label":"General"},{"id":"capture","label":"Capture"},{"id":"cache","label":"Cache"},{"id":"view","label":"View"},{"id":"image","label":"Image"},{"id":"location","label":"Location"},{"id":"histogram","label":"Histogram"},{"id":"highlight","label":"Highlight"},{"id":"zoom","label":"Zoom"},{"id":"corrections","label":"Corrections"}];
  private readActiveImageSidebarTab(): string {
    try { const saved = this.document.defaultView?.localStorage.getItem('light-matter.activeImageSidebarTab'); return this.imageSidebarTabs.some(tab => tab.id === saved) ? saved! : 'general'; }
    catch { return 'general'; }
  }
  protected readonly activeImageSidebarTab = signal(this.readActiveImageSidebarTab());
  protected readonly currentImageCacheStatus = signal('Cache status not loaded.');
  protected readonly refreshCurrentImageCache = (): void => {
    this.selectedImage$.pipe(take(1)).subscribe(image => {
      if (!image) { this.currentImageCacheStatus.set('No image selected.'); return; }
      this.currentImageCacheStatus.set('Checking cache…');
      void this.cacheManager.imageCachePath(image.path).then(path => {
        this.currentImageCacheStatus.set(path ? `Full-size cache exists: ${path}` : 'No valid full-size cache entry for this image.');
      }).catch(error => this.currentImageCacheStatus.set(`Could not read cache status: ${error instanceof Error ? error.message : String(error)}`));
    });
  };
  protected readonly setActiveImageSidebarTab = (tab: string): void => {
    if (!this.imageSidebarTabs.some(item => item.id === tab)) return;
    this.activeImageSidebarTab.set(tab);
    if (tab === 'cache') this.refreshCurrentImageCache();
    if (tab === 'histogram' && !this.histogramVisible()) this.toggleHistogram();
    try { this.document.defaultView?.localStorage.setItem('light-matter.activeImageSidebarTab', tab); } catch { /* Ignore unavailable storage. */ }
  };

  protected readonly sidebarSections = signal<Record<string, boolean>>({ zoom: true, brightness: true, basic: true, rgb: true, rgbLevels: false, inverse: false, loupe: true, loupeRenderer: false, highlight: true, toneCurve: false, mode: true, histogram: false, info: true, general: true, actions: false, copy: false });
  protected readonly sidebarSectionExpanded = (key: string): boolean => ['corrections', 'highlight', 'mode', 'info', 'general'].includes(key) || this.sidebarSections()[key] === true;
  protected readonly toggleSidebarSection = (key: string): void => {
    const sections = { ...this.sidebarSections(), [key]: !this.sidebarSectionExpanded(key) };
    this.sidebarSections.set(sections);
    this.configuration.updateSystemConfig({ imageSidebarSections: sections });
    if (key === 'loupe') {
      void this.toggleLoupe(sections['loupe']);
    }
    if (key === 'info') {
      this.exifVisible.set(sections['info']);
      this.configuration.updateSystemConfig({ exifVisible: sections['info'] });
      this.exifState.set(sections['info'] ? this.imageTags() ?? false : false);
      if (sections['info']) {
        this.selectedImage$
          .pipe(
            take(1),
            filter(image => image !== null),
            switchMap(image => from(this.exif.read(image.path)).pipe(
              map(response => response.success ? response.data : null),
              catchError(() => of(null))
            )),
            takeUntilDestroyed(this.destroyRef)
          )
          .subscribe(tags => {
            this.imageTags.set(tags);
            this.imageBitDepth.set(tags === null ? null : this.getBitDepth(tags));
            this.exifState.set(tags ?? false);
          });
      }
    }
    if (key === 'histogram') {
      if (this.sidebarSections()[key] && !this.histogramVisible()) this.toggleHistogram();
      else if (!this.sidebarSections()[key] && this.histogramVisible()) this.closeHistogram();
    }
  };
  protected readonly collapseAllSidebarSections = (): void => {
    const sections = Object.fromEntries(
      Object.keys(this.sidebarSections()).map(key => [key, false])
    ) as Record<string, boolean>;
    this.sidebarSections.set(sections);
    this.configuration.updateSystemConfig({ imageSidebarSections: sections, exifVisible: false, histogramVisible: false });
    this.exifVisible.set(false);
    this.exifState.set(false);
    if (this.loupeEnabled()) void this.toggleLoupe(false);
    if (this.histogramVisible()) this.closeHistogram();
  };
  protected readonly toggleControlsSidebar = (): void => {
    const next = !this.controlsSidebarVisible();
    this.controlsSidebarVisible.set(next);
    try { this.document.defaultView?.localStorage.setItem('light-matter.imageSidebarVisible', String(next)); } catch { /* Keep session state. */ }
  };
  protected readonly setDebugImageSwitching = (enabled: boolean): void => { try { this.document.defaultView?.localStorage.setItem('light-matter.debugImageSwitching', String(enabled)); } catch { /* storage may be unavailable */ } this.debugImageSwitching.set(enabled); };
  protected readonly hdrImageAdjustmentActive = computed(() =>
    this.mainImageBrightness() !== 1 || this.imageContrast() !== 1 || this.imageGamma() !== 1 ||
    this.redChannelLevel() !== 1 || this.greenChannelLevel() !== 1 || this.blueChannelLevel() !== 1 ||
    this.invertRedChannel() || this.invertGreenChannel() || this.invertBlueChannel() || this.invertAllRgbChannels() ||
    this.colorIntensity() !== 1 || this.blackPoint() !== 0 || this.whitePoint() !== 1 ||
    this.highlightHdrPixels() || this.highlightSdrOverexposure() || this.highlightSdrUnderexposure()
  );
  protected readonly setMainBrightness = (v: string | number): void => {
    this.mainImageBrightness.set(Math.max(0, Math.min(2, Number(v))));
    this.refreshHdrImageAdjustments();
  };
  protected readonly resetMainBrightness = (): void => this.setMainBrightness(1);
  protected readonly setImageContrast = (v: string | number): void => {
    this.imageContrast.set(Math.max(0, Math.min(2, Number(v))));
    this.refreshHdrImageAdjustments();
  };
  protected readonly setImageGamma = (v: string | number): void => {
    this.imageGamma.set(Math.max(0.1, Math.min(3, Number(v))));
    this.refreshHdrImageAdjustments();
  };
  protected readonly resetImageAdjustments = (): void => {
    this.mainImageBrightness.set(1); this.imageContrast.set(1); this.refreshHdrImageAdjustments();
  };
  protected readonly setRedChannelLevel = (v: string | number): void => {
    this.redChannelLevel.set(Math.max(0, Math.min(2, Number(v))));
    this.refreshHdrImageAdjustments();
  };
  protected readonly setGreenChannelLevel = (v: string | number): void => {
    this.greenChannelLevel.set(Math.max(0, Math.min(2, Number(v))));
    this.refreshHdrImageAdjustments();
  };
  protected readonly setBlueChannelLevel = (v: string | number): void => {
    this.blueChannelLevel.set(Math.max(0, Math.min(2, Number(v))));
    this.refreshHdrImageAdjustments();
  };
  protected readonly setInvertRedChannel = (enabled: boolean): void => { this.invertRedChannel.set(enabled); this.refreshHdrImageAdjustments(); };
  protected readonly setInvertGreenChannel = (enabled: boolean): void => { this.invertGreenChannel.set(enabled); this.refreshHdrImageAdjustments(); };
  protected readonly setInvertBlueChannel = (enabled: boolean): void => { this.invertBlueChannel.set(enabled); this.refreshHdrImageAdjustments(); };
  protected readonly setInvertAllRgbChannels = (enabled: boolean): void => { this.invertAllRgbChannels.set(enabled); this.refreshHdrImageAdjustments(); };
  protected readonly resetRgbChannels = (): void => {
    this.redChannelLevel.set(1); this.greenChannelLevel.set(1); this.blueChannelLevel.set(1);
    this.invertRedChannel.set(false); this.invertGreenChannel.set(false); this.invertBlueChannel.set(false); this.invertAllRgbChannels.set(false);
    this.refreshHdrImageAdjustments();
  };
  protected readonly setColorIntensity = (v: string | number): void => {
    this.colorIntensity.set(Math.max(0, Math.min(3, Number(v))));
    this.refreshHdrImageAdjustments();
  };
  protected readonly setBlackPoint = (v: string | number): void => {
    this.blackPoint.set(Math.max(0, Math.min(this.whitePoint() - 0.01, Number(v))));
    this.refreshHdrImageAdjustments();
  };
  protected readonly setWhitePoint = (v: string | number): void => {
    this.whitePoint.set(Math.max(this.blackPoint() + 0.01, Math.min(2, Number(v))));
    this.refreshHdrImageAdjustments();
  };
  protected readonly highlightHdrPixels = signal(false);
  protected readonly hdrHighlightThreshold = signal(1);
  protected readonly setHdrPixelHighlight = (enabled: boolean): void => {
    this.highlightHdrPixels.set(enabled);
    this.refreshHdrImageAdjustments();
  };
  protected readonly setHdrHighlightThreshold = (value: string | number): void => {
    this.hdrHighlightThreshold.set(Math.max(1, Math.min(125, Number(value))));
    this.refreshHdrImageAdjustments();
  };
  protected readonly hdrHighlightThresholdNits = (): number => Math.round(this.hdrHighlightThreshold() * 80);
  protected readonly highlightSdrOverexposure = signal(false);
  protected readonly sdrOverexposureThreshold = signal(255);
  protected readonly setSdrOverexposureHighlight = (enabled: boolean): void => {
    this.highlightSdrOverexposure.set(enabled);
    this.refreshHdrImageAdjustments();
  };
  protected readonly setSdrOverexposureThreshold = (value: string | number): void => {
    this.sdrOverexposureThreshold.set(Math.max(0, Math.min(255, Math.round(Number(value)))));
    this.refreshHdrImageAdjustments();
  };
  protected readonly highlightSdrUnderexposure = signal(false);
  protected readonly sdrUnderexposureThreshold = signal(16);
  protected readonly setSdrUnderexposureHighlight = (enabled: boolean): void => {
    this.highlightSdrUnderexposure.set(enabled);
    this.refreshHdrImageAdjustments();
  };
  protected readonly setSdrUnderexposureThreshold = (value: string | number): void => {
    this.sdrUnderexposureThreshold.set(Math.max(0, Math.min(64, Math.round(Number(value)))));
    this.refreshHdrImageAdjustments();
  };
  protected readonly resetCorrections = (): void => {
    this.mainImageBrightness.set(1);
    this.imageContrast.set(1);
    this.imageGamma.set(1);
    this.redChannelLevel.set(1);
    this.greenChannelLevel.set(1);
    this.blueChannelLevel.set(1);
    this.invertRedChannel.set(false);
    this.invertGreenChannel.set(false);
    this.invertBlueChannel.set(false);
    this.invertAllRgbChannels.set(false);
    this.colorIntensity.set(1);
    this.blackPoint.set(0);
    this.whitePoint.set(1);
    this.refreshHdrImageAdjustments();
  };
  protected readonly setLoupeBrightness = (v: string | number): void => {
    this.loupeBrightness.set(Math.max(0, Math.min(4, Number(v))));
    const sample = this.loupeSample();
    if (sample) {
      void this.renderHdrLoupe(sample);
      void this.renderHdrColorSwatch(sample);
    }
  };
  protected readonly setLoupeShape = (shape: 'circular' | 'rectangular' | 'ruler' | 'vertical-ruler'): void => {
    this.loupeShape.set(shape); this.storeLoupeShape(shape); this.hdrLoupeActive.set(false); this.hdrLoupeRenderer.dispose();
    if (!this.loupeEnabled()) void this.toggleLoupe(true);
  };

  /** Explicit renderer selection so CSS and WebGPU can be compared at identical settings. */
  protected readonly loupeRendererMode = signal<'css' | 'webgpu'>('webgpu');

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

  protected readonly loupeCaptureGeometry = signal<{ width: number; height: number; x: number; y: number; contentX: number; contentY: number; windowWidth: number; windowHeight: number; scaleFactor: number } | null>(null);

  protected readonly loupePosition = signal({ x: 24, y: 80 });

  private readonly lastMousePosition = signal<{ clientX: number; clientY: number; screenX: number; screenY: number } | null>(null);

  private loupeCaptureRequest = 0;

  private loupeResizeObserver: ResizeObserver | null = null;

  private loupeResizeTimer: ReturnType<typeof setTimeout> | null = null;

  private loupeSampleRequest = 0;

  private lastLoupeSampleAt = 0;


  /** Cells already logged for the current capture, to compare mapping across the whole window. */

  private get desktop(): Desktop | undefined {
    return (this.document.defaultView as (Window & { desktop?: Desktop }) | null)?.desktop;
  }

  protected readonly comparisonMode = signal<'hdr' | 'sdr' | 'side-by-side' | 'stacked' | 'dual-side-by-side' | 'dual-stacked'>('hdr');

  protected readonly comparisonSplit = signal(50);

  protected readonly imageBitDepth = signal<string | null>(null);

  protected readonly imageTags = signal<ExifTags | null>(null);

  protected readonly copyLocationStatus = signal('');

  protected readonly locationMapElement = viewChild<ElementRef<HTMLDivElement>>('locationMapElement');
  private isPointerOverLocationMap = false;
  protected readonly onLocationMapPointerEnter = (): void => { this.isPointerOverLocationMap = true; };
  protected readonly onLocationMapPointerLeave = (): void => { this.isPointerOverLocationMap = false; };
  protected readonly locationMapError = signal<string | null>(null);
  protected readonly locationMapStyle = signal(this.readStoredLocationMapStyle());
  // The external-map selector is an action menu and always returns to its dummy option.
  protected readonly locationWebApp = signal('');

  protected readonly openLocationWebApp = (webApp: string): void => {
    if (!webApp) return;
    // Reset immediately so the same destination can be selected again.
    this.locationWebApp.set('');
    const coordinates = this.gpsCoordinates();
    const latitude = coordinates?.latitude;
    const longitude = coordinates?.longitude;
    if (latitude === undefined || longitude === undefined) return;

    const lat = latitude.toFixed(6);
    const lon = longitude.toFixed(6);
    const encodedCoordinates = encodeURIComponent(`${lat},${lon}`);
    const urls: Record<string, string> = {
      'google-earth': `https://earth.google.com/web/search/${lat},${lon}`,
      'google-maps': `https://www.google.com/maps/search/?api=1&query=${encodedCoordinates}`,
      openstreetmap: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`,
      'bing-maps': `https://www.bing.com/maps?cp=${lat}~${lon}&lvl=16`,
      'here-wego': `https://wego.here.com/?map=${lat},${lon},16,normal`,
      'google-street-view': `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${encodedCoordinates}`,
      mapillary: `https://www.mapillary.com/app/?lat=${lat}&lng=${lon}&z=17`
    };
    const url = urls[webApp];
    if (!url) return;

    this.document.defaultView?.open(url, '_blank', 'noopener,noreferrer');
  };
  protected readonly locationMapColor = signal(this.readStoredLocationMapColor());
  protected readonly locationMapOpacity = signal(this.readStoredLocationMapOpacity());
  protected readonly gpxTrackOpacity = signal(this.readStoredGpxTrackOpacity());
  private readonly locationMapColors = ['original', 'light', 'extra-light', 'ultra-light', 'dark', 'grayscale', 'pastel', 'contrast', 'night'] as const;

  private readStoredGpxTrackOpacity(): number {
    try {
      const storedValue = this.document.defaultView?.localStorage.getItem('light-matter.gpxTrackOpacity');
      if (storedValue === null || storedValue === undefined) return 100;
      const stored = Number(storedValue);
      return Number.isFinite(stored) && stored >= 0 && stored <= 100 ? stored : 100;
    } catch {
      return 100;
    }
  }

  protected readonly changeGpxTrackOpacity = (value: string | number): void => {
    const opacity = Math.max(0, Math.min(100, Math.round(Number(value))));
    if (!Number.isFinite(opacity)) return;
    this.gpxTrackOpacity.set(opacity);
    try {
      this.document.defaultView?.localStorage.setItem('light-matter.gpxTrackOpacity', String(opacity));
    } catch {
      // The selected GPX track opacity remains active for this session.
    }
    for (const layer of this.locationGpxLayers) layer.setStyle({ opacity: 0.92 * opacity / 100 });
  };

  private readStoredLocationMapOpacity(): number {
    try {
      const storedValue = this.document.defaultView?.localStorage.getItem('light-matter.locationMapOpacity');
      if (storedValue === null || storedValue === undefined) return 100;
      const stored = Number(storedValue);
      return Number.isFinite(stored) && stored >= 0 && stored <= 100 ? stored : 100;
    } catch {
      return 100;
    }
  }

  protected readonly changeLocationMapOpacity = (value: string | number): void => {
    const opacity = Math.max(0, Math.min(100, Math.round(Number(value))));
    if (!Number.isFinite(opacity)) return;
    this.locationMapOpacity.set(opacity);
    try {
      this.document.defaultView?.localStorage.setItem('light-matter.locationMapOpacity', String(opacity));
    } catch {
      // The selected map opacity remains active for this session.
    }
    this.applyLocationMapOpacity();
  };

  private readStoredLocationMapColor(): typeof this.locationMapColors[number] {
    try {
      const stored = this.document.defaultView?.localStorage.getItem('light-matter.locationMapColor');
      if (this.locationMapColors.includes(stored as typeof this.locationMapColors[number])) return stored as typeof this.locationMapColors[number];
    } catch {
      // Use original tile colors when browser storage is unavailable.
    }
    return 'original';
  }

  protected readonly changeLocationMapColor = (color: string): void => {
    if (!this.locationMapColors.includes(color as typeof this.locationMapColors[number])) return;
    this.locationMapColor.set(color as typeof this.locationMapColors[number]);
    try {
      this.document.defaultView?.localStorage.setItem('light-matter.locationMapColor', color);
    } catch {
      // The selected color preset remains active for the current session.
    }
    this.applyLocationMapColor();
  };
  private locationMapInstance: LeafletMap | null = null;
  private locationMapTileLayer: LeafletTileLayer | null = null;
  private locationMapMarker: LeafletMarker | null = null;
  private locationMapContainer: HTMLDivElement | null = null;
  private locationGpxLayers: LeafletPolyline[] = [];
  private readonly gpxTrackSegments = signal<[number, number][][]>([]);
  protected readonly gpxTrackFileName = signal<string | null>(null);
  protected readonly gpxTrackVisible = signal(this.readStoredBoolean('gpxTrackVisible', true));
  protected readonly gpxTrackStatus = signal<string | null>(null);
  protected readonly gpxTrackColors = [
    { name: 'Red', value: '#ff3b30' },
    { name: 'Orange', value: '#ff9500' },
    { name: 'Yellow', value: '#ffd60a' },
    { name: 'Green', value: '#34c759' },
    { name: 'Blue', value: '#0a84ff' },
    { name: 'Magenta', value: '#bf5af2' }
  ] as const;
  protected readonly gpxTrackColor = signal(this.readStoredGpxTrackColor());
  protected readonly gpxTrackSelection = computed(() => this.gpxTrackVisible() ? this.gpxTrackColor() : 'off');
  private readonly gpxTrackRestore = this.restoreStoredGpxTrack();
  private readonly readStoredLocationMapZoom = (): number => {
    try {
      const stored = Number(this.document.defaultView?.localStorage.getItem('light-matter.locationMapZoom'));
      return Number.isFinite(stored) && stored >= 1 && stored <= 20 ? stored : 13;
    } catch {
      return 13;
    }
  };
  private locationMapZoom = this.readStoredLocationMapZoom();
  protected readonly locationMapZoomLevel = signal(this.locationMapZoom);
  private locationMapRequest = 0;

  private readonly storeLocationMapZoom = (zoom: number): void => {
    this.locationMapZoom = Math.max(1, Math.min(20, zoom));
    this.locationMapZoomLevel.set(this.locationMapZoom);
    try {
      this.document.defaultView?.localStorage.setItem('light-matter.locationMapZoom', String(this.locationMapZoom));
    } catch {
      // The current map zoom remains active for this session.
    }
  };

  protected readonly changeLocationMapZoom = (value: string | number): void => {
    const zoom = Math.max(1, Math.min(20, Math.round(Number(value))));
    if (!Number.isFinite(zoom)) return;
    this.storeLocationMapZoom(zoom);
    this.locationMapInstance?.setZoom(zoom, { animate: false });
  };

  protected readonly adjustLocationMapZoom = (direction: -1 | 1): void => {
    if (!this.locationMapInstance) return;
    this.changeLocationMapZoom(this.locationMapInstance.getZoom() + direction);
  };

  protected readonly importGpxTrack = (): void => {
    const input = this.document.createElement('input');
    input.type = 'file';
    input.accept = '.gpx,application/gpx+xml,application/xml,text/xml';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      void file.text().then(content => {
        this.setGpxTrackData(content, file.name, true);
        const path = this.desktop?.getPathForFile(file);
        if (path) {
          try {
            this.document.defaultView?.localStorage.setItem('light-matter.gpxTrackPath', path);
            this.document.defaultView?.localStorage.setItem('light-matter.gpxTrackFileName', file.name);
          } catch {
            // The imported track remains available for the current session.
          }
        }
      }).catch(error => {
        this.gpxTrackStatus.set(error instanceof Error ? error.message : 'Could not read the GPX file.');
      });
    }, { once: true });
    input.click();
  };

  private async restoreStoredGpxTrack(): Promise<void> {
    let path: string | null = null;
    let fileName: string | null = null;
    try {
      path = this.document.defaultView?.localStorage.getItem('light-matter.gpxTrackPath') ?? null;
      fileName = this.document.defaultView?.localStorage.getItem('light-matter.gpxTrackFileName') ?? null;
    } catch {
      return;
    }
    if (!path || !fileName || !this.desktop) return;

    const result = await this.desktop.FileSystem.readText(path);
    if (!result.success) {
      this.clearStoredGpxTrack();
      return;
    }

    try {
      this.setGpxTrackData(result.data, fileName, false);
    } catch {
      this.clearStoredGpxTrack();
    }
  }

  private clearStoredGpxTrack(): void {
    try {
      this.document.defaultView?.localStorage.removeItem('light-matter.gpxTrackPath');
      this.document.defaultView?.localStorage.removeItem('light-matter.gpxTrackFileName');
    } catch {
      // A missing stored GPX path is ignored when browser storage is unavailable.
    }
  }

  private setGpxTrackData(content: string, fileName: string, fitTrack: boolean): void {
    const xml = new DOMParser().parseFromString(content, 'application/xml');
    if (xml.getElementsByTagName('parsererror').length > 0) {
      throw new Error('The selected file is not valid GPX/XML.');
    }

    const elements = Array.from(xml.getElementsByTagName('*'));
    const trackSegments = elements
      .filter(element => element.localName === 'trkseg')
      .map(segment => Array.from(segment.getElementsByTagName('*'))
        .filter(point => point.localName === 'trkpt')
        .map(point => this.parseGpxPoint(point))
        .filter((point): point is [number, number] => point !== null))
      .filter(segment => segment.length > 0);

    if (trackSegments.length === 0) {
      const trackPoints = elements
        .filter(element => element.localName === 'trkpt')
        .map(point => this.parseGpxPoint(point))
        .filter((point): point is [number, number] => point !== null);
      if (trackPoints.length > 0) trackSegments.push(trackPoints);
    }
    if (trackSegments.length === 0) {
      const routePoints = elements
        .filter(element => element.localName === 'rtept')
        .map(point => this.parseGpxPoint(point))
        .filter((point): point is [number, number] => point !== null);
      if (routePoints.length > 0) trackSegments.push(routePoints);
    }
    if (trackSegments.length === 0) {
      throw new Error('No valid track or route points were found in the GPX file.');
    }

    this.gpxTrackSegments.set(trackSegments);
    this.gpxTrackFileName.set(fileName);
    if (fitTrack) this.setGpxTrackVisible(true);
    this.gpxTrackStatus.set(null);
    this.applyGpxTrack(fitTrack);
  }

  private parseGpxPoint(point: Element): [number, number] | null {
    const latitude = Number(point.getAttribute('lat'));
    const longitude = Number(point.getAttribute('lon'));
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    return [latitude, longitude];
  }

  private readStoredGpxTrackColor(): string {
    try {
      const stored = this.document.defaultView?.localStorage.getItem('light-matter.gpxTrackColor');
      if (this.gpxTrackColors.some(color => color.value === stored)) return stored as string;
    } catch {
      // Use the default GPX track color when browser storage is unavailable.
    }
    return '#ff3b30';
  }

  protected readonly setGpxTrackColor = (selection: string): void => {
    if (selection === 'off') {
      this.setGpxTrackVisible(false);
      return;
    }
    if (!this.gpxTrackColors.some(option => option.value === selection)) return;
    this.gpxTrackColor.set(selection);
    try {
      this.document.defaultView?.localStorage.setItem('light-matter.gpxTrackColor', selection);
    } catch {
      // The selected GPX track color remains active for the current session.
    }
    this.setGpxTrackVisible(true);
  };

  protected readonly setGpxTrackVisible = (visible: boolean): void => {
    this.gpxTrackVisible.set(visible);
    try {
      this.document.defaultView?.localStorage.setItem('light-matter.gpxTrackVisible', String(visible));
    } catch {
      // The selected overlay state remains active for the current session.
    }
    this.applyGpxTrack();
  };

  private readonly applyGpxTrack = (fitTrack = false): void => {
    for (const layer of this.locationGpxLayers) layer.remove();
    this.locationGpxLayers = [];
    const map = this.locationMapInstance;
    const segments = this.gpxTrackSegments();
    if (!map || !this.gpxTrackVisible() || segments.length === 0) return;

    const leaflet = (this.document.defaultView as (Window & { L?: LeafletApi }) | null)?.L;
    if (!leaflet) return;
    for (const segment of segments) {
      if (segment.length < 2) continue;
      this.locationGpxLayers.push(leaflet.polyline(segment, {
        color: this.gpxTrackColor(),
        weight: 4,
        opacity: 0.92 * this.gpxTrackOpacity() / 100,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(map));
    }

    if (fitTrack && this.locationGpxLayers.length > 0) {
      const points = segments.flat();
      const latitudes = points.map(point => point[0]);
      const longitudes = points.map(point => point[1]);
      const bounds: [[number, number], [number, number]] = [
        [Math.min(...latitudes), Math.min(...longitudes)],
        [Math.max(...latitudes), Math.max(...longitudes)]
      ];
      const requestMap = map;
      this.document.defaultView?.requestAnimationFrame(() => {
        this.document.defaultView?.requestAnimationFrame(() => {
          if (this.locationMapInstance !== requestMap || !this.gpxTrackVisible()) return;
          requestMap.invalidateSize({ animate: false, pan: false });
          requestMap.fitBounds(bounds, { padding: [24, 24], maxZoom: 16, animate: false });
        });
      });
    }
  };

  private readonly applyLocationMapOpacity = (): void => {
    const tilePane = this.locationMapContainer?.querySelector<HTMLElement>('.leaflet-tile-pane');
    if (!tilePane) return;
    tilePane.style.opacity = String(this.locationMapOpacity() / 100);
  };

  private readonly applyLocationMapColor = (): void => {
    const tilePane = this.locationMapContainer?.querySelector<HTMLElement>('.leaflet-tile-pane');
    if (!tilePane) return;
    const filters: Record<(typeof this.locationMapColors)[number], string> = {
      original: 'none',
      light: 'brightness(1.12) saturate(.82)',
      'extra-light': 'brightness(1.3) saturate(.72) contrast(.94)',
      'ultra-light': 'brightness(1.48) saturate(.64) contrast(.9)',
      dark: 'brightness(.68) contrast(1.16) saturate(.82)',
      grayscale: 'grayscale(1)',
      pastel: 'saturate(.62) brightness(1.12) contrast(.88)',
      contrast: 'saturate(1.35) contrast(1.22)',
      night: 'brightness(.48) contrast(1.35) saturate(.72) hue-rotate(12deg)'
    };
    tilePane.style.filter = filters[this.locationMapColor()];
    this.applyLocationMapOpacity();
  };

  private readonly locationMapStyles = {
    standard: {
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
      maxNativeZoom: 19,
      maxDisplayZoom: 20
    },
    satellite: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> — Sources: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      maxZoom: 19,
      maxNativeZoom: 19,
      maxDisplayZoom: 20
    },
    cycling: {
      url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &middot; <a href="https://www.cyclosm.org/">CyclOSM</a>',
      maxZoom: 20,
      maxNativeZoom: 20,
      maxDisplayZoom: 20
    },
    topographic: {
      url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      attribution: 'Kartendaten: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende, SRTM &middot; Kartendarstellung: &copy; <a href="https://opentopomap.org/">OpenTopoMap</a> (CC-BY-SA)',
      maxZoom: 17,
      maxNativeZoom: 17,
      maxDisplayZoom: 20
    },
    humanitarian: {
      url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &middot; <a href="https://www.hotosm.org/">Humanitarian OpenStreetMap Team</a>',
      maxZoom: 19,
      maxNativeZoom: 19,
      maxDisplayZoom: 20
    }
  } as const;

  private readStoredLocationMapStyle(): 'standard' | 'satellite' | 'cycling' | 'topographic' | 'humanitarian' {
    try {
      const stored = this.document.defaultView?.localStorage.getItem('light-matter.locationMapStyle');
      if (stored === 'standard' || stored === 'satellite' || stored === 'cycling' || stored === 'topographic' || stored === 'humanitarian') return stored;
    } catch {
      // Use the standard map when browser storage is unavailable.
    }
    return 'standard';
  }

  protected readonly changeLocationMapStyle = (style: string): void => {
    if (style !== 'standard' && style !== 'satellite' && style !== 'cycling' && style !== 'topographic' && style !== 'humanitarian') return;
    this.locationMapStyle.set(style);
    try {
      this.document.defaultView?.localStorage.setItem('light-matter.locationMapStyle', style);
    } catch {
      // The selected style remains active for the current session.
    }
    this.applyLocationMapStyle();
  };

  private readonly applyLocationMapStyle = (): void => {
    if (!this.locationMapInstance) return;
    const leaflet = (this.document.defaultView as (Window & { L?: LeafletApi }) | null)?.L;
    if (!leaflet) return;
    this.locationMapTileLayer?.remove();
    const style = this.locationMapStyles[this.locationMapStyle()];
    this.locationMapTileLayer = leaflet.tileLayer(style.url, {
      attribution: style.attribution,
      maxZoom: style.maxDisplayZoom ?? style.maxZoom,
      ...(style.maxNativeZoom ? { maxNativeZoom: style.maxNativeZoom } : {})
    }).addTo(this.locationMapInstance);
    this.applyLocationMapColor();
  };

  private readonly disposeLocationMap = (): void => {
    if (this.locationMapInstance) {
      this.storeLocationMapZoom(this.locationMapInstance.getZoom());
      this.locationMapInstance.remove();
    }
    this.locationMapInstance = null;
    this.locationMapTileLayer = null;
    this.locationMapMarker = null;
    this.locationMapContainer = null;
    this.locationGpxLayers = [];
  };

  private readonly syncLocationMap = async (
    container: HTMLDivElement,
    coordinates: { latitude: number; longitude: number },
    request: number
  ): Promise<void> => {
    try {
      const leaflet = await loadLeaflet(this.document);
      if (request !== this.locationMapRequest || this.activeImageSidebarTab() !== 'location' || !container.isConnected) return;

      const position: [number, number] = [coordinates.latitude, coordinates.longitude];
      if (!this.locationMapInstance || this.locationMapContainer !== container) {
        this.disposeLocationMap();
        this.locationMapContainer = container;
        this.locationMapInstance = leaflet.map(container, { zoomControl: false, keyboard: false, minZoom: 1, maxZoom: 20 })
          .setView(position, this.locationMapZoom, { animate: false });
        const mapStyle = this.locationMapStyles[this.locationMapStyle()];
        this.locationMapTileLayer = leaflet.tileLayer(mapStyle.url, {
          attribution: mapStyle.attribution,
          maxZoom: mapStyle.maxDisplayZoom ?? mapStyle.maxZoom,
          ...(mapStyle.maxNativeZoom ? { maxNativeZoom: mapStyle.maxNativeZoom } : {})
        }).addTo(this.locationMapInstance);
        this.applyLocationMapColor();
        this.locationMapMarker = leaflet.marker(position).addTo(this.locationMapInstance);
        this.applyGpxTrack();
        this.locationMapInstance.on('zoomend', () => {
          if (this.locationMapInstance) this.storeLocationMapZoom(this.locationMapInstance.getZoom());
        });
      }

      this.locationMapError.set(null);

      // Image navigation can change the sidebar/map layout after this effect runs.
      // Wait for the layout to settle, update Leaflet's dimensions first, and only
      // then recenter. Calling setView before invalidateSize can briefly offset the map.
      this.document.defaultView?.requestAnimationFrame(() => {
        this.document.defaultView?.requestAnimationFrame(() => {
          if (request !== this.locationMapRequest || this.locationMapContainer !== container) return;
          const map = this.locationMapInstance;
          if (!map) return;
          map.invalidateSize({ animate: false, pan: false });
          this.locationMapMarker?.setLatLng(position);
          map.setView(position, map.getZoom(), { animate: false });
          // Keep the imported GPX overlay visible without changing the user's map zoom.
          this.applyGpxTrack(false);
        });
      });
    } catch (error) {
      if (request === this.locationMapRequest) {
        this.locationMapError.set(error instanceof Error ? error.message : String(error));
      }
    }
  };

  protected readonly centerLocationMarker = (): void => {
    const coordinates = this.gpsCoordinates();
    const map = this.locationMapInstance;
    if (!coordinates || !map) return;
    map.setView([coordinates.latitude, coordinates.longitude], map.getZoom(), { animate: true });
  };

  protected readonly formatGpsCoordinate = (value: number, positiveDirection: string, negativeDirection: string): string =>
    `${Math.abs(value).toFixed(6)}° ${value >= 0 ? positiveDirection : negativeDirection}`;

  protected readonly gpsCoordinates = computed(() => {
    const tags = this.imageTags() as (Record<string, unknown> | null);
    if (!tags) return null;

    const parseCoordinate = (value: unknown, reference: unknown): number | null => {
      if (typeof value !== 'number' && typeof value !== 'string') return null;
      const parts = String(value).match(/-?\d+(?:\.\d+)?/g);
      if (!parts?.length) return null;
      const degrees = Math.abs(Number(parts[0]));
      const minutes = Number(parts[1] ?? 0);
      const seconds = Number(parts[2] ?? 0);
      if (![degrees, minutes, seconds].every(Number.isFinite) || minutes >= 60 || seconds >= 60) return null;
      let result = degrees + minutes / 60 + seconds / 3600;
      const ref = String(reference ?? '').toLowerCase();
      if (String(parts[0]).startsWith('-') || ['s', 'south', 'w', 'west'].includes(ref)) result *= -1;
      return Number.isFinite(result) ? result : null;
    };

    const latitude = parseCoordinate(tags['GPSLatitude'], tags['GPSLatitudeRef']);
    const longitude = parseCoordinate(tags['GPSLongitude'], tags['GPSLongitudeRef']);
    if (latitude === null || longitude === null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    return { latitude, longitude };
  });

  protected readonly copyLocation = async (): Promise<void> => {
    const coordinates = this.gpsCoordinates();
    if (!coordinates) return;
    const value = `${coordinates.latitude.toFixed(6)}, ${coordinates.longitude.toFixed(6)}`;
    try {
      await this.document.defaultView?.navigator.clipboard.writeText(value);
      this.copyLocationStatus.set('Copied');
      this.document.defaultView?.setTimeout(() => this.copyLocationStatus.set(''), 1800);
    } catch (error) {
      console.error('Failed to copy GPS coordinates', error);
      this.copyLocationStatus.set('Copy failed');
      this.document.defaultView?.setTimeout(() => this.copyLocationStatus.set(''), 2500);
    }
  };

  protected readonly displayImagePath = (path: string): string => {
    if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.startsWith('//')) {
      return path.replace(/\//g, '\\').replace(/\\{3,}/g, '\\\\');
    }
    return path.replace(/\\/g, '/');
  };

  protected readonly histogramVisible = signal(false);

  protected readonly histogramLoading = signal(false);

  protected readonly histogramData = signal<ImageHistogram | null>(null);

  protected readonly histogramUsesCapturePreview = signal(false);

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

  /** Logarithmic HDR channel-bar scale: scRGB 1.0 = 80 cd/m², capped at 10000 cd/m². */
  protected readonly hdrRgbBarWidth = (scRgbValue: number): number => {
    const nits = Math.max(0, scRgbValue * 80);
    return Math.min(100, Math.log1p(nits) / Math.log1p(10000) * 100);
  };

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
    effect(() => {
      const tab = this.activeImageSidebarTab();
      const container = this.locationMapElement()?.nativeElement ?? null;
      const coordinates = this.gpsCoordinates();
      const request = ++this.locationMapRequest;
      if (tab !== 'location' || !container || !coordinates) {
        this.disposeLocationMap();
        return;
      }
      void this.syncLocationMap(container, coordinates, request);
    });

    effect(() => {
      const frame = this.loupeShowsCapturePreview() ? this.capturePreviewStore.frame() : null;
      const canvas = this.loupeCapturePreviewCanvas()?.nativeElement;
      if (frame && canvas) void this.renderLoupeCapturePreviewHdr(canvas, frame); else this.disposeLoupeCapturePreview();
    });

    effect(() => {
      const frame = this.histogramUsesCapturePreview() ? this.capturePreviewStore.frame() : null;
      const canvas = this.histogramCaptureCanvas()?.nativeElement;
      if (frame && canvas) void this.renderCapturePreviewHdr(canvas, frame);
      else this.disposeHistogramCapturePreview();
    });

    effect(() => {
      if (!this.histogramUsesCapturePreview()) return;
      const frame = this.capturePreviewStore.frame();
      if (frame) {
        void this.loadCapturePreviewHistogram(frame);
      } else {
        this.histogramRequestId++;
        this.histogramData.set(null);
        this.histogramLoading.set(false);
        this.histogramErrorMessage.set('No capture preview available. Open the Capture tab and select “Preview source” first.');
        this.histogramError.set(true);
      }
    });

    // If the loupe is enabled while the image is still decoding, the initial
    // toggle cannot capture yet. Retry automatically once decoding has ended;
    // without this, the canvas and HDR pixel readouts stay blank until off/on.
    effect(() => {
      const enabled = this.loupeEnabled();
      const decoding = this.isDecoding();
      const geometry = this.loupeCaptureGeometry();
      const pending = this.loupeCapturePending();
      const dimensions = this.imageDimensions();
      const rendererMode = this.loupeRendererMode();
      if (enabled && dimensions.width > 0 && dimensions.height > 0 && rendererMode === 'webgpu' && !decoding && !geometry && !pending) {
        void this.captureLoupeAfterRender();
      }
    });

    // A full-monitor capture must be refreshed when the Chromium content area
    // changes size; otherwise its coordinate mapping describes stale geometry.
    if (typeof ResizeObserver !== 'undefined') {
      this.loupeResizeObserver = new ResizeObserver(() => {
        if (!this.loupeEnabled()) return;
        if (this.loupeResizeTimer !== null) clearTimeout(this.loupeResizeTimer);
        this.loupeResizeTimer = setTimeout(() => {
          this.loupeResizeTimer = null;
          if (this.loupeEnabled() && !this.isDecoding()) {
            void this.captureLoupeAfterRender();
          }
        }, 180);
      });
      this.loupeResizeObserver.observe(this.document.documentElement);
    }

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
        // General settings must never be restored as expanded at startup. Override
        // the saved value in memory and persist the collapsed state as well, so
        // older configuration files cannot keep reopening this section.
        const savedSidebarSections = config.system.imageSidebarSections ?? {};
        const sidebarSections = { ...this.sidebarSections(), ...savedSidebarSections, general: false };
        this.sidebarSections.set(sidebarSections);
        if (savedSidebarSections['general'] === true) {
          this.configuration.updateSystemConfig({ imageSidebarSections: sidebarSections });
        }
        if (this.sidebarSectionExpanded('loupe')) void this.toggleLoupe(true);
        this.histogramVisible.set(config.system.histogramVisible === true);
        const savedMode = config.system.comparisonMode ?? 'hdr';
        this.comparisonMode.set(savedMode);
        this.comparisonSplit.set(config.system.comparisonSplit ?? 50);
        this.exifVisible.set(config.system.exifVisible === true);
        if (config.system.exifVisible === true && config.system.imageSidebarSections?.['info'] === undefined) {
          this.sidebarSections.set({ ...this.sidebarSections(), info: true });
        }
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
        if (image) void this.refreshSourceFileCount(image.path);
        this.traceDebugSwitching(`selected ${image?.path?.split(/[\\/]/).pop() ?? 'none'}`);
        this.processManager.setWindowTitle(this.makeWindowTitle(image?.path)).catch(() => undefined);
        if (this.debugImageSwitching()) {
          this.debugSwitchingPhase.set(`navigation: selected=${image?.path ?? 'none'} · animation=disabled`);
        }
      });

    this.destroyRef.onDestroy(() => {
      this.sidebarResizeCleanup?.();
      this.loupeResizeObserver?.disconnect();
      this.locationMapRequest++;
      this.disposeLocationMap();
      this.loupeResizeObserver = null;
      if (this.loupeResizeTimer !== null) clearTimeout(this.loupeResizeTimer);
      this.loupeResizeTimer = null;
      this.loupeCaptureRequest++;
      this.loupeSampleRequest++;
      this.hdrLoupeRenderer.dispose();
      this.hdrSwatchRenderRequest++;
      this.hdrSwatchRenderer.dispose();
      this.capturePreviewSwatchRenderRequest++;
      this.capturePreviewSwatchRenderer.dispose();
      this.hdrImageAdjustmentRenderer.dispose();
      this.hdrImageAdjustmentRequest++;
      this.desktop?.Loupe.release().catch(() => undefined);
    });

    this.trackKeyboard();

    this.selectedImage$
      .pipe(
        filter(image => image !== null),
        map(image => image.path),
        distinctUntilChanged(),
        tap(() => {
          // Invalidate the loupe's previous-image capture as soon as navigation
          // changes the selected path. The new capture is taken by onImageRendered
          // after the replacement image has actually finished rendering.
          this.loupeCaptureRequest++;
          this.loupeSampleRequest++;
          this.loupeSample.set(null);
          this.loupeCaptureGeometry.set(null);
          this.loupeCapturePending.set(false);
          this.hdrLoupeActive.set(false);
          this.hdrLoupeRenderer.dispose();
          this.hdrSwatchRenderRequest++;
          this.hdrSwatchRenderer.dispose();
          this.hdrImageAdjustmentRequest++;
          this.hdrImageAdjustmentRegion = null;
          this.hdrImageAdjustmentReady.set(false);
          this.hdrImageAdjustmentRenderer.dispose();
          // Keep the previous image's metadata until the new image's EXIF read
          // completes. Clearing it here can temporarily classify a gain-map JPEG
          // as SDR, switching the renderer's comparison mode during navigation
          // while the previous image is still on screen.
          this.pixelColor.set(null);
          this.loupeSdrPixelCanvas = null;
          this.loupeSdrPixelContext = null;
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
        // Refresh the crop immediately when zoom changes, even if the mouse is stationary.
        const mouse = this.lastMousePosition();
        if (this.loupeEnabled() && mouse) {
          this.sampleLoupeAtPosition({ screenX: mouse.screenX, screenY: mouse.screenY }, true);
        }
      });

    this.zoomSlider
      .valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe(value => {
        this.imagePositioningService.setZoom(value / 100);
        if (this.hdrImageAdjustmentActive()) void this.renderHdrImageAdjustments(true);
      });

    this.desktop?.Loupe.onWindowGeometryChanged(() => {
      if (this.loupeEnabled()) void this.captureLoupeAfterRender();
    });

    const view = this.document.defaultView;
    if (view) {
      fromEvent(view, 'resize').pipe(takeUntilDestroyed()).subscribe(() => {
        if (this.hdrImageAdjustmentActive()) void this.renderHdrImageAdjustments(true);
      });
    }
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
    if (this.hdrImageAdjustmentActive()) void this.renderHdrImageAdjustments(true);
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
    if (this.hdrImageAdjustmentActive()) void this.renderHdrImageAdjustments(true);
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

  protected readonly setHistogramCapturePreview = (enabled: boolean): void => {
    this.histogramUsesCapturePreview.set(enabled);
    this.histogramRequestId++;
    this.histogramLoading.set(false);
    this.histogramData.set(null);
    this.histogramError.set(false);
    this.histogramHoverStatus.set(null);

    if (!enabled) {
      this.selectedImage$
        .pipe(take(1), filter(image => image !== null))
        .subscribe(image => this.loadHistogram(image.path));
    }
  };

  private histogramCaptureDevice: { destroy(): void } | null = null;
  private histogramCaptureTexture: { destroy(): void } | null = null;
  private histogramCaptureContext: { unconfigure(): void; configure(options: any): void; getCurrentTexture(): any } | null = null;
  private histogramCaptureRenderRequest = 0;
  private loupeCapturePreviewDevice: { destroy(): void } | null = null;
  private loupeCapturePreviewTexture: { destroy(): void } | null = null;
  private loupeCapturePreviewContext: { unconfigure(): void; configure(options: any): void; getCurrentTexture(): any } | null = null;
  private loupeCapturePreviewRenderRequest = 0;

  private readonly disposeHistogramCapturePreview = (): void => {
    this.histogramCaptureRenderRequest++;
    try { this.histogramCaptureContext?.unconfigure(); } catch { /* already unconfigured */ }
    this.histogramCaptureTexture?.destroy();
    this.histogramCaptureDevice?.destroy();
    this.histogramCaptureTexture = null;
    this.histogramCaptureDevice = null;
    this.histogramCaptureContext = null;
  };

  private readonly renderCapturePreviewHdr = async (canvas: HTMLCanvasElement, frame: CapturePreview): Promise<void> => {
    const requestId = ++this.histogramCaptureRenderRequest;
    try {
      const gpu = (navigator as Navigator & { gpu?: any }).gpu;
      if (!gpu) throw new Error('WebGPU is unavailable; HDR capture preview cannot be displayed.');
      try { this.histogramCaptureContext?.unconfigure(); } catch { /* already unconfigured */ }
      this.histogramCaptureTexture?.destroy();
      this.histogramCaptureDevice?.destroy();
      this.histogramCaptureTexture = null;
      this.histogramCaptureDevice = null;
      this.histogramCaptureContext = null;

      canvas.width = frame.width;
      canvas.height = frame.height;
      canvas.style.aspectRatio = `${frame.width} / ${frame.height}`;
      const adapter = await gpu.requestAdapter();
      if (requestId !== this.histogramCaptureRenderRequest) return;
      if (!adapter) throw new Error('No WebGPU adapter is available for the HDR capture preview.');
      const device: any = await adapter.requestDevice();
      if (requestId !== this.histogramCaptureRenderRequest) { device.destroy(); return; }
      const context = canvas.getContext('webgpu') as any;
      if (!context) {
        device.destroy();
        throw new Error('Could not create a WebGPU canvas for the HDR capture preview.');
      }
      context.configure({ device, format: 'rgba16float', colorSpace: 'srgb', alphaMode: 'opaque', toneMapping: { mode: 'extended' } });
      const texture = device.createTexture({
        size: { width: frame.width, height: frame.height },
        format: 'rgba16float',
        usage: 4 | 2
      });
      device.queue.writeTexture({ texture }, frame.pixels, { bytesPerRow: frame.width * 8, rowsPerImage: frame.height }, { width: frame.width, height: frame.height, depthOrArrayLayers: 1 });
      const shader = device.createShaderModule({ code: `
        @group(0) @binding(0) var sourceTexture: texture_2d<f32>;
        struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> }
        @vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOutput {
          var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
          var output: VertexOutput;
          let p = positions[index];
          output.position = vec4<f32>(p, 0.0, 1.0);
          output.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
          return output;
        }
        fn linearToExtendedSrgb(value: f32) -> f32 {
          if (value <= 0.0031308) { return value * 12.92; }
          return 1.055 * pow(value, 1.0 / 2.4) - 0.055;
        }
        @fragment fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
          let dims = vec2<i32>(textureDimensions(sourceTexture));
          let coords = vec2<i32>(clamp(input.uv * vec2<f32>(dims), vec2<f32>(0.0), vec2<f32>(dims - vec2<i32>(1, 1))));
          let linearColor = textureLoad(sourceTexture, coords, 0).rgb * 0.4;
          return vec4<f32>(linearToExtendedSrgb(linearColor.r), linearToExtendedSrgb(linearColor.g), linearToExtendedSrgb(linearColor.b), 1.0);
        }
      ` });
      const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module: shader, entryPoint: 'vs' }, fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] }, primitive: { topology: 'triangle-list' } });
      const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: texture.createView() }] });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
      if (requestId !== this.histogramCaptureRenderRequest) {
        context.unconfigure();
        texture.destroy();
        device.destroy();
        return;
      }
      this.histogramCaptureDevice = device;
      this.histogramCaptureTexture = texture;
      this.histogramCaptureContext = context;
    } catch (error) {
      if (requestId === this.histogramCaptureRenderRequest) {
        this.histogramErrorMessage.set(error instanceof Error ? error.message : String(error));
        this.histogramError.set(true);
        console.error('[HDR Capture Histogram] WebGPU preview failed:', error);
      }
    }
  };

  /** Render the same FP16/scRGB frame with the same extended-range WebGPU path as Capture Preview. */
  private readonly disposeLoupeCapturePreview = (): void => {
    this.loupeCapturePreviewRenderRequest++;
    try { this.loupeCapturePreviewContext?.unconfigure(); } catch { /* already unconfigured */ }
    this.loupeCapturePreviewTexture?.destroy(); this.loupeCapturePreviewDevice?.destroy();
    this.loupeCapturePreviewTexture = null; this.loupeCapturePreviewDevice = null; this.loupeCapturePreviewContext = null;
  };

  private readonly renderLoupeCapturePreviewHdr = async (canvas: HTMLCanvasElement, frame: CapturePreview): Promise<void> => {
    const requestId = ++this.loupeCapturePreviewRenderRequest;
    try {
      const gpu = (navigator as Navigator & { gpu?: any }).gpu;
      if (!gpu) throw new Error('WebGPU is unavailable; HDR capture preview cannot be displayed.');
      try { this.loupeCapturePreviewContext?.unconfigure(); } catch { /* already unconfigured */ }
      this.loupeCapturePreviewTexture?.destroy();
      this.loupeCapturePreviewDevice?.destroy();
      this.loupeCapturePreviewTexture = null;
      this.loupeCapturePreviewDevice = null;
      this.loupeCapturePreviewContext = null;

      canvas.width = frame.width;
      canvas.height = frame.height;
      canvas.style.aspectRatio = `${frame.width} / ${frame.height}`;
      const adapter = await gpu.requestAdapter();
      if (requestId !== this.loupeCapturePreviewRenderRequest) return;
      if (!adapter) throw new Error('No WebGPU adapter is available for the HDR capture preview.');
      const device: any = await adapter.requestDevice();
      if (requestId !== this.loupeCapturePreviewRenderRequest) { device.destroy(); return; }
      const context = canvas.getContext('webgpu') as any;
      if (!context) {
        device.destroy();
        throw new Error('Could not create a WebGPU canvas for the HDR capture preview.');
      }
      context.configure({ device, format: 'rgba16float', colorSpace: 'srgb', alphaMode: 'opaque', toneMapping: { mode: 'extended' } });
      const texture = device.createTexture({
        size: { width: frame.width, height: frame.height },
        format: 'rgba16float',
        usage: 4 | 2
      });
      device.queue.writeTexture({ texture }, frame.pixels, { bytesPerRow: frame.width * 8, rowsPerImage: frame.height }, { width: frame.width, height: frame.height, depthOrArrayLayers: 1 });
      const shader = device.createShaderModule({ code: `
        @group(0) @binding(0) var sourceTexture: texture_2d<f32>;
        struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> }
        @vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOutput {
          var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
          var output: VertexOutput;
          let p = positions[index];
          output.position = vec4<f32>(p, 0.0, 1.0);
          output.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
          return output;
        }
        fn linearToExtendedSrgb(value: f32) -> f32 {
          if (value <= 0.0031308) { return value * 12.92; }
          return 1.055 * pow(value, 1.0 / 2.4) - 0.055;
        }
        @fragment fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
          let dims = vec2<i32>(textureDimensions(sourceTexture));
          let coords = vec2<i32>(clamp(input.uv * vec2<f32>(dims), vec2<f32>(0.0), vec2<f32>(dims - vec2<i32>(1, 1))));
          let linearColor = textureLoad(sourceTexture, coords, 0).rgb * 0.4;
          return vec4<f32>(linearToExtendedSrgb(linearColor.r), linearToExtendedSrgb(linearColor.g), linearToExtendedSrgb(linearColor.b), 1.0);
        }
      ` });
      const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module: shader, entryPoint: 'vs' }, fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] }, primitive: { topology: 'triangle-list' } });
      const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: texture.createView() }] });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
      if (requestId !== this.loupeCapturePreviewRenderRequest) {
        context.unconfigure();
        texture.destroy();
        device.destroy();
        return;
      }
      this.loupeCapturePreviewDevice = device;
      this.loupeCapturePreviewTexture = texture;
      this.loupeCapturePreviewContext = context;
    } catch (error) {
      if (requestId === this.loupeCapturePreviewRenderRequest) {
        console.error('[HDR Magnifier Capture Preview] WebGPU preview failed:', error);
      }
    }
  };


  private readonly loadCapturePreviewHistogram = async (frame: CapturePreview): Promise<void> => {
    const requestId = ++this.histogramRequestId;
    this.histogramLoading.set(true);
    this.histogramError.set(false);
    this.histogramData.set(null);
    const pixelCount = Math.min(frame.width * frame.height, Math.floor(frame.pixels.length / 4));
    const minimumLogNits = 0.1;
    const chunkSize = 250_000;
    const linear = {
      white: new Array<number>(128).fill(0),
      red: new Array<number>(128).fill(0),
      green: new Array<number>(128).fill(0),
      blue: new Array<number>(128).fill(0)
    };
    const logarithmic = {
      white: new Array<number>(128).fill(0),
      red: new Array<number>(128).fill(0),
      green: new Array<number>(128).fill(0),
      blue: new Array<number>(128).fill(0)
    };

    // Decode IEEE-754 binary16 values without changing the captured FP16 data.
    const halfToFloat = (half: number): number => {
      const sign = (half & 0x8000) ? -1 : 1;
      const exponent = (half >> 10) & 0x1f;
      const mantissa = half & 0x03ff;
      if (exponent === 0) return sign * Math.pow(2, -14) * (mantissa / 1024);
      if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : NaN;
      return sign * Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
    };
    const toNits = (value: number): number => Number.isFinite(value) ? Math.max(0, value * 80) : 0;
    const luminance = (r: number, g: number, b: number): number =>
      Math.max(0, 0.2126 * r + 0.7152 * g + 0.0722 * b);

    try {
      let actualMaximumNits = 0;
      for (let start = 0; start < pixelCount; start += chunkSize) {
        const end = Math.min(pixelCount, start + chunkSize);
        for (let pixel = start; pixel < end; pixel++) {
          const offset = pixel * 4;
          const red = toNits(halfToFloat(frame.pixels[offset]));
          const green = toNits(halfToFloat(frame.pixels[offset + 1]));
          const blue = toNits(halfToFloat(frame.pixels[offset + 2]));
          actualMaximumNits = Math.max(actualMaximumNits, red, green, blue, luminance(red, green, blue));
        }
        if (requestId !== this.histogramRequestId) return;
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }

      const maximumNits = Math.max(minimumLogNits * 1.01, actualMaximumNits * 1.02);
      const linearBin = (nits: number): number =>
        Math.min(127, Math.max(0, Math.floor(nits / maximumNits * 128)));
      const logarithmicBin = (nits: number): number =>
        Math.min(127, Math.max(0, Math.floor(
          Math.log(Math.max(minimumLogNits, nits) / minimumLogNits) /
          Math.log(maximumNits / minimumLogNits) * 128
        )));

      for (let start = 0; start < pixelCount; start += chunkSize) {
        const end = Math.min(pixelCount, start + chunkSize);
        for (let pixel = start; pixel < end; pixel++) {
          const offset = pixel * 4;
          const red = toNits(halfToFloat(frame.pixels[offset]));
          const green = toNits(halfToFloat(frame.pixels[offset + 1]));
          const blue = toNits(halfToFloat(frame.pixels[offset + 2]));
          const white = luminance(red, green, blue);
          linear.white[linearBin(white)]++;
          linear.red[linearBin(red)]++;
          linear.green[linearBin(green)]++;
          linear.blue[linearBin(blue)]++;
          logarithmic.white[logarithmicBin(white)]++;
          logarithmic.red[logarithmicBin(red)]++;
          logarithmic.green[logarithmicBin(green)]++;
          logarithmic.blue[logarithmicBin(blue)]++;
        }
        if (requestId !== this.histogramRequestId) return;
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }

      if (requestId !== this.histogramRequestId || !this.histogramUsesCapturePreview()) return;
      this.histogramData.set({ linear, logarithmic, maximumNits, minimumLogNits });
      this.histogramError.set(false);
      this.histogramErrorMessage.set('Histogram could not be calculated.');
    } catch (error) {
      if (requestId === this.histogramRequestId) {
        this.histogramErrorMessage.set(error instanceof Error ? error.message : String(error));
        this.histogramError.set(true);
      }
    } finally {
      if (requestId === this.histogramRequestId) this.histogramLoading.set(false);
    }
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

  protected readonly toggleSidebarVisibility = (): void => {
    const visible = !this.controlsSidebarVisible();
    this.controlsSidebarVisible.set(visible);
    try { this.document.defaultView?.localStorage.setItem('light-matter.imageSidebarVisible', String(visible)); } catch { /* Keep the current session state. */ }
  };

  protected readonly changeImagePosition = (value: number): void => {
    this.viewNavigator.selectPosition(value);
  };

  private readonly changeViewerZoom = (direction: -1 | 1): void => {
    // The same controls operate the loupe magnification while the loupe is active.
    if (this.loupeEnabled()) {
      const factor = direction > 0 ? 1.25 : 0.8;
      const nextZoom = Math.max(0.1, Math.min(64, Number((this.loupeSlider.value * factor).toFixed(2))));
      this.loupeSlider.setValue(nextZoom);
      const mouse = this.lastMousePosition();
      if (mouse) this.sampleLoupeAtPosition({ screenX: mouse.screenX, screenY: mouse.screenY }, true);
      return;
    }

    // When fitted, use the actual displayed scale rather than a stale slider value.
    this.imageLocation$.pipe(take(1)).subscribe(location => {
      const currentZoom = location.zoom === 'fit' ? location.fitZoom : this.zoomSlider.value;
      const nextZoom = Math.max(this.zoomConfig.min, Math.min(this.zoomConfig.max, currentZoom + direction * 10));
      this.zoomSlider.setValue(nextZoom);
      this.imagePositioningService.setZoom(nextZoom / 100);
      if (this.hdrImageAdjustmentActive()) void this.renderHdrImageAdjustments(true);
    });
  };

  protected readonly zoomOut = (): void => this.changeViewerZoom(-1);

  protected readonly resetZoom = (): void => {
    if (this.loupeEnabled()) this.resetLoupeZoom();
    else this.fitToWindow();
  };

  protected readonly zoomIn = (): void => this.changeViewerZoom(1);

  protected readonly fitToWindow = () => {
    if (!this.loupeEnabled()) {
      this.imagePositioningService.setZoom('fit');
      if (this.hdrImageAdjustmentActive()) void this.renderHdrImageAdjustments(true);
    }
  };

  /** Restore a neutral viewing state without changing the selected image or comparison mode. */
  protected readonly resetViewAndAdjustments = (): void => {
    if (this.loupeEnabled()) void this.toggleLoupe(false);
    if (this.sidebarSectionExpanded('loupe')) {
      const sections = { ...this.sidebarSections(), loupe: false };
      this.sidebarSections.set(sections);
      this.configuration.updateSystemConfig({ imageSidebarSections: sections });
    }
    this.loupeBrightness.set(1);
    this.mainImageBrightness.set(1);
    this.imageContrast.set(1);
    this.redChannelLevel.set(1);
    this.greenChannelLevel.set(1);
    this.blueChannelLevel.set(1);
    this.invertRedChannel.set(false);
    this.invertGreenChannel.set(false);
    this.invertBlueChannel.set(false);
    this.invertAllRgbChannels.set(false);
    this.imagePositioningService.setZoom('fit');
    this.refreshHdrImageAdjustments();
  };

  protected readonly resetImageBrightness = () => {
    if (this.loupeEnabled()) this.loupeBrightness.set(1);
    else this.setMainBrightness(1);
  };

  protected readonly toggleLoupeShape = () => {
    const shapes = ['circular', 'rectangular', 'ruler', 'vertical-ruler'] as const;

    if (!this.loupeEnabled()) {
      this.loupeShape.set('circular');
      this.storeLoupeShape('circular');
      if (!this.sidebarSectionExpanded('loupe')) this.toggleSidebarSection('loupe');
      else void this.toggleLoupe(true);
      return;
    }

    // Normalize legacy saved shape values before cycling through supported shapes.
    const currentShape = this.loupeShape();
    const currentIndex = shapes.indexOf(currentShape);
    if (currentIndex === shapes.length - 1) {
      void this.toggleLoupe(false);
      return;
    }

    this.loupeShape.set(shapes[currentIndex + 1]);
    this.hdrLoupeActive.set(false);
    this.hdrLoupeRenderer.dispose();
    this.storeLoupeShape(shapes[currentIndex + 1]);
  };

  private readonly storeLoupeShape = (value: 'circular' | 'rectangular' | 'ruler' | 'vertical-ruler') => {
    try {
      this.document.defaultView?.localStorage.setItem('light-matter.loupeShape', value);
      this.storeBoolean('loupeCircular', value === 'circular');
    } catch {
      // The shape remains usable for the current session if storage is unavailable.
    }
  };

  protected readonly toggleLoupe = async (enabled: boolean) => {
    this.loupeEnabled.set(enabled);
    this.loupeSample.set(null);
    this.loupeCaptureError.set(null);
    this.loupeSampleRequest++;
    if (!enabled) {
      // Invalidate any pending swatch render while Angular removes its canvas.
      // The renderer will release the old canvas context when the next canvas is attached.
      this.hdrSwatchRenderRequest++;
      this.hdrLoupeActive.set(false);
      this.hdrLoupeRenderer.dispose();
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
      const loupeHeight = (310) + (shape === 'ruler' ? -180 : shape === 'vertical-ruler' ? 280 : 0);
      const left = lastMouse.clientX > viewWidth - loupeWidth - 24 ? lastMouse.clientX - loupeWidth - 20 : lastMouse.clientX + 20;
      const top = lastMouse.clientY > viewHeight - loupeHeight - 24 ? lastMouse.clientY - loupeHeight - 20 : lastMouse.clientY + 20;
      this.loupePosition.set({ x: Math.max(8, Math.min(viewWidth - loupeWidth - 8, left)), y: Math.max(8, Math.min(viewHeight - loupeHeight - 8, top)) });
    }

    // The constructor effect starts capture now or retries when decoding finishes.
  };

  private loupeSdrPixelCanvas: HTMLCanvasElement | null = null;
  private loupeSdrPixelContext: CanvasRenderingContext2D | null = null;

  /** Read only the source SDR pixel under the pointer; use a 1×1 canvas to avoid stale full-image copies. */
  private readonly updateLoupeSdrPixelColor = (image: HTMLImageElement, x: number, y: number): void => {
    try {
      if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
        this.pixelColor.set(null);
        return;
      }
      if (!this.loupeSdrPixelCanvas || !this.loupeSdrPixelContext) {
        const canvas = this.document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) {
          this.pixelColor.set(null);
          return;
        }
        this.loupeSdrPixelCanvas = canvas;
        this.loupeSdrPixelContext = context;
      }

      // Sampling one source pixel on every pointer move also handles an <img>
      // element whose src changes while Angular reuses the same DOM element.
      this.loupeSdrPixelContext.clearRect(0, 0, 1, 1);
      this.loupeSdrPixelContext.drawImage(
        image,
        Math.max(0, Math.min(image.naturalWidth - 1, x)),
        Math.max(0, Math.min(image.naturalHeight - 1, y)),
        1, 1, 0, 0, 1, 1
      );
      const pixel = this.loupeSdrPixelContext.getImageData(0, 0, 1, 1).data;
      this.pixelColor.set({ r: pixel[0], g: pixel[1], b: pixel[2] });
    } catch {
      // Never leave stale RGB values visible if the current image cannot be sampled.
      this.pixelColor.set(null);
      this.loupeSdrPixelCanvas = null;
      this.loupeSdrPixelContext = null;
    }
  };

  private readonly updateLoupeSourcePoint = (clientX: number, clientY: number) => {
    const images = Array.from(this.document.querySelectorAll<HTMLImageElement>('.comparison-image:not(.hidden-variant)'));
    const image = images.find(candidate => {
      const bounds = candidate.getBoundingClientRect();
      return clientX >= bounds.left && clientX < bounds.right &&
        clientY >= bounds.top && clientY < bounds.bottom &&
        candidate.naturalWidth > 0 && candidate.naturalHeight > 0;
    }) ?? images.find(candidate => {
      // Keep the loupe pinned to the nearest top/bottom edge while the pointer
      // remains horizontally over the image. Leaving the image vertically must
      // not reset the capture-preview sample to pixel 0/0.
      const bounds = candidate.getBoundingClientRect();
      return clientX >= bounds.left && clientX < bounds.right &&
        candidate.naturalWidth > 0 && candidate.naturalHeight > 0;
    });
    if (!image) {
      this.pixelColor.set(null);
      this.loupeSourcePoint.set({ x: 0, y: 0 });
      return;
    }

    const bounds = image.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;

    // Keep the loupe coordinate mapping identical to the renderer's RGB sampler.
    // Both use centered object-fit: contain geometry, including letterboxing.
    // Using a separate object-position calculation here caused the loupe crosshair
    // and the renderer's own pixel coordinates to disagree.
    const naturalWidth = image.naturalWidth;
    const naturalHeight = image.naturalHeight;
    const scale = Math.min(bounds.width / naturalWidth, bounds.height / naturalHeight);
    const renderedWidth = naturalWidth * scale;
    const renderedHeight = naturalHeight * scale;
    const imageLeft = bounds.left + (bounds.width - renderedWidth) / 2;
    const imageTop = bounds.top + (bounds.height - renderedHeight) / 2;
    const sourceX = Math.max(0, Math.min(naturalWidth - 1,
      Math.floor((clientX - imageLeft) / scale)));
    const sourceY = Math.max(0, Math.min(naturalHeight - 1,
      Math.floor((clientY - imageTop) / scale)));
    this.loupeSourcePoint.set({ x: sourceX, y: sourceY });
    this.updateLoupeSdrPixelColor(image, sourceX, sourceY);
  };

  private readonly fallbackLoupeToCss = (error: unknown, context: string): void => {
    console.error(context, error);
    this.loupeRendererMode.set('css');
    this.hdrLoupeActive.set(false);
    this.hdrLoupeRenderer.dispose();
    this.loupeCaptureError.set(error instanceof Error ? error.message : String(error));
  };

  private readonly sampleLoupeAtPosition = (position: { screenX: number; screenY: number }, force = false) => {
    const geometry = this.loupeCaptureGeometry();
    const view = this.document.defaultView;
    if (!geometry || !view || !this.desktop || !this.loupeEnabled()) return;
    // Convert Electron screen coordinates (DIP) to physical capture pixels
    // using the official Windows display scale factor, not a ratio affected by
    // rounded monitor/capture dimensions.
    const relativeScreenX = position.screenX - geometry.x;
    const relativeScreenY = position.screenY - geometry.y;
    const x = relativeScreenX * geometry.scaleFactor;
    const y = relativeScreenY * geometry.scaleFactor;
    const windowsScaleX = x;
    const windowsScaleY = y;
    const now = performance.now();
    if (!force && now - this.lastLoupeSampleAt < 24) return;
    this.lastLoupeSampleAt = now;
    const request = ++this.loupeSampleRequest;
    // Size the source crop for the longest viewport dimension. Ruler viewports
    // are 560 px long, so a 140 px radius only covers their center at low zoom.
    // Include the physical display scale and outer loupe size, but keep pixel
    // magnification independent from the loupe's visual size.
    const shape = this.loupeShape();
    const viewportHalfExtent = shape === 'ruler' || shape === 'vertical-ruler' ? 280 : 140;
    const effectiveZoom = this.loupePixelSize() * geometry.scaleFactor / this.loupeSizeScale();
    const requestedRadius = Math.ceil(viewportHalfExtent / Math.max(effectiveZoom, 0.01)) + 16;
    const radius = Math.max(3, Math.min(2048, requestedRadius));
    this.desktop.Loupe.sample(x, y, radius)
      .then(async sample => {
        if (request === this.loupeSampleRequest && this.loupeEnabled()) {
          this.loupeSample.set(sample);
          this.loupeCaptureError.set(null);
          if (sample) {
            void this.renderHdrColorSwatch(sample);
            await this.renderHdrLoupe(sample);
          } else {
            this.hdrLoupeActive.set(false);
          }
        }
      })
      .catch(error => {
        if (request === this.loupeSampleRequest && this.loupeEnabled()) {
          this.fallbackLoupeToCss(error, 'HDR loupe pixel capture failed; switching to CSS (SDR) mode.');
        }
      });
  };

  protected readonly onLoupeMouseMove = (event: MouseEvent, forceSample = false) => {
    const position = { clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY };
    this.lastMousePosition.set(position);
    if (!this.loupeEnabled() || this.loupeCapturePending()) return;
    const view = this.document.defaultView;
    const viewWidth = view?.innerWidth ?? 1280;
    const viewHeight = view?.innerHeight ?? 720;
    const shape = this.loupeShape();
    const sizeScale = this.loupeSizeScale();
    const loupeWidth = (shape === 'ruler' ? 590 : shape === 'vertical-ruler' ? 130 : 310) * sizeScale;
    const loupeHeight = ((310) + (shape === 'ruler' ? -180 : shape === 'vertical-ruler' ? 280 : 0)) * sizeScale;
    const left = event.clientX > viewWidth - loupeWidth - 24 ? event.clientX - loupeWidth - 20 : event.clientX + 20;
    const top = event.clientY > viewHeight - loupeHeight - 24 ? event.clientY - loupeHeight - 20 : event.clientY + 20;
    this.loupePosition.set({ x: Math.max(8, Math.min(viewWidth - loupeWidth - 8, left)), y: Math.max(8, Math.min(viewHeight - loupeHeight - 8, top)) });

    this.updateLoupeSourcePoint(event.clientX, event.clientY);
    this.sampleLoupeAtPosition(position, forceSample);
  };

  protected readonly onLoupeMouseLeave = () => {
    this.loupeSampleRequest++;
    // The sample block (including its WebGPU canvas) is removed from the DOM.
    // Invalidate queued animation-frame renders so they cannot target that stale canvas.
    this.hdrSwatchRenderRequest++;
    this.loupeSample.set(null);
  };

  private readonly refreshHdrImageAdjustments = (): void => {
    if (!this.hdrImageAdjustmentActive()) {
      this.hdrImageAdjustmentRequest++;
      this.hdrImageAdjustmentRecaptureQueued = false;
      this.hdrImageAdjustmentPending.set(false);
      this.hdrImageAdjustmentReady.set(false);
      this.hdrImageAdjustmentRegion = null;
      this.hdrImageAdjustmentRenderer.dispose();
      return;
    }
    void this.renderHdrImageAdjustments();
  };

  private readonly renderHdrImageAdjustments = async (recapture = false): Promise<void> => {
    if (!this.hdrImageAdjustmentActive()) return;
    if (recapture) {
      this.hdrImageAdjustmentRegion = null;
      this.hdrImageAdjustmentReady.set(false);
      if (this.hdrImageAdjustmentCapturePromise) {
        this.hdrImageAdjustmentRecaptureQueued = true;
        return this.hdrImageAdjustmentCapturePromise;
      }
    }
    if (!this.hdrImageAdjustmentRegion) {
      if (this.hdrImageAdjustmentCapturePromise) return this.hdrImageAdjustmentCapturePromise;
      const wrapped = this.captureHdrImageAdjustmentSource().finally(() => {
        if (this.hdrImageAdjustmentCapturePromise === wrapped) this.hdrImageAdjustmentCapturePromise = null;
        if (this.hdrImageAdjustmentRecaptureQueued && this.hdrImageAdjustmentActive()) {
          this.hdrImageAdjustmentRecaptureQueued = false;
          void this.renderHdrImageAdjustments(true);
        }
      });
      this.hdrImageAdjustmentCapturePromise = wrapped;
      return wrapped;
    }
    try {
      await this.drawHdrImageAdjustments();
    } catch (error) {
      console.error('HDR image adjustment render failed:', error);
      this.hdrImageAdjustmentReady.set(false);
      this.hdrImageAdjustmentPending.set(false);
      this.loupeCaptureError.set(error instanceof Error ? error.message : String(error));
    }
  };

  private readonly captureHdrImageAdjustmentSource = async (): Promise<void> => {
    const desktop = this.desktop;
    if (!desktop || !this.hdrImageAdjustmentActive()) return;
    const request = ++this.hdrImageAdjustmentRequest;
    const wasLoupeEnabled = this.loupeEnabled();
    this.hdrImageAdjustmentPending.set(true);
    this.hdrImageAdjustmentReady.set(false);
    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (request !== this.hdrImageAdjustmentRequest || !this.hdrImageAdjustmentActive()) return;
      const host = this.document.querySelector<HTMLElement>('app-image-renderer');
      const image = host?.querySelector<HTMLImageElement>('img.hdr-image:not(.hidden-variant)');
      const hostBounds = host?.getBoundingClientRect();
      const imageBounds = image?.getBoundingClientRect();
      if (!host || !image || !hostBounds || !imageBounds) return;
      const bounds = {
        left: Math.max(hostBounds.left, imageBounds.left),
        top: Math.max(hostBounds.top, imageBounds.top),
        right: Math.min(hostBounds.right, imageBounds.right),
        bottom: Math.min(hostBounds.bottom, imageBounds.bottom)
      };
      if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) return;
      const visibleBounds = { left: bounds.left, top: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top };
      const geometry = wasLoupeEnabled && this.loupeCaptureGeometry()
        ? this.loupeCaptureGeometry()!
        : await desktop.Loupe.capture();
      if (request !== this.hdrImageAdjustmentRequest || !this.hdrImageAdjustmentActive()) return;
      const scale = geometry.scaleFactor;
      const captureLeft = (geometry.contentX + visibleBounds.left - geometry.x) * scale;
      const captureTop = (geometry.contentY + visibleBounds.top - geometry.y) * scale;
      const region = await desktop.Loupe.region(captureLeft, captureTop, visibleBounds.width * scale, visibleBounds.height * scale);
      if (!region || request !== this.hdrImageAdjustmentRequest || !this.hdrImageAdjustmentActive()) return;
      this.hdrImageAdjustmentBounds.set(visibleBounds);
      this.hdrImageAdjustmentRegion = {
        width: region.regionWidth,
        height: region.regionHeight,
        centerX: region.regionWidth / 2,
        centerY: region.regionHeight / 2,
        data: region.data
      };

      // Sample the displayed image into an 8-bit SDR buffer aligned to the
      // exact visible area covered by the FP16 capture.
      const sdrCanvas = this.document.createElement('canvas');
      sdrCanvas.width = region.regionWidth;
      sdrCanvas.height = region.regionHeight;
      const sdrContext = sdrCanvas.getContext('2d', { willReadFrequently: true });
      if (!sdrContext || !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0 ||
          imageBounds.width <= 0 || imageBounds.height <= 0) {
        throw new Error('SDR image pixels are not available for overexposure highlighting.');
      }
      const sx = Math.max(0, (visibleBounds.left - imageBounds.left) / imageBounds.width * image.naturalWidth);
      const sy = Math.max(0, (visibleBounds.top - imageBounds.top) / imageBounds.height * image.naturalHeight);
      const sw = Math.min(image.naturalWidth - sx, visibleBounds.width / imageBounds.width * image.naturalWidth);
      const sh = Math.min(image.naturalHeight - sy, visibleBounds.height / imageBounds.height * image.naturalHeight);
      sdrContext.drawImage(image, sx, sy, sw, sh, 0, 0, region.regionWidth, region.regionHeight);
      this.hdrImageAdjustmentSdrPixels = new Uint8Array(sdrContext.getImageData(0, 0, region.regionWidth, region.regionHeight).data);
      this.hdrImageAdjustmentSourceKey = 'capture-' + request + ':' + this.debugSelectedImagePath;
      await this.drawHdrImageAdjustments();
    } catch (error) {
      console.error('HDR image adjustment capture/render failed:', error);
      this.hdrImageAdjustmentReady.set(false);
      this.loupeCaptureError.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (!wasLoupeEnabled) await desktop.Loupe.release().catch(() => undefined);
      if (request === this.hdrImageAdjustmentRequest && !this.hdrImageAdjustmentReady()) {
        this.hdrImageAdjustmentPending.set(false);
      }
    }
  };

  private readonly drawHdrImageAdjustments = async (): Promise<void> => {
    const canvas = this.document.querySelector<HTMLCanvasElement>('.hdr-image-adjustment-canvas');
    const region = this.hdrImageAdjustmentRegion;
    const sdrPixels = this.hdrImageAdjustmentSdrPixels;
    if (!canvas || !region || !sdrPixels || !this.hdrImageAdjustmentActive()) return;
    const host = this.document.querySelector<HTMLElement>('app-image-renderer');
    const image = host?.querySelector<HTMLElement>('img.hdr-image:not(.hidden-variant)');
    const hostBounds = host?.getBoundingClientRect();
    const imageBounds = image?.getBoundingClientRect();
    if (!hostBounds || !imageBounds) return;
    const left = Math.max(hostBounds.left, imageBounds.left);
    const top = Math.max(hostBounds.top, imageBounds.top);
    const right = Math.min(hostBounds.right, imageBounds.right);
    const bottom = Math.min(hostBounds.bottom, imageBounds.bottom);
    if (right <= left || bottom <= top) return;
    this.hdrImageAdjustmentBounds.set({ left, top, width: right - left, height: bottom - top });
    const request = this.hdrImageAdjustmentRequest;
    await this.hdrImageAdjustmentRenderer.render(
      canvas,
      region,
      sdrPixels,
      this.mainImageBrightness() * HDR_WEBGPU_BRIGHTNESS_CORRECTION,
      this.hdrImageAdjustmentSourceKey,
      {
        contrast: this.imageContrast(),
        gamma: this.imageGamma(),
        red: this.redChannelLevel(),
        green: this.greenChannelLevel(),
        blue: this.blueChannelLevel(),
        invertRed: this.invertRedChannel(),
        invertGreen: this.invertGreenChannel(),
        invertBlue: this.invertBlueChannel(),
        invertAll: this.invertAllRgbChannels(),
        saturation: this.colorIntensity(),
        blackPoint: this.blackPoint(),
        whitePoint: this.whitePoint(),
        highlightHdrPixels: this.highlightHdrPixels(),
        hdrHighlightThreshold: this.hdrHighlightThreshold(),
        highlightSdrOverexposure: this.highlightSdrOverexposure(),
        sdrOverexposureThreshold: this.sdrOverexposureThreshold(),
        highlightSdrUnderexposure: this.highlightSdrUnderexposure(),
        sdrUnderexposureThreshold: this.sdrUnderexposureThreshold()
      }
    );
    if (request === this.hdrImageAdjustmentRequest && this.hdrImageAdjustmentActive()) {
      this.hdrImageAdjustmentReady.set(true);
      this.hdrImageAdjustmentPending.set(false);
      this.loupeCaptureError.set(null);
    }
  };

  protected readonly onImageRendered = () => {
    if (this.isDecoding()) return;

    // Apply the final HDR adjustments before taking the window capture. Capturing
    // first can preserve a partially rendered or uncorrected frame in the loupe.
    if (this.hdrImageAdjustmentActive()) {
      void this.renderHdrImageAdjustments(true).finally(() => {
        if (this.loupeEnabled() && !this.isDecoding()) {
          void this.captureLoupeAfterRender();
        }
      });
      return;
    }

    if (this.loupeEnabled()) void this.captureLoupeAfterRender();
  };

  private readonly captureLoupeAfterRender = async () => {
    const desktop = this.desktop;
    if (!this.loupeEnabled() || !desktop) return;
    const request = ++this.loupeCaptureRequest;
    this.loupeSample.set(null);
    this.loupeCaptureError.set(null);
    this.hdrLoupeActive.set(false);
    this.hdrLoupeRenderer.dispose();
    this.loupeCapturePending.set(true);
    // Allow Angular to update the DOM and let the browser/GPU present the final
    // corrected frame before capturing the window. Two animation frames alone
    // are not a guarantee that a newly submitted GPU frame has been presented.
    await new Promise<void>(resolve => requestAnimationFrame(() =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    ));
    if (!this.loupeEnabled() || request !== this.loupeCaptureRequest) {
      this.loupeCapturePending.set(false);
      return;
    }
    try {
      const geometry = await desktop.Loupe.capture();
      this.loupeCaptureGeometry.set(geometry);
      const lastMouse = this.lastMousePosition();
      if (lastMouse) this.sampleLoupeAtPosition(lastMouse, true);
    } catch (error) {
      this.loupeCaptureGeometry.set(null);
      this.fallbackLoupeToCss(error, 'HDR loupe capture failed; switching to CSS (SDR) mode.');
    } finally {
      if (request === this.loupeCaptureRequest) this.loupeCapturePending.set(false);
    }
  };

  private readonly renderHdrLoupe = async (sample: NonNullable<Awaited<ReturnType<NonNullable<Desktop>['Loupe']['sample']>>>): Promise<void> => {
    if (!sample) return;
    // Renderer selection is explicit: CSS remains the reference path unless
    // the user chooses WebGPU. Both renderers can now be compared at 0% brightness.
    if (this.loupeRendererMode() !== 'webgpu') {
      this.hdrLoupeActive.set(false);
      return;
    }
    // During startup the native sample can arrive before Angular has attached
    // the loupe canvas. Wait for the next paint before looking it up; otherwise
    // the first render is skipped and the canvas stays as a flat gray surface
    // until the user toggles the loupe off and on again.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (!this.loupeEnabled() || this.loupeSample() !== sample || this.loupeRendererMode() !== 'webgpu') return;

    // WebGPU remains available at all zoom levels, including 1× and 0.98×.
    const canvas = this.document.querySelector<HTMLCanvasElement>('.hdr-loupe-canvas');
    if (!canvas) {
      this.hdrLoupeActive.set(false);
      return;
    }
    try {
      // Apply the shared HDR brightness correction while preserving the relative loupe adjustment.
      const brightness = this.loupeBrightness() * HDR_WEBGPU_BRIGHTNESS_CORRECTION;
      // Convert CSS/DIP loupe size to physical capture pixels using the official
      // Windows display scale factor (1.5 at 150% scaling in the current setup).
      const zoom = this.loupePixelSize() * (this.loupeCaptureGeometry()?.scaleFactor ?? 1) / this.loupeSizeScale();
      await this.hdrLoupeRenderer.render(canvas, {
        width: sample.regionWidth,
        height: sample.regionHeight,
        centerX: sample.centerX,
        centerY: sample.centerY,
        data: sample.data
      }, brightness, zoom);
      if (this.loupeEnabled() && this.loupeSample() === sample) {
        this.hdrLoupeActive.set(this.loupeRendererMode() === 'webgpu');
      }
    } catch (error) {
      this.fallbackLoupeToCss(error, 'HDR WebGPU loupe render failed; switching to CSS (SDR) mode.');
    }
  };

  /** Render the sampled FP16/scRGB pixel through the same extended-range WebGPU path as the HDR loupe. */
  private readonly renderHdrColorSwatch = async (sample: NonNullable<ReturnType<typeof this.loupeSample>>): Promise<void> => {
    const request = ++this.hdrSwatchRenderRequest;
    try {
      // Wait for Angular to attach the canvas and size its fixed 16px wrapper.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (request !== this.hdrSwatchRenderRequest || this.loupeSample() !== sample) return;
      const canvas = this.document.querySelector<HTMLCanvasElement>('.loupe-hdr-swatch-canvas');
      if (!canvas) return;
      // Match the loupe's 0.4 HDR brightness correction; otherwise this
      // small patch is substantially brighter than the corrected magnifier.
      const x = Math.max(0, Math.min(sample.regionWidth - 1, Math.round(sample.centerX)));
      const y = Math.max(0, Math.min(sample.regionHeight - 1, Math.round(sample.centerY)));
      const offset = (y * sample.regionWidth + x) * 4;
      // Pass exactly the sampled FP16 pixel. Rendering the surrounding sample
      // region made the swatch blend several neighboring colors.
      await this.hdrSwatchRenderer.render(canvas, {
        width: 1,
        height: 1,
        centerX: 0,
        centerY: 0,
        data: sample.data.slice(offset, offset + 4)
      }, HDR_WEBGPU_BRIGHTNESS_CORRECTION, 1);
      // A newer sample may have arrived while WebGPU initialized/rendered.
      // Never leave an obsolete frame as the apparent current pixel color.
      if (request !== this.hdrSwatchRenderRequest || this.loupeSample() !== sample) return;
    } catch (error) {
      console.warn('HDR pixel swatch WebGPU render failed:', error);
    }
  };

  protected readonly toggleLoupeRenderer = () => {
    const next = this.loupeRendererMode() === 'css' ? 'webgpu' : 'css';
    this.loupeRendererMode.set(next);
    if (next === 'css') {
      this.hdrLoupeActive.set(false);
      this.hdrLoupeRenderer.dispose();
      return;
    }

    // Request a fresh FP16 sample instead of reusing a possibly stale sample.
    const mouse = this.lastMousePosition();
    if (this.loupeEnabled() && mouse) {
      this.sampleLoupeAtPosition({
        screenX: mouse.screenX,
        screenY: mouse.screenY
      }, true);
    } else {
      this.hdrLoupeActive.set(false);
    }
  };

  /** Reset the loupe magnification to exactly 1× (displayed as loupePixelSize × 2). */
  protected readonly resetLoupeZoom = () => {
    this.loupeSlider.setValue(0.5);
    const mouse = this.lastMousePosition();
    if (this.loupeEnabled() && mouse) {
      this.sampleLoupeAtPosition({ screenX: mouse.screenX, screenY: mouse.screenY }, true);
    }
  };

  protected readonly setLoupeSize = (value: string | number) => {
    this.loupeSizeScale.set(Math.max(0.5, Math.min(1.2, Number(value))));
    const mouse = this.lastMousePosition();
    if (this.loupeEnabled() && mouse) {
      this.onLoupeMouseMove(new MouseEvent('mousemove', {
        clientX: mouse.clientX,
        clientY: mouse.clientY,
        screenX: mouse.screenX,
        screenY: mouse.screenY
      }), true);
    }
  };

  protected readonly adjustLoupeSize = (direction: 1 | -1) => {
    this.setLoupeSize(Number((this.loupeSizeScale() + direction * 0.1).toFixed(1)));
  };

  /** Return the displayed zoom factor for the current image location. */
  protected readonly getZoomFactor = (location: ImagePositioningResult | null | undefined): number => {
    const zoom = location?.zoom;
    if (zoom === 'fit') return (location?.fitZoom ?? 100) / 100;
    return typeof zoom === 'number' ? zoom : 1;
  };

  protected readonly adjustZoom = (direction: 1 | -1) => {
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

  protected readonly toggleExifInfo = (_path: string) => {
    const sections = { ...this.sidebarSections(), info: !this.sidebarSectionExpanded('info') };
    this.sidebarSections.set(sections);
    this.configuration.updateSystemConfig({ imageSidebarSections: sections, exifVisible: sections['info'] });
    this.exifVisible.set(sections['info']);
    this.exifState.set(sections['info'] ? this.imageTags() ?? false : false);
  };

  private readonly selectedImagePathForDebug = (): string => {
    // selectedImage$ is a stream; use the latest path cached by its subscription below.
    return this.debugSelectedImagePath;
  };

  private debugSelectedImagePath = 'unknown';

  protected readonly prevPhoto = () => this.viewNavigator.previous();

  protected readonly nextPhoto = () => this.viewNavigator.next();

  protected readonly copyPathStatus = signal('');

  protected readonly copyDestinationFolder = signal<string | null>(null);

  protected readonly copyPhotoStatus = signal('');

  protected readonly copyDestinationFileCount = signal<number | null>(null);

  protected readonly copyDestinationFolderSize = signal<number | null>(null);

  protected readonly sourceFileCount = signal<number | null>(null);

  protected readonly sourceFolderSize = signal<number | null>(null);

  protected readonly sourceFolderPath = signal<string | null>(null);

  private sourceFileCountFolder: string | null = null;

  protected readonly formatFolderSize = (bytes: number | null): string => {
    if (bytes === null) return '—';
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value.toFixed(2)} ${units[unit]}`;
  };

  private readonly refreshSourceFileCount = async (imagePath: string, force = false): Promise<void> => {
    const desktop = this.desktop;
    if (!desktop) return;
    try {
      const folder = await desktop.FileSystem.dirname(imagePath);
      this.sourceFolderPath.set(folder);
      if (!force && folder === this.sourceFileCountFolder) return;
      this.sourceFileCountFolder = folder;
      const files = (await desktop.FileSystem.readDir(folder)).filter(file => !file.isDirectory);
      this.sourceFileCount.set(files.length);
      this.sourceFolderSize.set(files.reduce((total, file) => total + file.size, 0));
    } catch (error) {
      console.error('Failed to read source folder statistics', error);
      this.sourceFileCount.set(null);
      this.sourceFolderSize.set(null);
    }
  };

  private readonly refreshDestinationFileCount = async (folder: string): Promise<void> => {
    const desktop = this.desktop;
    if (!desktop) return;
    try {
      const files = (await desktop.FileSystem.readDir(folder)).filter(file => !file.isDirectory);
      this.copyDestinationFileCount.set(files.length);
      this.copyDestinationFolderSize.set(files.reduce((total, file) => total + file.size, 0));
    } catch (error) {
      console.error('Failed to read destination folder statistics', error);
      this.copyDestinationFileCount.set(null);
      this.copyDestinationFolderSize.set(null);
    }
  };

  protected readonly copyImagePath = async (): Promise<void> => {
    const image = await this.selectedImage$.pipe(take(1)).toPromise();
    if (!image) return;
    try {
      const normalizedPath = /^[a-zA-Z]:[\\/]/.test(image.path) || image.path.startsWith('\\\\')
        ? image.path.replace(/\//g, '\\').replace(/\\{2,}/g, '\\')
        : image.path;
      await this.document.defaultView?.navigator.clipboard.writeText(normalizedPath);
      this.copyPathStatus.set('Copied');
      this.document.defaultView?.setTimeout(() => this.copyPathStatus.set(''), 1800);
    } catch (error) {
      console.error('Failed to copy image path to clipboard', error);
      this.copyPathStatus.set('Copy failed');
      this.document.defaultView?.setTimeout(() => this.copyPathStatus.set(''), 2500);
    }
  };

  protected readonly selectCopyFolder = async (): Promise<void> => {
    const desktop = this.desktop;
    if (!desktop) return;
    const image = await this.selectedImage$.pipe(take(1)).toPromise();
    if (!image) return;
    const initialFolder = await desktop.FileSystem.dirname(image.path);
    const result = await desktop.Dialogs.openFolder(initialFolder);
    if (result.success) {
      this.copyDestinationFolder.set(result.data);
      this.copyPhotoStatus.set('');
      await this.refreshDestinationFileCount(result.data);
    }
  };

  protected readonly selectBestOfFolder = async (): Promise<void> => {
    const desktop = this.desktop;
    if (!desktop) return;
    const image = await this.selectedImage$.pipe(take(1)).toPromise();
    if (!image) return;
    try {
      const imageFolder = await desktop.FileSystem.dirname(image.path);
      const parentFolder = await desktop.FileSystem.dirname(imageFolder);
      const result = await desktop.FileSystem.readDirectories(parentFolder);
      if (!result.success) throw new Error(result.errorMessage);
      const bestOf = result.data.find(folder => folder.isDirectory && folder.name.toLowerCase() === 'bestof');
      if (!bestOf) {
        this.copyPhotoStatus.set('BestOf folder not found.');
        return;
      }
      this.copyDestinationFolder.set(bestOf.path);
      this.copyPhotoStatus.set('');
      await this.refreshDestinationFileCount(bestOf.path);
    } catch (error) {
      this.copyPhotoStatus.set(error instanceof Error ? error.message : String(error));
    }
  };

  protected readonly copyPhoto = (): void => {
    const desktop = this.desktop;
    const destinationFolder = this.copyDestinationFolder();
    if (!desktop) return;
    if (!destinationFolder) {
      const message = 'Please select a destination folder before copying the image.';
      this.copyPhotoStatus.set(message);
      this.document.defaultView?.alert(message);
      return;
    }
    this.selectedImage$
      .pipe(take(1), filter(image => image !== null))
      .subscribe(image =>
        ConfirmationDialogComponent
          .open(this.dialog, {
            title: 'Copy image?',
            description: `Copy "${image.path}" to "${destinationFolder}"?`,
            confirmLabel: 'Copy',
            defaultAction: 'confirm'
          })
          .subscribe(async () => {
            const result = await desktop.FileSystem.copyFile(image.path, destinationFolder);
            if (!result.success) {
              this.copyDestinationFileCount.set(null);
              this.copyPhotoStatus.set(result.errorMessage);
              return;
            }

            this.copyPhotoStatus.set(`Copied to ${destinationFolder}`);
            await this.refreshDestinationFileCount(destinationFolder);
          })
      );
  };

  protected readonly deletePhoto = () => {
    this.selectedImage$
      .pipe(take(1), filter(image => image !== null))
      .subscribe(image =>
        ConfirmationDialogComponent
          .open(this.dialog, {
            title: 'Delete image?',
            description: `Do you want to permanently delete "${image.path}" from disk?`,
            defaultAction: 'cancel'
          })
          .subscribe(async () => {
            const deleted = await this.viewNavigator.deleteImage(image.path);

            if (!deleted) {
              this.document.defaultView?.alert('The image could not be deleted.');
            } else {
              await this.refreshSourceFileCount(image.path, true);
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
    if (this.histogramUsesCapturePreview()) return;
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

  private readonly copyLoupeValuesToClipboard = async (): Promise<void> => {
    const main = this.loupeHdrRgb();
    const capture = this.loupeCaptureRgb();
    const difference = this.loupeRgbDifference();
    const point = this.loupeSourcePoint();
    const dimensions = this.imageDimensions();
    const x = Math.max(0, Math.min(Math.max(0, dimensions.width - 1), Math.floor(point.x)));
    const y = Math.max(0, Math.min(Math.max(0, dimensions.height - 1), Math.floor(point.y)));
    const fmt = (value: number | null | undefined): string =>
      value === null || value === undefined || !Number.isFinite(value) ? '' : value.toFixed(6);
    const fields = [
      `x=${x}`,
      `y=${y}`,
      `main_scRGB_R=${fmt(main?.r)}`,
      `main_scRGB_G=${fmt(main?.g)}`,
      `main_scRGB_B=${fmt(main?.b)}`,
      `main_hex_R=${main?.rHex ?? ''}`,
      `main_hex_G=${main?.gHex ?? ''}`,
      `main_hex_B=${main?.bHex ?? ''}`,
      `capture_scRGB_R_x0.5=${fmt(capture ? capture.r * 0.5 : null)}`,
      `capture_scRGB_G_x0.5=${fmt(capture ? capture.g * 0.5 : null)}`,
      `capture_scRGB_B_x0.5=${fmt(capture ? capture.b * 0.5 : null)}`,
      `capture_hex_R=${capture?.rHex ?? ''}`,
      `capture_hex_G=${capture?.gHex ?? ''}`,
      `capture_hex_B=${capture?.bHex ?? ''}`,
      `delta_R=${fmt(difference?.r.delta)}`,
      `delta_G=${fmt(difference?.g.delta)}`,
      `delta_B=${fmt(difference?.b.delta)}`,
      `delta_percent_R=${fmt(difference?.r.percent)}`,
      `delta_percent_G=${fmt(difference?.g.percent)}`,
      `delta_percent_B=${fmt(difference?.b.percent)}`
    ];
    try {
      await this.document.defaultView?.navigator.clipboard.writeText(fields.join('\\t'));
    } catch (error) {
      console.error('Could not copy loupe pixel values to clipboard:', error);
    }
  };

  private readonly trackKeyboard = () => {
    // Capture Escape before the CDK dialog handles and closes the overlay.
    // The matching keyup must not also trigger the image-view back action.
    this.keyboard.keydown()
      .pipe(takeUntilDestroyed())
      .subscribe(event => {
        if (this.isPointerOverLocationMap &&
            (event.key === 'ArrowLeft' || event.key === 'ArrowRight' ||
             event.key === 'ArrowUp' || event.key === 'ArrowDown' ||
             event.key === '+' || event.key === '=' || event.key === 'Add' ||
             event.key === '-' || event.key === '_' || event.key === 'Subtract')) {
          event.preventDefault();
        }
        if (event.key === 'Escape' && this.dialog.openDialogs.length > 0) {
          this.escapePressedWhileDialogOpen = true;
        }
      });

    this.keyboard.keyup()
      .pipe(takeUntilDestroyed())
      .subscribe(event => {
        if (event.key === 'Escape' && this.escapePressedWhileDialogOpen) {
          this.escapePressedWhileDialogOpen = false;
          return;
        }

        if (event.key === 'Escape') {
          this.goBack();
          return;
        }

        // Arrow keys pan the GPS map only while the pointer is over it.
        // Disable Leaflet's built-in keyboard handler and pan explicitly so
        // the same keys never trigger image navigation in this situation.
        if (this.isPointerOverLocationMap &&
            (event.key === 'ArrowLeft' || event.key === 'ArrowRight' ||
             event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          event.preventDefault();
          event.stopPropagation();
          const horizontal = event.key === 'ArrowLeft' ? -80 : event.key === 'ArrowRight' ? 80 : 0;
          const vertical = event.key === 'ArrowUp' ? -80 : event.key === 'ArrowDown' ? 80 : 0;
          this.locationMapInstance?.panBy([horizontal, vertical], { animate: false });
          return;
        }

        // While the pointer is over the GPS map, +/- control map zoom instead
        // of changing the displayed image size. Outside the map they retain
        // their normal image zoom behavior.
        if (this.isPointerOverLocationMap &&
            (event.key === '+' || event.key === '=' || event.key === 'Add' ||
             event.key === '-' || event.key === '_' || event.key === 'Subtract')) {
          event.preventDefault();
          event.stopPropagation();
          const zoomIn = event.key === '+' || event.key === '=' || event.key === 'Add';
          this.adjustLocationMapZoom(zoomIn ? 1 : -1);
          return;
        }

        // Image navigation keys are global: they work regardless of which
        // control currently has focus, including selects and text inputs.
        if (event.key === ' ' || event.key === 'Spacebar' || event.key === 'Space' ||
            event.key === 'ArrowRight' || event.key === 'PageDown') {
          event.preventDefault();
          this.traceDebugSwitching(`key ${event.key}`);
          this.hasNext$
            .pipe(take(1), filter(flag => flag))
            .subscribe(() => this.nextPhoto());
          return;
        }

        if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
          event.preventDefault();
          this.traceDebugSwitching(`key ${event.key}`);
          this.hasPrevious$
            .pipe(take(1), filter(flag => flag))
            .subscribe(() => this.prevPhoto());
          return;
        }

        if ((event.shiftKey && event.key !== '+' && event.key !== '_') || event.ctrlKey || event.altKey || event.metaKey) {
          return;
        }

        const target = event.target;
        if (target instanceof HTMLElement && target.matches('input:not([type="checkbox"]), textarea, [contenteditable="true"]')) {
          return;
        }

        // Keep keyboard zoom shortcuts wired to the same actions as both sets of
        // on-screen zoom buttons. '+' may arrive as '=' on some keyboard layouts.
        if (event.key === '+' || event.key === '=' || event.key === 'Add') {
          event.preventDefault();
          this.zoomIn();
          return;
        }
        if (event.key === '-' || event.key === '_' || event.key === 'Subtract') {
          event.preventDefault();
          this.zoomOut();
          return;
        }

        if (event.key === 'v' || event.key === 'V') {
          this.cycleComparisonMode();
          return;
        }

        if (target instanceof HTMLSelectElement) {
          return;
        }

        if (event.key === 'c' || event.key === 'C' || event.key === 'F8') {
          event.preventDefault();
          this.copyPhoto();
          return;
        }

        if (event.key === 'm' || event.key === 'M') {
          event.preventDefault();
          // Toggle the actual loupe state, not just the sidebar section state.
          // These can diverge after restoring persisted sidebar preferences.
          const enabled = !this.loupeEnabled();
          const sections = { ...this.sidebarSections(), loupe: enabled };
          this.sidebarSections.set(sections);
          this.configuration.updateSystemConfig({ imageSidebarSections: sections });
          void this.toggleLoupe(enabled);
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

          case 'g':
            this.toggleSidebarSection('general');
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
  };
}
