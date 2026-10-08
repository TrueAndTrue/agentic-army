import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { boot } from './lib/state.ts';

void boot();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
