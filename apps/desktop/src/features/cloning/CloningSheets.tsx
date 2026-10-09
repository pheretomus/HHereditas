/** The cloning sheets of the document window; at most one is open (store `sheet`). */
import type { DocumentState } from '../../state/documents';
import type { SheetId } from '../../state/store';
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
    </>
  );
}
