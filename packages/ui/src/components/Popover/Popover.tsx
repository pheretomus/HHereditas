import { useMemo, useRef, type ComponentPropsWithRef, type CSSProperties } from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { cx } from '../../lib/cx';
import { mergeRefs } from '../../lib/mergeRefs';
import styles from './Popover.module.css';

/** Root: controls open state (`open`, `defaultOpen`, `onOpenChange`). */
export const Popover = PopoverPrimitive.Root;
/** The element that toggles the popover; use `asChild` with a Button or IconButton. */
export const PopoverTrigger = PopoverPrimitive.Trigger;
/** Optional alternative anchor to position against. */
export const PopoverAnchor = PopoverPrimitive.Anchor;
/** Closes the popover when clicked; use `asChild`. */
export const PopoverClose = PopoverPrimitive.Close;

export interface PopoverContentProps extends ComponentPropsWithRef<typeof PopoverPrimitive.Content> {
  /** Draw the macOS-style arrow pointing at the trigger (default true). */
  arrow?: boolean;
  /** Inner padding: none (lists), sm (8 px) or md (14 px, default). */
  padding?: 'none' | 'sm' | 'md';
  /** Fixed width (px or CSS length). */
  width?: number | string;
}

/** Text-entry controls that receive focus when a popover opens (not colour, range, checkbox…). */
const TEXT_ENTRY = [
  ...['', '[type="text"]', '[type="search"]', '[type="number"]', '[type="email"]', '[type="url"]', '[type="tel"]', '[type="password"]'].map(
    (t) => `input${t || ':not([type])'}:not([disabled])`,
  ),
  'textarea:not([disabled])',
  '[contenteditable="true"]',
].join(', ');

/**
 * Floating panel attached to a trigger (NSPopover). Closes on Esc and outside click.
 *
 * On open, focus goes to the first text field inside (its text selected, like macOS) or to
 * the panel itself, never to the first button: a focus ring on an arbitrary button looks
 * like a stray selection. Pass `onOpenAutoFocus` and call `preventDefault()` to take over.
 */
export function PopoverContent({
  arrow = true,
  padding = 'md',
  width,
  side = 'bottom',
  sideOffset,
  collisionPadding = 8,
  className,
  style,
  children,
  onOpenAutoFocus,
  ref,
  ...rest
}: PopoverContentProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const setRef = useMemo(() => mergeRefs(contentRef, ref), [ref]);
  const merged: CSSProperties | undefined = width !== undefined ? { width, ...style } : style;
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={setRef}
        side={side}
        sideOffset={sideOffset ?? (arrow ? 4 : 6)}
        collisionPadding={collisionPadding}
        className={cx(styles.content, styles[`pad-${padding}`], className)}
        style={merged}
        onOpenAutoFocus={(e) => {
          onOpenAutoFocus?.(e);
          if (e.defaultPrevented) return;
          e.preventDefault();
          const content = contentRef.current;
          if (!content) return;
          const field = content.querySelector<HTMLElement>(TEXT_ENTRY);
          if (field) {
            field.focus({ preventScroll: true });
            if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.select();
          } else {
            content.focus({ preventScroll: true });
          }
        }}
        {...rest}
      >
        {children}
        {arrow ? (
          <PopoverPrimitive.Arrow asChild width={20} height={9}>
            <svg viewBox="0 0 20 9" className={styles.arrow} aria-hidden>
              <path d="M0 0 C4 0 6.5 1.5 8.5 7.2 Q10 9.2 11.5 7.2 C13.5 1.5 16 0 20 0 Z" className={styles.arrowFill} />
              <path d="M0 0 C4 0 6.5 1.5 8.5 7.2 Q10 9.2 11.5 7.2 C13.5 1.5 16 0 20 0" className={styles.arrowEdge} />
            </svg>
          </PopoverPrimitive.Arrow>
        ) : null}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}
