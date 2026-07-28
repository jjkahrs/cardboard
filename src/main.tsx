import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { enablePatches } from 'immer';
import App from './App';
import './theme/index.css';

// The inverse patches ARE the rewind mechanism (§3.3) — this must run before any produce.
enablePatches();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
