import { app, desktopCapturer, dialog, ipcMain, IpcMainInvokeEvent, screen } from 'electron';
import { enumerateMonitors, enumerateWindows, ImageEncoder, ImageEncoderPixelFormat, ImageFormat, ScreenCapture } from '@screen-capture/node';
import { deflateSync } from 'node:zlib';
import { encodeExr, init as initExr } from 'exrs';
import { CaptureResult, CaptureSources, CaptureTarget, FileListing, supportedFileExtensions } from 'internal-api';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Injector } from '../../injector/injector';
import { IpcRegistry } from '../decorators/ipc-registry';
import { captureLoupeFrame, releaseLoupeFrame, sampleLoupeRegion, sampleLoupeRectangle } from '../loupe-capture';
import App from '../app';

let exrInitPromise: Promise<void> | undefined;

const halfToFloat = (half: number): number => {
  const sign = (half & 0x8000) !== 0 ? -1 : 1;
  const exponent = (half >> 10) & 0x1f;
  const fraction = half & 0x03ff;
  if (exponent === 0) return fraction === 0 ? sign * 0 : sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
};

const CAPTURE_BRIGHTNESS_CORRECTION = 0.4;
const halfConversionBuffer = new ArrayBuffer(4);
const halfConversionFloat = new Float32Array(halfConversionBuffer);
const halfConversionBits = new Uint32Array(halfConversionBuffer);

const floatToHalf = (value: number): number => {
  halfConversionFloat[0] = value;
  const bits = halfConversionBits[0];
  const sign = (bits >>> 16) & 0x8000;
  let exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  let mantissa = bits & 0x7fffff;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    mantissa = (mantissa | 0x800000) >> (1 - exponent);
    return sign | ((mantissa + 0x1000) >> 13);
  }
  if (exponent >= 31) return sign | 0x7c00 | (mantissa ? 0x0200 : 0);
  return sign | (exponent << 10) | ((mantissa + 0x1000) >> 13);
};

const crc32 = (buffer: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const makePngChunk = (type: string, data: Buffer): Buffer => {
  const typeBuffer = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuffer, data]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([header, body, checksum]);
};

const makeCapturePreview = (frame: { width: number; height: number; buffer: Buffer }): string => {
  const previewWidth = Math.min(640, frame.width);
  const previewHeight = Math.max(1, Math.round(frame.height * previewWidth / frame.width));
  const scanlines = Buffer.alloc((previewWidth * 4 + 1) * previewHeight);
  for (let y = 0; y < previewHeight; y++) {
    const sourceY = Math.min(frame.height - 1, Math.floor((y + 0.5) * frame.height / previewHeight));
    const row = y * (previewWidth * 4 + 1);
    scanlines[row] = 0;
    for (let x = 0; x < previewWidth; x++) {
      const sourceX = Math.min(frame.width - 1, Math.floor((x + 0.5) * frame.width / previewWidth));
      const sourceOffset = (sourceY * frame.width + sourceX) * 8;
      const targetOffset = row + 1 + x * 4;
      for (let channel = 0; channel < 3; channel++) {
        const linear = Math.max(0, halfToFloat(frame.buffer.readUInt16LE(sourceOffset + channel * 2)) * CAPTURE_BRIGHTNESS_CORRECTION);
        const mapped = linear / (1 + linear);
        const srgb = mapped <= 0.0031308 ? mapped * 12.92 : 1.055 * Math.pow(mapped, 1 / 2.4) - 0.055;
        scanlines[targetOffset + channel] = Math.max(0, Math.min(255, Math.round(srgb * 255)));
      }
      scanlines[targetOffset + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(previewWidth, 0);
  ihdr.writeUInt32BE(previewHeight, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', deflateSync(scanlines)),
    makePngChunk('IEND', Buffer.alloc(0))
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
};

export default class ElectronEvents {
  static bootstrapElectronEvents(): Electron.IpcMain {
    const injector = Injector.getInstance();

    IpcRegistry
      .getInstance()
      .registerIpcHandlers(
        ipcMain,
        [
          injector.inject('Dialogs'),
          injector.inject('Exif'),
          injector.inject('FileSystem'),
          injector.inject('ProcessManager'),
          injector.inject('CacheManager'),
          injector.inject('Histogram')
        ]
      );

    return ipcMain;
  }
}

ipcMain.handle('openFolder', async (): Promise<FileListing> => {
  const result = await dialog.showOpenDialog({ properties: [ 'openDirectory' ] });

  if (!result.canceled && result.filePaths.length > 0) {
    const folder = result.filePaths[0];

    return {
      success: true,
      data: {
        folder,
        files: await readFolder(folder)
      }
    };
  }

  return { success: false, errorMessage: '' };
});

ipcMain.handle('openFile', async (): Promise<FileListing> => {
  const result = await dialog.showOpenDialog({
    properties: [ 'openFile' ],
    filters: [ { name: 'Images', extensions: supportedFileExtensions } ]
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const fileName = result.filePaths[0];
    const folder = path.dirname(fileName);

    return {
      success: true,
      data: {
        folder,
        files: await readFolder(folder),
        selected: fileName
      }
    };
  }

  return { success: false, errorMessage: '' };
});

ipcMain.handle('openFileFromArgs', async (_: IpcMainInvokeEvent, fileName: string): Promise<FileListing> => {
  const folder = path.dirname(fileName);

  return {
    success: true,
    data: {
      folder,
      files: await readFolder(folder),
      selected: fileName
    }
  };
});

ipcMain.handle('Loupe.capture', async () => {
  let phase = 'prepare display capture';
  try {
    if (process.platform !== 'win32' || !App.mainWindow || App.mainWindow.isDestroyed()) {
      throw new Error('HDR loupe capture is unavailable: a live Windows application window is required.');
    }

    // Capture the whole monitor containing the application, not the application
    // window. This avoids window-frame/Chromium-area rounding differences.
    const windowBounds = App.mainWindow.getBounds();
    const contentBounds = App.mainWindow.getContentBounds();
    const display = screen.getDisplayMatching(windowBounds);
    const displays = screen.getAllDisplays();
    const displayPosition = displays.findIndex(candidate => candidate.id === display.id);
    const monitors = enumerateMonitors();
    const expectedWidth = Math.round(display.bounds.width * display.scaleFactor);
    const expectedHeight = Math.round(display.bounds.height * display.scaleFactor);

    // Electron and WGC normally enumerate displays in the same order. If the
    // dimensions show they do not, use the closest physical-size match instead.
    let monitorIndex = displayPosition >= 0 ? displayPosition + 1 : 1;
    const indexedMonitor = monitors[monitorIndex - 1];
    if (!indexedMonitor ||
        Math.abs(indexedMonitor.width - expectedWidth) > 2 ||
        Math.abs(indexedMonitor.height - expectedHeight) > 2) {
      const closest = monitors
        .map(monitor => ({
          index: monitor.index,
          score: Math.abs(monitor.width - expectedWidth) + Math.abs(monitor.height - expectedHeight)
        }))
        .sort((a, b) => a.score - b.score)[0];
      if (closest) monitorIndex = closest.index;
    }

    phase = 'capture FP16 monitor frame';
    const frame = await captureLoupeFrame(monitorIndex);
    return {
      width: frame.width,
      height: frame.height,
      x: display.bounds.x,
      y: display.bounds.y,
      contentX: contentBounds.x,
      contentY: contentBounds.y,
      windowWidth: display.bounds.width,
      windowHeight: display.bounds.height,
      scaleFactor: display.scaleFactor
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const gpuInfo = await app.getGPUInfo('complete').catch(() => null);
    const devices = (gpuInfo as { gpuDevice?: Array<{ description?: string; driverVersion?: string; driverDate?: string; vendorId?: number; deviceId?: number }> } | null)?.gpuDevice ?? [];
    const gpu = devices.length
      ? devices.map(device => `${device.description ?? 'Unknown GPU'} (vendor ${device.vendorId ?? '?'}, device ${device.deviceId ?? '?'}, driver ${device.driverVersion ?? 'unknown'}${device.driverDate ? `, ${device.driverDate}` : ''})`).join(' | ')
      : 'GPU/driver information unavailable from Electron';
    throw new Error(`${message}\nDiagnostics: phase=${phase}; OS=${os.version()} [${os.release()}]; Electron=${process.versions.electron}; API=@screen-capture/node; requested format=rgba16F (FP16 / R16G16B16A16_FLOAT); GPU=${gpu}`);
  }
});

ipcMain.handle('Loupe.sample', (_event, x: number, y: number, radius?: number) => sampleLoupeRegion(x, y, radius));
ipcMain.handle('Loupe.region', (_event, x: number, y: number, width: number, height: number) => sampleLoupeRectangle(x, y, width, height));
ipcMain.handle('Loupe.release', () => releaseLoupeFrame());

ipcMain.handle('Capture.listSources', async (): Promise<CaptureSources> => {
  if (process.platform !== 'win32') {
    throw new Error('HDR capture of individual windows and monitors is currently supported on Windows only.');
  }

  const monitors = enumerateMonitors().map(monitor => ({
    index: monitor.index,
    name: monitor.name || monitor.deviceName || `Monitor ${monitor.index}`,
    deviceName: monitor.deviceName,
    width: monitor.width,
    height: monitor.height,
    refreshRate: monitor.refreshRate
  }));

  // Enumerating top-level windows can fail independently on some Windows
  // configurations (for example, when the native API cannot inspect a window).
  // Keep monitor capture available instead of failing the entire source list.
  let windows: CaptureSources['windows'] = [];
  const sourceErrors: string[] = [];
  try {
    windows = enumerateWindows()
      .filter(window => window.isValid && window.title.trim().length > 0 && window.processId !== process.pid && !window.title.trim().toLowerCase().startsWith('light matter'))
      .map(window => ({
        title: window.title.trim(),
        processName: window.processName || 'Unknown application',
        processId: window.processId,
        handle: window.handle,
        width: window.width,
        height: window.height,
        monitorIndex: window.monitorIndex
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
  } catch (nativeError) {
    // The native enumerator can fail with E_ACCESSDENIED on some windows.
    // Try Electron's own source list as a fallback so window capture remains
    // available when its source IDs expose a native HWND.
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false
      });
      windows = sources.flatMap(source => {
        const match = /^window:(\d+):/.exec(source.id);
        if (!match) return [];
        const handle = Number(match[1]);
        if (!Number.isSafeInteger(handle) || handle <= 0) return [];
        const title = source.name.trim();
        if (!title || title.toLowerCase().startsWith('light matter')) return [];
        return [{
          title,
          processName: 'Windows application',
          processId: 0,
          handle,
          width: 0,
          height: 0
        }];
      }).sort((a, b) => a.title.localeCompare(b.title));
      if (windows.length === 0) {
        const message = nativeError instanceof Error ? nativeError.message : String(nativeError);
        sourceErrors.push(`Native window enumeration failed (${message}); Electron fallback did not return usable window handles.`);
      }
    } catch (fallbackError) {
      const nativeMessage = nativeError instanceof Error ? nativeError.message : String(nativeError);
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      sourceErrors.push(`Window enumeration failed. Native API: ${nativeMessage}. Electron fallback: ${fallbackMessage}`);
    }
  }

  return { monitors, windows, sourceErrors };
});

ipcMain.handle('Capture.chooseFolder', async (_event, initialPath?: string): Promise<string | null> => {
  const result = await dialog.showOpenDialog(App.mainWindow, {
    title: 'Choose HDR capture folder',
    defaultPath: initialPath || undefined,
    properties: ['openDirectory', 'createDirectory']
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

ipcMain.handle('Capture.preview', async (_event, target: CaptureTarget): Promise<{ width: number; height: number; dataUrl: string }> => {
  if (process.platform !== 'win32') throw new Error('HDR preview capture is currently supported on Windows only.');
  if (target?.kind !== 'monitor' && target?.kind !== 'window') throw new Error('Choose a monitor or application window to preview.');
  const options = target.kind === 'monitor' ? { monitorIndex: target.index } : { windowHandle: target.handle };
  const capture = new ScreenCapture({
    ...options,
    colorFormat: 'rgba16F' as unknown as ConstructorParameters<typeof ScreenCapture>[0]['colorFormat'],
    cursorCapture: false,
    drawBorder: false,
    minimumUpdateIntervalMs: 0
  });
  try {
    await capture.start();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const frame = await Promise.race([
      capture.nextFrame(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Timed out waiting for the HDR preview frame.')), 10000); })
    ]).finally(() => { if (timeout !== undefined) clearTimeout(timeout); });
    if (!frame) throw new Error('The selected preview source is no longer available.');
    if (frame.colorFormat !== 'rgba16F' || frame.rowPitch !== frame.width * 8 || frame.buffer.byteLength !== frame.width * frame.height * 8) {
      throw new Error('The preview did not return the expected packed FP16 HDR frame.');
    }
    return { width: frame.width, height: frame.height, dataUrl: makeCapturePreview(frame) };
  } finally {
    await capture.stop().catch(() => undefined);
  }
});

ipcMain.handle('Capture.capture', async (_event, target: CaptureTarget, folder: string, format: 'exr' | 'jxr' = 'exr'): Promise<CaptureResult> => {
  if (process.platform !== 'win32') {
    throw new Error('HDR capture is currently supported on Windows only.');
  }
  if (!folder || !path.isAbsolute(folder)) {
    throw new Error('Choose a valid destination folder before capturing.');
  }
  if (target?.kind !== 'monitor' && target?.kind !== 'window') {
    throw new Error('Choose a monitor or application window to capture.');
  }

  const options = target.kind === 'monitor'
    ? { monitorIndex: target.index }
    : { windowHandle: target.handle };
  const capture = new ScreenCapture({
    ...options,
    colorFormat: 'rgba16F' as unknown as ConstructorParameters<typeof ScreenCapture>[0]['colorFormat'],
    cursorCapture: false,
    drawBorder: false,
    minimumUpdateIntervalMs: 0
  });

  let phase = 'initialize capture';
  const logPhase = (nextPhase: string): void => {
    phase = nextPhase;
    console.info(`[HDR Capture] ${phase}`);
  };

  try {
    logPhase('start native capture session');
    await capture.start();

    logPhase('wait for first FP16 frame');
    let captureTimeout: ReturnType<typeof setTimeout> | undefined;
    const frame = await Promise.race([
      capture.nextFrame(),
      new Promise<never>((_, reject) => {
        captureTimeout = setTimeout(() => reject(new Error('Timed out waiting for the HDR capture frame.')), 10000);
      })
    ]).finally(() => {
      if (captureTimeout !== undefined) clearTimeout(captureTimeout);
    });
    if (!frame) throw new Error('The selected capture source is no longer available.');

    logPhase('validate FP16 frame');
    if (frame.colorFormat !== 'rgba16F' || frame.rowPitch !== frame.width * 8 ||
        frame.buffer.byteLength !== frame.width * frame.height * 8) {
      throw new Error('The capture did not return the expected packed FP16 HDR frame.');
    }

    logPhase('prepare corrected FP16 frame');
    if ((frame.buffer.byteOffset & 1) !== 0 || (frame.buffer.byteLength & 1) !== 0) {
      throw new Error('The FP16 frame buffer is not aligned to 16-bit channel boundaries.');
    }
    const sourceChannels = new Uint16Array(
      frame.buffer.buffer,
      frame.buffer.byteOffset,
      frame.buffer.byteLength / 2
    );

    let encoded: Buffer | Uint8Array;
    if (format === 'jxr') {
      logPhase('apply brightness correction and encode JPEG XR');
      const corrected = Buffer.allocUnsafe(frame.buffer.byteLength);
      for (let channelIndex = 0; channelIndex < sourceChannels.length; channelIndex++) {
        const channel = channelIndex % 4;
        const value = halfToFloat(sourceChannels[channelIndex]) * (channel === 3 ? 1 : CAPTURE_BRIGHTNESS_CORRECTION);
        corrected.writeUInt16LE(floatToHalf(value), channelIndex * 2);
      }
      // Keep all four 16-bit channels. The native RGB16F encoder expects a
      // packed 8-byte-per-pixel buffer; a 6-byte RGB-only buffer is too small.
      const encoder = new ImageEncoder(ImageFormat.JpegXr, ImageEncoderPixelFormat.Rgb16F);
      encoded = encoder.encode(corrected, frame.width, frame.height);
    } else {
      logPhase(`convert corrected RGBA16F to Float32 RGBA (${frame.width}x${frame.height})`);
      const rgba = new Float32Array(frame.width * frame.height * 4);
      for (let source = 0; source < sourceChannels.length; source++) {
        const channel = source % 4;
        rgba[source] = halfToFloat(sourceChannels[source]) * (channel === 3 ? 1 : CAPTURE_BRIGHTNESS_CORRECTION);
      }
      logPhase('FP16 to Float32 RGBA conversion complete');
      logPhase('initialize OpenEXR encoder');
      exrInitPromise ??= initExr();
      await exrInitPromise;
      logPhase('encode OpenEXR');
      encoded = encodeExr({
        width: frame.width,
        height: frame.height,
        layers: [{ name: 'rgba', channelNames: ['R', 'G', 'B', 'A'], interleavedPixels: rgba, precision: 'f32', compression: 'piz' }]
      });
    }

    logPhase(`write ${format.toUpperCase()} file`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseName = `LightMatter_Capture_${stamp}`;
    let outputPath = path.join(folder, `${baseName}.${format}`);
    let suffix = 1;
    while (fsSync.existsSync(outputPath)) {
      outputPath = path.join(folder, `${baseName}_${suffix++}.${format}`);
    }
    await fs.writeFile(outputPath, encoded, { flag: 'wx' });
    return { path: outputPath, width: frame.width, height: frame.height };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[HDR Capture] Failed during "${phase}": ${message}`);
    throw new Error(`HDR capture failed during "${phase}": ${message}`);
  } finally {
    logPhase('stop native capture session');
    await capture.stop().catch((error: unknown) => {
      console.error('[HDR Capture] Failed to stop native capture session:', error);
    });
  }
});


ipcMain.on('quit', (_, code) => app.exit(code));

const readFolder = async (folder: string): Promise<string[]> =>
  (await fs.readdir(folder))
    .map(f => path.join(folder, f))
    .filter(f => fsSync.lstatSync(f).isFile())
    .filter(f => supportedFileExtensions.includes(path.extname(f).toLowerCase().replace('.', '')));
