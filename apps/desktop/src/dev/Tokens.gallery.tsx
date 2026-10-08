import type { GalleryStories } from './Gallery';

const FEATURE_TOKENS = [
  'cds', 'gene', 'promoter', 'terminator', 'rep-origin', 'primer-bind', 'rbs', 'protein-bind',
  'enhancer', 'polya', 'ltr', 'sig-peptide', 'rna', 'regulatory', 'repeat', 'misc',
];
const SYSTEM_TOKENS = ['accent', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink', 'gray'];

function Swatch({ name, varName }: { name: string; varName: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: 190 }}>
      <span style={{ width: 28, height: 18, borderRadius: 4, background: `var(${varName})`, boxShadow: 'var(--hh-shadow-control)' }} />
      <span style={{ fontSize: 'var(--hh-text-sm)', color: 'var(--hh-text-secondary)' }}>{name}</span>
    </div>
  );
}

export default {
  palette: () => (
    <div style={{ padding: 24, display: 'grid', gap: 20 }}>
      <div style={{ fontSize: 'var(--hh-text-2xl)', fontWeight: 600 }}>HHereditas tokens</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {SYSTEM_TOKENS.map((t) => <Swatch key={t} name={t} varName={`--hh-${t}`} />)}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {FEATURE_TOKENS.map((t) => <Swatch key={t} name={`feature ${t}`} varName={`--hh-feature-${t}`} />)}
      </div>
      <div className="hh-mono" style={{ fontSize: 13 }}>
        GAATTCGGATCCAAGCTTCTCGAG <span style={{ background: 'var(--hh-seq-selection)' }}>ACGTACGTAC</span>
      </div>
    </div>
  ),
} satisfies GalleryStories;
