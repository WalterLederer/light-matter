import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { Desktop, SortDirection, SortType } from 'internal-api';

const api: Desktop = {
  ProcessManager: {
    getAppVersion: () => ipcRenderer.invoke('ProcessManager.getAppVersion'),
    isPackaged: () => ipcRenderer.invoke('ProcessManager.isPackaged'),
    getDevToolsOpen: () => ipcRenderer.invoke('ProcessManager.getDevToolsOpen'),
    setDevToolsOpen: (open: boolean) => ipcRenderer.invoke('ProcessManager.setDevToolsOpen', open),
    getPlatform: () => ipcRenderer.invoke('ProcessManager.getPlatform'),
    argv: () => ipcRenderer.invoke('ProcessManager.argv'),
    getSystemPaths: () => ipcRenderer.invoke('ProcessManager.getSystemPaths'),
    openConfigFile: () => ipcRenderer.invoke('ProcessManager.openConfigFile'),
    quit: (code: number) => ipcRenderer.invoke('ProcessManager.quit', code),
    setWindowTitle: (title: string) => ipcRenderer.invoke('ProcessManager.setWindowTitle', title)
  },

  FileSystem: {
    join: (...paths: string[]) => ipcRenderer.invoke('FileSystem.join', ...paths),
    dirname: (fileName: string) => ipcRenderer.invoke('FileSystem.dirname', fileName),
    readDir: (path: string) => ipcRenderer.invoke('FileSystem.readDir', path),
    readJson: (path: string) => ipcRenderer.invoke('FileSystem.readJson', path),
    writeJson: <T>(path: string, data: T) => ipcRenderer.invoke('FileSystem.writeJson', path, data),
    readGalleryLocation: (path: string) => ipcRenderer.invoke('FileSystem.readGalleryLocation', path),
    readDirectories: (path: string) => ipcRenderer.invoke('FileSystem.readDirectories', path),
    readImages: (path: string, sortBy: SortType, sortDir: SortDirection) =>
      ipcRenderer.invoke('FileSystem.readImages', path, sortBy, sortDir),
    deleteFile: (path: string) => ipcRenderer.invoke('FileSystem.deleteFile', path),
    copyFile: (sourcePath: string, destinationDirectory: string) =>
      ipcRenderer.invoke('FileSystem.copyFile', sourcePath, destinationDirectory)
  },

  Dialogs: {
    openFolder: (initialPath?: string) => ipcRenderer.invoke('Dialogs.openFolder', initialPath)
  },

  Exif: {
    read: (path: string) => ipcRenderer.invoke('Exif.read', path)
  },

  CacheManager: {
    clear: () => ipcRenderer.invoke('CacheManager.clear'),
    clearFullSize: () => ipcRenderer.invoke('CacheManager.clearFullSize'),
    clearThumbnails: () => ipcRenderer.invoke('CacheManager.clearThumbnails'),
    cacheSize: () => ipcRenderer.invoke('CacheManager.cacheSize'),
    cacheInfo: () => ipcRenderer.invoke('CacheManager.cacheInfo'),
    imageCachePath: (sourceName: string) => ipcRenderer.invoke('CacheManager.imageCachePath', sourceName),
    openCacheFolder: () => ipcRenderer.invoke('CacheManager.openCacheFolder')
  },

  Histogram: {
    calculate: (path: string) => ipcRenderer.invoke('Histogram.calculate', path)
  },

  Loupe: {
    capture: () => ipcRenderer.invoke('Loupe.capture'),
    sample: (x: number, y: number, radius?: number) => ipcRenderer.invoke('Loupe.sample', x, y, radius),
    region: (x: number, y: number, width: number, height: number) => ipcRenderer.invoke('Loupe.region', x, y, width, height),
    release: () => ipcRenderer.invoke('Loupe.release'),
    onWindowGeometryChanged: (callback: () => void) => {
      const listener = (): void => callback();
      ipcRenderer.on('Loupe.windowGeometryChanged', listener);
      return () => ipcRenderer.removeListener('Loupe.windowGeometryChanged', listener);
    }
  },

  Capture: {
    listSources: () => ipcRenderer.invoke('Capture.listSources'),
    chooseFolder: (initialPath?: string) => ipcRenderer.invoke('Capture.chooseFolder', initialPath),
    preview: target => ipcRenderer.invoke('Capture.preview', target),
    capture: (target, folder: string, format?: 'exr' | 'jxr' | 'uhdr', gammaCorrection?: number) => ipcRenderer.invoke('Capture.capture', target, folder, format, gammaCorrection)
  },

  // TODO: Deprecated methods, should be moved into a handler class in the future
  openFolder: () => ipcRenderer.invoke('openFolder'),
  openFile: () => ipcRenderer.invoke('openFile'),
  openFileFromArgs: (fileName: string) => ipcRenderer.invoke('openFileFromArgs', fileName),
  getPathForFile: (file: File) => webUtils.getPathForFile(file)
};

contextBridge.exposeInMainWorld('desktop', api);
