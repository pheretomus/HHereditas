/** The host platform: Tauri when running inside the desktop shell, otherwise the browser. */
import { browserPlatform } from './browser';
import { tauriPlatform } from './tauri';
import type { PlatformApi } from './types';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export const platform: PlatformApi = isTauri() ? tauriPlatform : browserPlatform;

export { readBrowserFile } from './browser';
export * from './types';
