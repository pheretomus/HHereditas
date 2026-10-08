import { useRef, type ReactNode } from 'react';
import { AlertDialog } from 'radix-ui';
import { cx } from '../../lib/cx';
import { Button } from '../Button';
import type { SheetAction } from '../Sheet';
import { isConfirmKey } from '../Sheet/confirmKey';
import styles from './Dialog.module.css';

export type DialogAction = SheetAction;

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 48–64 px artwork above the title (app icon, warning symbol…). */
  icon?: ReactNode;
  title: ReactNode;
  /** Informative text under the title. */
  message?: ReactNode;
  /** Extra content (e.g. a "Don't ask again" checkbox). */
  children?: ReactNode;
  /** Default button: focused on open, Return triggers it. Closes the alert after onAction. */
  primaryAction: DialogAction;
  /** Cancel button: Esc triggers it. Closes the alert after onAction. */
  secondaryAction?: DialogAction;
  /** Optional third button (e.g. "Don't Save"); buttons stack vertically when present. */
  tertiaryAction?: DialogAction;
  /** Width in px (default 260, like macOS alerts). */
  width?: number;
  className?: string;
}

/** macOS alert: compact, centred, icon + bold title + message + full-width buttons. */
export function Dialog({
  open,
  onOpenChange,
  icon,
  title,
  message,
  children,
  primaryAction,
  secondaryAction,
  tertiaryAction,
  width = 260,
  className,
}: DialogProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const run = (action: DialogAction | undefined) => {
    action?.onAction?.();
    onOpenChange(false);
  };
  const stacked = !!tertiaryAction;
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(o) => {
        if (o) onOpenChange(true);
        else run(secondaryAction);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={styles.overlay} />
        <AlertDialog.Content
          ref={contentRef}
          className={cx(styles.dialog, className)}
          style={{ width }}
          {...(message ? {} : { 'aria-describedby': undefined })}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            primaryRef.current?.focus();
          }}
          onKeyDown={(e) => {
            if (primaryAction.disabled) return;
            if (isConfirmKey(e, contentRef.current)) {
              e.preventDefault();
              run(primaryAction);
            }
          }}
        >
          {icon ? (
            <div className={styles.icon} aria-hidden>
              {icon}
            </div>
          ) : null}
          <AlertDialog.Title className={styles.title}>{title}</AlertDialog.Title>
          {message ? <AlertDialog.Description className={styles.message}>{message}</AlertDialog.Description> : null}
          {children ? <div className={styles.extra}>{children}</div> : null}
          <div className={cx(styles.buttons, stacked && styles.stacked)}>
            {stacked ? (
              <>
                <Button
                  ref={primaryRef}
                  block
                  variant={primaryAction.destructive ? 'destructive' : 'primary'}
                  disabled={primaryAction.disabled}
                  onClick={() => run(primaryAction)}
                >
                  {primaryAction.label}
                </Button>
                <Button
                  block
                  variant={tertiaryAction!.destructive ? 'destructive' : 'default'}
                  disabled={tertiaryAction!.disabled}
                  onClick={() => run(tertiaryAction)}
                >
                  {tertiaryAction!.label}
                </Button>
                {secondaryAction ? (
                  <AlertDialog.Cancel asChild>
                    <Button block variant={secondaryAction.destructive ? 'destructive' : 'default'} disabled={secondaryAction.disabled}>
                      {secondaryAction.label}
                    </Button>
                  </AlertDialog.Cancel>
                ) : null}
              </>
            ) : (
              <>
                {secondaryAction ? (
                  <AlertDialog.Cancel asChild>
                    <Button block variant={secondaryAction.destructive ? 'destructive' : 'default'} disabled={secondaryAction.disabled}>
                      {secondaryAction.label}
                    </Button>
                  </AlertDialog.Cancel>
                ) : null}
                <Button
                  ref={primaryRef}
                  block
                  variant={primaryAction.destructive ? 'destructive' : 'primary'}
                  disabled={primaryAction.disabled}
                  onClick={() => run(primaryAction)}
                >
                  {primaryAction.label}
                </Button>
              </>
            )}
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
