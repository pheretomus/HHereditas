import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGenbank } from '../io/genbank';
import { parseXml } from '../io/snapgene-markup';
import {
  SnapGeneExtraKey,
  buildSequencePropertiesXml,
  parseSequenceProperties,
} from '../io/snapgene-sequence';
import { makeRecord } from './features';
import { reverseComplement } from './alphabet';
import {
  STANDARD_COMMON_FEATURES,
  STANDARD_EPITOPE_TAGS,
  STANDARD_POLYMERASES,
  STANDARD_PROTEASE_SITES,
  annotateCommonFeatures,
  detectCommonFeatures,
  parseSnapGeneFtrs,
} from './common-features';

describe('SnapGene REA-reconstructed common features & peptide libraries', () => {
  it('bundles standard epitope tags, protease cleavage sites, polymerases, and plasmid features', () => {
    expect(STANDARD_EPITOPE_TAGS.length).toBe(14);
    expect(STANDARD_PROTEASE_SITES.length).toBe(6);
    expect(STANDARD_POLYMERASES.length).toBe(2);
    expect(STANDARD_COMMON_FEATURES.length).toBeGreaterThanOrEqual(50);

    const tev = STANDARD_PROTEASE_SITES.find((s) => s.name === 'TEV Protease');
    expect(tev).toBeDefined();
    expect(tev?.rawTranslation).toBe('EDLYFQ↓S');
    expect(tev?.cleavageOffsetAa).toBe(6);
  });

  it('auto-detects all 10 pUC19 plasmid features including maxRunOn spliced lacZα', () => {
    const pucGbPath = path.resolve(__dirname, '../../../../apps/desktop/src/samples/pUC19.gb');
    const parsed = parseGenbank(fs.readFileSync(pucGbPath, 'utf8'));
    const unannotated = makeRecord({
      name: 'pUC19-unannotated',
      seq: parsed.records[0].seq,
      topology: 'circular',
    });

    const { record: annotated, added } = annotateCommonFeatures(unannotated);
    const names = new Set(added.map((f) => f.name));

    for (const expected of [
      'AmpR',
      'ori',
      'lacZα',
      'AmpR promoter',
      'MCS',
      'lac promoter',
      'CAP binding site',
      'M13 fwd',
      'M13 rev',
      'lac operator',
    ]) {
      expect(names.has(expected), `expected ${expected} to be detected`).toBe(true);
    }

    // Verify deduplication on second pass
    const secondPass = annotateCommonFeatures(annotated);
    expect(secondPass.added.length).toBe(0);
  });

  it('detects epitope tags and protease cleavage sites on both forward and reverse strands', () => {
    const hisTag = STANDARD_EPITOPE_TAGS.find((t) => t.name === '6xHis')!;
    const flagTag = STANDARD_EPITOPE_TAGS.find((t) => t.name === 'FLAG®')!;
    const tevSite = STANDARD_PROTEASE_SITES.find((s) => s.name === 'TEV Protease')!;

    const syntheticSeq =
      'ATGGCC' +
      hisTag.sequence +
      'GGG' +
      tevSite.sequence +
      'CCC' +
      reverseComplement(flagTag.sequence) +
      'TAA';
    const rec = makeRecord({ name: 'TaggedConstruct', seq: syntheticSeq, topology: 'linear' });
    const detected = detectCommonFeatures(rec);

    const his = detected.find((f) => f.name === '6xHis');
    const tev = detected.find((f) => f.name === 'TEV Protease');
    const flag = detected.find((f) => f.name === 'FLAG®');

    expect(his).toBeDefined();
    expect(his?.strand).toBe(1);
    expect(his?.segments[0]).toEqual({ start: 6, end: 6 + hisTag.sequence.length });

    expect(tev).toBeDefined();
    expect(tev?.strand).toBe(1);

    expect(flag).toBeDefined();
    expect(flag?.strand).toBe(-1);
  });

  it('parses binary .ftrs packet containers via parseSnapGeneFtrs', () => {
    const dnaPayload = Buffer.from('\x00ATGGCTAGCATGAAAGGGCCCTAA', 'latin1');
    const xmlStr =
      '<Features><Feature name="TestFeature" type="CDS" directionality="1" maxRunOn="300">' +
      '<Segment range="1-24" color="#cc99ff"/>' +
      '<Q name="product"><V text="synthetic test protein"/></Q>' +
      '</Feature></Features>';
    const xmlPayload = Buffer.from(xmlStr, 'utf8');

    const packet = (type: number, payload: Buffer) => {
      const hdr = Buffer.alloc(5);
      hdr[0] = type;
      hdr.writeUInt32BE(payload.length, 1);
      return Buffer.concat([hdr, payload]);
    };

    const ftrsBytes = new Uint8Array(
      Buffer.concat([packet(0x00, dnaPayload), packet(0x0a, xmlPayload)])
    );
    const templates = parseSnapGeneFtrs(ftrsBytes);
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe('TestFeature');
    expect(templates[0].type).toBe('CDS');
    expect(templates[0].maxRunOn).toBe(300);
    expect(templates[0].sequence).toBe('ATGGCTAGCATGAAAGGGCCCTAA');
  });

  it('reads and writes extended <AdditionalSequenceProperties> tags discovered in SnapGene.exe', () => {
    const xml =
      '<AdditionalSequenceProperties>' +
      '<UpstreamStickyness>-4</UpstreamStickyness>' +
      '<DownstreamStickyness>4</DownstreamStickyness>' +
      '<UpstreamFivePrimePhosphate>1</UpstreamFivePrimePhosphate>' +
      '<DownstreamFivePrimePhosphate>0</DownstreamFivePrimePhosphate>' +
      '<UpstreamEnzymeName>PstI</UpstreamEnzymeName>' +
      '<DownstreamEnzymeName>EcoRI</DownstreamEnzymeName>' +
      '<OriginalFirstBase>3536</OriginalFirstBase>' +
      '<CountBasesFrom>1</CountBasesFrom>' +
      '<OffsetFromOriginalOrigin>120</OffsetFromOriginalOrigin>' +
      '</AdditionalSequenceProperties>';
    const parsedXml = parseXml(xml);
    if (!parsedXml.ok) throw new Error(parsedXml.error);
    const root = parsedXml.root;
    const props = parseSequenceProperties(root, 1000, 'linear', []);

    expect(props.ends).toEqual({
      left: { kind: '3prime', length: 4 },
      right: { kind: '5prime', length: 4 },
    });
    expect(props.extras[SnapGeneExtraKey.UpstreamModification]).toBe('FivePrimePhosphorylated');
    expect(props.extras[SnapGeneExtraKey.DownstreamModification]).toBe('Unmodified');
    expect(props.extras[SnapGeneExtraKey.UpstreamEnzymeName]).toBe('PstI');
    expect(props.extras[SnapGeneExtraKey.DownstreamEnzymeName]).toBe('EcoRI');
    expect(props.extras[SnapGeneExtraKey.OriginalFirstBase]).toBe('3536');
    expect(props.extras[SnapGeneExtraKey.CountBasesFrom]).toBe('1');
    expect(props.extras[SnapGeneExtraKey.OffsetFromOriginalOrigin]).toBe('120');

    const record = makeRecord({
      name: 'Linearized',
      seq: 'A'.repeat(1000),
      topology: 'linear',
      ends: props.ends,
      meta: { extras: props.extras },
    });
    const outXml = buildSequencePropertiesXml(record, []);
    expect(outXml).toContain('<OriginalFirstBase>3536</OriginalFirstBase>');
    expect(outXml).toContain('<UpstreamEnzymeName>PstI</UpstreamEnzymeName>');
    expect(outXml).toContain('<DownstreamEnzymeName>EcoRI</DownstreamEnzymeName>');
  });
});
