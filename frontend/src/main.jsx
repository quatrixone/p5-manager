import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// The service worker answers a visit from its cache, so the first visit after
// the app was replaced by a newer version still gets the old UI; the new
// worker is fetched in the background and takes the page over a moment
// later. Load the UI it brought, instead of showing the old one until the
// user happens to reload.
if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);