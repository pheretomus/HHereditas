import type { ComponentPropsWithRef, ReactNode } from 'react';
import { Check } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { cx } from '../../lib/cx';
import { MenuItemInner } from './MenuItemInner';
import styles from './menu.module.css';

/** Root of a dropdown menu (`open`, `defaultOpen`, `onOpenChange`, `modal`). */
export const Menu = DropdownMenu.Root;
/** Opens the menu; use `asChild` with a Button / IconButton. */
export const MenuTrigger = DropdownMenu.Trigger;
export const MenuGroup = DropdownMenu.Group;
export const MenuRadioGroup = DropdownMenu.RadioGroup;
/** Root of a submenu: <MenuSub><MenuSubTrigger/><MenuSubContent/></MenuSub>. */
export const MenuSub = DropdownMenu.Sub;

export type MenuContentProps = ComponentPropsWithRef<typeof DropdownMenu.Content>;

export function MenuContent({ className, sideOffset = 4, align = 'start', collisionPadding = 8, ...rest }: MenuContentProps) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={collisionPadding}
        className={cx(styles.content, className)}
        {...rest}
      />
    </DropdownMenu.Portal>
  );
}

export interface MenuItemProps extends ComponentPropsWithRef<typeof DropdownMenu.Item> {
  /** 16 px leading icon. */
  icon?: ReactNode;
  /** Platform-neutral shortcut ("Mod+Shift+O") shown at the trailing edge. */
  shortcut?: string;
  /** Red label for actions that delete or discard. */
  destructive?: boolean;
}

export function MenuItem({ icon, shortcut, destructive, className, children, ...rest }: MenuItemProps) {
  return (
    <DropdownMenu.Item className={cx(styles.item, destructive && styles.destructive, className)} {...rest}>
      <MenuItemInner icon={icon} shortcut={shortcut}>
        {children}
      </MenuItemInner>
    </DropdownMenu.Item>
  );
}

export interface MenuCheckboxItemProps extends ComponentPropsWithRef<typeof DropdownMenu.CheckboxItem> {
  icon?: ReactNode;
  shortcut?: string;
}

/** Item with an on/off checkmark in the state column. */
export function MenuCheckboxItem({ icon, shortcut, className, children, ...rest }: MenuCheckboxItemProps) {
  return (
    <DropdownMenu.CheckboxItem className={cx(styles.item, className)} {...rest}>
      <DropdownMenu.ItemIndicator className={styles.indicator}>
        <Check />
      </DropdownMenu.ItemIndicator>
      <MenuItemInner icon={icon} shortcut={shortcut}>
        {children}
      </MenuItemInner>
    </DropdownMenu.CheckboxItem>
  );
}

export interface MenuRadioItemProps extends ComponentPropsWithRef<typeof DropdownMenu.RadioItem> {
  icon?: ReactNode;
  shortcut?: string;
}

/** One choice of a MenuRadioGroup; the chosen item shows a checkmark (macOS style). */
export function MenuRadioItem({ icon, shortcut, className, children, ...rest }: MenuRadioItemProps) {
  return (
    <DropdownMenu.RadioItem className={cx(styles.item, className)} {...rest}>
      <DropdownMenu.ItemIndicator className={styles.indicator}>
        <Check />
      </DropdownMenu.ItemIndicator>
      <MenuItemInner icon={icon} shortcut={shortcut}>
        {children}
      </MenuItemInner>
    </DropdownMenu.RadioItem>
  );
}

export function MenuLabel({ className, ...rest }: ComponentPropsWithRef<typeof DropdownMenu.Label>) {
  return <DropdownMenu.Label className={cx(styles.sectionLabel, className)} {...rest} />;
}

export function MenuSeparator({ className, ...rest }: ComponentPropsWithRef<typeof DropdownMenu.Separator>) {
  return <DropdownMenu.Separator className={cx(styles.separator, className)} {...rest} />;
}

export interface MenuSubTriggerProps extends ComponentPropsWithRef<typeof DropdownMenu.SubTrigger> {
  icon?: ReactNode;
}

export function MenuSubTrigger({ icon, className, children, ...rest }: MenuSubTriggerProps) {
  return (
    <DropdownMenu.SubTrigger className={cx(styles.item, styles.subTrigger, className)} {...rest}>
      <MenuItemInner icon={icon} submenu>
        {children}
      </MenuItemInner>
    </DropdownMenu.SubTrigger>
  );
}

export function MenuSubContent({
  className,
  sideOffset = 2,
  alignOffset = -5,
  collisionPadding = 8,
  ...rest
}: ComponentPropsWithRef<typeof DropdownMenu.SubContent>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.SubContent
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
        className={cx(styles.content, className)}
        {...rest}
      />
    </DropdownMenu.Portal>
  );
}
