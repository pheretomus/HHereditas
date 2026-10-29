// @vitest-environment jsdom
import '../../../shell/__tests__/setup';
import { makeFeature, makeRecord } from '@hhereditas/core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { createDocument } from '../../../state/documents';
import { useApp } from '../../../state/store';
import {
  AnnealOligosSheet,
  CodonOptimizeSheet,
  InFusionTopoSheet,
  MutagenesisSheet,
} from '../../cloning/AdvancedCloningSheets';
import { SequencePropertiesSheet } from '../../dialogs/SequencePropertiesSheet';
import { AddPrimerSheet } from '../../primers/AddPrimerSheet';
import { AddFeatureSheet } from '../AddFeatureSheet';

const TEST_SEQ =
  'ATGAGTAAAGGAGAAGAACTTTTCACTGGAGTTGTCCCAATTCTTGTTGAATTAGATGGTGATGTTAATGGGCACAAATTTTCTGTCAGTGGAGAGGGTGAAGGTGATGCAACATACGGAAAACTTACCCTTAAATTTATTTGCACTACTGGAAAACTACCTGTTCCATGGCCAACACTTGTCACTACTTTCTCTTATGGTGTTCAATGCTTTTCAAGATACCCAGATCATATGAAACGGCATGACTTTTTCAAGAGTGCCATGCCCGAAGGTTATGTACAGGAAAGAACTATATTTTTCAAAGATGACGGGAACTACAAGACACGTGCTGAAGTCAAGTTTGAAGGTGATACCCTTGTTAATAGAATCGAGTTAAAAGGTATTGATTTTAAAGAAGATGGAAACATTCTTGGACACAAATTGGAATACAACTATAACTCACACAATGTATACATCATGGCAGACAAACAAAAGAATGGAATCAAAGTTAACTTCAAAATTAGACACAACATTGAGGATGGAAGCGTTCAACTAGCAGACCATTATCAACAAAATACTCCAATTGGCGATGGCCCTGTCCTTTTACCAGACAACCATTACCTGTCCACACAATCTGCCCTTTCGAAAGATCCCAACGAAAAGAGAGACCACATGGTCCTTCTTGAGTTTGTAACAGCTGCTGGGATTACACATGGCATGGATGAACTATACAAATAA'.replace(
    /[^ACGT]/g,
    'A',
  );

afterEach(() => {
  cleanup();
  useApp.setState({ documents: [], activeId: null, sheet: null, sheetOptions: {} });
});

describe('SnapGene Feature Dialog (AddFeatureSheet)', () => {
  it('lays the dialog out like SnapGene and supports coding sequence (CDS) translation & genetic code settings', async () => {
    const user = userEvent.setup();
    const rec = makeRecord({
      name: 'pGFP',
      seq: TEST_SEQ,
      topology: 'circular',
      features: [],
    });
    useApp.getState().openRecords([rec]);
    const doc = useApp.getState().documents[0];

    render(<AddFeatureSheet open={true} doc={doc} mode="add" />);

    // Title names the document; segment map, table and qualifier buttons are there
    expect(screen.getByText('Add Feature to pGFP')).toBeTruthy();
    expect(screen.getByRole('img', { name: /Feature segment map/i })).toBeTruthy();
    expect(screen.getByText(/1 segment$/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Split Feature/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Merge Segments/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Delete Segment/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add qualifier/i })).toBeTruthy();

    // Translation options are closed until the feature is translated
    const optionsButton = screen.getByRole('button', { name: /Feature Translation Options/i });
    expect((optionsButton as HTMLButtonElement).disabled).toBe(true);
    const translateCheckbox = screen.getByRole('checkbox', {
      name: /Translate this feature in Sequence view/i,
    });
    await user.click(translateCheckbox);
    expect((optionsButton as HTMLButtonElement).disabled).toBe(false);
    await user.click(optionsButton);

    // Genetic code & Codon start controls appear
    expect(screen.getByRole('combobox', { name: /Genetic code/i })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: /Codon start/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Copy Protein/i })).toBeTruthy();

    // Switch preview to Codon Alignment (DNA + AA)
    await user.click(screen.getByRole('radio', { name: /Codon Alignment/i }));
    expect(screen.getByTitle(/Codon alignment preview/i)).toBeTruthy();

    // Fill name and save feature
    const nameInput = screen.getByLabelText('Feature:');
    await user.type(nameInput, 'GFP_CDS');
    await user.click(screen.getByRole('button', { name: /^OK$/ }));

    const updatedDoc = useApp.getState().documents[0];
    expect(updatedDoc.record.features.length).toBe(1);
    expect(updatedDoc.record.features[0].name).toBe('GFP_CDS');
    expect(updatedDoc.record.features[0].type).toBe('CDS');
    expect(updatedDoc.record.features[0].qualifiers.some((q) => q.key === 'translation')).toBe(true);
  });

  it('splits, merges and deletes segments and edits qualifiers in Edit mode', async () => {
    const user = userEvent.setup();
    const rec = makeRecord({
      name: 'pTest',
      seq: TEST_SEQ,
      topology: 'circular',
      features: [
        makeFeature({
          type: 'promoter',
          name: 'AmpR promoter',
          strand: -1,
          segments: [{ start: 100, end: 300 }],
          qualifiers: [
            { key: 'label', value: 'AmpR promoter' },
            { key: 'note', value: 'bla promoter' },
          ],
        }),
      ],
    });
    useApp.getState().openRecords([rec]);
    const doc = useApp.getState().documents[0];
    const featureId = doc.record.features[0].id;

    render(<AddFeatureSheet open={true} doc={doc} mode="edit" featureId={featureId} />);

    expect(screen.getByText('Edit Feature in pTest')).toBeTruthy();
    expect((screen.getByLabelText('Feature:') as HTMLInputElement).value).toBe('AmpR promoter');
    expect(screen.getByText(/200 bp/)).toBeTruthy();
    // the /label that repeats the name is the name field, so only /note is listed
    expect((screen.getByLabelText('Qualifier 1 value') as HTMLTextAreaElement).value).toBe('bla promoter');
    expect(screen.queryByLabelText('Qualifier 2 value')).toBeNull();

    // Split 101..300 after base 200 -> 101..200 and 201..300
    await user.click(screen.getByRole('button', { name: /Split Feature/i }));
    const splitField = screen.getByLabelText('Split position');
    await user.clear(splitField);
    await user.type(splitField, '200');
    await user.click(screen.getByRole('button', { name: /^Split$/ }));
    expect(screen.getByText(/2 segments$/)).toBeTruthy();
    expect((screen.getByLabelText('Segment 1 End') as HTMLInputElement).value).toBe('200');
    expect((screen.getByLabelText('Segment 2 Start') as HTMLInputElement).value).toBe('201');

    // Merge them back
    await user.click(screen.getByRole('button', { name: /Merge Segments/i }));
    expect(screen.getByText(/1 segment$/)).toBeTruthy();
    expect((screen.getByLabelText('Segment 1 End') as HTMLInputElement).value).toBe('300');

    // Add a qualifier, then remove it again
    await user.click(screen.getByRole('button', { name: /Add qualifier/i }));
    expect(screen.getByLabelText('Qualifier 2 value')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Remove qualifier/i }));
    expect(screen.queryByLabelText('Qualifier 2 value')).toBeNull();

    await user.click(screen.getByRole('button', { name: /^OK$/ }));
    const saved = useApp.getState().documents[0].record.features[0];
    expect(saved.segments).toEqual([{ start: 100, end: 300 }]);
    expect(saved.qualifiers).toEqual([
      { key: 'label', value: 'AmpR promoter' },
      { key: 'note', value: 'bla promoter' },
    ]);
  });
});

describe('SnapGene Primer Dialog (AddPrimerSheet)', () => {
  it('supports 5-prime restriction site extension, common tag insertion,template binding alignment, and Edit Primer mode', async () => {
    const user = userEvent.setup();
    const rec = makeRecord({
      name: 'pGFP',
      seq: TEST_SEQ,
      topology: 'circular',
      primers: [
        {
          id: 'p1',
          name: 'GFP_Fwd_1',
          sequence: TEST_SEQ.slice(0, 22),
          description: 'Initial forward primer',
        },
      ],
    });
    useApp.getState().openRecords([rec]);
    const doc = useApp.getState().documents[0];

    render(<AddPrimerSheet open={true} doc={doc} mode="edit" primerId="p1" />);

    expect(screen.getByText('Edit Primer')).toBeTruthy();
    expect(screen.getByText(/5′ Extension \/ Tail Addition/i)).toBeTruthy();
    expect(screen.getByText(/Template Binding & Thermodynamics/i)).toBeTruthy();

    // Prepend a +Kozak or restriction site 5' extension
    await user.click(screen.getByRole('button', { name: /\+Kozak/i }));
    await user.click(screen.getByRole('button', { name: /Save Primer/i }));

    const updatedPrimer = useApp.getState().documents[0].record.primers[0];
    expect(updatedPrimer.sequence.startsWith('GCCACCATGG')).toBe(true);
  });
});

describe('SnapGene Sequence Properties, Methylation & Origin Dialog', () => {
  it('displays Dam/Dcm/EcoKI methylation counts and rotates circular origin', async () => {
    const user = userEvent.setup();
    const rec = makeRecord({
      name: 'pTest',
      seq: 'GATCCCAGG' + TEST_SEQ.slice(0, 120),
      topology: 'circular',
      features: [
        makeFeature({
          type: 'CDS',
          name: 'TestFeat',
          strand: 1,
          segments: [{ start: 10, end: 40 }],
        }),
      ],
    });
    useApp.getState().openRecords([rec]);
    const doc = useApp.getState().documents[0];

    render(<SequencePropertiesSheet open={true} doc={doc} initialTab="methylation" />);
    expect(screen.getByText(/Host Methylation Status/i)).toBeTruthy();

    // Switch to Set Origin & Flip tab
    await user.click(screen.getByRole('radio', { name: /Set Origin & Flip/i }));
    expect(screen.getByText(/Set Circular Origin/i)).toBeTruthy();
  });
});

describe('SnapGene Advanced Cloning & Molecular Biology Sheets', () => {
  it('designs mutagenic primers in Site-Directed Mutagenesis and anneals oligos', () => {
    const rec = makeRecord({
      name: 'pSDM',
      seq: TEST_SEQ,
      topology: 'circular',
    });
    const doc = createDocument(rec);

    const { unmount } = render(<MutagenesisSheet open={true} doc={doc} />);
    expect(screen.getByText(/Site-Directed Mutagenesis/i)).toBeTruthy();
    expect(screen.getByText(/Designed Mutagenic Primer Pair/i)).toBeTruthy();
    unmount();

    const { unmount: unmountAnneal } = render(<AnnealOligosSheet open={true} />);
    expect(screen.getByText(/Anneal Oligonucleotides/i)).toBeTruthy();
    expect(screen.getByText(/Duplex Core/i)).toBeTruthy();
    unmountAnneal();

    const { unmount: unmountInFusion } = render(<InFusionTopoSheet open={true} doc={doc} mode="infusion" />);
    expect(screen.getByText(/In-Fusion Seamless Cloning/i)).toBeTruthy();
    unmountInFusion();

    const { unmount: unmountCodon } = render(<CodonOptimizeSheet open={true} doc={doc} />);
    expect(screen.getByText(/Back-Translate & Codon Optimization/i)).toBeTruthy();
    unmountCodon();
  });
});
