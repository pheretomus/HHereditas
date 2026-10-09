import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from '../../lib/cx';
import styles from './Toolbar.module.css';

export interface ToolbarProps extends ComponentPropsWithRef<'div'> {
  /** window: 52 px unified title-bar toolbar; inline: 36 px bar inside panels. */
  size?: 'window' | 'inline';
  /** Accessible name, e.g. "Document toolbar". */
  'aria-label'?: string;
}

/**
 * Horizontal bar of controls. Empty toolbar space drags the window (Tauri). The bar and its
 * passive parts are `deep` drag regions: a mouse-down on any non-interactive descendant
 * drags, while buttons, fields and other focusable controls keep their clicks. (A plain
 * attribute on a wrapper would stop Tauri's ancestor walk and block the `deep` region for
 * that wrapper's own children, so every passive wrapper uses `deep`.)
 */
export function Toolbar({ size = 'window', className, children, ...rest }: ToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-orientation="horizontal"
      data-hh-toolbar=""
      data-tauri-drag-region="deep"
      className={cx(styles.toolbar, styles[size], className)}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface ToolbarGroupProps extends ComponentPropsWithRef<'div'> {
  /** Accessible name of the group (optional). */
  label?: string;
}

/** Visually groups related toolbar items (tighter spacing inside the group). */
export function ToolbarGroup({ label, className, children, ...rest }: ToolbarGroupProps) {
  return (
    <div role="group" aria-label={label} data-tauri-drag-region="deep" className={cx(styles.group, className)} {...rest}>
      {children}
    </div>
  );
}

export interface ToolbarSpacerProps {
  /** Fixed width in px; omit for a flexible space that pushes later items to the end. */
  width?: number;
  className?: string;
}

/** Empty, draggable space between toolbar items. */
export function ToolbarSpacer({ width, className }: ToolbarSpacerProps) {
  return (
    <div
      aria-hidden
      data-tauri-drag-region="deep"
      className={cx(width === undefined ? styles.flexSpacer : styles.spacer, className)}
      style={width === undefined ? undefined : { width }}
    />
  );
}

export interface ToolbarTitleProps extends Omit<ComponentPropsWithRef<'div'>, 'title'> {
  title: ReactNode;
  /** Secondary line, e.g. "3,938 bp · circular". */
  subtitle?: ReactNode;
  /** Optional accessory after the title (e.g. an "edited" dot). */
  accessory?: ReactNode;
}

/** Window title with an optional subtitle, as in macOS unified toolbars. */
export function ToolbarTitle({ title, subtitle, accessory, className, ...rest }: ToolbarTitleProps) {
  return (
    <div data-tauri-drag-region="deep" className={cx(styles.title, className)} {...rest}>
      <div data-tauri-drag-region="deep" className={styles.titleRow}>
        <span data-tauri-drag-region="deep" className={styles.titleText}>
          {title}
        </span>
        {accessory}
      </div>
      {subtitle != null ? (
        <div data-tauri-drag-region="deep" className={styles.subtitle}>
          {subtitle}
        </div>
      ) : null}
    </div>
  );
}
