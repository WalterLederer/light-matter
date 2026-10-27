import { Injectable } from '@angular/core';
import { CaptureFormat, CapturePreview, CaptureResult, CaptureSources, CaptureTarget, DesktopCapture } from 'internal-api';

@Injectable({ providedIn: 'root' })
export class CaptureService implements DesktopCapture {
  readonly listSources = (): Promise<CaptureSources> => window.desktop.Capture.listSources();

  readonly chooseFolder = (initialPath?: string): Promise<string | null> =>
    window.desktop.Capture.chooseFolder(initialPath);

  readonly preview = (target: CaptureTarget): Promise<CapturePreview> =>
    window.desktop.Capture.preview(target);

  readonly capture = (target: CaptureTarget, folder: string, format?: CaptureFormat): Promise<CaptureResult> =>
    window.desktop.Capture.capture(target, folder, format);
}
