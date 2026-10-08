/**
 * Application shell: window layout and chrome around the visualizations. Presentational and
 * props-driven; the app store connects to these props.
 */
export { AppShell, INSPECTOR_LIMITS, SIDEBAR_LIMITS } from './AppShell';
export type { AppShellProps } from './AppShell';
export { ToolbarContent, ENZYME_DISPLAY_LABELS, TOOLBAR_DENSITY, toolbarDensity } from './ToolbarContent';
export type { ToolbarContentProps, ToolbarDensity } from './ToolbarContent';
export { Sidebar } from './Sidebar';
export type { SidebarProps, SidebarSectionId } from './Sidebar';
export { MainArea } from './MainArea';
export type { MainAreaProps } from './MainArea';
export { VisualizationPlaceholder } from './VisualizationPlaceholder';
export type { VisualizationPlaceholderProps } from './VisualizationPlaceholder';
export { Inspector, CompositionBar, formatFeatureLocation } from './Inspector';
export type { FeatureEdit, InspectorCardId, InspectorProps } from './Inspector';
export { FeatureColorWell, readSwatchPalette } from './FeatureColorWell';
export type { FeatureColorWellProps } from './FeatureColorWell';
export { StatusBar } from './StatusBar';
export type { StatusBarProps } from './StatusBar';
export { WelcomeScreen } from './WelcomeScreen';
export type { WelcomeScreenProps } from './WelcomeScreen';
export { DocumentGlyph, FeatureGlyph, PrimerGlyph } from './glyphs';
export type { FeatureGlyphProps } from './glyphs';
export {
  buildSequenceIndex,
  countBases,
  describeCaret,
  formatSelectionRange,
  formatSelectionStatus,
  gcPercent,
  summarizeSelection,
  summarizeSequence,
  useSelectionSummary,
  useSequenceIndex,
} from './selectionSummary';
export type { BaseComposition, SelectionSummary, SequenceIndex } from './selectionSummary';
export { enzymeRows, featureRows, matchesFilter, primerRows } from './sidebarModel';
export type { EnzymeRow, FeatureRow, PrimerRow } from './sidebarModel';
export { COMMON_FEATURE_TYPES, featureTypeLabel, featureTypeOptions, qualifierLabel } from './featureTypes';
export type { FeatureTypeOption } from './featureTypes';
export { formatCompactLength, formatDocumentSubtitle, formatLength, formatPercent, lengthUnit } from './format';
export { INSPECTOR_PANE_ID, SIDEBAR_PANE_ID } from './ids';
export type { DocumentSummary, EnzymeDisplay, RecentFile, SampleSequence, ShellAction, SidebarItemRef, ViewMode } from './types';
