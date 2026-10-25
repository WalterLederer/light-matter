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

export const captureLoupeFrame = async (monitorIndex: number): Promise<{ width: number; height: number }> => {
  if (process.platform !== 'win32') {
    throw new Error('The HDR loupe capture currently requires Windows.');
  }

  const request = ++captureRequest;
  const createCapture = (drawBorder?: boolean): ScreenCapture => new ScreenCapture({
    monitorIndex,
    // The package runtime supports rgba16F (verified by the FP16 prototype),
    // but its published TypeScript union omits this accepted format.
    colorFormat: 'rgba16F' as unknown as ConstructorParameters<typeof ScreenCapture>[0]['colorFormat'],
    cursorCapture: false,
    ...(drawBorder === undefined ? {} : { drawBorder }),
    minimumUpdateIntervalMs: 0
  });

  // Windows 10 builds before 20348 do not support changing the WGC capture
  // border. Retry without the option only for that specific compatibility error.
  let capture = createCapture(false);
  let phase = 'initialize capture';
  try {
    phase = 'start capture session';
    try {
      await capture.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes('toggling the capture border is not supported')) {
        throw error;
      }

      await capture.stop().catch(() => undefined);
      capture = createCapture();
      await capture.start();
    }
    phase = 'wait for first frame';
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const frame = await Promise.race([
      capture.nextFrame(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('HDR monitor capture timed out.')), 10000);
      })
    ]).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });

    phase = 'validate captured frame';
    if (!frame) throw new Error('HDR monitor capture returned no frame.');
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
  // Low magnification and a physically enlarged loupe require a wider source crop.
  // Keep the native crop limit aligned with the renderer's request limit so the
  // shader can sample the full visible area without stretching edge pixels.
  const safeRadius = Math.max(1, Math.min(2048, Math.round(radius)));
  // Clip the crop to the real monitor frame instead of repeating edge pixels.
  // The shader treats coordinates outside this cropped texture as empty, so a
  // low zoom never stretches the monitor's border pixels across the ruler.
  const requestedDiameter = safeRadius * 2 + 1;
  // If the requested crop spans an entire monitor dimension, copy that whole
  // dimension even when the cursor is near an edge. Otherwise the far side of
  // the monitor would be missing and the shader would have to show empty pixels.
  const left = requestedDiameter >= frame.width ? 0 : Math.max(0, px - safeRadius);
  const right = requestedDiameter >= frame.width ? frame.width - 1 : Math.min(frame.width - 1, px + safeRadius);
  const top = requestedDiameter >= frame.height ? 0 : Math.max(0, py - safeRadius);
  const bottom = requestedDiameter >= frame.height ? frame.height - 1 : Math.min(frame.height - 1, py + safeRadius);
  const regionWidth = right - left + 1;
  const regionHeight = bottom - top + 1;
  const centerX = px - left;
  const centerY = py - top;
  const pixels: Array<{ x: number; y: number; color: string }> = [];
  const data = new Uint16Array(regionWidth * regionHeight * 4);
  let dataIndex = 0;

  for (let sy = top; sy <= bottom; sy++) {
    for (let sx = left; sx <= right; sx++) {
      const pixelOffset = (sy * frame.width + sx) * 8;
      if (safeRadius <= 12) {
        const pixel = readPixel(frame, sx, sy);
        pixels.push({ x: sx - px, y: sy - py, color: pixel.color });
      }
      for (let channel = 0; channel < 4; channel++) {
        data[dataIndex++] = frame.buffer.readUInt16LE(pixelOffset + channel * 2);
      }
    }
  }

  return {
    width: frame.width,
    height: frame.height,
    x: px,
    y: py,
    radius: safeRadius,
    regionWidth,
    regionHeight,
    centerX,
    centerY,
    data,
    center: readPixel(frame, px, py),
    pixels
  };
};


/**
 * Copies a rectangular crop from the existing monitor FP16 frame.
 * Coordinates and dimensions are in physical capture pixels. The returned
 * buffer is tightly packed RGBA16F and safe to pass across Electron IPC.
 */
export const sampleLoupeRectangle = (x: number, y: number, width: number, height: number) => {
  const frame = capturedFrame;
  if (!frame) return null;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new RangeError('FP16 capture rectangle must have finite coordinates and positive dimensions.');
  }

  const left = Math.max(0, Math.min(frame.width, Math.floor(x)));
  const top = Math.max(0, Math.min(frame.height, Math.floor(y)));
  const right = Math.max(left, Math.min(frame.width, Math.ceil(x + width)));
  const bottom = Math.max(top, Math.min(frame.height, Math.ceil(y + height)));
  const regionWidth = right - left;
  const regionHeight = bottom - top;
  if (regionWidth === 0 || regionHeight === 0) return null;

  const data = new Uint16Array(regionWidth * regionHeight * 4);
  for (let row = 0; row < regionHeight; row++) {
    const sourceStart = ((top + row) * frame.width + left) * 8;
    const targetStart = row * regionWidth * 4;
    for (let column = 0; column < regionWidth * 4; column++) {
      data[targetStart + column] = frame.buffer.readUInt16LE(sourceStart + column * 2);
    }
  }

  return {
    width: frame.width,
    height: frame.height,
    x: left,
    y: top,
    regionWidth,
    regionHeight,
    centerX: Math.max(0, Math.min(regionWidth - 1, Math.round(x - left))),
    centerY: Math.max(0, Math.min(regionHeight - 1, Math.round(y - top))),
    data
  };
};
