import { app, dialog, ipcMain, IpcMainInvokeEvent, screen } from 'electron';
import { enumerateMonitors } from '@screen-capture/node';
import { FileListing, supportedFileExtensions } from 'internal-api';
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
    console.debug('[HDR loupe native geometry diagnostic]', {
      displayBoundsDip: display.bounds,
      captureFramePx: { width: frame.width, height: frame.height },
      windowsDisplayScaleFactor: display.scaleFactor,
      monitorIndex,
      expectedFramePx: { width: expectedWidth, height: expectedHeight },
      captureToDisplayScale: {
        x: frame.width / display.bounds.width,
        y: frame.height / display.bounds.height
      }
    });
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

ipcMain.on('quit', (_, code) => app.exit(code));

const readFolder = async (folder: string): Promise<string[]> =>
  (await fs.readdir(folder))
    .map(f => path.join(folder, f))
    .filter(f => fsSync.lstatSync(f).isFile())
    .filter(f => supportedFileExtensions.includes(path.extname(f).toLowerCase().replace('.', '')));
