/**
 * Go to Position / Select Range dialog (Ctrl+G / Ctrl+J in SnapGene).
 * Accepts a 1-based position (e.g. "250") or a 1-based range (e.g. "100..500" or "100-500").
 */
import type { Range, Topology } from '@hhereditas/core';
import { formatRange, normalizeRange, rangeFromInclusive, rangeLength } from '@hhereditas/core';
import { caretAt, hasSelectedBases, selectRange } from '@hhereditas/viewer';
import { Field, Sheet, TextField } from '@hhereditas/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentState } from '../../state/documents';
import { useApp } from '../../state/store';
import styles from './forms.module.css';

interface ParsedTarget {
  valid: boolean;
  kind?: 'position' | 'range';
  pos1?: number;
  range?: Range;
  error?: string;
}

function parseGotoInput(raw: string, seqLen: number, topology: Topology): ParsedTarget {
  if (seqLen <= 0) return { valid: false, error: 'Sequence is empty.' };
  const cleaned = raw.replace(/,/g, '').trim();
  if (!cleaned) return { valid: false };

  const rangeMatch = /^(\d+)\s*(?:\.\.|-|:|\s+to\s+)\s*(\d+)$/i.exec(cleaned);
  if (rangeMatch) {
    const start1 = Number(rangeMatch[1]);
    const end1 = Number(rangeMatch[2]);
    if (start1 < 1 || start1 > seqLen || end1 < 1 || end1 > seqLen) {
      return { valid: false, error: `Positions must be between 1 and ${seqLen.toLocaleString('en-US')}.` };
    }
    if (topology === 'linear' && end1 < start1) {
      return { valid: false, error: 'Start cannot exceed end on a linear sequence.' };
    }
    const range = rangeFromInclusive(start1 - 1, end1 - 1, seqLen, topology);
    return { valid: true, kind: 'range', pos1: start1, range };
  }

  if (/^\d+$/.test(cleaned)) {
    const pos1 = Number(cleaned);
    if (pos1 < 1 || pos1 > seqLen) {
      return { valid: false, error: `Position must be between 1 and ${seqLen.toLocaleString('en-US')}.` };
    }
    return { valid: true, kind: 'position', pos1 };
  }

  return { valid: false, error: 'Enter a base position (e.g. 250) or range (e.g. 100..500).' };
}

export function GotoPositionSheet({ open, doc }: { open: boolean; doc: DocumentState | null }) {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const seqLen = doc?.record.seq.length ?? 0;
  const topology: Topology = doc?.record.topology ?? 'circular';

  useEffect(() => {
    if (!open || !doc) return;
    const len = doc.record.seq.length;
    if (len <= 0) {
      setInput('');
      return;
    }
    const sel = doc.selection;
    const caret0 = sel?.caret ?? 0;
    if (hasSelectedBases(sel)) {
      const r = normalizeRange(sel.range, len, doc.record.topology);
      setInput(formatRange(r, len));
    } else {
      const caret1 = Math.min(len, Math.max(1, caret0 + 1));
      setInput(String(caret1));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const parsed = useMemo(() => parseGotoInput(input, seqLen, topology), [input, seqLen, topology]);

  const submit = () => {
    if (!doc || !parsed.valid || !parsed.pos1) return;
    const app = useApp.getState();
    if (parsed.kind === 'range' && parsed.range) {
      app.setSelection(selectRange(parsed.range, seqLen, topology));
      app.reveal(parsed.pos1 - 1);
      app.closeSheet();
      app.flash(`Selected bases ${formatRange(parsed.range, seqLen)} (${rangeLength(parsed.range).toLocaleString('en-US')} bp)`);
    } else {
      const pos0 = parsed.pos1 - 1;
      app.setSelection(caretAt(pos0));
      app.reveal(pos0);
      app.closeSheet();
      app.flash(`Moved to base ${parsed.pos1.toLocaleString('en-US')}`);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) useApp.getState().closeSheet();
      }}
      title="Go to Position"
      description={
        seqLen > 0
          ? `Enter a 1-based base coordinate (1–${seqLen.toLocaleString('en-US')}) or range (e.g. 100..500).`
          : 'Sequence is empty.'
      }
      primaryAction={{ label: 'Go', onAction: submit, disabled: !parsed.valid }}
      initialFocusRef={inputRef}
      width={400}
    >
      <div className={styles.form}>
        <Field label="Position or Range" error={parsed.error}>
          <TextField
            ref={inputRef}
            mono
            value={input}
            onValueChange={setInput}
            placeholder={seqLen > 0 ? `1..${Math.min(500, seqLen)}` : '1'}
            aria-label="Position or Range"
          />
        </Field>
        {parsed.valid ? (
          <p className={styles.hint}>
            {parsed.kind === 'range' && parsed.range
              ? `Select bases ${formatRange(parsed.range, seqLen)} (${rangeLength(parsed.range).toLocaleString('en-US')} bp)`
              : `Move cursor to base ${parsed.pos1?.toLocaleString('en-US')}`}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
