import { ScreenCapture } from '@screen-capture/node';

interface CapturedFrame {
  buffer: Buffer;
  width: number;
  height: number;
}

let capturedFrame: CapturedFrame | null = null;
let captureRequest = 0;

const halfToFloat = (h: number): number => {
  const sign = (h & 0x8000) ? -1 : 1;
  const exponent = (h >> 10) & 0x1f;
  const fraction = h & 0x03ff;
  if (exponent === 0) return fraction === 0 ? sign * 0 : sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
};

const linearToSrgb = (value: number): number => {
  // A soft display transform keeps detail visible in the SDR loupe preview.
  const mapped = value <= 0 ? 0 : value / (1 + value);
  const srgb = mapped <= 0.0031308 ? mapped * 12.92 : 1.055 * Math.pow(mapped, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(srgb * 255)));
};

const readPixel = (frame: CapturedFrame, x: number, y: number) => {
  const offset = (y * frame.width + x) * 8;
  const raw = [
    frame.buffer.readUInt16LE(offset),
    frame.buffer.readUInt16LE(offset + 2),
    frame.buffer.readUInt16LE(offset + 4)
  ];
  const values = raw.map(halfToFloat);
  return {
    x, y,
    r: values[0], g: values[1], b: values[2],
    rHex: '0x' + raw[0].toString(16).padStart(4, '0').toUpperCase(),
    gHex: '0x' + raw[1].toString(16).padStart(4, '0').toUpperCase(),
    bHex: '0x' + raw[2].toString(16).padStart(4, '0').toUpperCase(),
    color: '#' + values.map(linearToSrgb).map(v => v.toString(16).padStart(2, '0')).join('')
  };
};

const describeCaptureError = (error: unknown, phase: string): Error => {
  const value = error as { message?: unknown; code?: unknown; hresult?: unknown } | null;
  const message = value && typeof value.message === 'string' ? value.message : String(error);
  const explicitCode = value && (typeof value.hresult === 'string' || typeof value.hresult === 'number')
    ? String(value.hresult)
    : value && (typeof value.code === 'string' || typeof value.code === 'number')
      ? String(value.code)
      : message.match(/(?:HRESULT[=: ]*|DXGI_ERROR_[A-Z_]*\s*\(?)(0x[0-9a-f]{8})/i)?.[1] ?? '';
  const dxgiDescriptions: Record<string, string> = {
    '0x887a0005': 'DXGI_ERROR_DEVICE_REMOVED (GPU/device reset or driver restart)',
    '0x887a0006': 'DXGI_ERROR_DEVICE_HUNG (GPU stopped responding)',
    '0x887a0004': 'DXGI_ERROR_UNSUPPORTED (unsupported operation or format)',
    '0x887a0001': 'DXGI_ERROR_INVALID_CALL (invalid graphics API call)'
  };
  const code = explicitCode ? `; code/HRESULT=${explicitCode}${dxgiDescriptions[explicitCode.toLowerCase()] ? ` — ${dxgiDescriptions[explicitCode.toLowerCase()]}` : ''}` : '';
  return new Error(`Capture phase: ${phase}. ${message}${code}`);
};

export const captureLoupeFrame = async (windowHandle: number): Promise<{ width: number; height: number }> => {
  if (process.platform !== 'win32') {
    throw new Error('The HDR loupe capture currently requires Windows.');
  }

  const request = ++captureRequest;
  const capture = new ScreenCapture({
    windowHandle,
    // The package runtime supports rgba16F (verified by the FP16 prototype),
    // but its published TypeScript union omits this accepted format.
    colorFormat: 'rgba16F' as unknown as ConstructorParameters<typeof ScreenCapture>[0]['colorFormat'],
    cursorCapture: false,
    drawBorder: false,
    minimumUpdateIntervalMs: 0
  });

  let phase = 'initialize capture';
  try {
    phase = 'start capture session';
    await capture.start();
    phase = 'wait for first frame';
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const frame = await Promise.race([
      capture.nextFrame(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('HDR window capture timed out.')), 10000);
      })
    ]).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });

    phase = 'validate captured frame';
    if (!frame) throw new Error('HDR window capture returned no frame.');
    if (frame.colorFormat !== 'rgba16F') throw new Error(`Expected rgba16F but received ${String(frame.colorFormat)}.`);
    if (frame.rowPitch !== frame.width * 8 || frame.buffer.byteLength !== frame.width * frame.height * 8) {
      throw new Error('Unexpected FP16 frame layout; refusing to sample incorrect pixels.');
    }

    if (request === captureRequest) {
      capturedFrame = { buffer: Buffer.from(frame.buffer), width: frame.width, height: frame.height };
    }
    return { width: frame.width, height: frame.height };
  } catch (error) {
    throw describeCaptureError(error, phase);
  } finally {
    await capture.stop().catch(() => undefined);
  }
};

export const releaseLoupeFrame = (): void => {
  captureRequest++;
  capturedFrame = null;
};

export const sampleLoupeRegion = (x: number, y: number, radius = 5) => {
  const frame = capturedFrame;
  if (!frame) return null;

  const px = Math.max(0, Math.min(frame.width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(frame.height - 1, Math.round(y)));
  const safeRadius = Math.max(1, Math.min(12, Math.round(radius)));
  const pixels: Array<{ x: number; y: number; color: string }> = [];

  for (let dy = -safeRadius; dy <= safeRadius; dy++) {
    for (let dx = -safeRadius; dx <= safeRadius; dx++) {
      const sx = Math.max(0, Math.min(frame.width - 1, px + dx));
      const sy = Math.max(0, Math.min(frame.height - 1, py + dy));
      const pixel = readPixel(frame, sx, sy);
      pixels.push({ x: dx, y: dy, color: pixel.color });
    }
  }

  return {
    width: frame.width,
    height: frame.height,
    x: px,
    y: py,
    center: readPixel(frame, px, py),
    radius: safeRadius,
    pixels
  };
};
