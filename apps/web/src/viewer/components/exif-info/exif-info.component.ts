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
}
