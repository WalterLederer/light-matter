// @ts-nocheck -- WebGPU declarations are not included in the project's DOM type library yet.
/** Small HDR loupe renderer using captured FP16/scRGB samples. */
export interface HdrLoupeRegion {
  width: number;
  height: number;
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

    device.queue.writeBuffer(this.uniformBuffer!, 0, new Float32Array([brightness, zoom, 0, 0]));
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
    if (!navigator.gpu) throw new Error('WebGPU is unavailable; using CSS brightness fallback.');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter is available.');
    const device = await adapter.requestDevice();
    canvas.width = 280;
    canvas.height = 280;
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
        struct Params { brightness: f32, zoom: f32, _pad0: f32, _pad1: f32 };
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
          // Preserve the loupe slider's exact magnification while sampling a small
          // region around the cursor from the FP16 desktop capture.
          // Sample a zoom-dependent fraction of the actual source region.
          // The crop size varies with loupe magnification and display scaling;
          // using a hard-coded 280 source pixels caused only a few pixels to
          // be visible at high zoom.
          let sourceSpan = vec2<f32>(dims) / max(params.zoom, 0.01);
          let sourcePosition = vec2<f32>(dims) * 0.5
            + (input.uv - vec2<f32>(0.5)) * sourceSpan;
          let coords = clamp(
            vec2<i32>(floor(sourcePosition)),
            vec2<i32>(0, 0),
            dims - vec2<i32>(1, 1)
          );
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
      size: 16,
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
        device.queue.writeBuffer(this.uniformBuffer, 0, new Float32Array([brightness, 1, 0, 0]));
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
