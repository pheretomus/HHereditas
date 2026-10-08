import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { cx } from '../../lib/cx';
import { formatShortcut } from '../../lib/shortcut';
import styles from './Tooltip.module.css';

const ProviderPresent = createContext(false);

export interface TooltipProviderProps {
  children: ReactNode;
  /** Hover delay before the first tooltip appears (ms). */
  delayDuration?: number;
  /** Window in which moving to another trigger shows its tooltip immediately (ms). */
  skipDelayDuration?: number;
}

/**
 * Shares tooltip timing across the app (moving between toolbar buttons shows the next
 * tooltip instantly). Optional: a Tooltip outside a provider creates its own.
 */
export function TooltipProvider({ children, delayDuration = 600, skipDelayDuration = 300 }: TooltipProviderProps) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration}>
      <ProviderPresent.Provider value={true}>{children}</ProviderPresent.Provider>
    </TooltipPrimitive.Provider>
  );
}

export interface TooltipProps {
  /** Tooltip text. When empty/undefined the trigger is rendered without a tooltip. */
  content: ReactNode;
  /** Optional keyboard shortcut hint, platform-neutral ("Mod+Shift+F"). */
  shortcut?: string;
  /** The trigger: a single element that accepts a ref and DOM props (Button, IconButton, …). */
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  delayDuration?: number;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  className?: string;
}

/** Small, quiet macOS-style help tag with an optional shortcut hint. */
export function Tooltip({
  content,
  shortcut,
  children,
  side = 'bottom',
  align = 'center',
  sideOffset = 6,
  delayDuration,
  open,
  defaultOpen,
  onOpenChange,
  disabled,
  className,
}: TooltipProps) {
  const hasProvider = useContext(ProviderPresent);
  if (disabled || content == null || content === '') return children;
  const root = (
    <TooltipPrimitive.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange} delayDuration={delayDuration}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          className={cx(styles.content, className)}
        >
          <span className={styles.text}>{content}</span>
          {shortcut ? <span className={styles.shortcut}>{formatShortcut(shortcut)}</span> : null}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
  return hasProvider ? root : <TooltipProvider>{root}</TooltipProvider>;
}
