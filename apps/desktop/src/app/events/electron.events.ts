import { app, desktopCapturer, dialog, ipcMain, IpcMainInvokeEvent, screen } from 'electron';
import { enumerateMonitors, enumerateWindows, ImageEncoder, ImageEncoderPixelFormat, ImageFormat, ScreenCapture } from '@screen-capture/node';
import { encodeExr, init as initExr } from 'exrs';
import { CaptureResult, CaptureSources, CaptureTarget, FileListing, supportedFileExtensions } from 'internal-api';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
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

interface CapturedHdrFrame {
  targetKey: string;
  width: number;
  height: number;
  buffer: Buffer;
}

let cachedHdrFrame: CapturedHdrFrame | null = null;

const captureTargetKey = (target: CaptureTarget): string => target.kind === 'monitor'
  ? `monitor:${target.index}`
  : `window:${target.handle}`;

const captureHdrFrame = async (target: CaptureTarget): Promise<CapturedHdrFrame> => {
  if (process.platform !== 'win32') throw new Error('HDR capture is currently supported on Windows only.');
  if (target?.kind !== 'monitor' && target?.kind !== 'window') throw new Error('Choose a monitor or application window to capture.');
  const targetKey = captureTargetKey(target);
  const options = target.kind === 'monitor' ? { monitorIndex: target.index } : { windowHandle: target.handle };
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
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const frame = await Promise.race([
      capture.nextFrame(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Timed out waiting for the HDR capture frame.')), 10000); })
    ]).finally(() => { if (timeout !== undefined) clearTimeout(timeout); });
    if (!frame) throw new Error('The selected capture source is no longer available.');
    logPhase('validate FP16 frame');
    if (frame.colorFormat !== 'rgba16F' || frame.rowPitch !== frame.width * 8 || frame.buffer.byteLength !== frame.width * frame.height * 8) {
      throw new Error('The capture did not return the expected packed FP16 HDR frame.');
    }
    const captured: CapturedHdrFrame = {
      targetKey,
      width: frame.width,
      height: frame.height,
      buffer: Buffer.from(frame.buffer)
    };
    cachedHdrFrame = captured;
    logPhase(`FP16 HDR frame ready (${frame.width}x${frame.height})`);
    return captured;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[HDR Capture] Failed during "${phase}": ${message}`);
  } finally {
    await capture.stop().catch(() => undefined);
  }
};

const getHdrFrame = async (target: CaptureTarget): Promise<CapturedHdrFrame> => {
  const key = captureTargetKey(target);
  if (cachedHdrFrame?.targetKey === key) {
    console.info('[HDR Capture] reuse cached FP16 HDR frame');
    return cachedHdrFrame;
  }
  return captureHdrFrame(target);
};
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

  let windows: CaptureSources['windows'] = [];
  const sourceErrors: string[] = [];
  try {
    const enumeratedWindows = enumerateWindows()
      .filter(window => window.isValid && window.title.trim().length > 0 &&
        window.processId !== process.pid &&
        !window.title.trim().toLowerCase().startsWith('light matter'));

    // Use Win32 directly for visibility and process identity. DWM visibility is
    // deliberately not consulted: IsWindowVisible is the sole visibility test.
    const handles = enumeratedWindows.map(window => String(window.handle));
    const script = String.raw`
      $ErrorActionPreference = 'Stop'
      Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class LightMatterWindowNative {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref uint size);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
}
'@
      $handles = ConvertFrom-Json $env:LIGHT_MATTER_WINDOW_HANDLES
      $result = foreach ($rawHandle in $handles) {
        $hwnd = [IntPtr]([Int64]$rawHandle)
        if (-not [LightMatterWindowNative]::IsWindowVisible($hwnd)) { continue }
        [uint32]$processIdValue = 0
        [void][LightMatterWindowNative]::GetWindowThreadProcessId($hwnd, [ref]$processIdValue)
        $exePath = $null
        if ($processIdValue -ne 0) {
          $process = [LightMatterWindowNative]::OpenProcess(0x1000, $false, $processIdValue)
          if ($process -ne [IntPtr]::Zero) {
            try {
              $buffer = New-Object System.Text.StringBuilder 32768
              [uint32]$size = $buffer.Capacity
              if ([LightMatterWindowNative]::QueryFullProcessImageNameW($process, 0, $buffer, [ref]$size)) {
                $exePath = $buffer.ToString()
              }
            } finally {
              [void][LightMatterWindowNative]::CloseHandle($process)
            }
          }
        }
        [pscustomobject]@{ handle = [string]$rawHandle; visible = $true; processId = [uint32]$processIdValue; executablePath = $exePath }
      }
      ConvertTo-Json -InputObject @($result) -Compress -Depth 3
    `;
    const nativeJson = execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', script
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      env: { ...process.env, LIGHT_MATTER_WINDOW_HANDLES: JSON.stringify(handles) }
    }).trim();
    const nativeRows = JSON.parse(nativeJson || '[]') as Array<{
      handle: string;
      visible: boolean;
      processId: number;
      executablePath?: string | null;
    }>;
    const nativeByHandle = new Map(nativeRows.map(row => [String(row.handle), row]));

    windows = enumeratedWindows.flatMap(window => {
      const native = nativeByHandle.get(String(window.handle));
      // Only IsWindowVisible determines whether the window is included.
      if (!native?.visible) return [];
      const executablePath = native.executablePath || undefined;
      const processName = executablePath ? path.basename(executablePath) : 'Unknown executable';
      return [{
        title: window.title.trim(),
        processName,
        executablePath,
        processId: native.processId || window.processId,
        handle: window.handle,
        width: window.width,
        height: window.height,
        monitorIndex: window.monitorIndex
      }];
    }).sort((a, b) => a.title.localeCompare(b.title));
  } catch (nativeError) {
    const message = nativeError instanceof Error ? nativeError.message : String(nativeError);
    sourceErrors.push(`Native window enumeration failed: ${message}`);
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

ipcMain.handle('Capture.preview', async (_event, target: CaptureTarget): Promise<{ width: number; height: number; pixels: Uint16Array }> => {
  console.info('[HDR Capture] preview requested');
  // Always capture a fresh frame for Preview. The resulting frame remains cached
  // so Save can reuse exactly the image the user just inspected.
  const frame = await captureHdrFrame(target);
  const pixels = new Uint16Array(frame.buffer.buffer.slice(frame.buffer.byteOffset, frame.buffer.byteOffset + frame.buffer.byteLength));
  console.info(`[HDR Capture] send FP16 frame to WebGPU preview (${frame.width}x${frame.height})`);
  return { width: frame.width, height: frame.height, pixels };
});

ipcMain.handle('Capture.capture', async (_event, target: CaptureTarget, folder: string, format: 'exr' | 'jxr' = 'exr'): Promise<CaptureResult> => {
  if (format !== 'exr' && format !== 'jxr') throw new Error('Choose EXR or JXR as the capture format.');
  if (process.platform !== 'win32') throw new Error('HDR capture is currently supported on Windows only.');
  if (!folder || !path.isAbsolute(folder)) throw new Error('Choose a valid destination folder before capturing.');
  if (target?.kind !== 'monitor' && target?.kind !== 'window') throw new Error('Choose a monitor or application window to capture.');

  let phase = 'get FP16 HDR frame';
  const logPhase = (nextPhase: string): void => {
    phase = nextPhase;
    console.info(`[HDR Capture] ${phase}`);
  };
  try {
    const frame = await getHdrFrame(target);
    const sourceChannels = new Uint16Array(frame.buffer.buffer, frame.buffer.byteOffset, frame.buffer.byteLength / 2);
    let encoded: Buffer | Uint8Array;
    if (format === 'jxr') {
      logPhase('pack RGBA16F input and encode JPEG XR');
      // Keep the native RGBA16F layout. The Windows JPEG XR encoder reported
      // WINCODEC_ERR_INSUFFICIENTBUFFER when given a tightly packed RGB16F buffer.
      // Use the encoder's RGBA16F pixel format so channel order and row size agree.
      const rgba = Buffer.allocUnsafe(frame.width * frame.height * 4 * 2);
      for (let channelIndex = 0; channelIndex < sourceChannels.length; channelIndex++) {
        const channel = channelIndex % 4;
        const value = halfToFloat(sourceChannels[channelIndex]) * (channel === 3 ? 1 : CAPTURE_BRIGHTNESS_CORRECTION);
        rgba.writeUInt16LE(floatToHalf(value), channelIndex * 2);
      }
      const encoder = new ImageEncoder(ImageFormat.JpegXr, ImageEncoderPixelFormat.Rgb16F);
      encoded = encoder.encode(rgba, frame.width, frame.height);
    } else {
      logPhase(`convert native RGBA16F to Float32 RGBA (${frame.width}x${frame.height}) without brightness correction`);
      const rgba = new Float32Array(frame.width * frame.height * 4);
      for (let source = 0; source < sourceChannels.length; source++) {
        rgba[source] = halfToFloat(sourceChannels[source]);
      }
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
    while (fsSync.existsSync(outputPath)) outputPath = path.join(folder, `${baseName}_${suffix++}.${format}`);
    await fs.writeFile(outputPath, encoded, { flag: 'wx' });
    if (cachedHdrFrame === frame) cachedHdrFrame = null;
    return { path: outputPath, width: frame.width, height: frame.height };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[HDR Capture] Failed during "${phase}": ${message}`);
  }
});


ipcMain.on('quit', (_, code) => app.exit(code));

const readFolder = async (folder: string): Promise<string[]> =>
  (await fs.readdir(folder))
    .map(f => path.join(folder, f))
    .filter(f => fsSync.lstatSync(f).isFile())
    .filter(f => supportedFileExtensions.includes(path.extname(f).toLowerCase().replace('.', '')));
