import { Dialog, DIALOG_DATA, DialogModule, DialogRef } from '@angular/cdk/dialog';
import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, inject } from '@angular/core';
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
export class ConfirmationDialogComponent implements AfterViewInit {
  readonly options = inject<ConfirmationDialogOptions>(DIALOG_DATA);

  readonly dialogRef = inject<DialogRef<boolean>>(DialogRef);

  private readonly elementRef = inject(ElementRef<HTMLElement>);

  ngAfterViewInit(): void {
    // Focus the native button inside ui-action-button. The cdkFocusInitial
    // attribute on the custom-element host cannot focus its internal button.
    const host = this.elementRef.nativeElement as HTMLElement;
    const buttons = host.querySelectorAll(
      'button:not(:disabled)'
    ) as NodeListOf<HTMLButtonElement>;
    const initialButton = this.options.defaultAction === 'cancel'
      ? buttons[1]
      : buttons[0];

    // Run after CDK has attached the overlay and completed its own autofocus.
    requestAnimationFrame(() => initialButton?.focus());
  }

  static readonly open = (dialog: Dialog, options: ConfirmationDialogOptions) =>
    dialog.open<boolean, ConfirmationDialogOptions, ConfirmationDialogComponent>(
      ConfirmationDialogComponent,
      { data: options }
    )
      .closed
      .pipe(filter(result => result === true));
}
