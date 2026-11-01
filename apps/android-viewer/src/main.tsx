import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@hhereditas/ui/styles.css';
import '@hhereditas/viewer/styles.css';
import './app.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

document.documentElement.dataset.theme = 'light';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
