import { app, dialog, ipcMain, IpcMainInvokeEvent, screen } from 'electron';
import { enumerateMonitors, enumerateWindows, ImageEncoder, ImageEncoderPixelFormat, ImageFormat, ScreenCapture } from '@screen-capture/node';
import { CaptureResult, CaptureSources, CaptureTarget, FileListing, supportedFileExtensions } from 'internal-api';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Injector } from '../../injector/injector';
import { IpcRegistry } from '../decorators/ipc-registry';
import { captureLoupeFrame, releaseLoupeFrame, sampleLoupeRegion, sampleLoupeRectangle } from '../loupe-capture';
import App from '../app';

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

ipcMain.handle('Capture.listSources', (): CaptureSources => {
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sourceErrors.push(`Could not enumerate application windows: ${message}`);
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

ipcMain.handle('Capture.capture', async (_event, target: CaptureTarget, folder: string): Promise<CaptureResult> => {
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

  try {
    await capture.start();
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
    if (frame.colorFormat !== 'rgba16F' || frame.rowPitch !== frame.width * 8 ||
        frame.buffer.byteLength !== frame.width * frame.height * 8) {
      throw new Error('The capture did not return the expected packed FP16 HDR frame.');
    }

    // JPEG XR's RGB16F encoder expects three half-float channels, without RGBA alpha.
    const rgb = Buffer.allocUnsafe(frame.width * frame.height * 6);
    for (let source = 0, destination = 0; source < frame.buffer.length; source += 8, destination += 6) {
      frame.buffer.copy(rgb, destination, source, source + 6);
    }
    const encoder = new ImageEncoder(ImageFormat.JpegXr, ImageEncoderPixelFormat.Rgb16F);
    const encoded = encoder.encode(rgb, frame.width, frame.height);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseName = `LightMatter_Capture_${stamp}`;
    let outputPath = path.join(folder, `${baseName}.jxr`);
    let suffix = 1;
    while (fsSync.existsSync(outputPath)) {
      outputPath = path.join(folder, `${baseName}_${suffix++}.jxr`);
    }
    await fs.writeFile(outputPath, encoded, { flag: 'wx' });
    return { path: outputPath, width: frame.width, height: frame.height };
  } finally {
    await capture.stop().catch(() => undefined);
  }
});


ipcMain.on('quit', (_, code) => app.exit(code));

const readFolder = async (folder: string): Promise<string[]> =>
  (await fs.readdir(folder))
    .map(f => path.join(folder, f))
    .filter(f => fsSync.lstatSync(f).isFile())
    .filter(f => supportedFileExtensions.includes(path.extname(f).toLowerCase().replace('.', '')));
