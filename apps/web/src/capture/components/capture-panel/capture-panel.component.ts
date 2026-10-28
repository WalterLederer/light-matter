import { ChangeDetectionStrategy, Component, DestroyRef, effect, ElementRef, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CaptureFormat, CaptureMonitor, CapturePreview, CaptureTarget, CaptureWindow } from 'internal-api';
import { filter, firstValueFrom, take } from 'rxjs';
import { CaptureService } from '../../../ipc/capture';
import { GalleryLocations } from '../../../gallery/services/gallery-locations/gallery-locations';
import { GalleryState } from '../../../gallery/services/gallery-state/gallery-state';
import { ViewNavigator } from '../../../viewer/services/view-navigator/view-navigator';

type CaptureSourceRow = {
  value: string;
  kind: 'monitor' | 'window';
  favoriteKey: string;
  favorite: boolean;
  exe: string;
  title: string;
  size: string;
  status: string;
};

@Component({
  selector: 'app-capture-panel',
  templateUrl: './capture-panel.component.html',
  styleUrl: './capture-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CapturePanelComponent {
  private readonly captureService = inject(CaptureService);
  private readonly galleryState = inject(GalleryState);
  private readonly galleryLocations = inject(GalleryLocations);
  private readonly viewNavigator = inject(ViewNavigator);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly monitors = signal<CaptureMonitor[]>([]);
  protected readonly windows = signal<CaptureWindow[]>([]);
  protected readonly selectedTarget = signal('monitor:1');
  protected readonly sourceMenuOpen = signal(false);
  protected readonly favoriteKeys = signal<string[]>(this.readFavoriteKeys());
  protected readonly destinationFolder = signal('');
  protected readonly loadingSources = signal(false);
  protected readonly capturing = signal(false);
  protected readonly previewing = signal(false);
  protected readonly previewFrame = signal<CapturePreview | null>(null);
  protected readonly previewSize = signal('');
  protected readonly previewCanvas = viewChild<ElementRef<HTMLCanvasElement>>('previewCanvas');
  private previewDevice: { destroy(): void } | null = null;
  private previewTexture: { destroy(): void } | null = null;
  private previewContext: { unconfigure(): void; configure(options: any): void; getCurrentTexture(): any } | null = null;
  private previewRequestId = 0;
  protected readonly selectedFormat = signal<CaptureFormat>('exr');
  protected readonly status = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly lastOutputPath = signal('');

  protected readonly sourceRows = (): CaptureSourceRow[] => {
    const favorites = new Set(this.favoriteKeys());
    const monitors: CaptureSourceRow[] = this.monitors().map(monitor => {
      const value = `monitor:${monitor.index}`;
      const favoriteKey = value;
      return {
        value, kind: 'monitor', favoriteKey, favorite: favorites.has(favoriteKey),
        exe: 'Monitor',
        title: monitor.name || monitor.deviceName || `Monitor ${monitor.index}`,
        size: `${monitor.width} × ${monitor.height}`,
        status: monitor.refreshRate ? `${monitor.refreshRate} Hz` : ''
      };
    });
    const windows: CaptureSourceRow[] = this.windows().map(window => {
      const value = `window:${window.handle}`;
      const executablePath = (window.executablePath ?? window.processName ?? 'Unknown executable').trim();
      const favoriteKey = `window:${executablePath.toLowerCase()}|${window.title.trim().toLowerCase()}`;
      return {
        value, kind: 'window', favoriteKey, favorite: favorites.has(favoriteKey),
        exe: this.windowExecutableName(window),
        title: window.title,
        size: `${window.width} × ${window.height}`,
        status: window.isMinimized ? '[Minimized]' : ''
      };
    });
    return [...monitors, ...windows].sort((a, b) =>
      Number(b.favorite) - Number(a.favorite) ||
      a.exe.localeCompare(b.exe, undefined, { sensitivity: 'base' }) ||
      a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    );
  };

  protected readonly toggleSourceMenu = (): void => {
    this.sourceMenuOpen.update(open => !open);
  };

  protected readonly selectSourceRow = (value: string): void => {
    this.sourceMenuOpen.set(false);
    this.changeTarget(value);
  };

  protected readonly toggleFavorite = (row: CaptureSourceRow, event: MouseEvent): void => {
    event.stopPropagation();
    const next = new Set(this.favoriteKeys());
    if (next.has(row.favoriteKey)) next.delete(row.favoriteKey);
    else next.add(row.favoriteKey);
    const keys = [...next];
    this.favoriteKeys.set(keys);
    try { localStorage.setItem('capture.source.favorites', JSON.stringify(keys)); }
    catch { /* keep the current-session preference if storage is unavailable */ }
  };

  private readFavoriteKeys(): string[] {
    try {
      const value: unknown = JSON.parse(localStorage.getItem('capture.source.favorites') ?? '[]');
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    } catch { return []; }
  }

  protected readonly selectedSourceLabel = (): string => {
    const target = this.selectedCaptureTarget();
    if (!target) return 'None';
    if (target.kind === 'monitor') {
      const monitor = this.monitors().find(item => item.index === target.index);
      return monitor
        ? `Monitor ${monitor.index} · ${monitor.name || monitor.deviceName || 'Unknown monitor'} · ${monitor.width} × ${monitor.height}${monitor.refreshRate ? ` · ${monitor.refreshRate} Hz` : ''}`
        : `Monitor ${target.index}`;
    }
    const window = this.windows().find(item => item.handle === target.handle);
    return window
      ? `${this.windowExecutableName(window)} · ${window.title} · ${window.width} × ${window.height}`
      : `Window ${target.handle}`;
  };

  protected readonly windowExecutableName = (window: CaptureWindow): string => {
    const path = (window.executablePath ?? '').trim();
    const executable = path.split(/[\\/]/).pop()?.trim();
    const processName = (window.processName ?? '').trim();
    // Some capture backends return a placeholder instead of the real executable.
    // Never show the bare "Windows application -" prefix as if it were a filename.
    const usable = (value: string | undefined): value is string =>
      !!value && !/^Windows application\s*-?\s*$/i.test(value) && value !== 'Unknown executable';
    if (usable(executable)) return executable;
    if (usable(processName)) return processName;
    return 'Unknown executable';
  };
  protected readonly changeTarget = (value: string): void => {
    this.disposeHdrPreview();
    this.selectedTarget.set(value);
    this.sourceMenuOpen.set(false);
    this.previewFrame.set(null);
    this.previewSize.set('');
    this.status.set('');
    this.error.set(null);
    this.lastOutputPath.set('');
    void this.previewNow();
  };

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

    this.destroyRef.onDestroy(() => this.disposeHdrPreview());
    effect(() => {
      const frame = this.previewFrame();
      const canvas = this.previewCanvas()?.nativeElement;
      if (frame && canvas) void this.renderHdrPreview(canvas, frame);
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
      if (sources.sourceErrors?.length) this.error.set(sources.sourceErrors.join('\n'));
      const saved = this.readSavedSource();
      let restored = false;
      if (saved?.kind === 'monitor' && sources.monitors.some(item => item.index === saved.index)) {
        this.selectedTarget.set(`monitor:${saved.index}`);
        restored = true;
      } else if (saved?.kind === 'window') {
        const matchingWindow = sources.windows.find(item => item.executablePath && item.executablePath.toLowerCase() === saved.executablePath.toLowerCase());
        if (matchingWindow) {
          this.selectedTarget.set(`window:${matchingWindow.handle}`);
          restored = true;
        }
      }
      if (!restored && !sources.monitors.some(monitor => this.selectedTarget() === `monitor:${monitor.index}`) &&
          !sources.windows.some(window => this.selectedTarget() === `window:${window.handle}`)) {
        const firstMonitor = sources.monitors[0];
        const firstWindow = sources.windows[0];
        this.selectedTarget.set(firstMonitor ? `monitor:${firstMonitor.index}` : firstWindow ? `window:${firstWindow.handle}` : '');
      }
      if (this.selectedTarget()) void this.previewNow();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loadingSources.set(false);
    }
  };

  private readSavedSource(): { kind: 'monitor'; index: number } | { kind: 'window'; executablePath: string } | null {
    try {
      const value = JSON.parse(localStorage.getItem('capture.source') ?? 'null');
      if (value?.kind === 'monitor' && Number.isSafeInteger(value.index)) return value;
      if (value?.kind === 'window' && typeof value.executablePath === 'string') return value;
    } catch { /* ignore invalid saved preference */ }
    return null;
  }

  private saveSelectedSource(): void {
    const target = this.selectedCaptureTarget();
    if (!target) return;
    if (target.kind === 'monitor') {
      localStorage.setItem('capture.source', JSON.stringify({ kind: 'monitor', index: target.index }));
      return;
    }
    const window = this.windows().find(item => item.handle === target.handle);
    if (window?.executablePath) {
      localStorage.setItem('capture.source', JSON.stringify({ kind: 'window', executablePath: window.executablePath }));
    }
  }

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

  protected readonly previewNow = async (): Promise<void> => {
    const target = this.selectedCaptureTarget();
    if (!target) {
      this.error.set('Select a monitor or application window.');
      return;
    }
    const requestId = ++this.previewRequestId;
    this.previewing.set(true);
    this.error.set(null);
    this.status.set('Capturing source preview…');
    try {
      const preview = await this.captureService.preview(target);
      if (requestId !== this.previewRequestId) return;
      this.previewFrame.set(preview);
      this.previewSize.set(`${preview.width} × ${preview.height}`);
      this.status.set(`Preview ready · ${preview.width} × ${preview.height}`);
      this.saveSelectedSource();
    } catch (error) {
      if (requestId !== this.previewRequestId) return;
      this.previewFrame.set(null);
      this.status.set('');
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === this.previewRequestId) this.previewing.set(false);
    }
  };

  private readonly renderHdrPreview = async (canvas: HTMLCanvasElement, frame: CapturePreview): Promise<void> => {
    try {
      const gpu = (navigator as Navigator & { gpu?: any }).gpu;
      if (!gpu) throw new Error('WebGPU is unavailable; HDR preview cannot be displayed.');
      this.disposeHdrPreview();
      canvas.width = frame.width;
      canvas.height = frame.height;
      const adapter = await gpu.requestAdapter();
      if (!adapter) throw new Error('No WebGPU adapter is available for the HDR preview.');
      const device: any = await adapter.requestDevice();
      const context = canvas.getContext('webgpu') as any;
      if (!context) {
        device.destroy();
        throw new Error('Could not create a WebGPU canvas for the HDR preview.');
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
        struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
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
      this.previewDevice = device;
      this.previewTexture = texture;
      this.previewContext = context;
      this.status.set(`HDR preview ready · ${frame.width} × ${frame.height} · WebGPU FP16/scRGB`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.error.set(message);
      console.error('[HDR Capture] WebGPU preview failed:', error);
    }
  };

  private readonly disposeHdrPreview = (): void => {
    try { this.previewContext?.unconfigure(); } catch { /* already unconfigured */ }
    this.previewTexture?.destroy();
    this.previewDevice?.destroy();
    this.previewTexture = null;
    this.previewDevice = null;
    this.previewContext = null;
  };

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
      const result = await this.captureService.capture(target, folder, this.selectedFormat());
      this.galleryLocations.addLocation(folder);
      await firstValueFrom(this.galleryState.navigateTo(folder).pipe(take(1)));
      await firstValueFrom(this.viewNavigator.selectImage(result.path).pipe(take(1)));
      this.lastOutputPath.set(result.path);
      this.status.set(`Saved ${result.width} × ${result.height} HDR · ${result.path}`);
    } catch (error) {
      this.status.set('');
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.capturing.set(false);
    }
  };
}
