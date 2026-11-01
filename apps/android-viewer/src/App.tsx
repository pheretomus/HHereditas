/**
 * Minimal read-only viewer: pick a file, show its map (circular or linear by topology)
 * and its features. This is the environment-check skeleton; the mobile shell replaces it.
 */
import type { SeqRecord } from '@hhereditas/core';
import { parseAny } from '@hhereditas/core';
import { CircularMap, LinearMap } from '@hhereditas/viewer';
import { useState } from 'react';
import { pickFile } from './platform';

export function App() {
  const [record, setRecord] = useState<SeqRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onOpen = async () => {
    setError(null);
    try {
      const file = await pickFile();
      if (!file) return;
      const result = parseAny(file.data, file.name);
      const first = result.records[0];
      if (!first) {
        setError(result.warnings[0]?.message ?? 'No sequence found');
        return;
      }
      setRecord(first);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>HHereditas Viewer</h1>
        <button type="button" onClick={onOpen}>Open file</button>
      </header>
      {error && <p className="app-error">{error}</p>}
      {record ? (
        <main className="app-main">
          <h2>
            {record.name} <small>{record.seq.length.toLocaleString()} bp · {record.topology}</small>
          </h2>
          <div className="app-map">
            {record.topology === 'circular' ? <CircularMap record={record} /> : <LinearMap record={record} />}
          </div>
          <ul className="app-features">
            {record.features.map((f) => (
              <li key={f.id}>
                <span className="app-feature-type">{f.type}</span> {f.name}
              </li>
            ))}
          </ul>
        </main>
      ) : (
        <main className="app-main app-empty">
          <p>Open a GenBank, SnapGene or FASTA file to view it.</p>
        </main>
      )}
    </div>
  );
}
