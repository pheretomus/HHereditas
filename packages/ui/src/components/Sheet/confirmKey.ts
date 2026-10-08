import type { KeyboardEvent } from 'react';

/**
 * True when a keydown inside a modal should trigger its default (primary) action:
 * a plain Return that is not part of IME composition (Korean/Japanese/Chinese input),
 * not typed into a multi-line field, and not aimed at a focused button or popup list,
 * which handle Return themselves.
 */
export function isConfirmKey(e: KeyboardEvent, container: HTMLElement | null): boolean {
  if (e.key !== 'Enter' || e.defaultPrevented) return false;
  if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return false;
  const native = e.nativeEvent as globalThis.KeyboardEvent;
  if (native.isComposing || native.keyCode === 229) return false;
  const t = e.target as HTMLElement | null;
  if (!t || !container || !container.contains(t)) return false;
  if (t.isContentEditable) return false;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A' || tag === 'SELECT') return false;
  const role = t.getAttribute('role');
  if (role && /^(button|combobox|listbox|option|menuitem|menuitemradio|menuitemcheckbox|checkbox|switch|radio|tab|link)$/.test(role)) {
    return false;
  }
  return true;
}
