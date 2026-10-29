import { Injectable, signal } from '@angular/core';
import { CapturePreview } from 'internal-api';

/**
 * Keeps the most recently rendered native FP16 capture frame available when
 * the Capture panel is destroyed while switching sidebar tabs.
 */
@Injectable({ providedIn: 'root' })
export class CapturePreviewStore {
  readonly frame = signal<CapturePreview | null>(null);

  setFrame(frame: CapturePreview): void {
    this.frame.set(frame);
  }
}
