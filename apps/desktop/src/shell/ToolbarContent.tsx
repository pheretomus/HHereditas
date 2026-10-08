import { useRef, type ReactNode, type Ref } from 'react';
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
  className?: string;
}

/** Widths (px) at which the toolbar gets denser. */
export const TOOLBAR_DENSITY = { regular: 820, compact: 600 } as const;
export type ToolbarDensity = 'regular' | 'compact' | 'tight';

export function toolbarDensity(width: number): ToolbarDensity {
  if (width === 0 || width >= TOOLBAR_DENSITY.regular) return 'regular';
  return width >= TOOLBAR_DENSITY.compact ? 'compact' : 'tight';
}

export const ENZYME_DISPLAY_LABELS: Readonly<Record<EnzymeDisplay, string>> = {
  unique: 'Unique cutters',
  'unique-dual': 'Unique & dual cutters',
  common: 'Common set',
  none: 'None',
  custom: 'Chosen enzymes',
};

const VIEW_OPTIONS: readonly SegmentedOption<ViewMode>[] = [
  { value: 'map', label: 'Map', icon: <Donut />, shortcut: 'Mod+1' },
  { value: 'sequence', label: 'Sequence', icon: <LetterText />, shortcut: 'Mod+2' },
  { value: 'split', label: 'Split', icon: <Rows2 />, shortcut: 'Mod+3' },
];

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
  onAction,
  searchValue,
  onSearchChange,
  onSearchSubmit,
  searchStatus,
  searchRef,
  disabled = false,
  className,
}: ToolbarContentProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(ref);
  const density = toolbarDensity(width);
  const run = (action: ShellAction) => () => onAction?.(action);

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
      width={density === 'regular' ? 210 : 160}
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
          shortcut="Ctrl+Mod+S"
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
        options={VIEW_OPTIONS}
        value={view}
        onValueChange={onViewChange}
        iconOnly={density !== 'regular'}
        disabled={disabled}
      />
      <ToolbarSpacer />
      <ToolbarGroup label="Tools" className={styles.tools}>
        <Menu modal={false}>
          <Tooltip content={`Enzymes: ${ENZYME_DISPLAY_LABELS[enzymeDisplay]}`}>
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
              <MenuRadioItem value="unique">{ENZYME_DISPLAY_LABELS.unique}</MenuRadioItem>
              <MenuRadioItem value="unique-dual">{ENZYME_DISPLAY_LABELS['unique-dual']}</MenuRadioItem>
              <MenuRadioItem value="common">{ENZYME_DISPLAY_LABELS.common}</MenuRadioItem>
              {enzymeDisplay === 'custom' ? (
                <MenuRadioItem value="custom">{ENZYME_DISPLAY_LABELS.custom}</MenuRadioItem>
              ) : null}
              <MenuRadioItem value="none">{ENZYME_DISPLAY_LABELS.none}</MenuRadioItem>
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
            <MenuItem icon={<AlignVerticalSpaceAround />} onSelect={run('digest')}>
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
          <Tooltip content="Search sequence" shortcut="Mod+F">
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
          shortcut="Alt+Mod+I"
          onClick={onToggleInspector}
          className={styles.paneToggle}
        />
      ) : null}
    </Toolbar>
  );
}
