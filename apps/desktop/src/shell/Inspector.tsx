import { useEffect, useId, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Crosshair, Ellipsis, Minus, Trash2 } from 'lucide-react';
import type { Feature, MoleculeType, Strand, Topology } from '@hhereditas/core';
import { featureLength } from '@hhereditas/core';
import { featureFill, featureTypeColor, formatInt } from '@hhereditas/viewer';
import {
  Disclosure,
  EmptyState,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  PropertyList,
  SegmentedControl,
  Select,
  TextField,
  cx,
  useControllableState,
  type PropertyItem,
} from '@hhereditas/ui';
import { FeatureColorWell } from './FeatureColorWell';
import { featureTypeOptions, qualifierLabel } from './featureTypes';
import { formatLength, formatPercent } from './format';
import { describeCaret, formatSelectionRange, type BaseComposition, type SelectionSummary } from './selectionSummary';
import styles from './Inspector.module.css';

export type InspectorCardId = 'selection' | 'feature' | 'analysis';

/** An edit made in the Feature card. */
export interface FeatureEdit {
  name?: string;
  type?: string;
  strand?: Strand;
  /** '#rrggbb', or null to go back to the type's colour. */
  color?: string | null;
}

export interface InspectorProps {
  /** Selection summary (useSelectionSummary). Undefined/null when no document is open. */
  selection?: SelectionSummary | null;
  /** Melting temperature of the selected bases in °C, when the app computes one. */
  tm?: number | null;
  /** Whole-sequence composition, shown by the Analysis card when no bases are selected. */
  sequenceComposition?: BaseComposition | null;
  /** The feature to inspect (usually the selected one). */
  feature?: Feature | null;
  /** Length and topology of the sequence, for the feature's location text. */
  sequenceLength?: number;
  topology?: Topology;
  molecule?: MoleculeType;
  /** Commits Feature-card edits. Omit for a read-only card. */
  onFeatureChange?: (featureId: string, edit: FeatureEdit) => void;
  onZoomToFeature?: (featureId: string) => void;
  onDeleteFeature?: (featureId: string) => void;
  /** Buttons at the foot of the Analysis card (e.g. Find ORFs, Translate). */
  analysisActions?: ReactNode;
  /** Collapsed cards (controlled). */
  collapsedCards?: readonly InspectorCardId[];
  defaultCollapsedCards?: readonly InspectorCardId[];
  onCollapsedCardsChange?: (cards: InspectorCardId[]) => void;
  className?: string;
}

const LABEL_WIDTH = 76;

/** "396..1,256" for each segment (1-based inclusive); wrapped segments read "3,901..100". */
export function formatFeatureLocation(feature: Pick<Feature, 'segments'>, sequenceLength: number): string {
  return feature.segments
    .map((s) => {
      const first = s.start + 1;
      const lastIndex = s.end - 1;
      const last = (sequenceLength > 0 && lastIndex >= sequenceLength ? lastIndex - sequenceLength : lastIndex) + 1;
      return first === last ? formatInt(first) : `${formatInt(first)}..${formatInt(last)}`;
    })
    .join(', ');
}

/**
 * The inspector pane: details of the current selection, the selected feature (editable) and
 * a quick analysis. Cards collapse individually.
 */
export function Inspector({
  selection,
  tm,
  sequenceComposition,
  feature,
  sequenceLength,
  topology = 'circular',
  molecule,
  onFeatureChange,
  onZoomToFeature,
  onDeleteFeature,
  analysisActions,
  collapsedCards,
  defaultCollapsedCards,
  onCollapsedCardsChange,
  className,
}: InspectorProps) {
  const [collapsed, setCollapsed] = useControllableState<readonly InspectorCardId[]>(
    collapsedCards,
    () => [...(defaultCollapsedCards ?? [])],
    onCollapsedCardsChange ? (ids) => onCollapsedCardsChange([...ids]) : undefined,
  );
  const cardProps = (id: InspectorCardId) => ({
    open: !collapsed.includes(id),
    onOpenChange: (open: boolean) => setCollapsed(open ? collapsed.filter((c) => c !== id) : [...collapsed, id]),
  });

  if (!selection) {
    return (
      <div className={cx(styles.inspector, className)}>
        <EmptyState size="sm" title="No Document" message="Open or create a sequence to inspect it." />
      </div>
    );
  }
  const n = sequenceLength ?? selection.sequenceLength;
  const composition = selection.hasBases ? selection.composition : (sequenceComposition ?? null);

  return (
    <div className={cx(styles.inspector, className)}>
      <Disclosure title="Selection" {...cardProps('selection')}>
        <SelectionCard summary={selection} tm={tm} molecule={molecule} />
      </Disclosure>
      {feature ? (
        <Disclosure
          title="Feature"
          {...cardProps('feature')}
          actions={
            onZoomToFeature || onDeleteFeature ? (
              <FeatureMenu
                onZoom={onZoomToFeature ? () => onZoomToFeature(feature.id) : undefined}
                onDelete={onDeleteFeature ? () => onDeleteFeature(feature.id) : undefined}
              />
            ) : undefined
          }
        >
          <FeatureCard
            feature={feature}
            sequenceLength={n}
            topology={topology}
            molecule={molecule}
            onChange={onFeatureChange ? (edit) => onFeatureChange(feature.id, edit) : undefined}
          />
        </Disclosure>
      ) : null}
      <Disclosure title="Analysis" {...cardProps('analysis')}>
        <AnalysisCard
          composition={molecule === 'protein' ? null : composition}
          scope={selection.hasBases ? 'Selection' : 'Whole sequence'}
          actions={analysisActions}
        />
      </Disclosure>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------------------

function SelectionCard({ summary, tm, molecule }: { summary: SelectionSummary; tm?: number | null; molecule?: MoleculeType }) {
  if (!summary.hasBases) {
    return (
      <div className={styles.stack}>
        <PropertyList
          labelWidth={LABEL_WIDTH}
          copyable={false}
          items={[{ label: 'Cursor', value: capitalize(describeCaret(summary.caret, summary.sequenceLength, summary.topology)) }]}
        />
        <p className={styles.hint}>Drag across the map or the sequence to select bases.</p>
      </div>
    );
  }
  const rangeText = formatSelectionRange(summary);
  const items: PropertyItem[] = [
    {
      label: 'Range',
      value: (
        <>
          {rangeText}
          {summary.wrapsOrigin ? <span className={styles.inlineHint}> across the origin</span> : null}
        </>
      ),
      copyValue: rangeText.replace(/,/g, ''),
    },
    { label: 'Length', value: formatLength(summary.length, molecule), copyValue: String(summary.length) },
  ];
  if (molecule !== 'protein') {
    items.push(
      { label: 'GC', value: summary.gcPercent === null ? '—' : formatPercent(summary.gcPercent) },
      {
        label: 'Tm',
        value: tm == null ? <span className={styles.placeholderValue}>—</span> : `${tm.toFixed(1)} °C`,
        title: tm == null ? 'Melting temperature is shown for primer-length selections.' : undefined,
        copyable: tm != null,
      },
    );
  }
  return <PropertyList labelWidth={LABEL_WIDTH} items={items} />;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------------------
// Feature
// ---------------------------------------------------------------------------------------

const STRAND_OPTIONS = [
  { value: '1', label: 'Forward', icon: <ArrowRight /> },
  { value: '-1', label: 'Reverse', icon: <ArrowLeft /> },
  { value: '0', label: 'None', icon: <Minus /> },
] as const;

function FeatureMenu({ onZoom, onDelete }: { onZoom?: () => void; onDelete?: () => void }) {
  return (
    <Menu modal={false}>
      <MenuTrigger asChild>
        <IconButton size="sm" icon={<Ellipsis />} aria-label="Feature actions" tooltip={false} />
      </MenuTrigger>
      <MenuContent align="end">
        {onZoom ? (
          <MenuItem icon={<Crosshair />} onSelect={onZoom}>
            Zoom to Feature
          </MenuItem>
        ) : null}
        {onZoom && onDelete ? <MenuSeparator /> : null}
        {onDelete ? (
          <MenuItem icon={<Trash2 />} destructive onSelect={onDelete}>
            Delete Feature
          </MenuItem>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

/** A text field that edits a value and commits on Return or blur (Esc reverts). */
function CommitField({
  value,
  onCommit,
  readOnly,
  'aria-labelledby': labelledBy,
}: {
  value: string;
  onCommit?: (value: string) => void;
  readOnly?: boolean;
  'aria-labelledby'?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [value]);
  const commit = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (next && next !== value) onCommit?.(next);
  };
  return (
    <TextField
      size="sm"
      value={draft ?? value}
      readOnly={readOnly}
      aria-labelledby={labelledBy}
      onValueChange={setDraft}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape' && draft !== null) {
          e.preventDefault();
          e.stopPropagation();
          setDraft(null);
        }
      }}
    />
  );
}

function FeatureCard({
  feature,
  sequenceLength,
  topology,
  molecule,
  onChange,
}: {
  feature: Feature;
  sequenceLength: number;
  topology: Topology;
  molecule?: MoleculeType;
  onChange?: (edit: FeatureEdit) => void;
}) {
  const ids = useId();
  const readOnly = !onChange;
  const typeOptions = featureTypeOptions(feature.type).map((o) => ({
    value: o.value,
    label: o.label,
    icon: <span className={styles.typeDot} style={{ background: featureTypeColor(o.value) }} />,
  }));
  const location = formatFeatureLocation(feature, sequenceLength);
  // The qualifier the name came from (/label="AmpR") would only repeat the Name field.
  const qualifiers: PropertyItem[] = feature.qualifiers
    .filter((q) => q.value !== null && q.value !== '' && !(q.key === 'label' && q.value === feature.name))
    .map((q, i) => ({
      key: `${q.key}-${i}`,
      label: qualifierLabel(q.key),
      value: q.value ?? '',
      mono: q.key === 'translation',
      maxLines: q.key === 'translation' ? 4 : 6,
    }));

  return (
    <div className={styles.stack}>
      <div className={styles.form} style={{ gridTemplateColumns: `${LABEL_WIDTH}px minmax(0, 1fr)` }}>
        <span id={`${ids}-name`} className={styles.formLabel}>
          Name
        </span>
        <CommitField
          value={feature.name}
          readOnly={readOnly}
          aria-labelledby={`${ids}-name`}
          onCommit={(name) => onChange?.({ name })}
        />
        <span id={`${ids}-type`} className={styles.formLabel}>
          Type
        </span>
        <div className={styles.control}>
          <Select
            size="sm"
            aria-label="Type"
            value={feature.type}
            options={typeOptions}
            disabled={readOnly}
            onValueChange={(type) => onChange?.({ type })}
            width="100%"
          />
        </div>
        <span id={`${ids}-strand`} className={styles.formLabel}>
          Strand
        </span>
        <div className={styles.control}>
          <SegmentedControl
            aria-label="Strand"
            size="sm"
            iconOnly
            options={STRAND_OPTIONS}
            value={String(feature.strand) as '1' | '-1' | '0'}
            disabled={readOnly}
            onValueChange={(v) => onChange?.({ strand: Number(v) as Strand })}
          />
        </div>
        <span id={`${ids}-color`} className={styles.formLabel}>
          Colour
        </span>
        <div className={styles.control}>
          <FeatureColorWell
            value={feature.color}
            automaticColor={featureTypeColor(feature.type)}
            aria-labelledby={`${ids}-color`}
            onChange={onChange ? (color) => onChange({ color }) : undefined}
          />
        </div>
      </div>
      <PropertyList
        labelWidth={LABEL_WIDTH}
        items={[
          {
            label: 'Location',
            value: (
              <span className={styles.location}>
                <span className={styles.locationSwatch} style={{ background: featureFill(feature) }} />
                {location}
              </span>
            ),
            copyValue: location.replace(/,(?=\d{3})/g, ''),
          },
          { label: 'Length', value: formatLength(featureLength(feature), molecule) },
          ...(topology === 'circular' && feature.segments.some((s) => s.end > sequenceLength)
            ? [{ label: 'Note', value: 'Spans the origin', copyValue: '' }]
            : []),
        ]}
      />
      {qualifiers.length > 0 ? (
        <div className={styles.qualifiers}>
          <div className={styles.subheading}>Qualifiers</div>
          <PropertyList labelWidth={LABEL_WIDTH} items={qualifiers} />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------

const BASES = [
  { key: 'a', label: 'A', className: styles.baseA },
  { key: 'c', label: 'C', className: styles.baseC },
  { key: 'g', label: 'G', className: styles.baseG },
  { key: 't', label: 'T', className: styles.baseT },
] as const;

/** Stacked bar of the A / C / G / T fractions with a legend. */
export function CompositionBar({ composition }: { composition: BaseComposition }) {
  const total = composition.total || 1;
  const other = composition.s + composition.w + composition.other;
  const pct = (n: number) => (100 * n) / total;
  const label = BASES.map((b) => `${b.label} ${pct(composition[b.key]).toFixed(1)} %`).join(', ');
  return (
    <div className={styles.composition}>
      <div className={styles.bar} role="img" aria-label={`Base composition: ${label}`}>
        {BASES.map((b) =>
          composition[b.key] > 0 ? (
            <span key={b.key} className={cx(styles.segment, b.className)} style={{ flexGrow: composition[b.key] }} />
          ) : null,
        )}
        {other > 0 ? <span className={cx(styles.segment, styles.baseOther)} style={{ flexGrow: other }} /> : null}
      </div>
      <div className={styles.legend} aria-hidden>
        {BASES.map((b) => (
          <span key={b.key} className={styles.legendItem}>
            <span className={cx(styles.legendDot, b.className)} />
            <span className={styles.legendBase}>{b.label}</span>
            <span className={styles.legendValue}>{pct(composition[b.key]).toFixed(1)}%</span>
          </span>
        ))}
      </div>
      {other > 0 ? (
        <div className={styles.hint}>
          {formatInt(other)} ambiguous {other === 1 ? 'base' : 'bases'}
        </div>
      ) : null}
    </div>
  );
}

function AnalysisCard({
  composition,
  scope,
  actions,
}: {
  composition: BaseComposition | null;
  scope: string;
  actions?: ReactNode;
}) {
  if (!composition && !actions) return <p className={styles.hint}>Nothing to analyse.</p>;
  return (
    <div className={styles.stack}>
      {composition && composition.total > 0 ? (
        <div className={styles.analysisBlock}>
          <div className={styles.blockHeader}>
            <span className={styles.subheading}>Base composition</span>
            <span className={styles.scope}>{scope}</span>
          </div>
          <CompositionBar composition={composition} />
        </div>
      ) : null}
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}
