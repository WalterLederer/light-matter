import { Injectable } from '@angular/core';
import { CacheClearResult, CacheInfo, DesktopCacheManager } from 'internal-api';

@Injectable({ providedIn: 'root' })
export class CacheManager implements DesktopCacheManager {
  readonly clear = (): Promise<CacheClearResult> => window.desktop.CacheManager.clear();

  readonly clearFullSize = (): Promise<CacheClearResult> => window.desktop.CacheManager.clearFullSize();

  readonly clearThumbnails = (): Promise<CacheClearResult> => window.desktop.CacheManager.clearThumbnails();

  readonly cacheSize = () => window.desktop.CacheManager.cacheSize();

  readonly cacheInfo = (): Promise<CacheInfo> => window.desktop.CacheManager.cacheInfo();

  readonly imageCachePath = (sourceName: string): Promise<string | null> =>
    window.desktop.CacheManager.imageCachePath(sourceName);

  readonly openCacheFolder = () => window.desktop.CacheManager.openCacheFolder();
}
