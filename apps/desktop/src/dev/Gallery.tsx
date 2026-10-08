/**
 * Development gallery: renders any component "story" in isolation so it can be inspected
 * and screenshotted (see scripts/shot.mjs). Only bundled in development builds.
 *
 * A story file is any `*.gallery.tsx` file in apps/desktop/src or packages/<pkg>/src whose
 * default export maps story names to render functions:
 *
 *   export default {
 *     'pFA6a-kanMX6': () => <CircularMap record={...} />,
 *     'empty': () => <CircularMap record={empty} />,
 *   } satisfies GalleryStories;
 *
 * URLs:
 *   /?gallery                       index of all stories
 *   /?gallery=CircularMap&story=x   one story, full window (file name without .gallery.tsx)
 *   add &theme=dark and/or &platform=mac to check variants
 */
import { type ReactNode, useEffect, useState } from 'react';

export type GalleryStories = Record<string, () => ReactNode>;
type GalleryModule = { default: GalleryStories };

const loaders = import.meta.glob<GalleryModule>([
  '../**/*.gallery.tsx',
  '../../../../packages/*/src/**/*.gallery.tsx',
]);

function stemOf(path: string): string {
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.gallery\.tsx$/, '');
}

const byStem = new Map<string, () => Promise<GalleryModule>>();
for (const [path, load] of Object.entries(loaders)) byStem.set(stemOf(path), load);

function StoryView({ file, story }: { file: string; story: string | null }) {
  const [stories, setStories] = useState<GalleryStories | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = byStem.get(file);
    if (!load) {
      setError(`No gallery file named "${file}.gallery.tsx"`);
      return;
    }
    load().then(
      (m) => setStories(m.default),
      (e: unknown) => setError(String(e instanceof Error ? (e.stack ?? e.message) : e)),
    );
  }, [file]);

  if (error) return <pre style={{ color: 'var(--hh-red)', padding: 16, whiteSpace: 'pre-wrap' }}>{error}</pre>;
  if (!stories) return null;
  const name = story ?? Object.keys(stories)[0];
  const render = name ? stories[name] : undefined;
  if (!render) {
    return (
      <pre style={{ color: 'var(--hh-red)', padding: 16 }}>
        Story "{name}" not found in {file}. Available: {Object.keys(stories).join(', ')}
      </pre>
    );
  }
  return (
    <div data-gallery-ready="true" style={{ height: '100%', background: 'var(--hh-bg-content)' }}>
      {render()}
    </div>
  );
}

function GalleryIndex() {
  const [entries, setEntries] = useState<Array<{ file: string; names: string[] }>>([]);
  useEffect(() => {
    void Promise.all(
      [...byStem.entries()].map(async ([file, load]) => {
        try {
          return { file, names: Object.keys((await load()).default) };
        } catch (e) {
          return { file, names: [`(failed to load: ${String(e)})`] };
        }
      }),
    ).then((list) => setEntries(list.sort((a, b) => a.file.localeCompare(b.file))));
  }, []);
  return (
    <div className="hh-selectable" style={{ padding: 24, overflow: 'auto', height: '100%', background: 'var(--hh-bg-content)' }}>
      <h1 style={{ fontSize: 'var(--hh-text-2xl)', marginTop: 0 }}>Component gallery</h1>
      {entries.map(({ file, names }) => (
        <section key={file} style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 'var(--hh-text-lg)', marginBottom: 4 }}>{file}</h2>
          {names.map((n) => (
            <div key={n}>
              <a href={`?gallery=${encodeURIComponent(file)}&story=${encodeURIComponent(n)}`}>{n}</a>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

export default function Gallery({ file, story }: { file: string; story: string | null }) {
  return file ? <StoryView file={file} story={story} /> : <GalleryIndex />;
}
