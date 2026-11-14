import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './style.css';
import './dashboard.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.warn('FundiConnect offline support could not be registered:', error);
    });
  });
}
