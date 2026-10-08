import type { ReactNode } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Select as SelectPrimitive } from 'radix-ui';
import { cx } from '../../lib/cx';
import type { ControlSize } from '../Button';
import menu from '../Menu/menu.module.css';
import styles from './Select.module.css';

export interface SelectOption<T extends string = string> {
  /** Non-empty string. */
  value: T;
  label: ReactNode;
  /** Plain text for type-ahead when `label` is not a string. */
  textValue?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export type SelectEntry<T extends string = string> =
  | SelectOption<T>
  | { type: 'separator' }
  | { type: 'label'; label: ReactNode };

export interface SelectProps<T extends string = string> {
  value?: T;
  defaultValue?: T;
  onValueChange?: (value: T) => void;
  options: readonly SelectEntry<T>[];
  placeholder?: string;
  size?: ControlSize;
  disabled?: boolean;
  'aria-label'?: string;
  id?: string;
  name?: string;
  /** Width of the button (px or CSS length). */
  width?: number | string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

function isOption<T extends string>(e: SelectEntry<T>): e is SelectOption<T> {
  return !('type' in e);
}

/**
 * macOS pop-up button: shows the current choice with an accent up/down indicator; the menu
 * opens with the chosen item over the button.
 */
export function Select<T extends string = string>({
  value,
  defaultValue,
  onValueChange,
  options,
  placeholder,
  size = 'md',
  disabled,
  id,
  name,
  width,
  open,
  defaultOpen,
  onOpenChange,
  className,
  'aria-label': ariaLabel,
}: SelectProps<T>) {
  return (
    <SelectPrimitive.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange as ((v: string) => void) | undefined}
      disabled={disabled}
      name={name}
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
    >
      <SelectPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cx(styles.trigger, styles[size], className)}
        style={width !== undefined ? { width } : undefined}
      >
        <span className={styles.value}>
          <SelectPrimitive.Value placeholder={placeholder} />
        </span>
        <SelectPrimitive.Icon className={styles.indicator}>
          <ChevronsUpDown aria-hidden />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="item-aligned" className={cx(menu.content, styles.content)}>
          <SelectPrimitive.Viewport className={styles.viewport}>
            {options.map((entry, i) => {
              if (!isOption(entry)) {
                return entry.type === 'separator' ? (
                  <SelectPrimitive.Separator key={`sep-${i}`} className={menu.separator} />
                ) : (
                  <SelectPrimitive.Label key={`label-${i}`} className={menu.sectionLabel}>
                    {entry.label}
                  </SelectPrimitive.Label>
                );
              }
              return (
                <SelectPrimitive.Item
                  key={entry.value}
                  value={entry.value}
                  disabled={entry.disabled}
                  textValue={entry.textValue}
                  className={menu.item}
                >
                  <SelectPrimitive.ItemIndicator className={menu.indicator}>
                    <Check />
                  </SelectPrimitive.ItemIndicator>
                  {entry.icon ? (
                    <span className={menu.icon} aria-hidden>
                      {entry.icon}
                    </span>
                  ) : null}
                  <span className={menu.label}>
                    <SelectPrimitive.ItemText>{entry.label}</SelectPrimitive.ItemText>
                  </span>
                </SelectPrimitive.Item>
              );
            })}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
