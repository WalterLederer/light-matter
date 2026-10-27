// @ts-nocheck -- WebGPU declarations are not included in the project's DOM type library yet.
/** Small HDR loupe renderer using captured FP16/scRGB samples. */
export interface HdrLoupeRegion {
  width: number;
  height: number;
  /** Cursor position within the clipped source region. */
  centerX: number;
  centerY: number;
  /** Packed RGBA half-float channel bit patterns, row-major. */
  data: Uint16Array;
}

export class HdrLoupeRenderer {
  private static brightnessReadbackTestDone = false;
  private device: GPUDevice | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private sourceTexture: GPUTexture | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private canvasContext: GPUCanvasContext | null = null;
  private configuredCanvas: HTMLCanvasElement | null = null;
  private sourceWidth = 0;
  private sourceHeight = 0;
  private renderQueue: Promise<void> = Promise.resolve();

  render(canvas: HTMLCanvasElement, region: HdrLoupeRegion, brightness: number, zoom: number): Promise<void> {
    const task = this.renderQueue.then(() => this.renderInternal(canvas, region, brightness, zoom));
    this.renderQueue = task.catch(() => undefined);
    return task;
  }

  private async renderInternal(canvas: HTMLCanvasElement, region: HdrLoupeRegion, brightness: number, zoom: number): Promise<void> {
    const viewport = canvas.parentElement;
    const outputWidth = Math.max(1, Math.round(viewport?.clientWidth ?? canvas.clientWidth ?? 280));
    const outputHeight = Math.max(1, Math.round(viewport?.clientHeight ?? canvas.clientHeight ?? 280));
    if (canvas.width !== outputWidth) canvas.width = outputWidth;
    if (canvas.height !== outputHeight) canvas.height = outputHeight;
    await this.initialize(canvas);
    const device = this.device!;
    if (!this.sourceTexture || this.sourceWidth !== region.width || this.sourceHeight !== region.height) {
      this.sourceTexture?.destroy();
      this.sourceTexture = device.createTexture({
        size: { width: region.width, height: region.height },
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });
      this.sourceWidth = region.width;
      this.sourceHeight = region.height;
    }

    const packed = region.data;
    device.queue.writeTexture(
      { texture: this.sourceTexture },
      packed,
      { bytesPerRow: region.width * 8, rowsPerImage: region.height },
      { width: region.width, height: region.height, depthOrArrayLayers: 1 }
    );

    device.queue.writeBuffer(this.uniformBuffer!, 0, new Float32Array([brightness, zoom, outputWidth, outputHeight, region.centerX, region.centerY, 0, 0]));
    const bindGroup = device.createBindGroup({
      layout: this.pipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sourceTexture.createView() },
        { binding: 1, resource: { buffer: this.uniformBuffer! } }
      ]
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.canvasContext!.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  private async initialize(canvas: HTMLCanvasElement): Promise<void> {
    if (this.device && this.configuredCanvas === canvas) return;
    // The HDR pixel swatch lives inside a conditional Angular block. When the
    // sample disappears (mouse leaves / loupe toggles), Angular removes that
    // canvas and creates a new one on the next sample. A WebGPU context belongs
    // to its original canvas, so release it before initializing the replacement.
    if (this.device || this.configuredCanvas || this.canvasContext) this.dispose();
    if (!navigator.gpu) throw new Error('WebGPU is unavailable. CSS mode must be selected explicitly.');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter is available.');
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!context) {
      device.destroy();
      throw new Error('Unable to create a WebGPU canvas context.');
    }

    // Browser WebGPU's extended-range canvas uses extended *sRGB-encoded*
    // values, not linear scRGB. The WGC capture is linear scRGB, so the shader
    // must encode its output with the extended sRGB transfer function.
    const requestedCanvasConfiguration = {
      device,
      format: 'rgba16float',
      colorSpace: 'srgb',
      alphaMode: 'opaque',
      toneMapping: { mode: 'extended' as const }
    };
    context.configure(requestedCanvasConfiguration);
    console.info('[HDR loupe WebGPU canvas configuration]', {
      requested: {
        format: requestedCanvasConfiguration.format,
        colorSpace: requestedCanvasConfiguration.colorSpace,
        toneMapping: requestedCanvasConfiguration.toneMapping,
        alphaMode: requestedCanvasConfiguration.alphaMode
      },
      actual: context.getConfiguration()
    });

    const module = device.createShaderModule({
      code: `
        struct Params { brightness: f32, zoom: f32, outputWidth: f32, outputHeight: f32, centerX: f32, centerY: f32, _pad0: f32, _pad1: f32 };
        @group(0) @binding(0) var imageTexture: texture_2d<f32>;
        @group(0) @binding(1) var<uniform> params: Params;

        struct VertexOutput {
          @builtin(position) position: vec4<f32>,
          @location(0) uv: vec2<f32>,
        };

        @vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOutput {
          var positions = array<vec2<f32>, 3>(
            vec2<f32>(-1.0, -1.0),
            vec2<f32>( 3.0, -1.0),
            vec2<f32>(-1.0,  3.0)
          );
          var output: VertexOutput;
          let position = positions[index];
          output.position = vec4<f32>(position, 0.0, 1.0);
          output.uv = vec2<f32>((position.x + 1.0) * 0.5, (1.0 - position.y) * 0.5);
          return output;
        }

        // WebGPU extended-sRGB canvases expect extended sRGB-encoded output.
        // This transfer function intentionally also handles values above 1.0,
        // preserving highlights from the linear scRGB capture.
        fn linearToExtendedSrgb(value: f32) -> f32 {
          if (value <= 0.0031308) {
            return value * 12.92;
          }
          return 1.055 * pow(value, 1.0 / 2.4) - 0.055;
        }

        @fragment fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
          let dims = vec2<i32>(textureDimensions(imageTexture));
          // Select the source span needed for the actual viewport dimensions
          // at the requested magnification, independent of how
          // much extra safety margin was copied around the cursor. The capture
          // crop is deliberately enlarged at low zoom so this span stays inside
          // the texture and edge pixels are not stretched by coordinate clamping.
          let sourceSpan = vec2<f32>(params.outputWidth, params.outputHeight) / max(params.zoom, 0.01);
          let sourcePosition = vec2<f32>(params.centerX, params.centerY)
            + (input.uv - vec2<f32>(0.5)) * sourceSpan;
          // Never clamp out-of-crop coordinates to the nearest edge pixel:
          // that creates visible streaks along ruler edges at low magnification.
          if (sourcePosition.x < 0.0 || sourcePosition.y < 0.0
            || sourcePosition.x >= f32(dims.x) || sourcePosition.y >= f32(dims.y)) {
            return vec4<f32>(0.0, 0.0, 0.0, 1.0);
          }
          let coords = vec2<i32>(floor(sourcePosition));
          // Apply brightness in linear light, then encode to extended sRGB for
          // the browser canvas. The canvas's extended tone mapping preserves
          // encoded values above 1.0 for HDR output when supported.
          let linearColor = textureLoad(imageTexture, coords, 0).rgb * params.brightness;
          let encodedColor = vec3<f32>(
            linearToExtendedSrgb(linearColor.r),
            linearToExtendedSrgb(linearColor.g),
            linearToExtendedSrgb(linearColor.b)
          );
          return vec4<f32>(encodedColor, 1.0);
        }
      `
    });
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' }
    });

    this.device = device;
    this.pipeline = pipeline;
    this.uniformBuffer = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.canvasContext = context;
    this.configuredCanvas = canvas;

    // Run once per renderer class lifetime. This reads back the actual FP16
    // fragment-shader output for a fixed sample at brightness 1.0 and 0.4.
    // It verifies shader math/output encoding, not Windows' final display output.
    if (!HdrLoupeRenderer.brightnessReadbackTestDone) {
      HdrLoupeRenderer.brightnessReadbackTestDone = true;
      await this.runBrightnessReadbackTest();
    }
  }

  private async runBrightnessReadbackTest(): Promise<void> {
    const device = this.device;
    const pipeline = this.pipeline;
    if (!device || !pipeline || !this.uniformBuffer) return;

    const inputLinear = [0.65771484375, 0.55712890625, 0.5078125];
    const packedInput = new Uint16Array([0x3943, 0x3875, 0x3810, 0x3c00]);
    const source = device.createTexture({
      size: { width: 1, height: 1 },
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    const output = device.createTexture({
      size: { width: 1, height: 1 },
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
    });
    const readback = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });

    try {
      device.queue.writeTexture(
        { texture: source },
        packedInput,
        { bytesPerRow: 8, rowsPerImage: 1 },
        { width: 1, height: 1, depthOrArrayLayers: 1 }
      );
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: source.createView() },
          { binding: 1, resource: { buffer: this.uniformBuffer } }
        ]
      });

      const results: Array<Record<string, unknown>> = [];
      for (const brightness of [1.0, 0.4]) {
        device.queue.writeBuffer(this.uniformBuffer, 0, new Float32Array([brightness, 1, 1, 1, 0, 0, 0, 0]));
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: output.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store'
          }]
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
        encoder.copyTextureToBuffer(
          { texture: output },
          { buffer: readback, bytesPerRow: 256, rowsPerImage: 1 },
          { width: 1, height: 1, depthOrArrayLayers: 1 }
        );
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const words = new Uint16Array(readback.getMappedRange().slice(0, 8));
        const actual = Array.from(words.slice(0, 3), HdrLoupeRenderer.halfToFloat);
        readback.unmap();

        const expected = inputLinear.map(value => HdrLoupeRenderer.linearToExtendedSrgbCpu(value * brightness));
        results.push({
          brightness,
          actualFp16Hex: Array.from(words.slice(0, 3), value => '0x' + value.toString(16).padStart(4, '0')).join(' '),
          actualEncodedSrgb: actual,
          expectedEncodedSrgb: expected,
          maxAbsoluteError: Math.max(...actual.map((value, index) => Math.abs(value - expected[index])))
        });
      }
      console.info('[HDR loupe GPU brightness readback test]', {
        sourceLinearScRgb: inputLinear,
        results,
        interpretation: 'Compares actual FP16 fragment output against CPU extended-sRGB encoding; does not measure final Windows/compositor/display output.'
      });
    } catch (error) {
      console.warn('[HDR loupe GPU brightness readback test] failed', error);
    } finally {
      if (readback.mapState === 'mapped') readback.unmap();
      source.destroy();
      output.destroy();
      readback.destroy();
    }
  }

  private static linearToExtendedSrgbCpu(value: number): number {
    return value <= 0.0031308
      ? value * 12.92
      : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
  }

  private static halfToFloat(value: number): number {
    const sign = (value & 0x8000) ? -1 : 1;
    const exponent = (value >>> 10) & 0x1f;
    const fraction = value & 0x03ff;
    if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
    if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : NaN;
    return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
  }

  dispose(): void {
    // Unconfigure before destroying the device, especially when Angular has
    // detached the old conditional canvas and a replacement will be rendered.
    try {
      this.canvasContext?.unconfigure();
    } catch {
      // A lost or already-unconfigured context needs no further cleanup.
    }
    this.sourceTexture?.destroy();
    this.uniformBuffer?.destroy();
    this.device?.destroy();
    this.device = null;
    this.pipeline = null;
    this.sourceTexture = null;
    this.uniformBuffer = null;
    this.canvasContext = null;
    this.configuredCanvas = null;
    this.sourceWidth = 0;
    this.sourceHeight = 0;
  }
}


/**
 * Full-frame brightness renderer for the main image.
 *
 * The captured FP16 source is uploaded only when sourceKey changes. Brightness
 * updates modify a uniform, never the captured pixels or source texture.
 * This class is intentionally separate from HdrLoupeRenderer so loupe behavior
 * and its crop/zoom semantics remain unchanged.
 */
export class HdrImageBrightnessRenderer {
  private device: GPUDevice | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private sourceTexture: GPUTexture | null = null;
  private sdrSourceTexture: GPUTexture | null = null;
  private sdrSourceKey: string | number | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private context: GPUCanvasContext | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private sourceKey: string | number | null = null;
  private sourceWidth = 0;
  private sourceHeight = 0;
  private queue: Promise<void> = Promise.resolve();

  render(
    canvas: HTMLCanvasElement,
    region: HdrLoupeRegion,
    sdrPixels: Uint8Array,
    brightness: number,
    sourceKey: string | number,
    adjustments: { contrast: number; red: number; green: number; blue: number; invertRed?: boolean; invertGreen?: boolean; invertBlue?: boolean; invertAll?: boolean; saturation: number; blackPoint: number; whitePoint: number; highlightHdrPixels?: boolean; hdrHighlightThreshold?: number; highlightSdrOverexposure?: boolean; sdrOverexposureThreshold?: number; highlightSdrUnderexposure?: boolean; sdrUnderexposureThreshold?: number } = { contrast: 1, red: 1, green: 1, blue: 1, saturation: 1, blackPoint: 0, whitePoint: 1, highlightHdrPixels: false, hdrHighlightThreshold: 1, highlightSdrOverexposure: false, sdrOverexposureThreshold: 255, highlightSdrUnderexposure: false, sdrUnderexposureThreshold: 16 }
  ): Promise<void> {
    const task = this.queue.then(() => this.renderInternal(canvas, region, sdrPixels, brightness, sourceKey, adjustments));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async renderInternal(
    canvas: HTMLCanvasElement,
    region: HdrLoupeRegion,
    sdrPixels: Uint8Array,
    brightness: number,
    sourceKey: string | number,
    adjustments: { contrast: number; red: number; green: number; blue: number; invertRed?: boolean; invertGreen?: boolean; invertBlue?: boolean; invertAll?: boolean; saturation: number; blackPoint: number; whitePoint: number; highlightHdrPixels?: boolean; hdrHighlightThreshold?: number; highlightSdrOverexposure?: boolean; sdrOverexposureThreshold?: number; highlightSdrUnderexposure?: boolean; sdrUnderexposureThreshold?: number }
  ): Promise<void> {
    const width = Math.max(1, Math.round(canvas.clientWidth || canvas.parentElement?.clientWidth || region.width));
    const height = Math.max(1, Math.round(canvas.clientHeight || canvas.parentElement?.clientHeight || region.height));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    await this.initialize(canvas);
    const device = this.device!;

    const replaceSource = !this.sourceTexture
      || this.sourceKey !== sourceKey
      || this.sourceWidth !== region.width
      || this.sourceHeight !== region.height;
    if (replaceSource) {
      this.sourceTexture?.destroy();
      this.sourceTexture = device.createTexture({
        size: { width: region.width, height: region.height },
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });
      device.queue.writeTexture(
        { texture: this.sourceTexture },
        region.data,
        { bytesPerRow: region.width * 8, rowsPerImage: region.height },
        { width: region.width, height: region.height, depthOrArrayLayers: 1 }
      );
      this.sourceKey = sourceKey;
      this.sourceWidth = region.width;
      this.sourceHeight = region.height;
    }

    // Upload original 8-bit SDR values independently of the FP16/scRGB capture.
    if (!this.sdrSourceTexture || this.sdrSourceKey !== sourceKey) {
      this.sdrSourceTexture?.destroy();
      this.sdrSourceTexture = device.createTexture({
        size: { width: region.width, height: region.height },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });
      if (sdrPixels.length !== region.width * region.height * 4) {
        throw new Error('SDR pixel buffer dimensions do not match the HDR capture region.');
      }
      device.queue.writeTexture(
        { texture: this.sdrSourceTexture },
        sdrPixels,
        { bytesPerRow: region.width * 4, rowsPerImage: region.height },
        { width: region.width, height: region.height, depthOrArrayLayers: 1 }
      );
      this.sdrSourceKey = sourceKey;
    }

    device.queue.writeBuffer(this.uniformBuffer!, 0, new Float32Array([
      brightness, adjustments.contrast, adjustments.red, adjustments.green,
      adjustments.blue, adjustments.saturation, adjustments.blackPoint, adjustments.whitePoint,
      adjustments.highlightHdrPixels ? 1 : 0, 1, 0, 1,
      adjustments.hdrHighlightThreshold ?? 1,
      adjustments.invertRed ? 1 : 0, adjustments.invertGreen ? 1 : 0, adjustments.invertBlue ? 1 : 0, adjustments.invertAll ? 1 : 0,
      adjustments.highlightSdrOverexposure ? 1 : 0, (adjustments.sdrOverexposureThreshold ?? 255) / 255,
      adjustments.highlightSdrUnderexposure ? 1 : 0, (adjustments.sdrUnderexposureThreshold ?? 16) / 255, 0
    ]));
    const bindGroup = device.createBindGroup({
      layout: this.pipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sourceTexture!.createView() },
        { binding: 1, resource: { buffer: this.uniformBuffer! } },
        { binding: 2, resource: this.sdrSourceTexture!.createView() }
      ]
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context!.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  private async initialize(canvas: HTMLCanvasElement): Promise<void> {
    if (this.device && this.canvas === canvas) return;
    this.dispose();
    if (!navigator.gpu) throw new Error('WebGPU is unavailable.');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter is available.');
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!context) {
      device.destroy();
      throw new Error('Unable to create a WebGPU canvas context.');
    }
    context.configure({
      device,
      format: 'rgba16float',
      colorSpace: 'srgb',
      alphaMode: 'opaque',
      toneMapping: { mode: 'extended' }
    });
    const module = device.createShaderModule({ code: `
      struct Params { brightness: f32, contrast: f32, red: f32, green: f32, blue: f32, saturation: f32, blackPoint: f32, whitePoint: f32, highlightEnabled: f32, highlightR: f32, highlightG: f32, highlightB: f32, highlightThreshold: f32, invertRed: f32, invertGreen: f32, invertBlue: f32, invertAll: f32, sdrOverexposureEnabled: f32, sdrOverexposureThreshold: f32, sdrUnderexposureEnabled: f32, sdrUnderexposureThreshold: f32, pad2: f32 };
      @group(0) @binding(0) var imageTexture: texture_2d<f32>;
      @group(0) @binding(1) var<uniform> params: Params;
      @group(0) @binding(2) var sdrImageTexture: texture_2d<f32>;
      struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
      @vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOutput {
        var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0,-1.0), vec2<f32>(3.0,-1.0), vec2<f32>(-1.0,3.0));
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
        let dims = vec2<f32>(textureDimensions(imageTexture));
        let coords = vec2<i32>(clamp(input.uv * dims, vec2<f32>(0.0), dims - vec2<f32>(1.0)));
        let sourceColor = textureLoad(imageTexture, coords, 0).rgb;
        // WGC supplies linear scRGB; any channel above reference white (1.0)
        // marks the pixel as HDR. Apply the diagnostic color before corrections.
        if (params.highlightEnabled > 0.5
          && (sourceColor.r >= params.highlightThreshold || sourceColor.g >= params.highlightThreshold || sourceColor.b >= params.highlightThreshold)) {
          return vec4<f32>(params.highlightR, params.highlightG, params.highlightB, 1.0);
        }
        // Read the separately uploaded 8-bit SDR image values (normalized by /255).
        let sdrDims = vec2<i32>(textureDimensions(sdrImageTexture));
        let sdrCoords = vec2<i32>(clamp(input.uv * vec2<f32>(sdrDims), vec2<f32>(0.0), vec2<f32>(sdrDims - vec2<i32>(1, 1))));
        let sdrEncoded = textureLoad(sdrImageTexture, sdrCoords, 0).rgb;
        if (params.sdrOverexposureEnabled > 0.5
          && max(sdrEncoded.r, max(sdrEncoded.g, sdrEncoded.b)) >= params.sdrOverexposureThreshold) {
          return vec4<f32>(1.0, 0.18, 0.0, 1.0);
        }
        // Mark very dark SDR pixels only when all three channels are below the threshold.
        if (params.sdrUnderexposureEnabled > 0.5
          && max(sdrEncoded.r, max(sdrEncoded.g, sdrEncoded.b)) <= params.sdrUnderexposureThreshold) {
          return vec4<f32>(0.0, 0.82, 0.9, 1.0);
        }
        let linearColor = sourceColor * params.brightness;
        var encodedColor = vec3<f32>(
          linearToExtendedSrgb(linearColor.r),
          linearToExtendedSrgb(linearColor.g),
          linearToExtendedSrgb(linearColor.b)
        );
        encodedColor = (encodedColor - vec3<f32>(0.5)) * params.contrast + vec3<f32>(0.5);
        let luminance = dot(encodedColor, vec3<f32>(0.2126, 0.7152, 0.0722));
        encodedColor = vec3<f32>(luminance) + (encodedColor - vec3<f32>(luminance)) * params.saturation;
        encodedColor = (encodedColor - vec3<f32>(params.blackPoint)) / max(params.whitePoint - params.blackPoint, 0.01);
        encodedColor *= vec3<f32>(params.red, params.green, params.blue);
        if (params.invertRed > 0.5 || params.invertAll > 0.5) { encodedColor.r = 1.0 - encodedColor.r; }
        if (params.invertGreen > 0.5 || params.invertAll > 0.5) { encodedColor.g = 1.0 - encodedColor.g; }
        if (params.invertBlue > 0.5 || params.invertAll > 0.5) { encodedColor.b = 1.0 - encodedColor.b; }
        return vec4<f32>(encodedColor, 1.0);
      }
    ` });
    this.device = device;
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' }
    });
    this.uniformBuffer = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.context = context;
    this.canvas = canvas;
  }

  dispose(): void {
    this.sourceTexture?.destroy();
    this.sdrSourceTexture?.destroy();
    this.uniformBuffer?.destroy();
    this.device?.destroy();
    this.device = null;
    this.pipeline = null;
    this.sourceTexture = null;
    this.sdrSourceTexture = null;
    this.sdrSourceKey = null;
    this.uniformBuffer = null;
    this.context = null;
    this.canvas = null;
    this.sourceKey = null;
    this.sourceWidth = 0;
    this.sourceHeight = 0;
  }
}
