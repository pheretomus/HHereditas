import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/**
 * State that can be controlled (value passed by the parent) or uncontrolled (internal),
 * with a single change callback. The returned setter is stable; it always calls `onChange`
 * and only updates the internal state when uncontrolled.
 */
export function useControllableState<T>(
  controlled: T | undefined,
  defaultValue: T | (() => T),
  onChange?: (value: T) => void,
): [T, (next: T) => void] {
  const [internal, setInternal] = useState<T>(defaultValue);
  const isControlled = controlled !== undefined;
  const value = isControlled ? controlled : internal;
  const latest = useRef({ isControlled, onChange });
  useLayoutEffect(() => {
    latest.current = { isControlled, onChange };
  });
  const setValue = useCallback((next: T) => {
    if (!latest.current.isControlled) setInternal(next);
    latest.current.onChange?.(next);
  }, []);
  return [value, setValue];
}
