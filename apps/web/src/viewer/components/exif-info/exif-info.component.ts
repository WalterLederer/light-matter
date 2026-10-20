import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { ExifTags } from 'internal-api';
import { ByteSizePipe } from '../../../ui/pipes/byte-size/byte-size.pipe';
import { ImageDimensions } from '../../services/image-positioning/image-positioning.types';

@Component({
  selector: 'app-exif-info',
  imports: [ DatePipe, ByteSizePipe ],
  templateUrl: './exif-info.component.html',
  styleUrl: './exif-info.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ExifInfoComponent {
  /* Inputs */
  readonly exif = input<false | ExifTags>(false);

  readonly dimensions = input<ImageDimensions>({ width: 0, height: 0 });

  readonly fileSize = input(0);

  readonly bitDepth = input<string | null>(null);

  readonly modifiedAt = input<number | undefined>(undefined);
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
