import { app, dialog, ipcMain, IpcMainInvokeEvent, screen } from 'electron';
import { FileListing, supportedFileExtensions } from 'internal-api';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Injector } from '../../injector/injector';
import { IpcRegistry } from '../decorators/ipc-registry';
import { captureLoupeFrame, releaseLoupeFrame, sampleLoupeRegion } from '../loupe-capture';
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
  let phase = 'prepare application window';
  try {
    if (process.platform !== 'win32' || !App.mainWindow || App.mainWindow.isDestroyed()) {
      throw new Error('HDR loupe capture is unavailable: a live Windows application window is required.');
    }
    const handle = App.mainWindow.getNativeWindowHandle();
    const windowHandle = Number(handle.readBigUInt64LE(0));
    const bounds = App.mainWindow.getBounds();
    const contentBounds = App.mainWindow.getContentBounds();
    const displayScaleFactor = screen.getDisplayMatching(bounds).scaleFactor;
    const expectedMarker = {
      x: (contentBounds.x - bounds.x + contentBounds.width / 2) * displayScaleFactor,
      y: (contentBounds.y - bounds.y + contentBounds.height / 2) * displayScaleFactor
    };
    phase = 'capture FP16 window frame';
    const frame = await captureLoupeFrame(windowHandle, expectedMarker);
    console.debug('[HDR loupe native geometry diagnostic]', {
      windowBoundsDip: bounds,
      contentBoundsDip: contentBounds,
      captureFramePx: { width: frame.width, height: frame.height },
      windowsDisplayScaleFactor: displayScaleFactor,
      expectedMarkerCapturePx: expectedMarker,
      markerPixelDiagnostic: frame.marker,
      captureToWindowScale: {
        x: frame.width / bounds.width,
        y: frame.height / bounds.height
      },
      captureToContentScale: {
        x: frame.width / contentBounds.width,
        y: frame.height / contentBounds.height
      },
      contentInsetDip: {
        left: contentBounds.x - bounds.x,
        top: contentBounds.y - bounds.y,
        right: bounds.x + bounds.width - contentBounds.x - contentBounds.width,
        bottom: bounds.y + bounds.height - contentBounds.y - contentBounds.height
      }
    });
    return { width: frame.width, height: frame.height, x: bounds.x, y: bounds.y, windowWidth: bounds.width, windowHeight: bounds.height, scaleFactor: displayScaleFactor, marker: frame.marker };
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
ipcMain.handle('Loupe.release', () => releaseLoupeFrame());

ipcMain.on('quit', (_, code) => app.exit(code));

const readFolder = async (folder: string): Promise<string[]> =>
  (await fs.readdir(folder))
    .map(f => path.join(folder, f))
    .filter(f => fsSync.lstatSync(f).isFile())
    .filter(f => supportedFileExtensions.includes(path.extname(f).toLowerCase().replace('.', '')));
