// @ts-nocheck -- WebGPU declarations are not included in the project's DOM type library yet.
export type MainImageDynamicRange = 'sdr' | 'hdr';

/** WebGPU brightness pass for the main image, with an FP16 output path for HDR. */
export class MainImageBrightnessRenderer {
  private device: GPUDevice | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private texture: GPUTexture | null = null;
  private uniform: GPUBuffer | null = null;
  private context: GPUCanvasContext | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private width = 0;
  private height = 0;
  private queue: Promise<void> = Promise.resolve();
  private version = 0;

  constructor(
    private readonly dynamicRange: MainImageDynamicRange = 'sdr',
    // Diagnostic canvases use the broadly supported SDR presentation format,
    // while retaining the FP16 intermediate texture used by the HDR copy test.
    private readonly useHdrCanvasFormat = true
  ) {}

  render(canvas: HTMLCanvasElement, image: HTMLImageElement, brightness: number): Promise<void> {
    const version = ++this.version;
    const task = this.queue.then(() => this.renderInternal(canvas, image, brightness, version));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async renderInternal(canvas: HTMLCanvasElement, image: HTMLImageElement, brightness: number, version: number): Promise<void> {
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    canvas.width = width;
    canvas.height = height;
    await this.initialize(canvas);
    if (version !== this.version) return;

    const textureFormat = this.dynamicRange === 'hdr' ? 'rgba16float' : 'rgba8unorm';
    if (!this.texture || width !== this.width || height !== this.height) {
      this.texture?.destroy();
      this.texture = this.device!.createTexture({
        size: { width, height },
        format: textureFormat,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });
      this.width = width;
      this.height = height;
    }

    this.device!.queue.copyExternalImageToTexture(
      { source: image, colorSpace: 'srgb' },
      { texture: this.texture },
      { width, height }
    );
    this.device!.queue.writeBuffer(this.uniform!, 0, new Float32Array([brightness, 0, 0, 0]));
    const bind = this.device!.createBindGroup({
      layout: this.pipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.texture.createView() },
        { binding: 1, resource: { buffer: this.uniform! } }
      ]
    });
    const encoder = this.device!.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context!.getCurrentTexture().createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 }
      }]
    });
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    this.device!.queue.submit([encoder.finish()]);

    // Do not report the canvas as ready while its render pass is still queued.
    // The caller only hides the source image after this promise resolves.
    await this.device!.queue.onSubmittedWorkDone();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }

  private async initialize(canvas: HTMLCanvasElement): Promise<void> {
    if (this.device && this.canvas === canvas) return;
    if (!navigator.gpu) throw new Error('WebGPU is unavailable.');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter is available.');
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!context) {
      device.destroy();
      throw new Error('Unable to create a WebGPU canvas context.');
    }

    const hdr = this.dynamicRange === 'hdr';
    const format = hdr && this.useHdrCanvasFormat ? 'rgba16float' : navigator.gpu.getPreferredCanvasFormat();
    if (hdr && this.useHdrCanvasFormat) {
      context.configure({
        device,
        format,
        colorSpace: 'srgb',
        alphaMode: 'opaque',
        toneMapping: { mode: 'extended' }
      });
    } else {
      context.configure({ device, format, colorSpace: 'srgb', alphaMode: 'opaque' });
    }

    const shader = hdr ? [
      'struct Params { brightness: f32, p0: f32, p1: f32, p2: f32 };',
      '@group(0) @binding(0) var imageTexture: texture_2d<f32>;',
      '@group(0) @binding(1) var<uniform> params: Params;',
      'struct VOut { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };',
      '@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut { var p=array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0)); var o:VOut; o.position=vec4<f32>(p[i],0.0,1.0); o.uv=vec2<f32>((p[i].x+1.0)*0.5,(1.0-p[i].y)*0.5); return o; }',
      'fn extendedSrgbToLinear(value: f32) -> f32 { if (value <= 0.04045) { return value / 12.92; } return pow(max((value + 0.055) / 1.055, 0.0), 2.4); }',
      'fn linearToExtendedSrgb(value: f32) -> f32 { if (value <= 0.0031308) { return value * 12.92; } return 1.055 * pow(max(value, 0.0), 1.0 / 2.4) - 0.055; }',
      '@fragment fn fs(i:VOut) -> @location(0) vec4<f32> { let d=vec2<i32>(textureDimensions(imageTexture)); let c=clamp(vec2<i32>(i.uv*vec2<f32>(d)),vec2<i32>(0,0),d-vec2<i32>(1,1)); let encoded=textureLoad(imageTexture,c,0); let linearColor=vec3<f32>(extendedSrgbToLinear(encoded.r),extendedSrgbToLinear(encoded.g),extendedSrgbToLinear(encoded.b))*params.brightness; return vec4<f32>(linearToExtendedSrgb(linearColor.r),linearToExtendedSrgb(linearColor.g),linearToExtendedSrgb(linearColor.b),encoded.a); }'
    ].join('\n') : [
      'struct Params { brightness: f32, p0: f32, p1: f32, p2: f32 };',
      '@group(0) @binding(0) var imageTexture: texture_2d<f32>;',
      '@group(0) @binding(1) var<uniform> params: Params;',
      'struct VOut { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };',
      '@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut { var p=array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0)); var o:VOut; o.position=vec4<f32>(p[i],0.0,1.0); o.uv=vec2<f32>((p[i].x+1.0)*0.5,(1.0-p[i].y)*0.5); return o; }',
      '@fragment fn fs(i:VOut) -> @location(0) vec4<f32> { let d=vec2<i32>(textureDimensions(imageTexture)); let c=clamp(vec2<i32>(i.uv*vec2<f32>(d)),vec2<i32>(0,0),d-vec2<i32>(1,1)); let color=textureLoad(imageTexture,c,0); return vec4<f32>(color.rgb*params.brightness,color.a); }'
    ].join('\n');

    const module = device.createShaderModule({ code: shader });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' }
    });
    this.device = device;
    this.context = context;
    this.canvas = canvas;
    this.uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  dispose(): void {
    this.version++;
    this.texture?.destroy();
    this.uniform?.destroy();
    this.device?.destroy();
    this.texture = null;
    this.uniform = null;
    this.device = null;
    this.pipeline = null;
    this.context = null;
    this.canvas = null;
    this.width = 0;
    this.height = 0;
  }
}
