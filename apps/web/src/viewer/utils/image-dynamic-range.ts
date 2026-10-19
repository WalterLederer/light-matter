import { ExifTags } from 'internal-api';

export type ImageDynamicRange = 'HDR' | 'SDR';

export function imageDynamicRange(path: string, tags: ExifTags | null, bitDepth: string | null): ImageDynamicRange {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  const depth = Number.parseInt(String(tags?.BitsPerSample ?? tags?.BitDepth ?? bitDepth ?? ''), 10);
  const metadata = Object.entries(tags ?? {})
    .map(([ key, value ]) => `${key} ${JSON.stringify(value)}`)
    .join(' ')
    .toLowerCase();

  if (extension === 'exr' || extension === 'hdr') {
    return 'HDR';
  }

  if (extension === 'jxr' || extension === 'jxl') {
    return 'HDR';
  }

  if (/gain.?map|jpegr|hdrimage|smpte.?2084|st.?2084|\bpq\b|\bhlg\b|arib/i.test(metadata)) {
    return 'HDR';
  }

  if ([ 'avif', 'heif', 'heic', 'png', 'tif', 'tiff' ].includes(extension) && depth >= 10) {
    return 'HDR';
  }

  return 'SDR';
}
