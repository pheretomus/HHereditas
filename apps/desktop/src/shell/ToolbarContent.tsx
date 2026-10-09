import { useMemo, useRef, type ReactNode, type Ref } from 'react';
import {
  ArrowRightToLine,
  ChevronDown,
  Combine,
  Donut,
  FlaskConical,
  LetterText,
  PanelLeft,
  PanelRight,
  Rows2,
  ScanSearch,
  Scissors,
  Search,
  AlignVerticalSpaceAround,
} from 'lucide-react';
import { useElementSize } from '@hhereditas/viewer';
import {
  Button,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SearchField,
  SegmentedControl,
  Toolbar,
  ToolbarGroup,
  ToolbarSpacer,
  ToolbarTitle,
  Tooltip,
  cx,
  type SegmentedOption,
} from '@hhereditas/ui';
import { INSPECTOR_PANE_ID, SIDEBAR_PANE_ID } from './ids';
import type { EnzymeDisplay, ShellAction, ViewMode } from './types';
import styles from './ToolbarContent.module.css';

export interface ToolbarContentProps {
  /** Document title. Omit when no document is open. */
  title?: string;
  /** Second line, e.g. formatDocumentSubtitle(…) → "3,938 bp · circular". */
  subtitle?: ReactNode;
  /** Shows "Edited" after the title (unsaved changes). */
  edited?: boolean;
  /** Sidebar toggle; omit onToggleSidebar to hide the button. */
  sidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  /** Inspector toggle; omit onToggleInspector to hide the button. */
  inspectorVisible?: boolean;
  onToggleInspector?: () => void;
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  /** Which restriction sites are shown. */
  enzymeDisplay: EnzymeDisplay;
  onEnzymeDisplayChange: (display: EnzymeDisplay) => void;
  /** "Choose…" in the enzyme menu (open the enzyme chooser). */
  onChooseEnzymes?: () => void;
  /**
   * Choices of the enzyme menu, in order (default DEFAULT_ENZYME_DISPLAY_OPTIONS). 'custom'
   * is listed automatically while it is the current display.
   */
  enzymeDisplayOptions?: readonly EnzymeDisplay[];
  /** Names of the choices, overriding ENZYME_DISPLAY_LABELS (e.g. { unique: 'Unique 6+ cutters' }). */
  enzymeDisplayLabels?: Partial<Record<EnzymeDisplay, string>>;
  /** Commands of the Actions menu. */
  onAction?: (action: ShellAction) => void;
  /** Sequence search (controlled when searchValue is given). */
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  /** Return / Shift+Return in the search field. */
  onSearchSubmit?: (value: string, direction: 'next' | 'previous') => void;
  /** Short result status in the search field, e.g. "3 of 12". */
  searchStatus?: ReactNode;
  /** Ref to the search input (focus it for ⌘F). */
  searchRef?: Ref<HTMLInputElement>;
  /** Disables the document commands (e.g. while a file loads). */
  disabled?: boolean;
  /**
   * Keyboard shortcuts shown in tooltips and menus (display only: the app binds the keys).
   * Defaults: DEFAULT_TOOLBAR_SHORTCUTS. Pass the app's command bindings to keep them in sync.
   */
  shortcuts?: Partial<ToolbarShortcuts>;
  className?: string;
}

/** Platform-neutral shortcut strings ("Alt+Mod+S"; Mod = ⌘ on macOS, Ctrl elsewhere). */
export interface ToolbarShortcuts {
  toggleSidebar: string;
  toggleInspector: string;
  viewMap: string;
  viewSequence: string;
  viewSplit: string;
  enzymes: string;
  digest: string;
  search: string;
}

/** The bindings listed in the app-integration spec. */
export const DEFAULT_TOOLBAR_SHORTCUTS: Readonly<ToolbarShortcuts> = {
  toggleSidebar: 'Alt+Mod+S',
  toggleInspector: 'Alt+Mod+I',
  viewMap: 'Mod+1',
  viewSequence: 'Mod+2',
  viewSplit: 'Mod+3',
  enzymes: 'Mod+E',
  digest: 'Mod+D',
  search: 'Mod+F',
};

/** Widths (px) at which the toolbar gets denser. */
export const TOOLBAR_DENSITY = { regular: 820, compact: 600 } as const;
export type ToolbarDensity = 'regular' | 'compact' | 'tight';

export function toolbarDensity(width: number): ToolbarDensity {
  if (width === 0 || width >= TOOLBAR_DENSITY.regular) return 'regular';
  return width >= TOOLBAR_DENSITY.compact ? 'compact' : 'tight';
}

/** Search field width: 210 px in a regular toolbar; in a compact one it scales with the bar
 *  (150–170 px: the placeholder still fits) so the document title keeps its room. */
export function searchFieldWidth(density: ToolbarDensity, toolbarWidth: number): number {
  if (density === 'regular') return 210;
  return Math.round(Math.max(150, Math.min(170, toolbarWidth * 0.22)));
}

export const ENZYME_DISPLAY_LABELS: Readonly<Record<EnzymeDisplay, string>> = {
  unique: 'Unique cutters',
  'unique-dual': 'Unique & dual cutters',
  common: 'Common set',
  commercial: 'Commercial (≥ 6 bp sites)',
  none: 'None',
  custom: 'Chosen enzymes',
};

/** The enzyme menu's choices unless the app passes its own. */
export const DEFAULT_ENZYME_DISPLAY_OPTIONS: readonly EnzymeDisplay[] = ['unique', 'unique-dual', 'common', 'none'];

/** Menu choices: the given ones, plus 'custom' (before 'none') while it is the current display. */
export function enzymeMenuChoices(options: readonly EnzymeDisplay[], current: EnzymeDisplay): EnzymeDisplay[] {
  const list = [...new Set(options)];
  if (current === 'custom' && !list.includes('custom')) {
    const none = list.indexOf('none');
    list.splice(none >= 0 ? none : list.length, 0, 'custom');
  }
  return list;
}

function viewOptions(keys: ToolbarShortcuts): SegmentedOption<ViewMode>[] {
  // Tooltips on every segment (not only when icon-only) so the shortcuts are discoverable.
  return [
    { value: 'map', label: 'Map', icon: <Donut />, tooltip: 'Map', shortcut: keys.viewMap },
    { value: 'sequence', label: 'Sequence', icon: <LetterText />, tooltip: 'Sequence', shortcut: keys.viewSequence },
    { value: 'split', label: 'Split', icon: <Rows2 />, tooltip: 'Map and Sequence', shortcut: keys.viewSplit },
  ];
}

/**
 * The document window's toolbar items: sidebar toggle, title and subtitle, the Map |
 * Sequence | Split switcher, enzyme and actions menus, sequence search and the inspector
 * toggle. Renders its own Toolbar and gets denser as it narrows (icon-only view switcher,
 * then a search button instead of the field).
 */
export function ToolbarContent({
  title,
  subtitle,
  edited = false,
  sidebarVisible = true,
  onToggleSidebar,
  inspectorVisible = true,
  onToggleInspector,
  view,
  onViewChange,
  enzymeDisplay,
  onEnzymeDisplayChange,
  onChooseEnzymes,
  enzymeDisplayOptions = DEFAULT_ENZYME_DISPLAY_OPTIONS,
  enzymeDisplayLabels,
  onAction,
  searchValue,
  onSearchChange,
  onSearchSubmit,
  searchStatus,
  searchRef,
  disabled = false,
  shortcuts,
  className,
}: ToolbarContentProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(ref);
  const density = toolbarDensity(width);
  const run = (action: ShellAction) => () => onAction?.(action);
  const keys = useMemo(() => ({ ...DEFAULT_TOOLBAR_SHORTCUTS, ...shortcuts }), [shortcuts]);
  const enzymeLabel = (d: EnzymeDisplay) => enzymeDisplayLabels?.[d] ?? ENZYME_DISPLAY_LABELS[d];
  const views = useMemo(() => viewOptions(keys), [keys]);

  const search = (
    <SearchField
      ref={searchRef}
      placeholder="Search sequence"
      aria-label="Search sequence"
      value={searchValue}
      onValueChange={onSearchChange}
      onSubmit={onSearchSubmit}
      status={searchStatus}
      disabled={disabled}
      width={searchFieldWidth(density, width)}
      className={styles.search}
    />
  );

  return (
    <Toolbar ref={ref} aria-label="Document" className={cx(styles.toolbar, className)} data-density={density}>
      {onToggleSidebar ? (
        <IconButton
          icon={<PanelLeft />}
          aria-label={sidebarVisible ? 'Hide Sidebar' : 'Show Sidebar'}
          aria-expanded={sidebarVisible}
          aria-controls={SIDEBAR_PANE_ID}
          shortcut={keys.toggleSidebar}
          onClick={onToggleSidebar}
          className={styles.paneToggle}
        />
      ) : null}
      {title !== undefined ? (
        <ToolbarTitle
          className={styles.title}
          title={title}
          subtitle={density === 'tight' ? undefined : subtitle}
          accessory={edited ? <span className={styles.edited}>Edited</span> : undefined}
        />
      ) : null}
      <ToolbarSpacer />
      <SegmentedControl
        aria-label="View"
        options={views}
        value={view}
        onValueChange={onViewChange}
        iconOnly={density !== 'regular'}
        disabled={disabled}
      />
      <ToolbarSpacer />
      <ToolbarGroup label="Tools" className={styles.tools}>
        <Menu modal={false}>
          <Tooltip content={`Enzymes: ${enzymeLabel(enzymeDisplay)}`} shortcut={keys.enzymes}>
            <MenuTrigger asChild>
              <Button
                variant="plain"
                icon={<Scissors />}
                trailingIcon={<ChevronDown />}
                aria-label="Enzymes"
                disabled={disabled}
              />
            </MenuTrigger>
          </Tooltip>
          <MenuContent align="end">
            <MenuLabel>Show Enzymes</MenuLabel>
            <MenuRadioGroup value={enzymeDisplay} onValueChange={(v) => onEnzymeDisplayChange(v as EnzymeDisplay)}>
              {enzymeMenuChoices(enzymeDisplayOptions, enzymeDisplay).map((d) => (
                <MenuRadioItem key={d} value={d}>
                  {enzymeLabel(d)}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuItem onSelect={() => onChooseEnzymes?.()} disabled={!onChooseEnzymes}>
              Choose…
            </MenuItem>
          </MenuContent>
        </Menu>
        <Menu modal={false}>
          <Tooltip content="Actions">
            <MenuTrigger asChild>
              <Button
                variant="plain"
                icon={<FlaskConical />}
                trailingIcon={<ChevronDown />}
                aria-label="Actions"
                disabled={disabled}
              />
            </MenuTrigger>
          </Tooltip>
          <MenuContent align="end">
            <MenuSub>
              <MenuSubTrigger icon={<Combine />}>Clone</MenuSubTrigger>
              <MenuSubContent>
                <MenuItem onSelect={run('clone-restriction')}>Restriction cloning…</MenuItem>
                <MenuItem onSelect={run('clone-gibson')}>Gibson assembly…</MenuItem>
                <MenuItem onSelect={run('clone-golden-gate')}>Golden Gate…</MenuItem>
                <MenuItem onSelect={run('clone-pcr')}>PCR…</MenuItem>
              </MenuSubContent>
            </MenuSub>
            <MenuItem icon={<AlignVerticalSpaceAround />} shortcut={keys.digest} onSelect={run('digest')}>
              Digest &amp; gel…
            </MenuItem>
            <MenuItem icon={<ScanSearch />} onSelect={run('find-orfs')}>
              Find ORFs
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<ArrowRightToLine />} onSelect={run('primers')}>
              Primers…
            </MenuItem>
          </MenuContent>
        </Menu>
      </ToolbarGroup>
      {density === 'tight' ? (
        <Popover>
          <Tooltip content="Search sequence" shortcut={keys.search}>
            <PopoverTrigger asChild>
              <IconButton icon={<Search />} aria-label="Search sequence" tooltip={false} disabled={disabled} />
            </PopoverTrigger>
          </Tooltip>
          <PopoverContent padding="sm" side="bottom" align="end" aria-label="Search sequence">
            {search}
          </PopoverContent>
        </Popover>
      ) : (
        search
      )}
      {onToggleInspector ? (
        <IconButton
          icon={<PanelRight />}
          aria-label={inspectorVisible ? 'Hide Inspector' : 'Show Inspector'}
          aria-expanded={inspectorVisible}
          aria-controls={INSPECTOR_PANE_ID}
          shortcut={keys.toggleInspector}
          onClick={onToggleInspector}
          className={styles.paneToggle}
        />
      ) : null}
    </Toolbar>
  );
}
