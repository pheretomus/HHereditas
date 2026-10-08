/**
 * jsdom setup for shell tests (import first in each test file). jsdom lacks a few browser APIs
 * that Radix primitives and the shell touch.
 */
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

const proto = Element.prototype as Element & {
  scrollIntoView?: () => void;
  hasPointerCapture?: (id: number) => boolean;
  setPointerCapture?: (id: number) => void;
  releasePointerCapture?: (id: number) => void;
};
proto.scrollIntoView ??= function scrollIntoView() {};
proto.hasPointerCapture ??= function hasPointerCapture() {
  return false;
};
proto.setPointerCapture ??= function setPointerCapture() {};
proto.releasePointerCapture ??= function releasePointerCapture() {};

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  cleanup();
  document.documentElement.className = '';
});
