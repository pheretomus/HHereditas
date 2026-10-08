import '../test/setup';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { cx } from './cx';
import { mergeRefs } from './mergeRefs';
import { getPlatform } from './platform';
import { formatShortcut, shortcutKeys } from './shortcut';
import { useControllableState } from './useControllableState';

describe('cx', () => {
  it('joins truthy class names', () => {
    expect(cx('a', false, null, undefined, 0, '', 'b')).toBe('a b');
    expect(cx()).toBe('');
  });
});

describe('formatShortcut', () => {
  it('uses macOS glyphs in canonical modifier order', () => {
    expect(formatShortcut('Mod+Shift+F', 'mac')).toBe('⇧⌘F');
    expect(formatShortcut('Shift+Mod+F', 'mac')).toBe('⇧⌘F');
    expect(formatShortcut('Mod+Alt+I', 'mac')).toBe('⌥⌘I');
    expect(formatShortcut('Ctrl+Mod+S', 'mac')).toBe('⌃⌘S');
    expect(formatShortcut('Mod+Backspace', 'mac')).toBe('⌘⌫');
    expect(formatShortcut('Escape', 'mac')).toBe('⎋');
  });

  it('spells modifiers out on Windows and Linux', () => {
    expect(formatShortcut('Mod+Shift+F', 'windows')).toBe('Ctrl+Shift+F');
    expect(formatShortcut('Mod+Alt+I', 'linux')).toBe('Ctrl+Alt+I');
    expect(formatShortcut('Mod+Enter', 'windows')).toBe('Ctrl+Enter');
    expect(formatShortcut('Cmd+K', 'windows')).toBe('Win+K');
  });

  it('handles literal plus keys and unknown tokens', () => {
    expect(shortcutKeys('Mod++', 'mac')).toEqual(['⌘', '+']);
    expect(shortcutKeys('Mod+Plus', 'windows')).toEqual(['Ctrl', '+']);
    expect(shortcutKeys('Mod+F5', 'windows')).toEqual(['Ctrl', 'F5']);
    expect(shortcutKeys('mod+k', 'mac')).toEqual(['⌘', 'K']);
  });
});

describe('getPlatform', () => {
  it('prefers the platform class on <html>', () => {
    document.documentElement.classList.add('hh-platform-windows');
    expect(getPlatform()).toBe('windows');
    document.documentElement.classList.remove('hh-platform-windows');
    document.documentElement.classList.add('hh-platform-mac');
    expect(getPlatform()).toBe('mac');
  });
});

describe('mergeRefs', () => {
  it('assigns object refs and calls callback refs', () => {
    const obj = { current: null as string | null };
    const fn = vi.fn();
    mergeRefs<string>(obj, fn, undefined)('x');
    expect(obj.current).toBe('x');
    expect(fn).toHaveBeenCalledWith('x');
  });
});

describe('useControllableState', () => {
  it('keeps internal state when uncontrolled and reports changes', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useControllableState<number>(undefined, 1, onChange));
    expect(result.current[0]).toBe(1);
    act(() => result.current[1](5));
    expect(result.current[0]).toBe(5);
    expect(onChange).toHaveBeenCalledWith(5);
  });

  it('follows the controlled value and only reports changes', () => {
    const onChange = vi.fn();
    const { result, rerender } = renderHook(({ v }) => useControllableState<number>(v, 1, onChange), {
      initialProps: { v: 3 },
    });
    act(() => result.current[1](9));
    expect(result.current[0]).toBe(3);
    expect(onChange).toHaveBeenCalledWith(9);
    rerender({ v: 9 });
    expect(result.current[0]).toBe(9);
  });

  it('returns a stable setter', () => {
    const { result, rerender } = renderHook(() => useControllableState<number>(undefined, 0));
    const first = result.current[1];
    rerender();
    expect(result.current[1]).toBe(first);
  });
});
