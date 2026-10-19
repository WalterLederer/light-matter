import { IpcMainInvokeEvent } from 'electron';
import { ExifTool } from 'exiftool-vendored';
import { open } from 'node:fs/promises';
import { ApiResponse, ExifTags } from 'internal-api';
import { IpcHandler } from '../app/decorators/ipc-handler';

export class Exif {
  private readonly exifTool = new ExifTool();

  @IpcHandler({ name: 'Exif.read' })
  readonly read = async (_: IpcMainInvokeEvent, path: string): Promise<ApiResponse<ExifTags>> => {
    try {
      const tags = await this.exifTool.read(path);

      if (/\.jpe?g$/i.test(path) && await this.hasUltraHdrGainMap(path)) {
        (tags as ExifTags & { HDRGainMap?: boolean }).HDRGainMap = true;
      }

      return { success: true, data: tags };
    } catch (e) {
      return { success: false, errorMessage: e.message };
    }
  };

  private readonly hasUltraHdrGainMap = async (path: string): Promise<boolean> => {
    const file = await open(path, 'r');

    try {
      const buffer = Buffer.alloc(1024 * 1024);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return /hdrgm|gainmap|mincontentboost|maxcontentboost|ultrahdr/i.test(buffer.subarray(0, bytesRead).toString('latin1'));
    } finally {
      await file.close();
    }
  };
}
