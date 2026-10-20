import { ExifTags } from 'internal-api';

export type ImageDynamicRange = 'HDR' | 'SDR';

export function imageDynamicRange(path: string, tags: ExifTags | null, bitDepth: string | null): ImageDynamicRange {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  const depth = Number.parseInt(String(tags?.BitsPerSample ?? tags?.BitDepth ?? bitDepth ?? ''), 10);

  // Exif/XMP readers may expose Ultra HDR metadata as nested objects or as flattened
  // tag names. Include keys and values at every level rather than only top-level fields.
  const flattenMetadata = (value: unknown): string => {
    if (value === null || value === undefined) {
      return '';
    }
    if (Array.isArray(value)) {
      return value.map(flattenMetadata).join(' ');
    }
    if (typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>)
        .map(([ key, nested ]) => `${key} ${flattenMetadata(nested)}`)
        .join(' ');
    }
    return String(value);
  };
  const metadata = flattenMetadata(tags).toLowerCase();

  if (extension === 'exr' || extension === 'hdr' || extension === 'jxr' || extension === 'jxl') {
    return 'HDR';
  }

  // Ultra HDR JPEGs commonly signal the gain map through XMP/HDRGM fields.
  // Do not infer HDR from a reported peak-nit value alone: that value can describe
  // the gain map or display capability, not prove that this JPEG contains HDR data.
  if (/gain.?map|hdr.?gm|jpegr|hdrimage|hdr.?capacity|iso.?21496|smpte.?2084|st.?2084|\\bpq\\b|\\bhlg\\b|arib/i.test(metadata)) {
    return 'HDR';
  }

  if ([ 'avif', 'heif', 'heic', 'png', 'tif', 'tiff' ].includes(extension) && depth >= 10) {
    return 'HDR';
  }

  return 'SDR';
}
