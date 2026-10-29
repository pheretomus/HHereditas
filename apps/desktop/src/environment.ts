/**
 * Theme and platform bootstrapping. Runs before React renders so the first frame already
 * has the right colours and window-chrome insets.
 *
 * URL overrides (useful for screenshots and the dev gallery):
 *   ?theme=light|dark       force a theme (default: follow the OS)
 *   ?platform=mac|windows|linux   force platform-specific chrome (default: detected)
 */
export type Platform = 'mac' | 'windows' | 'linux';

export function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/Mac|iPhone|iPad/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'windows';
  return 'linux';
}

export function applyEnvironment(params: URLSearchParams = new URLSearchParams(location.search)): Platform {
  const root = document.documentElement;
  root.dataset.theme = 'light';

  const forced = params.get('platform');
  const platform: Platform = forced === 'mac' || forced === 'windows' || forced === 'linux' ? forced : detectPlatform();
  root.classList.add(`hh-platform-${platform}`);
  return platform;
}
