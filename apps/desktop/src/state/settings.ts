/**
 * Persisted user settings (localStorage, versioned, parsed defensively so a corrupt or
 * outdated entry never breaks start-up).
 */
import type { Topology } from '@hhereditas/core';
import { create } from 'zustand';
import type { EnzymeDisplay } from '../shell';

export interface RecentEntry {
  /** Absolute path (desktop app only). */
  path: string;
  name: string;
  length?: number;
  topology?: Topology;
  /** Epoch milliseconds of the last opening. */
  openedAt: number;
}

export interface Settings {
  enzymeDisplay: EnzymeDisplay;
  /** Enzymes shown when enzymeDisplay is 'custom'. */
  customEnzymes: string[];
  sidebarVisible: boolean;
  inspectorVisible: boolean;
  sidebarWidth: number | null;
  inspectorWidth: number | null;
  splitRatio: number;
  /** Show open reading frames (≥ 100 codons) on the maps and the sequence. */
  showOrfs: boolean;
  recentFiles: RecentEntry[];
}

export const SETTINGS_KEY = 'hhereditas.settings.v1';
export const RECENT_LIMIT = 10;

export const DEFAULT_SETTINGS: Settings = {
  enzymeDisplay: 'unique',
  customEnzymes: [],
  sidebarVisible: true,
  inspectorVisible: true,
  sidebarWidth: null,
  inspectorWidth: null,
  splitRatio: 0.46,
  showOrfs: false,
  recentFiles: [],
};

const ENZYME_DISPLAYS: readonly EnzymeDisplay[] = ['unique', 'unique-dual', 'common', 'commercial', 'none', 'custom'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;

function parseRecent(v: unknown): RecentEntry[] {
  if (!Array.isArray(v)) return [];
  const out: RecentEntry[] = [];
  for (const e of v) {
    if (!isObject(e) || typeof e.path !== 'string' || typeof e.name !== 'string') continue;
    out.push({
      path: e.path,
      name: e.name,
      ...(typeof e.length === 'number' ? { length: e.length } : {}),
      ...(e.topology === 'circular' || e.topology === 'linear' ? { topology: e.topology } : {}),
      openedAt: typeof e.openedAt === 'number' ? e.openedAt : 0,
    });
  }
  return out.slice(0, RECENT_LIMIT);
}

/** Settings from stored JSON; unknown or invalid fields fall back to the defaults. */
export function parseSettings(json: string | null): Settings {
  if (!json) return { ...DEFAULT_SETTINGS };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (!isObject(raw)) return { ...DEFAULT_SETTINGS };
  const d = DEFAULT_SETTINGS;
  return {
    enzymeDisplay: ENZYME_DISPLAYS.includes(raw.enzymeDisplay as EnzymeDisplay) ? (raw.enzymeDisplay as EnzymeDisplay) : d.enzymeDisplay,
    customEnzymes: Array.isArray(raw.customEnzymes) ? raw.customEnzymes.filter((x): x is string => typeof x === 'string') : [],
    sidebarVisible: typeof raw.sidebarVisible === 'boolean' ? raw.sidebarVisible : d.sidebarVisible,
    inspectorVisible: typeof raw.inspectorVisible === 'boolean' ? raw.inspectorVisible : d.inspectorVisible,
    sidebarWidth: num(raw.sidebarWidth, 100, 1000),
    inspectorWidth: num(raw.inspectorWidth, 100, 1000),
    splitRatio: num(raw.splitRatio, 0.05, 0.95) ?? d.splitRatio,
    showOrfs: typeof raw.showOrfs === 'boolean' ? raw.showOrfs : d.showOrfs,
    recentFiles: parseRecent(raw.recentFiles),
  };
}

function load(): Settings {
  try {
    return parseSettings(localStorage.getItem(SETTINGS_KEY));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

interface SettingsStore extends Settings {
  update: (patch: Partial<Settings>) => void;
  addRecent: (entry: Omit<RecentEntry, 'openedAt'>) => void;
  clearRecent: () => void;
}

export const useSettings = create<SettingsStore>()((set, get) => ({
  ...load(),
  update: (patch) => set(patch),
  addRecent: (entry) => {
    const rest = get().recentFiles.filter((r) => r.path !== entry.path);
    set({ recentFiles: [{ ...entry, openedAt: Date.now() }, ...rest].slice(0, RECENT_LIMIT) });
  },
  clearRecent: () => set({ recentFiles: [] }),
}));

/** Only the persisted fields of the store. */
function persisted(s: SettingsStore): Settings {
  const { update: _u, addRecent: _a, clearRecent: _c, ...rest } = s;
  void _u;
  void _a;
  void _c;
  return rest;
}

useSettings.subscribe((s) => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(persisted(s)));
  } catch {
    // storage full or unavailable (private mode): settings simply do not persist
  }
});
