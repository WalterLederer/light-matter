import { ChangeDetectionStrategy, Component, DestroyRef, effect, ElementRef, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CaptureFormat, CaptureMonitor, CapturePreview, CaptureTarget, CaptureWindow } from 'internal-api';
import { filter, firstValueFrom, take } from 'rxjs';
import { CaptureService } from '../../../ipc/capture';
import { GalleryLocations } from '../../../gallery/services/gallery-locations/gallery-locations';
import { GalleryState } from '../../../gallery/services/gallery-state/gallery-state';
import { ViewNavigator } from '../../../viewer/services/view-navigator/view-navigator';

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

  protected readonly expanded = signal(true);
  protected readonly monitors = signal<CaptureMonitor[]>([]);
  protected readonly windows = signal<CaptureWindow[]>([]);
  protected readonly selectedTarget = signal('monitor:1');
  protected readonly destinationFolder = signal('');
  protected readonly loadingSources = signal(false);
  protected readonly capturing = signal(false);
  protected readonly previewing = signal(false);
  protected readonly previewFrame = signal<CapturePreview | null>(null);
  protected readonly previewSize = signal('');
  protected readonly previewCanvas = viewChild<ElementRef<HTMLCanvasElement>>('previewCanvas');
  private previewDevice: GPUDevice | null = null;
  private previewTexture: GPUTexture | null = null;
  private previewContext: GPUCanvasContext | null = null;
  protected readonly selectedFormat = signal<CaptureFormat>('exr');
  protected readonly status = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly toggleExpanded = (): void => this.expanded.update(value => !value);
  protected readonly changeTarget = (value: string): void => {
    this.selectedTarget.set(value);
    this.previewFrame.set(null);
    this.previewSize.set('');
    this.status.set('');
    this.error.set(null);
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
      if (sources.sourceErrors?.length) {
        this.error.set(sources.sourceErrors.join('\n'));
      }
      if (!sources.monitors.some(monitor => this.selectedTarget() === `monitor:${monitor.index}`) &&
          !sources.windows.some(window => this.selectedTarget() === `window:${window.handle}`)) {
        const firstMonitor = sources.monitors[0];
        const firstWindow = sources.windows[0];
        this.selectedTarget.set(firstMonitor ? `monitor:${firstMonitor.index}` : firstWindow ? `window:${firstWindow.handle}` : '');
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loadingSources.set(false);
    }
  };

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
    this.previewing.set(true);
    this.error.set(null);
    this.status.set('Capturing source preview…');
    try {
      const preview = await this.captureService.preview(target);
      this.previewFrame.set(preview);
      this.previewSize.set(`${preview.width} × ${preview.height}`);
      this.status.set(`Preview ready · ${preview.width} × ${preview.height}`);
    } catch (error) {
      this.previewFrame.set(null);
      this.status.set('');
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.previewing.set(false);
    }
  };


  private readonly renderHdrPreview = async (canvas: HTMLCanvasElement, frame: CapturePreview): Promise<void> => {
    try {
      if (!navigator.gpu) throw new Error('WebGPU is unavailable; HDR preview cannot be displayed.');
      this.disposeHdrPreview();
      canvas.width = frame.width;
      canvas.height = frame.height;
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('No WebGPU adapter is available for the HDR preview.');
      const device = await adapter.requestDevice();
      const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
      if (!context) {
        device.destroy();
        throw new Error('Could not create a WebGPU canvas for the HDR preview.');
      }
      context.configure({
        device,
        format: 'rgba16float',
        colorSpace: 'srgb',
        alphaMode: 'opaque',
        toneMapping: { mode: 'extended' }
      });
      const texture = device.createTexture({
        size: { width: frame.width, height: frame.height },
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });
      device.queue.writeTexture(
        { texture },
        frame.pixels,
        { bytesPerRow: frame.width * 8, rowsPerImage: frame.height },
        { width: frame.width, height: frame.height, depthOrArrayLayers: 1 }
      );
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
      const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: shader, entryPoint: 'vs' },
        fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
        primitive: { topology: 'triangle-list' }
      });
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: texture.createView() }]
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store'
        }]
      });
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
      // Refresh the folder from disk so the capture appears in the gallery and
      // becomes part of the current image-navigation sequence immediately.
      this.galleryLocations.addLocation(folder);
      await firstValueFrom(this.galleryState.navigateTo(folder).pipe(take(1)));
      await firstValueFrom(this.viewNavigator.selectImage(result.path).pipe(take(1)));
      this.status.set(`Saved ${result.width} × ${result.height} HDR · ${result.path}`);
    } catch (error) {
      this.status.set('');
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.capturing.set(false);
    }
  };
}
