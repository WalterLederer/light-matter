import { app, dialog, ipcMain, IpcMainInvokeEvent } from 'electron';
import { FileListing, supportedFileExtensions } from 'internal-api';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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
  if (process.platform !== 'win32' || !App.mainWindow || App.mainWindow.isDestroyed()) {
    throw new Error('HDR loupe capture is unavailable.');
  }
  const handle = App.mainWindow.getNativeWindowHandle();
  const windowHandle = Number(handle.readBigUInt64LE(0));
  return captureLoupeFrame(windowHandle);
});

ipcMain.handle('Loupe.sample', (_event, x: number, y: number, radius?: number) => sampleLoupeRegion(x, y, radius));
ipcMain.handle('Loupe.release', () => releaseLoupeFrame());

ipcMain.on('quit', (_, code) => app.exit(code));

const readFolder = async (folder: string): Promise<string[]> =>
  (await fs.readdir(folder))
    .map(f => path.join(folder, f))
    .filter(f => fsSync.lstatSync(f).isFile())
    .filter(f => supportedFileExtensions.includes(path.extname(f).toLowerCase().replace('.', '')));
