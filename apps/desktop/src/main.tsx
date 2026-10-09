import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@hhereditas/ui/styles.css';
import '@hhereditas/viewer/styles.css';

import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { applyEnvironment } from './environment';

const params = new URLSearchParams(location.search);
applyEnvironment(params);

// The component gallery is a development tool and is never part of production bundles.
const galleryFile = import.meta.env.DEV && params.has('gallery') ? (params.get('gallery') ?? '') : null;
const Gallery = import.meta.env.DEV ? lazy(() => import('./dev/Gallery')) : null;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {galleryFile !== null && Gallery ? (
      <Suspense fallback={null}>
        <Gallery file={galleryFile} story={params.get('story')} />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
