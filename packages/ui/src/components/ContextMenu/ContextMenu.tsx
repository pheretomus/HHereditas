import type { ComponentPropsWithRef, ReactNode } from 'react';
import { Check } from 'lucide-react';
import { ContextMenu as ContextMenuPrimitive } from 'radix-ui';
import { cx } from '../../lib/cx';
import { MenuItemInner } from '../Menu/MenuItemInner';
import styles from '../Menu/menu.module.css';

/** Root of a context (right-click) menu. Same item components as Menu, prefixed ContextMenu*. */
export const ContextMenu = ContextMenuPrimitive.Root;
/** The area that opens the menu on right-click / Ctrl-click / long-press (use `asChild`). */
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuGroup = ContextMenuPrimitive.Group;
export const ContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup;
/** Root of a submenu: <ContextMenuSub><ContextMenuSubTrigger/><ContextMenuSubContent/></ContextMenuSub>. */
export const ContextMenuSub = ContextMenuPrimitive.Sub;

export type ContextMenuContentProps = ComponentPropsWithRef<typeof ContextMenuPrimitive.Content>;

export function ContextMenuContent({ className, collisionPadding = 8, ...rest }: ContextMenuContentProps) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content collisionPadding={collisionPadding} className={cx(styles.content, className)} {...rest} />
    </ContextMenuPrimitive.Portal>
  );
}

export interface ContextMenuItemProps extends ComponentPropsWithRef<typeof ContextMenuPrimitive.Item> {
  /** 16 px leading icon. */
  icon?: ReactNode;
  /** Platform-neutral shortcut ("Mod+Shift+O") shown at the trailing edge. */
  shortcut?: string;
  /** Red label for actions that delete or discard. */
  destructive?: boolean;
}

export function ContextMenuItem({ icon, shortcut, destructive, className, children, ...rest }: ContextMenuItemProps) {
  return (
    <ContextMenuPrimitive.Item className={cx(styles.item, destructive && styles.destructive, className)} {...rest}>
      <MenuItemInner icon={icon} shortcut={shortcut}>
        {children}
      </MenuItemInner>
    </ContextMenuPrimitive.Item>
  );
}

export interface ContextMenuCheckboxItemProps extends ComponentPropsWithRef<typeof ContextMenuPrimitive.CheckboxItem> {
  icon?: ReactNode;
  shortcut?: string;
}

/** Item with an on/off checkmark in the state column. */
export function ContextMenuCheckboxItem({ icon, shortcut, className, children, ...rest }: ContextMenuCheckboxItemProps) {
  return (
    <ContextMenuPrimitive.CheckboxItem className={cx(styles.item, className)} {...rest}>
      <ContextMenuPrimitive.ItemIndicator className={styles.indicator}>
        <Check />
      </ContextMenuPrimitive.ItemIndicator>
      <MenuItemInner icon={icon} shortcut={shortcut}>
        {children}
      </MenuItemInner>
    </ContextMenuPrimitive.CheckboxItem>
  );
}

export interface ContextMenuRadioItemProps extends ComponentPropsWithRef<typeof ContextMenuPrimitive.RadioItem> {
  icon?: ReactNode;
  shortcut?: string;
}

/** One choice of a ContextMenuRadioGroup; the chosen item shows a checkmark (macOS style). */
export function ContextMenuRadioItem({ icon, shortcut, className, children, ...rest }: ContextMenuRadioItemProps) {
  return (
    <ContextMenuPrimitive.RadioItem className={cx(styles.item, className)} {...rest}>
      <ContextMenuPrimitive.ItemIndicator className={styles.indicator}>
        <Check />
      </ContextMenuPrimitive.ItemIndicator>
      <MenuItemInner icon={icon} shortcut={shortcut}>
        {children}
      </MenuItemInner>
    </ContextMenuPrimitive.RadioItem>
  );
}

export function ContextMenuLabel({ className, ...rest }: ComponentPropsWithRef<typeof ContextMenuPrimitive.Label>) {
  return <ContextMenuPrimitive.Label className={cx(styles.sectionLabel, className)} {...rest} />;
}

export function ContextMenuSeparator({ className, ...rest }: ComponentPropsWithRef<typeof ContextMenuPrimitive.Separator>) {
  return <ContextMenuPrimitive.Separator className={cx(styles.separator, className)} {...rest} />;
}

export interface ContextMenuSubTriggerProps extends ComponentPropsWithRef<typeof ContextMenuPrimitive.SubTrigger> {
  icon?: ReactNode;
}

export function ContextMenuSubTrigger({ icon, className, children, ...rest }: ContextMenuSubTriggerProps) {
  return (
    <ContextMenuPrimitive.SubTrigger className={cx(styles.item, styles.subTrigger, className)} {...rest}>
      <MenuItemInner icon={icon} submenu>
        {children}
      </MenuItemInner>
    </ContextMenuPrimitive.SubTrigger>
  );
}

export function ContextMenuSubContent({
  className,
  sideOffset = 2,
  alignOffset = -5,
  collisionPadding = 8,
  ...rest
}: ComponentPropsWithRef<typeof ContextMenuPrimitive.SubContent>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
        className={cx(styles.content, className)}
        {...rest}
      />
    </ContextMenuPrimitive.Portal>
  );
}
