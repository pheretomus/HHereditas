/**
 * View-model types of the application shell. The shell is presentational: the app store
 * owns the state and passes these values down; user intent comes back through callbacks.
 */
import type { MoleculeType, Topology } from '@hhereditas/core';

/** What the main area shows: the map, the sequence, or the map above the sequence. */
export type ViewMode = 'map' | 'sequence' | 'split';

/** Which restriction sites are displayed (toolbar enzyme menu). */
export type EnzymeDisplay = 'unique' | 'unique-dual' | 'common' | 'none' | 'custom';

/** Commands of the toolbar's Actions menu. */
export type ShellAction =
  | 'clone-restriction'
  | 'clone-gibson'
  | 'clone-golden-gate'
  | 'clone-pcr'
  | 'digest'
  | 'find-orfs'
  | 'primers';

/** An open document, as listed in the sidebar. */
export interface DocumentSummary {
  id: string;
  name: string;
  /** Length in bases (or residues for proteins). */
  length: number;
  topology: Topology;
  molecule?: MoleculeType;
  /** Has unsaved changes. */
  edited?: boolean;
}

/** A recently opened file, as listed on the welcome screen. */
export interface RecentFile {
  /** Stable id, e.g. the file path. */
  id: string;
  name: string;
  /** Folder shown under the name, e.g. "~/Documents/Plasmids". */
  location?: string;
  /** Short, already formatted date, e.g. "Yesterday" or "12 Mar". */
  modified?: string;
  length?: number;
  topology?: Topology;
}

/** A bundled example sequence, as listed on the welcome screen. */
export interface SampleSequence {
  id: string;
  name: string;
  /** One line, e.g. "Yeast gene deletion cassette". */
  description?: string;
  length: number;
  topology: Topology;
}

/** What is selected in the sidebar's annotation list. */
export interface SidebarItemRef {
  kind: 'feature' | 'primer' | 'enzyme';
  /** Feature id, primer id, or enzyme name. */
  id: string;
}
