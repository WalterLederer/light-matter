import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ScreenCapture } from '@screen-capture/node';

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out after ' + ms + ' ms')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function halfToFloat(h) {
  const sign = (h & 0x8000) ? -1 : 1;
  const exponent = (h >> 10) & 0x1f;
  const fraction = h & 0x03ff;
  if (exponent === 0) return fraction === 0 ? sign * 0 : sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function pixelAt(buffer, width, height, x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
    throw new RangeError('Pixel (' + x + ', ' + y + ') is outside ' + width + 'x' + height);
  }
  const offset = (y * width + x) * 8;
  const values = [];
  for (let channel = 0; channel < 4; channel++) values.push(halfToFloat(buffer.readUInt16LE(offset + channel * 2)));
  return { x, y, r: values[0], g: values[1], b: values[2], a: values[3] };
}

function parseArgs(args) {
  const result = { monitor: 1, windowHandle: null, windowName: null, sample: null, rawPath: null, jsonPath: 'node-wgc-fp16-test.json' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--monitor') result.monitor = Number(args[++i]);
    else if (arg === '--window-handle') {
      const value = args[++i] ?? '';
      result.windowHandle = Number.parseInt(value, value.toLowerCase().startsWith('0x') ? 16 : 10);
      if (!Number.isSafeInteger(result.windowHandle) || result.windowHandle <= 0) throw new Error('--window-handle expects a positive decimal or hexadecimal HWND');
    } else if (arg === '--window-name') result.windowName = args[++i] ?? '';
    else if (arg === '--sample') {
      const parts = (args[++i] ?? '').split(',').map(Number);
      if (parts.length !== 2 || parts.some(n => !Number.isInteger(n))) {
        throw new Error('--sample expects X,Y, for example --sample 1920,1080');
      }
      result.sample = { x: parts[0], y: parts[1] };
    } else if (arg === '--raw') result.rawPath = args[++i] ?? 'node-wgc-fp16.rgba16f';
    else if (arg === '--json') result.jsonPath = args[++i] ?? result.jsonPath;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node node-screen-capture-fp16-test.mjs [--monitor 1 | --window-handle 0x123456 | --window-name "title"] [--sample X,Y] [--raw [file]] [--json file]');
      process.exit(0);
    } else throw new Error('Unknown argument: ' + arg);
  }
  const targetCount = Number(result.windowHandle !== null) + Number(result.windowName !== null);
  if (targetCount > 1) throw new Error('Choose only one target: --monitor, --window-handle, or --window-name');
  if (result.windowName !== null && !result.windowName.trim()) throw new Error('--window-name must not be empty');
  if (targetCount === 0 && (!Number.isInteger(result.monitor) || result.monitor < 1)) throw new Error('--monitor must be a positive one-based monitor index');
  return result;
}

const options = parseArgs(process.argv.slice(2));
const captureOptions = {
  colorFormat: 'rgba16F',
  cursorCapture: false,
  drawBorder: false,
  minimumUpdateIntervalMs: 0,
};
if (options.windowHandle !== null) captureOptions.windowHandle = options.windowHandle;
else if (options.windowName !== null) captureOptions.windowName = options.windowName;
else captureOptions.monitorIndex = options.monitor;
const capture = new ScreenCapture(captureOptions);
const targetDescription = options.windowHandle !== null
  ? 'window HWND ' + '0x' + options.windowHandle.toString(16).toUpperCase()
  : options.windowName !== null ? 'window title containing ' + JSON.stringify(options.windowName) : 'monitor ' + options.monitor;

let started = false;
try {
  console.log('Creating WGC capture: ' + targetDescription + ', requested format rgba16F');
  console.log('Starting native capture (15-second timeout)...');
  const start = performance.now();
  await withTimeout(capture.start(), 15000, 'capture.start()');
  started = true;
  console.log('Capture started in ' + (performance.now() - start).toFixed(1) + ' ms.');
  console.log('Waiting for first frame (10-second timeout)...');

  const frameStart = performance.now();
  const frame = await withTimeout(capture.nextFrame(), 10000, 'first frame');
  const elapsedMs = performance.now() - frameStart;
  if (!frame) throw new Error('Capture ended without delivering a frame');

  const buffer = frame.buffer;
  const expectedBytes = frame.width * frame.height * 8;
  const format = frame.colorFormat;
  const reportBase = {
    package: '@screen-capture/node',
    target: targetDescription,
    requestedColorFormat: 'rgba16F',
    actualColorFormat: format,
    width: frame.width,
    height: frame.height,
    rowPitch: frame.rowPitch,
    depthPitch: frame.depthPitch,
    bufferBytes: buffer.byteLength,
    expectedPackedRgba16fBytes: expectedBytes,
    byteLengthMatchesExpected: buffer.byteLength === expectedBytes,
    rowPitchMatchesExpected: frame.rowPitch === frame.width * 8,
    firstFrameWaitMs: Number(elapsedMs.toFixed(2)),
    timestamp: frame.timestamp,
    sample: pixelAt(buffer, frame.width, frame.height,
      options.sample?.x ?? Math.floor(frame.width / 2),
      options.sample?.y ?? Math.floor(frame.height / 2)),
  };

  let min = Infinity, max = -Infinity;
  const minRgb = [Infinity, Infinity, Infinity], maxRgb = [-Infinity, -Infinity, -Infinity];
  let negativeRgbCount = 0, aboveOneRgbCount = 0, nonFiniteRgbCount = 0;
  let alphaMin = Infinity, alphaMax = -Infinity;
  let firstAboveOne = null, firstNegative = null, firstNonFinite = null;
  const pixelCount = frame.width * frame.height;
  const channelNames = ['r', 'g', 'b'];

  console.log('Scanning ' + pixelCount + ' pixels for FP16 value range...');
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * 8;
    for (let c = 0; c < 3; c++) {
      const value = halfToFloat(buffer.readUInt16LE(offset + c * 2));
      if (!Number.isFinite(value)) {
        nonFiniteRgbCount++;
        if (!firstNonFinite) firstNonFinite = { x: pixel % frame.width, y: Math.floor(pixel / frame.width), channel: channelNames[c], value: String(value) };
        continue;
      }
      min = Math.min(min, value);
      max = Math.max(max, value);
      minRgb[c] = Math.min(minRgb[c], value);
      maxRgb[c] = Math.max(maxRgb[c], value);
      if (value < 0) {
        negativeRgbCount++;
        if (!firstNegative) firstNegative = { x: pixel % frame.width, y: Math.floor(pixel / frame.width), channel: channelNames[c], value };
      }
      if (value > 1) {
        aboveOneRgbCount++;
        if (!firstAboveOne) firstAboveOne = { x: pixel % frame.width, y: Math.floor(pixel / frame.width), channel: channelNames[c], value };
      }
    }
    const alpha = halfToFloat(buffer.readUInt16LE(offset + 6));
    if (Number.isFinite(alpha)) {
      alphaMin = Math.min(alphaMin, alpha);
      alphaMax = Math.max(alphaMax, alpha);
    }
  }

  const report = {
    ...reportBase,
    scan: {
      rgbMin: min, rgbMax: max,
      rgbMinByChannel: { r: minRgb[0], g: minRgb[1], b: minRgb[2] },
      rgbMaxByChannel: { r: maxRgb[0], g: maxRgb[1], b: maxRgb[2] },
      negativeRgbChannelValues: negativeRgbCount,
      rgbChannelValuesAboveOne: aboveOneRgbCount,
      nonFiniteRgbChannelValues: nonFiniteRgbCount,
      alphaMin, alphaMax, firstAboveOne, firstNegative, firstNonFinite,
      pixelsScanned: pixelCount,
    },
    verdict: {
      formatReportedAsRgba16F: format === 'rgba16F' || String(format).toLowerCase().includes('rgba16f'),
      packedRgba16fBufferSize: buffer.byteLength === expectedBytes,
      hasRgbValuesAboveOne: aboveOneRgbCount > 0,
      hasNegativeRgbValues: negativeRgbCount > 0,
      note: 'Format and buffer size establish the expected layout, not by themselves that the compositor preserved HDR values. Compare sample and extrema with the existing WGC EXR capture.',
    },
  };

  if (options.rawPath) {
    const rawPath = resolve(options.rawPath);
    await writeFile(rawPath, buffer);
    report.rawFile = rawPath;
  }
  const jsonPath = resolve(options.jsonPath);
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(report, null, 2));
  console.log('\nJSON report: ' + jsonPath);
} catch (error) {
  console.error('\nFP16 capture test FAILED:', error?.stack ?? error);
  process.exitCode = 1;
} finally {
  console.log('Stopping capture...');
  await capture.stop().catch(error => console.error('Capture stop failed:', error));
}
