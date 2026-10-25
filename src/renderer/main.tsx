import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const view = new URLSearchParams(window.location.search).get('view') === 'pet' ? 'pet' : 'bubble';
document.documentElement.dataset.view = view;
createRoot(document.getElementById('root')!).render(<React.StrictMode><App view={view} /></React.StrictMode>);
