/**
 * Primer dialog laid out the way SnapGene's "Add Primer for …" window is: Primer name and Description fields, a
 * 5′…3′ sequence field with an Insert menu (restriction sites, tags), "5′ Phosphorylated" and Reverse Complement,
 * the primer statistics (n-mer, GC%) and the binding site (position, annealed bases, Tm), and a sequence view of
 * the template around the binding site with the Show enzymes / features / translations toggles on its left.
 * Handles both Add Primer and Edit Primer.
 */
import type { Primer, PrimerBindingSite } from '@hhereditas/core';
import {
  COMMON_ENZYMES,
  addPrimer,
  analyzePrimer,
  findBindingSites,
  newId,
  normalizeDna,
  reverseComplement,
  updatePrimer,
} from '@hhereditas/core';
import { SequenceView } from '@hhereditas/viewer';
import {
  Button,
  Checkbox,
  Field,
  IconButton,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  Sheet,
  TextField,
  Tooltip,
} from '@hhereditas/ui';
import { ArrowLeftRight, ChevronDown, ChevronLeft, ChevronRight, Copy, Scissors, Tag, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { deletePrimerCommand, selectedText } from '../../app/commands';
import type { EnzymeDisplay } from '../../shell';
import { ENZYME_DISPLAY_CHOICES, ENZYME_DISPLAY_NAMES, useDisplayedSites, useOrfs } from '../../state/analysis';
import type { DocumentState } from '../../state/documents';
import { useSettings } from '../../state/settings';
import { useApp } from '../../state/store';
import styles from './PrimerSheet.module.css';

/** Selections longer than this give a primer of PRIMER_LENGTH bases at the matching end. */
const MAX_PRIMER_FROM_SELECTION = 60;
const PRIMER_LENGTH = 20;

const COMMON_TAIL_MOTIFS = [
  { label: 'Kozak (GCCACCATGG)', seq: 'GCCACCATGG' },
  { label: '6×His (CATCACCATCACCATCAC)', seq: 'CATCACCATCACCATCAC' },
  { label: 'Start codon (ATG)', seq: 'ATG' },
  { label: 'Stop codon (TAA)', seq: 'TAA' },
  { label: 'attB1', seq: 'ACAAGTTTGTACAAAAAAGCAGGCT' },
  { label: 'attB2', seq: 'ACCACTTTGTACAAGAAAGCTGGGT' },
] as const;

/** Preview primer id while adding (an edited primer keeps its own id so its name is drawn). */
const PREVIEW_ID = 'primer-preview';

export interface AddPrimerSheetProps {
  open: boolean;
  doc: DocumentState | null;
  direction?: 1 | -1;
  mode?: 'add' | 'edit';
  primerId?: string;
}

/** Primer for a selected template: forward = its first bases, reverse = reverse complement of its last bases. */
export function primerFromTemplate(template: string, direction: 1 | -1): string {
  const t =
    template.length > MAX_PRIMER_FROM_SELECTION
      ? direction === 1
        ? template.slice(0, PRIMER_LENGTH)
        : template.slice(-PRIMER_LENGTH)
      : template;
  return direction === -1 ? reverseComplement(t) : t;
}

/** 1-based inclusive "start .. end" of a binding site on the top strand. */
function siteCoords(site: PrimerBindingSite, seqLen: number): string {
  const first = site.range.start + 1;
  const lastRaw = site.range.end <= site.range.start ? first : site.range.end;
  const last = seqLen > 0 && lastRaw > seqLen ? lastRaw - seqLen : lastRaw;
  return `${first.toLocaleString('en-US')} .. ${last.toLocaleString('en-US')}`;
}

export function AddPrimerSheet({ open, doc, direction = 1, mode = 'add', primerId }: AddPrimerSheetProps) {
  const [name, setName] = useState('');
  const [sequence, setSequence] = useState('');
  const [description, setDescription] = useState('');
  const [phosphorylated, setPhosphorylated] = useState(false);
  const [siteIndex, setSiteIndex] = useState(0);

  // What the preview shows (the app's own choices to start with)
  const settings = useSettings();
  const [showEnzymes, setShowEnzymes] = useState(true);
  const [enzymeDisplay, setEnzymeDisplay] = useState<EnzymeDisplay>('unique');
  const [showFeatures, setShowFeatures] = useState(true);
  const [showTranslations, setShowTranslations] = useState(true);
  const [showOrfs, setShowOrfs] = useState(false);

  const targetPrimerId = primerId ?? (doc?.selectedItem?.kind === 'primer' ? doc.selectedItem.id : undefined);
  const existingPrimer: Primer | null = useMemo(() => {
    if (mode !== 'edit' || !doc || !targetPrimerId) return null;
    return doc.record.primers.find((p) => p.id === targetPrimerId) ?? null;
  }, [mode, doc, targetPrimerId]);

  const isEditMode = mode === 'edit' && !!existingPrimer;
  const template = open ? selectedText(doc) : null;
  const docName = doc?.record.name?.trim() || 'Untitled';
  const seqLen = doc?.record.seq.length ?? 0;

  useEffect(() => {
    if (!open || !doc) return;
    setSiteIndex(0);
    setEnzymeDisplay(settings.enzymeDisplay === 'custom' ? 'unique' : settings.enzymeDisplay);
    setShowEnzymes(settings.enzymeDisplay !== 'none');
    setShowOrfs(settings.showOrfs);
    if (mode === 'edit' && existingPrimer) {
      setName(existingPrimer.name);
      setSequence(existingPrimer.sequence);
      setDescription(existingPrimer.description ?? '');
      setPhosphorylated(existingPrimer.phosphorylated === true);
      return;
    }
    const d: 1 | -1 = direction === -1 ? -1 : 1;
    setName(`Primer ${doc.record.primers.length + 1}`);
    setSequence(primerFromTemplate(selectedText(doc) ?? '', d));
    setDescription('');
    setPhosphorylated(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, existingPrimer?.id]);

  const clean = normalizeDna(sequence);
  const invalid = clean.invalid.length > 0;

  const analysis = useMemo(() => {
    if (clean.seq.length < 6 || clean.seq.length > 200 || invalid) return null;
    try {
      return analyzePrimer(clean.seq);
    } catch {
      return null;
    }
  }, [clean.seq, invalid]);

  const gcPercent = useMemo(() => {
    if (!clean.seq) return 0;
    const gc = (clean.seq.match(/[GCgc]/g) ?? []).length;
    return Math.round((gc / clean.seq.length) * 100);
  }, [clean.seq]);

  const previewPrimer = useMemo<Primer>(
    () => ({
      id: existingPrimer?.id ?? PREVIEW_ID,
      name: name.trim() || 'Primer',
      sequence: clean.seq,
    }),
    [existingPrimer?.id, name, clean.seq],
  );

  const bindingSites = useMemo<PrimerBindingSite[]>(() => {
    if (!doc || clean.seq.length < 10 || invalid || doc.record.seq.length === 0) return [];
    try {
      const exact = findBindingSites(doc.record.seq, doc.record.topology, previewPrimer);
      if (exact.length > 0) return exact;
      return findBindingSites(doc.record.seq, doc.record.topology, previewPrimer, {
        minAnneal: Math.min(15, clean.seq.length),
        maxMismatches: 2,
      });
    } catch {
      return [];
    }
  }, [doc, clean.seq, invalid, previewPrimer]);

  const currentSite = bindingSites.length ? bindingSites[Math.min(siteIndex, bindingSites.length - 1)] : null;

  // The template with the primer being edited drawn as it is now (other primers stay).
  const previewRecord = useMemo(() => {
    if (!doc) return null;
    return {
      ...doc.record,
      primers: [...doc.record.primers.filter((p) => p.id !== previewPrimer.id), previewPrimer],
    };
  }, [doc, previewPrimer]);

  const enzymeSites = useDisplayedSites(previewRecord, showEnzymes ? enzymeDisplay : 'none', settings.customEnzymes);
  const orfs = useOrfs(previewRecord, showTranslations && showOrfs);

  // Scroll the preview to the binding site whenever another one is shown.
  const scrollRequest = useRef(0);
  const [scrollTo, setScrollTo] = useState<{ position: number; requestId: number } | undefined>(undefined);
  const siteStart = currentSite?.range.start ?? -1;
  useEffect(() => {
    if (siteStart < 0) return;
    scrollRequest.current += 1;
    setScrollTo({ position: siteStart, requestId: scrollRequest.current });
  }, [siteStart, open]);

  const tmText = (() => {
    const tm = currentSite?.tm ?? analysis?.tm;
    return tm !== undefined && Number.isFinite(tm) ? `${Math.round(tm)}°C` : '—';
  })();

  const prepend = (bases: string) => setSequence((prev) => `${bases}${prev}`);
  const reverseComplementSequence = () => setSequence(reverseComplement(clean.seq));
  const makeFromSelection = (d: 1 | -1) => {
    if (!template) return;
    setSequence(primerFromTemplate(template, d));
  };

  const valid = clean.seq.length >= 6 && !invalid && name.trim().length > 0;

  const primerDraft = (id: string, primerName: string): Primer => {
    const trimmedDesc = description.trim();
    return {
      id,
      name: primerName,
      sequence: clean.seq,
      ...(trimmedDesc ? { description: trimmedDesc } : {}),
      ...(phosphorylated ? { phosphorylated: true } : {}),
    };
  };

  const save = () => {
    if (!valid) return;
    const trimmedName = name.trim();
    const trimmedDesc = description.trim();
    const app = useApp.getState();

    if (isEditMode && existingPrimer) {
      app.change(
        (r) =>
          updatePrimer(r, existingPrimer.id, {
            name: trimmedName,
            sequence: clean.seq,
            description: trimmedDesc ? trimmedDesc : undefined,
            phosphorylated: phosphorylated ? true : undefined,
          }),
        'Edit Primer',
      );
      app.closeSheet();
      app.selectItem({ kind: 'primer', id: existingPrimer.id });
      return;
    }

    const primer = primerDraft(newId('p'), trimmedName);
    app.change((r) => addPrimer(r, primer), 'Add Primer');
    app.closeSheet();
    app.selectItem({ kind: 'primer', id: primer.id });
  };

  const handleDelete = () => {
    if (!existingPrimer) return;
    const app = useApp.getState();
    deletePrimerCommand(existingPrimer.id);
    app.closeSheet();
    app.flash(`Deleted primer "${existingPrimer.name}"`);
  };

  const handleDuplicate = () => {
    if (!valid) return;
    const dupName = `${name.trim() || existingPrimer?.name || 'Primer'} (copy)`;
    const dup = primerDraft(newId('p'), dupName);
    const app = useApp.getState();
    app.change((r) => addPrimer(r, dup), 'Duplicate Primer');
    app.closeSheet();
    app.selectItem({ kind: 'primer', id: dup.id });
    app.flash(`Duplicated primer as "${dupName}"`);
  };

  const showSelectionPrompt = !isEditMode && clean.seq.length === 0 && !!template && template.length >= 6;

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) useApp.getState().closeSheet();
      }}
      title={isEditMode ? `Edit Primer in ${docName}` : `Add Primer for ${docName}`}
      primaryAction={{
        label: isEditMode ? 'Save Primer' : 'Add Primer to Template',
        onAction: save,
        disabled: !valid,
      }}
      secondaryAction={{ label: 'Close' }}
      footerStart={
        isEditMode ? (
          <div className={styles.footerActions}>
            <Button variant="destructive" size="sm" icon={<Trash2 />} onClick={handleDelete}>
              Delete Primer
            </Button>
            <Button variant="default" size="sm" icon={<Copy />} onClick={handleDuplicate} disabled={!valid}>
              Duplicate
            </Button>
          </div>
        ) : undefined
      }
      width={900}
    >
      <div className={styles.sheetBody}>
        {/* Primer | Description */}
        <div className={styles.nameRow}>
          <Field label="Primer" className={styles.nameField}>
            <TextField aria-label="Primer" value={name} onValueChange={setName} autoComplete="off" />
          </Field>
          <Field label="Description" className={styles.descriptionField}>
            <TextField aria-label="Description" value={description} onValueChange={setDescription} autoComplete="off" />
          </Field>
        </div>

        {/* 5′ [sequence] 3′  [Insert ▾] */}
        <div className={styles.sequenceRow}>
          <TextField
            mono
            aria-label="Sequence"
            value={sequence}
            onValueChange={setSequence}
            spellCheck={false}
            invalid={invalid}
            leading={<span className={styles.endLabel}>5′</span>}
            trailing={<span className={styles.endLabel}>3′</span>}
            className={styles.sequenceField}
          />
          <Menu modal={false}>
            <MenuTrigger asChild>
              <Button size="sm" variant="default" trailingIcon={<ChevronDown />} aria-label="Insert at the 5′ end">
                Insert
              </Button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuLabel>Restriction site at the 5′ end</MenuLabel>
              {COMMON_ENZYMES.map((e) => (
                <MenuItem key={e.name} icon={<Scissors />} onSelect={() => prepend(e.site)}>
                  {e.name} <span className={styles.menuSite}>{e.site}</span>
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuLabel>Tag or motif at the 5′ end</MenuLabel>
              {COMMON_TAIL_MOTIFS.map((m) => (
                <MenuItem key={m.label} icon={<Tag />} onSelect={() => prepend(m.seq)}>
                  {m.label}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        </div>
        {invalid ? <p className={styles.errorText}>Not IUPAC DNA: {clean.invalid.join(' ')}</p> : null}

        {/* [ ] 5′ Phosphorylated                       Reverse Complement */}
        <div className={styles.optionsRow}>
          <Checkbox
            checked={phosphorylated}
            onCheckedChange={(c) => setPhosphorylated(c === true)}
            label="5′ Phosphorylated"
          />
          <Button size="sm" variant="plain" disabled={!clean.seq} onClick={reverseComplementSequence}>
            Reverse Complement
          </Button>
        </div>

        {/* Primer:                         Binding site: (i/n) */}
        <div className={styles.statsRow}>
          <div className={styles.statsBlock}>
            <span className={styles.statsTitle}>Primer:</span>
            <span className={styles.statsLine}>
              <strong>{clean.seq.length}</strong>-mer <span className={styles.dot}>•</span> <strong>{gcPercent}</strong>% GC
            </span>
          </div>
          <div className={`${styles.statsBlock} ${styles.statsBlockEnd}`}>
            <span className={styles.statsTitle}>
              Binding site:{' '}
              {bindingSites.length ? `(${Math.min(siteIndex, bindingSites.length - 1) + 1}/${bindingSites.length})` : '(0)'}
              {bindingSites.length > 1 ? (
                <span className={styles.siteNav}>
                  <IconButton
                    size="sm"
                    icon={<ChevronLeft />}
                    aria-label="Previous binding site"
                    onClick={() => setSiteIndex((i) => (i - 1 + bindingSites.length) % bindingSites.length)}
                  />
                  <IconButton
                    size="sm"
                    icon={<ChevronRight />}
                    aria-label="Next binding site"
                    onClick={() => setSiteIndex((i) => (i + 1) % bindingSites.length)}
                  />
                </span>
              ) : null}
            </span>
            {currentSite ? (
              <span className={styles.statsLine}>
                <strong>{siteCoords(currentSite, seqLen)}</strong> <span className={styles.dot}>•</span>{' '}
                <strong>{currentSite.annealedLength}</strong> Annealed bases <span className={styles.dot}>•</span> T
                <sub>m</sub> = <strong className={styles.tmValue}>{tmText}</strong>
                {currentSite.mismatches > 0 ? (
                  <>
                    {' '}
                    <span className={styles.dot}>•</span> <strong>{currentSite.mismatches}</strong> mismatch
                    {currentSite.mismatches > 1 ? 'es' : ''}
                  </>
                ) : null}
                {currentSite.strand === -1 ? (
                  <>
                    {' '}
                    <span className={styles.dot}>•</span> bottom strand
                  </>
                ) : null}
              </span>
            ) : (
              <span className={`${styles.statsLine} ${styles.statsMuted}`}>
                {clean.seq.length >= 10 ? `Does not bind ${docName}` : 'Enter at least 10 bases'}
              </span>
            )}
          </div>
        </div>

        {/* Template around the binding site, with the Show toggles on the left */}
        <div className={styles.previewBox}>
          <div className={styles.previewTools}>
            <div className={styles.toolPair}>
              <Tooltip content="Show enzymes">
                <button
                  type="button"
                  className={styles.toolToggle}
                  aria-pressed={showEnzymes}
                  aria-label="Show enzymes"
                  onClick={() => setShowEnzymes((v) => !v)}
                >
                  <Scissors />
                </button>
              </Tooltip>
              <Menu modal={false}>
                <MenuTrigger asChild>
                  <button type="button" className={styles.toolChevron} aria-label="Enzyme set">
                    <ChevronDown />
                  </button>
                </MenuTrigger>
                <MenuContent align="start">
                  <MenuRadioGroup
                    value={enzymeDisplay}
                    onValueChange={(v) => {
                      setEnzymeDisplay(v as EnzymeDisplay);
                      setShowEnzymes(v !== 'none');
                    }}
                  >
                    {ENZYME_DISPLAY_CHOICES.map((choice) => (
                      <MenuRadioItem key={choice} value={choice}>
                        {ENZYME_DISPLAY_NAMES[choice] ?? choice}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuContent>
              </Menu>
            </div>
            <div className={styles.toolPair}>
              <Tooltip content="Show features">
                <button
                  type="button"
                  className={styles.toolToggle}
                  aria-pressed={showFeatures}
                  aria-label="Show features"
                  onClick={() => setShowFeatures((v) => !v)}
                >
                  <Tag />
                </button>
              </Tooltip>
            </div>
            <div className={styles.toolPair}>
              <Tooltip content="Show translations and ORFs">
                <button
                  type="button"
                  className={styles.toolToggle}
                  aria-pressed={showTranslations}
                  aria-label="Show translations and ORFs"
                  onClick={() => setShowTranslations((v) => !v)}
                >
                  <ArrowLeftRight />
                </button>
              </Tooltip>
              <Menu modal={false}>
                <MenuTrigger asChild>
                  <button type="button" className={styles.toolChevron} aria-label="Translation options">
                    <ChevronDown />
                  </button>
                </MenuTrigger>
                <MenuContent align="start">
                  <MenuCheckboxItem checked={showTranslations} onCheckedChange={(c) => setShowTranslations(c === true)}>
                    Feature translations
                  </MenuCheckboxItem>
                  <MenuCheckboxItem
                    checked={showOrfs}
                    onCheckedChange={(c) => {
                      setShowOrfs(c === true);
                      if (c === true) setShowTranslations(true);
                    }}
                  >
                    ORFs
                  </MenuCheckboxItem>
                </MenuContent>
              </Menu>
            </div>
          </div>

          <div className={styles.previewView}>
            {previewRecord && seqLen > 0 ? (
              <SequenceView
                record={previewRecord}
                enzymeSites={enzymeSites}
                primerSites={bindingSites}
                orfs={orfs}
                show={{
                  complement: true,
                  numbering: true,
                  enzymes: showEnzymes,
                  features: showFeatures,
                  primers: true,
                  translations: showTranslations,
                  orfs: showTranslations && showOrfs,
                  alignments: false,
                }}
                scrollTo={scrollTo}
                className={styles.sequenceView}
              />
            ) : (
              <p className={styles.previewEmpty}>Open a sequence to see where the primer binds.</p>
            )}

            {showSelectionPrompt ? (
              <div className={styles.selectionPrompt} role="dialog" aria-label="Make a primer from the selection?">
                <p className={styles.selectionPromptText}>Make a primer from the selection?</p>
                <div className={styles.selectionPromptActions}>
                  <Button size="sm" variant="default" onClick={() => makeFromSelection(1)}>
                    Top Strand
                  </Button>
                  <Button size="sm" variant="default" onClick={() => makeFromSelection(-1)}>
                    Bottom Strand
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </Sheet>
  );
}
