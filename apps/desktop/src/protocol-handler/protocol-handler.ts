import { appPaths } from 'internal-api';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import * as url from 'node:url';
import { Injector } from '../injector/injector';

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jxl': 'image/jxl',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.heif': 'image/heif',
  '.heic': 'image/heic',
  '.exr': 'image/x-exr',
  '.hdr': 'image/vnd.radiance',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.bmp': 'image/bmp'
};

export const getMimeType = (filePath: string): string => {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
};

export const streamFile = (filePath: string): GlobalResponse => {
  if (!existsSync(filePath)) {
    return notFound();
  }

  try {
    const mimeType = getMimeType(filePath);
    const nodeStream = createReadStream(filePath);
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

    return new Response(webStream, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (err) {
    console.error(`[protocolHandler] Failed to stream file ${filePath}:`, err);
    return notFound();
  }
};

const fullSizeCacheStatus = new Map<string, boolean>();

export const protocolHandler = async (request: GlobalRequest): Promise<GlobalResponse> => {
  const parsed = new url.URL(request.url);

  switch (parsed.pathname) {
    case appPaths.thumbs:
      return await thumb(parsed.searchParams, request.signal);

    case appPaths.raw:
      return await raw(parsed.searchParams, request.signal);

    case appPaths.histogram:
      return await histogram(parsed.searchParams, request.signal);

    case appPaths.conversionTime:
      return await conversionTime(parsed.searchParams);

    default:
      return notFound();
  }
};

const conversionTime = async (params: URLSearchParams): Promise<GlobalResponse> => {
  const fileName = params.get('image');
  if (fileName === null) return notFound();

  try {
    const thumbManager = Injector.getInstance().inject('ThumbManager');
    const durationMs = thumbManager.fullSizeConversionDuration(fileName);
    const fromCache = fullSizeCacheStatus.get(resolve(fileName)) ?? null;
    return new Response(JSON.stringify({ durationMs, fromCache }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
    });
  } catch (error) {
    console.error('[protocolHandler] Failed to read conversion timing:', error);
    return new Response(JSON.stringify({ durationMs: null }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
    });
  }
};

const histogram = async (params: URLSearchParams, signal?: AbortSignal): Promise<GlobalResponse> => {
  const fileName = params.get('image');

  if (fileName === null || signal?.aborted) {
    return notFound();
  }

  try {
    const extension = extname(fileName).toLowerCase();
    let source = fileName;

    if ([ '.jxr', '.avif', '.heif', '.heic', '.exr', '.hdr', '.tif', '.tiff' ].includes(extension)) {
      const injector = Injector.getInstance();
      const cacheManager = injector.inject('CacheManager');
      const thumbManager = injector.inject('ThumbManager');
      const isTiff = [ '.tif', '.tiff' ].includes(extension);
      const tag = `${extension.slice(1)}-full-${isTiff ? 'hdr-v6' : 'uhdr'}`;
      const result = await cacheManager.get(
        fileName,
        tag,
        async target => await thumbManager.generate(fileName, target, 0, 0),
        '.jpg'
      );

      if (signal?.aborted || result === null) {
        if (signal?.aborted) {
          return notFound();
        }

        throw new Error(`Could not decode ${extension} image for histogram.`);
      }

      source = result;
    }

    const result = await Injector.getInstance().inject('ThumbManager').histogram(source);
    if (result === null) {
      throw new Error('Histogram worker returned no image data.');
    }

    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('[protocolHandler] Failed to calculate image histogram:', error);
    const message = error instanceof Error ? error.message : String(error);
    return new Response(message, { status: 500, headers: { 'Content-Type': 'text/plain' } });
  }
};

const thumb = async (params: URLSearchParams, signal?: AbortSignal): Promise<GlobalResponse> => {
  const fileName = params.get('image');
  const width = Number(params.get('width'));
  const height = Number(params.get('height'));

  if (fileName === null || signal?.aborted) {
    return notFound();
  }

  try {
    const isJxr = extname(fileName).toLowerCase() === '.jxr';
    const isAvif = extname(fileName).toLowerCase() === '.avif';
    const isHeif = [ '.heif', '.heic' ].includes(extname(fileName).toLowerCase());
    const isExr = extname(fileName).toLowerCase() === '.exr';
    const isRadiance = extname(fileName).toLowerCase() === '.hdr';
    const isTiff = [ '.tif', '.tiff' ].includes(extname(fileName).toLowerCase());
    const tag = `${width}x${height}${isJxr ? '-jxr-uhdr' : isAvif ? '-avif' : isHeif ? '-heif' : isExr ? '-exr-uhdr-v2' : isRadiance ? '-radiance-hdr' : isTiff ? '-tiff-hdr-v6' : ''}`;
    const injector = Injector.getInstance();
    const cacheManager = injector.inject('CacheManager');
    const thumbManager = injector.inject('ThumbManager');

    const result = await cacheManager.get(
      fileName,
      tag,
      async target => {
        if (signal?.aborted) {
          return false;
        }

        return await thumbManager.generate(
          fileName,
          target,
          width,
          height,
          signal
        );
      },
      isJxr || isAvif || isHeif || isExr || isRadiance || isTiff ? '.jpg' : undefined
    );

    if (signal?.aborted) {
      return notFound();
    }

    if ((isJxr || isAvif || isHeif || isExr || isRadiance || isTiff) && result === null) {
      return notFound();
    }

    const filePath = result === null ? fileName : result;
    return streamFile(filePath);
  } catch (_error) {
    console.error(_error);
    return notFound();
  }
};

const raw = async (params: URLSearchParams, signal?: AbortSignal): Promise<GlobalResponse> => {
  const fileName = params.get('image');

  if (fileName === null) {
    return notFound();
  }

  try {
    if ([ '.jxr', '.avif', '.heif', '.heic', '.exr', '.hdr', '.tif', '.tiff' ].includes(extname(fileName).toLowerCase())) {
      const injector = Injector.getInstance();
      const cacheManager = injector.inject('CacheManager');
      const thumbManager = injector.inject('ThumbManager');
      const extension = extname(fileName).toLowerCase();
      const cacheTag = `${extension.slice(1)}${[ '.tif', '.tiff' ].includes(extension) ? '-full-hdr-v6' : extension === '.exr' ? '-full-uhdr-v2' : '-full-uhdr'}`;
      const cacheEntry = cacheManager.exists(fileName, cacheTag);
      let wasCacheHit = false;
      if (cacheEntry && typeof cacheEntry['target_path'] === 'string' && existsSync(cacheEntry['target_path'])) {
        try {
          const sourceStats = statSync(fileName);
          wasCacheHit = cacheEntry['source_size'] === sourceStats.size
            && cacheEntry['updated_at'] === sourceStats.mtimeMs;
        } catch {
          wasCacheHit = false;
        }
      }

      const result = await cacheManager.get(
        fileName,
        cacheTag,
        // Full-size conversions are shared with histogram requests through CacheManager.
        // Let the shared conversion finish even if this particular renderer request is aborted.
        async target => await thumbManager.generate(fileName, target, 0, 0),
        '.jpg'
      );
      if (result !== null) {
        fullSizeCacheStatus.set(resolve(fileName), wasCacheHit);
      }

      if (signal?.aborted || result === null) {
        return notFound();
      }

      return streamFile(result);
    }

    return streamFile(fileName);
  } catch (_error) {
    console.error(_error);
    return notFound();
  }
};

const notFound = () => new Response('Not found', { status: 404 });
