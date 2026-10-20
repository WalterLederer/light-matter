import { Dialog } from '@angular/cdk/dialog';
import { AsyncPipe, DecimalPipe, DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
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
import { ExifTags, ImageHistogram } from 'internal-api';
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
import { FileNamePipe } from '../../pipes/file-name/file-name-pipe';
import { imageDynamicRange } from '../../utils/image-dynamic-range';
import { ImagePositioningService } from '../../services/image-positioning/image-positioning.service';
import {
  defaultImagePositioningResult,
  ImageDimensions
} from '../../services/image-positioning/image-positioning.types';
import { ViewNavigator } from '../../services/view-navigator/view-navigator';
import { AnimationState } from './image-view.types';

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
    FileNamePipe,
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

  private readonly document = inject(DOCUMENT);

  private readonly exif = inject(ExifService);

  private readonly histogram = inject(HistogramService);

  private readonly processManager = inject(ProcessManager);

  private readonly imagePositioningService = inject(ImagePositioningService);

  private readonly overlayService = inject(OverlayService);

  private readonly dialog = inject(Dialog);

  private readonly configuration = inject(Configuration);

  /* State */
  protected readonly selectedImage$ = this.viewNavigator.selectedImage();

  protected readonly hasPrevious$ = this.viewNavigator.hasPrevious();

  protected readonly hasNext$ = this.viewNavigator.hasNext();

  protected readonly imageLocation$ = this.imagePositioningService.imageLocation();

  protected readonly defaultImageLocation = defaultImagePositioningResult();

  protected readonly imageDimensions = signal<ImageDimensions>({ width: 0, height: 0 });

  protected readonly isDecoding = signal(false);

  protected readonly decodeDuration = signal<number | null>(null);

  protected readonly imageLoadFailed = signal(false);

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
      return { sdr: '', hdr: '', sdrRed: '', sdrGreen: '', sdrBlue: '', hdrRed: '', hdrGreen: '', hdrBlue: '' };
    }

    const maximum = Math.max(
      1,
      ...data.sdr,
      ...data.hdr,
      ...data.sdrRed,
      ...data.sdrGreen,
      ...data.sdrBlue,
      ...data.hdrRed,
      ...data.hdrGreen,
      ...data.hdrBlue
    );
    // Use one shared SDR X stretch for white and all three RGB curves so
    // their relative channel positions remain comparable.
    const sdrLastOccupiedBin = Math.max(
      1,
      ...data.sdr.map((count, index) => count > 0 ? index : 0),
      ...data.sdrRed.map((count, index) => count > 0 ? index : 0),
      ...data.sdrGreen.map((count, index) => count > 0 ? index : 0),
      ...data.sdrBlue.map((count, index) => count > 0 ? index : 0)
    );
    const makePath = (bins: number[], startX: number, endX: number, lastBin = bins.length - 1) =>
      bins.slice(0, lastBin + 1).map((count, index) => {
        const x = startX + index / Math.max(1, lastBin) * (endX - startX);
        const y = 148 - count / maximum * 140;
        return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      }).join(' ');

    return {
      sdr: makePath(data.sdr, 0, 248, sdrLastOccupiedBin),
      hdr: makePath(data.hdr, 264, 512),
      sdrRed: makePath(data.sdrRed, 0, 248, sdrLastOccupiedBin),
      sdrGreen: makePath(data.sdrGreen, 0, 248, sdrLastOccupiedBin),
      sdrBlue: makePath(data.sdrBlue, 0, 248, sdrLastOccupiedBin),
      hdrRed: makePath(data.hdrRed, 264, 512),
      hdrGreen: makePath(data.hdrGreen, 264, 512),
      hdrBlue: makePath(data.hdrBlue, 264, 512)
    };
  });

  protected readonly onHistogramMouseMove = (event: MouseEvent) => {
    const data = this.histogramData();
    const svg = event.currentTarget as SVGSVGElement | null;
    const bounds = svg?.getBoundingClientRect();

    if (data === null || bounds === undefined || bounds.width === 0) {
      return;
    }

    const x = Math.max(0, Math.min(512, (event.clientX - bounds.left) / bounds.width * 512));
    const isSdr = x < 256;
    const startX = isSdr ? 0 : 264;
    const endX = isSdr ? 248 : 512;
    const position = Math.max(0, Math.min(1, (x - startX) / (endX - startX)));
    const sdrLastOccupiedBin = Math.max(
      1,
      ...data.sdr.map((count, index) => count > 0 ? index : 0),
      ...data.sdrRed.map((count, index) => count > 0 ? index : 0),
      ...data.sdrGreen.map((count, index) => count > 0 ? index : 0),
      ...data.sdrBlue.map((count, index) => count > 0 ? index : 0)
    );
    const bin = Math.min(127, Math.round(position * (isSdr ? sdrLastOccupiedBin : 127)));
    const white = (isSdr ? data.sdr : data.hdr)[bin] ?? 0;
    const red = (isSdr ? data.sdrRed : data.hdrRed)[bin] ?? 0;
    const green = (isSdr ? data.sdrGreen : data.hdrGreen)[bin] ?? 0;
    const blue = (isSdr ? data.sdrBlue : data.hdrBlue)[bin] ?? 0;
    const formatCount = (value: number) => new Intl.NumberFormat().format(value);
    const domain = isSdr
      ? `SDR ${((bin + 0.5) / 128 * 100).toFixed(1)}%`
      : `HDR ≈ ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
        100 * Math.pow(100, (bin + 0.5) / 128)
      )} cd/m²`;

    this.histogramHoverStatus.set(
      `${domain} · White ${formatCount(white)} · R ${formatCount(red)} · G ${formatCount(green)} · B ${formatCount(blue)}`
    );
  };

  protected readonly onHistogramMouseLeave = () => this.histogramHoverStatus.set(null);

  protected readonly imageDynamicRange = imageDynamicRange;

  protected readonly exifVisible = signal(false);

  protected readonly exifState = signal<false | ExifTags>(false);

  protected readonly animationState = signal<AnimationState>('none');

  protected readonly zoomSlider = new FormControl(100, { nonNullable: true });

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
    this.trackKeyboard();

    this.selectedImage$
      .pipe(
        filter(image => image !== null),
        map(image => image.path),
        distinctUntilChanged(),
        tap(() => {
          this.imageBitDepth.set(null);
          this.imageTags.set(null);
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
      });

    this.zoomSlider
      .valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe(value => this.imagePositioningService.setZoom(value / 100));
  }

  /* Event handlers */
  protected readonly toggleFullScreen = async () => {
    if (this.document.fullscreenElement !== null) {
      await this.document.exitFullscreen();
    } else {
      await this.document.documentElement.requestFullscreen();
    }
  };

  protected readonly toggleHistogram = () => {
    if (this.histogramVisible()) {
      this.histogramVisible.set(false);
      this.histogramRequestId++;
      this.histogramLoading.set(false);
      return;
    }

    this.histogramVisible.set(true);
    this.selectedImage$
      .pipe(take(1), filter(image => image !== null))
      .subscribe(image => this.loadHistogram(image.path));
  };

  protected readonly closeHistogram = () => {
    this.histogramVisible.set(false);
    this.histogramRequestId++;
    this.histogramLoading.set(false);
  };

  protected readonly goBack = () => {
    if (this.viewNavigator.standalone()) {
      this.processManager.quit(0).then();
    } else {
      this.overlayService.hide();
    }
  };

  protected readonly fitToWindow = () => this.imagePositioningService.setZoom('fit');

  protected readonly toggleExifInfo = async (path: string) => {
    this.exifState.set(false);

    const exifVisible = !this.exifVisible();
    this.exifVisible.set(exifVisible);

    if (exifVisible) {
      const response = await this.exif.read(path);

      if (response.success) {
        this.exifState.set(response.data);
      }
    }
  };

  protected readonly prevPhoto = () => {
    this.exifVisible.set(false);
    this.exifState.set(false);
    this.viewNavigator.previous();
  };

  protected readonly nextPhoto = () => {
    this.exifVisible.set(false);
    this.exifState.set(false);
    this.viewNavigator.next();
  };

  protected readonly deletePhoto = () => {
    this.selectedImage$
      .pipe(take(1), filter(image => image !== null))
      .subscribe(image =>
        ConfirmationDialogComponent
          .open(this.dialog, {
            title: 'Bild löschen?',
            description: `Möchtest du „${image.path}“ dauerhaft von der Festplatte löschen?`
          })
          .subscribe(async () => {
            const deleted = await this.viewNavigator.deleteImage(image.path);

            if (!deleted) {
              this.document.defaultView?.alert('Das Bild konnte nicht gelöscht werden.');
            }
          })
      );
  };

  protected readonly onAnimationEnd = (event: AnimationEvent) => {
    const split = event.animationName.split('animation-');

    if (split.length < 2) {
      return;
    }

    const name = split[1];

    switch (name) {
      case 'leave-left':
        this.viewNavigator.previous();
        this.animationState.set('enter-left');
        break;
      case 'enter-left':
        this.animationState.set('none');
        break;
      case 'leave-right':
        this.viewNavigator.next();
        this.animationState.set('enter-right');
        break;
      case 'enter-right':
        this.animationState.set('none');
        break;
      default:
        this.animationState.set('none');
        break;
    }
  };

  protected readonly onMouseWheel = (event: WheelEvent) => {
    event.preventDefault();

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
  private readonly calculateWheelZoom = (deltaY: number, currentZoom: number, zoomStep: number): number => {
    if (deltaY < 0) {
      return Math.min(currentZoom + zoomStep, this.zoomConfig.max);
    }

    if (deltaY > 0) {
      return Math.max(currentZoom - zoomStep, this.zoomConfig.min);
    }

    return currentZoom;
  };

  private readonly getBitDepth = (tags: ExifTags): string | null => {
    const bits = tags.BitsPerSample ?? tags.BitDepth;
    if (bits !== undefined) {
      return `${bits}-bit`;
    }

    return tags.ImagePixelDepth ?? null;
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
        if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
          return;
        }

        const target = event.target;
        if (target instanceof HTMLElement && target.matches('input, textarea, select, [contenteditable="true"]')) {
          return;
        }

        switch (event.key) {
          case 'e':
          case 'E':
            this.selectedImage$
              .pipe(take(1), filter(image => image !== null))
              .subscribe(image => this.toggleExifInfo(image.path));
            break;

          case 'h':
          case 'H':
            this.toggleHistogram();
            break;

          case 'ArrowLeft':
            this.hasPrevious$
              .pipe(
                take(1),
                filter(flag => flag)
              )
              .subscribe(() => this.prevPhoto());
            break;

          case 'ArrowRight':
            this.hasNext$
              .pipe(
                take(1),
                filter(flag => flag)
              )
              .subscribe(() => this.nextPhoto());
            break;

          case 'Escape':
            this.goBack();
            break;

          case 'Delete':
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
