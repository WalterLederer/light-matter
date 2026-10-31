import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { ExifTags } from 'internal-api';
import { ByteSizePipe } from '../../../ui/pipes/byte-size/byte-size.pipe';
import { ImageDimensions } from '../../services/image-positioning/image-positioning.types';
import { imageDynamicRangeDiagnostics } from '../../utils/image-dynamic-range';
import { CacheManager } from '../../../ipc/cache-manager';

@Component({
  selector: 'app-exif-info',
  imports: [ DatePipe, DecimalPipe, ByteSizePipe ],
  templateUrl: './exif-info.component.html',
  styleUrl: './exif-info.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ExifInfoComponent {
  /* Inputs */
  readonly mode = input<'image' | 'cache'>('image');
  readonly exif = input<false | ExifTags>(false);

  readonly dimensions = input<ImageDimensions>({ width: 0, height: 0 });

  readonly fileSize = input(0);

  readonly bitDepth = input<string | null>(null);

  readonly modifiedAt = input<number | undefined>(undefined);

  readonly decoderName = input<string | null>(null);

  readonly loadDuration = input<number | null>(null);

  readonly decodeDuration = input<number | null>(null);

  readonly totalDuration = input<number | null>(null);

  readonly conversionDuration = input<number | null>(null);
  readonly fullSizeFromCache = input<boolean | null>(null);

  readonly requiresConversion = input(false);

  readonly path = input('');

  private readonly cacheManager = inject(CacheManager);

  readonly cachePath = signal<string | null>(null);

  readonly cachePathLoading = signal(false);

  readonly copyCachePathStatus = signal('');

  private cachePathRequestId = 0;
  readonly cachePathRefresh = signal(0);

  constructor() {
    effect(() => {
      const sourcePath = this.path();
      this.cachePathRefresh();
      // Recheck after the image load completes: the raw-image request may still be
      // generating the full-size derivative when this component first appears.
      this.loadDuration();
      const requestId = ++this.cachePathRequestId;
      this.cachePath.set(null);
      this.cachePathLoading.set(!!sourcePath);
      if (!sourcePath) {
        this.cachePathLoading.set(false);
        return;
      }

      this.cacheManager.imageCachePath(sourcePath).then(path => {
        if (requestId !== this.cachePathRequestId) return;
        this.cachePath.set(path);
        this.cachePathLoading.set(false);
      }).catch(error => {
        if (requestId !== this.cachePathRequestId) return;
        console.error('Failed to retrieve image cache path', error);
        this.cachePath.set(null);
        this.cachePathLoading.set(false);
      });
    });
  }

  readonly refreshCachePath = (): void => this.cachePathRefresh.update(value => value + 1);

  readonly rawImageUrl = (): string => {
    const sourcePath = this.path();
    return sourcePath ? `atom://app/raw?image=${encodeURIComponent(sourcePath)}` : '';
  };

  readonly normalizedCachePath = (): string => {
    const value = this.cachePath() ?? '';
    // Display cache paths with native Windows separators and single backslashes.
    return value.replace(/\//g, '\\').replace(/\\{2,}/g, '\\');
  };

  readonly copyCachePath = async (): Promise<void> => {
    const path = this.normalizedCachePath();
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      this.copyCachePathStatus.set('Copied');
      window.setTimeout(() => this.copyCachePathStatus.set(''), 1800);
    } catch (error) {
      console.error('Failed to copy cache path to clipboard', error);
      this.copyCachePathStatus.set('Copy failed');
      window.setTimeout(() => this.copyCachePathStatus.set(''), 2500);
    }
  };

  readonly normalizedPath = () => {
    const value = this.path();
    // Windows drive-letter and UNC paths must be copied with native backslashes.
    if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('//')) {
      const windowsPath = value.replace(/\//g, '\\');
      // Preserve the two leading separators of a UNC path, but collapse doubled
      // separators everywhere else (some file sources already escape them).
      if (windowsPath.startsWith('\\\\')) {
        return '\\\\' + windowsPath.slice(2).replace(/\\{2,}/g, '\\');
      }
      return windowsPath.replace(/\\{2,}/g, '\\');
    }
    // For non-Windows paths, preserve Unix-style separators.
    return value.replace(/\\/g, '/');
  };

  readonly dynamicRangeDiagnostics = () => {
    const data = this.exif();
    return imageDynamicRangeDiagnostics(this.path(), data === false ? null : data, this.bitDepth());
  };
  /** Raw HDR-related tags exposed by ExifTool, for verifying dynamic-range detection. */
  readonly hdrMetadata = () => {
    const data = this.exif();
    if (data === false) {
      return [];
    }

    const marker = /hdr|gain.?map|hdrgm|\bpq\b|\bhlg\b|cicp|transfer.?characteristic|color.?primar|colour.?primar|mastering|content.?light|light.?level|smpte|2084|21496|gamma/i;
    return Object.entries(data as Record<string, unknown>)
      .filter(([ key, value ]) => ![ 'sourcefile', 'directory' ].includes(key.toLowerCase()) && (marker.test(key) || marker.test(String(value ?? ''))))
      .map(([ key, value ]) => ({ key, value: Array.isArray(value) ? value.join(', ') : String(value) }))
      .filter(item => item.value.length > 0)
      .sort((a, b) => a.key.localeCompare(b.key));
  };

}
