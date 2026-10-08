/**
 * Platform detection for platform-specific details (shortcut glyphs, window chrome).
 * The app tags <html> with `hh-platform-mac | hh-platform-windows | hh-platform-linux`
 * before the first render (apps/desktop/src/environment.ts); that class wins, so
 * `?platform=…` overrides in the gallery are respected.
 */
export type Platform = 'mac' | 'windows' | 'linux';

export function getPlatform(): Platform {
  if (typeof document !== 'undefined') {
    const cl = document.documentElement.classList;
    if (cl.contains('hh-platform-mac')) return 'mac';
    if (cl.contains('hh-platform-windows')) return 'windows';
    if (cl.contains('hh-platform-linux')) return 'linux';
  }
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent;
    if (/Mac|iPhone|iPad/.test(ua)) return 'mac';
    if (/Windows/.test(ua)) return 'windows';
  }
  return 'linux';
}

/** The platform does not change while the app runs, so this is a plain read. */
export function usePlatform(): Platform {
  return getPlatform();
}
