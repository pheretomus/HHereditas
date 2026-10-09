/** Save As in the browser (no native save dialog): file name and format, then download. */
import { Field, Select, Sheet, TextField } from '@hhereditas/ui';
import { useEffect, useState } from 'react';
import { defaultFileName, resolveSaveAs } from '../../app/files';
import { SAVE_FORMATS } from '../../platform';
import type { FileFormat } from '../../state/documents';
import styles from './forms.module.css';

export function SaveAsSheet({ open, defaultName, format: initialFormat }: { open: boolean; defaultName?: string; format?: FileFormat }) {
  const [name, setName] = useState('');
  const [format, setFormat] = useState<FileFormat>('genbank');

  useEffect(() => {
    if (!open) return;
    setName(defaultName ?? 'Untitled.gb');
    setFormat(initialFormat ?? 'genbank');
  }, [open, defaultName, initialFormat]);

  const changeFormat = (f: FileFormat) => {
    setFormat(f);
    setName((n) => defaultFileName(n, f));
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) resolveSaveAs(null);
      }}
      onCancel={() => resolveSaveAs(null)}
      title="Save As"
      description="The file is downloaded by the browser."
      primaryAction={{ label: 'Save', disabled: !name.trim(), onAction: () => resolveSaveAs({ path: null, name: name.trim(), format }) }}
      width={420}
    >
      <div className={styles.form}>
        <Field label="File name">
          <TextField value={name} onValueChange={setName} />
        </Field>
        <Field label="Format">
          <Select value={format} onValueChange={changeFormat} options={SAVE_FORMATS.map((f) => ({ value: f.format, label: f.name }))} width="100%" />
        </Field>
        {format === 'snapgene' ? <p className={styles.hint}>SnapGene writing is experimental: keep a GenBank copy.</p> : null}
        {format === 'fasta' ? <p className={styles.hint}>FASTA stores only the sequence: features and primers are not saved.</p> : null}
      </div>
    </Sheet>
  );
}
