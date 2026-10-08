import { useRef, type ReactNode, type RefObject } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { cx } from '../../lib/cx';
import { Button } from '../Button';
import { isConfirmKey } from './confirmKey';
import styles from './Sheet.module.css';

export interface SheetAction {
  label: ReactNode;
  onAction?: () => void;
  disabled?: boolean;
  /** Red label (e.g. "Delete"). */
  destructive?: boolean;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
}

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** One-line explanation under the title. */
  description?: ReactNode;
  /** Body content (form fields, previews…). */
  children?: ReactNode;
  /** Default button (accent). Return triggers it. The handler closes the sheet when done. */
  primaryAction?: SheetAction;
  /**
   * Cancel button; Esc triggers it. Defaults to "Cancel", which closes the sheet.
   * Pass null for no secondary button.
   */
  secondaryAction?: SheetAction | null;
  /** Called when the sheet is dismissed with Esc or the Cancel button. */
  onCancel?: () => void;
  /** Footer content aligned to the start (help button, "Don't ask again" checkbox…). */
  footerStart?: ReactNode;
  /** Width in px (default 480). */
  width?: number;
  /** Element focused when the sheet opens (default: the first focusable element). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
}

/**
 * macOS document-modal sheet: slides down from under the window toolbar, dims the window
 * slightly, traps focus. Return = primary action, Esc = cancel.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  primaryAction,
  secondaryAction,
  onCancel,
  footerStart,
  width = 480,
  initialFocusRef,
  className,
}: SheetProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const cancel = () => {
    if (secondaryAction?.onAction) secondaryAction.onAction();
    onCancel?.();
    onOpenChange(false);
  };
  const secondary: SheetAction | null = secondaryAction === null ? null : (secondaryAction ?? { label: 'Cancel' });
  const hasFooter = !!primaryAction || !!secondary || !!footerStart;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => (o ? onOpenChange(true) : cancel())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={styles.overlay} />
        <div className={styles.viewport}>
          <DialogPrimitive.Content
            ref={contentRef}
            className={cx(styles.sheet, className)}
            style={{ width }}
            {...(description ? {} : { 'aria-describedby': undefined })}
            onOpenAutoFocus={(e) => {
              if (initialFocusRef?.current) {
                e.preventDefault();
                initialFocusRef.current.focus();
              }
            }}
            onKeyDown={(e) => {
              if (!primaryAction || primaryAction.disabled || primaryAction.loading) return;
              if (isConfirmKey(e, contentRef.current)) {
                e.preventDefault();
                primaryAction.onAction?.();
              }
            }}
          >
            <div className={styles.header}>
              <DialogPrimitive.Title className={styles.title}>{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className={styles.description}>{description}</DialogPrimitive.Description>
              ) : null}
            </div>
            {children != null ? <div className={styles.body}>{children}</div> : null}
            {hasFooter ? (
              <div className={styles.footer}>
                <div className={styles.footerStart}>{footerStart}</div>
                {secondary ? (
                  <Button
                    variant={secondary.destructive ? 'destructive' : 'default'}
                    disabled={secondary.disabled}
                    loading={secondary.loading}
                    onClick={cancel}
                    className={styles.footerButton}
                  >
                    {secondary.label}
                  </Button>
                ) : null}
                {primaryAction ? (
                  <Button
                    variant={primaryAction.destructive ? 'destructive' : 'primary'}
                    disabled={primaryAction.disabled}
                    loading={primaryAction.loading}
                    onClick={() => primaryAction.onAction?.()}
                    className={styles.footerButton}
                  >
                    {primaryAction.label}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
