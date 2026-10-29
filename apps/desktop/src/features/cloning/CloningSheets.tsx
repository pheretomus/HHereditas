/** The cloning sheets of the document window; at most one is open (store `sheet`). */
import type { DocumentState } from '../../state/documents';
import type { SheetId } from '../../state/store';
import { AnnealOligosSheet, CodonOptimizeSheet, InFusionTopoSheet, MutagenesisSheet } from './AdvancedCloningSheets';
import { GibsonSheet } from './GibsonSheet';
import { GoldenGateSheet } from './GoldenGateSheet';
import { PcrSheet } from './PcrSheet';
import { RestrictionSheet } from './RestrictionSheet';

export function CloningSheets({ sheet, doc }: { sheet: SheetId | null; doc: DocumentState | null }) {
  return (
    <>
      <PcrSheet open={sheet === 'clone-pcr'} doc={doc} />
      <RestrictionSheet open={sheet === 'clone-restriction'} doc={doc} />
      <GibsonSheet open={sheet === 'clone-gibson'} doc={doc} />
      <GoldenGateSheet open={sheet === 'clone-golden-gate'} doc={doc} />
      <MutagenesisSheet open={sheet === 'clone-mutagenesis'} doc={doc} />
      <AnnealOligosSheet open={sheet === 'clone-anneal-oligos'} />
      <InFusionTopoSheet
        open={sheet === 'clone-infusion' || sheet === 'clone-topo'}
        doc={doc}
        mode={sheet === 'clone-topo' ? 'topo' : 'infusion'}
      />
      <CodonOptimizeSheet open={sheet === 'codon-optimize'} doc={doc} />
    </>
  );
}
