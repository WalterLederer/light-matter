import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';
import { fromEvent, share } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class Keyboard {
  private readonly document = inject(DOCUMENT);

  private readonly keydown$ = fromEvent<KeyboardEvent>(this.document, 'keydown', { capture: true }).pipe(share());

  private readonly keyup$ = fromEvent<KeyboardEvent>(this.document, 'keyup').pipe(share());

  readonly keydown = () => this.keydown$;

  readonly keyup = () => this.keyup$;
}
