MODULE KEY: snapgene
OWNERSHIP: packages/core/src/io/snapgene.ts (+ optional helpers src/io/snapgene-*.ts), src/io/snapgene*.test.ts, tools/oracle/snapgene_*.py, packages/core/test/oracle/snapgene/**. Another agent owns src/io/genbank.ts, fasta.ts, location.ts. Do NOT create src/io/index.ts.

API:
  isSnapGeneFile(data: Uint8Array): boolean
  parseSnapGene(data: Uint8Array, options?: { fileName?: string }): ParseResult   // exactly one record, or none plus a warning when the data is not a SnapGene DNA file
  writeSnapGene(record: SeqRecord, options?: { now?: Date }): Uint8Array        // EXPERIMENTAL; DNA records only

FORMAT (reverse-engineered: read Biopython's implementation at tools/oracle/.venv/lib/python3.12/site-packages/Bio/SeqIO/SnapGeneIO.py first, and dump the packets/XML of every fixture to see real files):
- A sequence of packets: [1-byte type][4-byte big-endian payload length][payload].
- 0x09 cookie: 'SnapGene' + uint16 sequence type (1 = DNA) + uint16 export version + uint16 import version. Must be the first packet.
- 0x00 DNA: 1 flags byte (bit 0 = circular; other bits double-stranded / Dam / Dcm / EcoKI methylation: keep them in meta.extras), then the ASCII sequence.
- 0x0A features XML, 0x05 primers XML, 0x06 notes XML, 0x08 additional sequence properties XML (sticky-end information: map to SeqRecord.ends when non-zero; inspect fixtures and Biopython for element names; if no fixture has them, implement per best understanding and test via round trip). Unknown packets (history 0x07 is LZMA-compressed, alignments, etc.) are skipped silently. Truncated or corrupt data → warning, never an exception or an infinite loop.
- Parse XML with fast-xml-parser (import { XMLParser } from 'fast-xml-parser'). Handle attributes, entities (&amp; &lt; &#x..;) and repeated elements (single vs array!).

MAPPING to types.ts:
- Feature: type attr → type; name attr → name (ALSO keep or insert a 'label' qualifier so a later GenBank export keeps the name, consistent with GenBank import where the name derives from /label); directionality 1 → strand 1, 2 → -1, absent/0/3 → 0; Segment range "a-b" is 1-based inclusive and a > b wraps the origin → one wrapping segment; segment order: verify how SnapGene orders segments of minus-strand multi-segment features and convert to the types.ts top-strand order; first segment colour → feature.color; segment type "gap": check Biopython and fixtures and document your choice; <Q name><V text|int|predef ...> → qualifiers (strip the HTML wrapper SnapGene puts around text, see linebreak_in_qualifier_text.dna, consistent with Biopython).
- Primers: <Primer name sequence description> → Primer { id: newId('p'), name, sequence (uppercase), description }. Binding sites stored in the file are ignored (we compute them).
- Notes: Description (HTML stripped) → record.description; AccessionNumber → meta.accession; Organism → meta.organism; Comments → meta.comments; other simple fields (Type, Created, LastModified, SequenceClass, CustomMapLabel, TransformedInto, ...) → meta.extras. meta.sourceFormat = 'snapgene'.
- Name: SnapGene files store no name: use the base name of options.fileName without extension, else 'Untitled'.

ORACLE & TESTS:
- tools/oracle/snapgene_oracle.py dumps Biopython's parse of every fixture (seq, topology, description, features with types, location parts, strand, qualifiers) to JSON; Vitest compares (document deviations, e.g. we merge origin-spanning parts into one wrapping segment).
- Writer: mimic real SnapGene output as closely as possible (packet order, cookie versions, XML attributes as found in the fixtures: Feature attrs directionality/type/name, Segment range/color/type, Q/V forms, Notes fields including Created/LastModified from the injectable 'now') so that real SnapGene can open the file. Tests: parseSnapGene(writeSnapGene(r)) equals r for records with wrapping, multi-segment, minus-strand and coloured features, qualifiers with special characters (& < > " ' and non-ASCII such as α, µ), primers, description and sticky ends; a live-oracle test (skipped when the venv is absent) feeds writer output to Biopython and checks equivalence; every fixture survives parse → write → parse.
