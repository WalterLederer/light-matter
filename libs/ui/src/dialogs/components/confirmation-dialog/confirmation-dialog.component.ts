import { Dialog, DIALOG_DATA, DialogModule, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, inject } from '@angular/core';
import { filter } from 'rxjs';
import { ActionButtonComponent } from '../../../actions';
import { TextComponent, TitleComponent } from '../../../content';
import { DialogComponent } from '../dialog/dialog.component';

export interface ConfirmationDialogOptions {
  title: string;
  description: string;
  confirmLabel?: string;
  defaultAction?: 'confirm' | 'cancel';
}

@Component({
  selector: 'ui-confirmation-dialog',
  imports: [
    DialogModule,
    DialogComponent,
    TitleComponent,
    TextComponent,
    ActionButtonComponent
  ],
  templateUrl: './confirmation-dialog.component.html',
  styleUrl: './confirmation-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ConfirmationDialogComponent {
  readonly options = inject<ConfirmationDialogOptions>(DIALOG_DATA);

  readonly dialogRef = inject<DialogRef<boolean>>(DialogRef);

  private readonly elementRef = inject(ElementRef<HTMLElement>);

  @HostListener('document:keydown', ['$event'])
  protected readonly handleDialogArrowKeys = (event: KeyboardEvent): void => {
    // The document-level listener also works when focus is managed by the CDK
    // overlay or focus trap. Ignore key presses that originate outside this dialog.
    if (!event.composedPath().includes(this.elementRef.nativeElement)) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

    const buttons = this.elementRef.nativeElement.querySelectorAll(
      'button:not(:disabled)'
    ) as NodeListOf<HTMLButtonElement>;
    if (buttons.length < 2) return;

    event.preventDefault();
    event.stopPropagation();

    const activeElement = this.elementRef.nativeElement.ownerDocument.activeElement;
    let activeIndex = -1;
    buttons.forEach((button, index) => {
      if (button === activeElement) activeIndex = index;
    });

    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex = activeIndex < 0
      ? (direction > 0 ? 0 : buttons.length - 1)
      : (activeIndex + direction + buttons.length) % buttons.length;
    buttons[nextIndex].focus();
  };

  static readonly open = (dialog: Dialog, options: ConfirmationDialogOptions) =>
    dialog.open<boolean, ConfirmationDialogOptions, ConfirmationDialogComponent>(
      ConfirmationDialogComponent,
      { data: options }
    )
      .closed
      .pipe(filter(result => result === true));
}
