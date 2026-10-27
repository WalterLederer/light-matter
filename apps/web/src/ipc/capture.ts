import { Injectable } from '@angular/core';
import { CaptureResult, CaptureSources, CaptureTarget, DesktopCapture } from 'internal-api';

@Injectable({ providedIn: 'root' })
export class CaptureService implements DesktopCapture {
  readonly listSources = (): Promise<CaptureSources> => window.desktop.Capture.listSources();

  readonly chooseFolder = (initialPath?: string): Promise<string | null> =>
    window.desktop.Capture.chooseFolder(initialPath);

  readonly capture = (target: CaptureTarget, folder: string): Promise<CaptureResult> =>
    window.desktop.Capture.capture(target, folder);
}
