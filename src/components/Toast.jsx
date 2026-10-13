import { useState } from 'react';

// Port of the toast + loader helpers from js/app.js (showToast, Loader).
// Renders a fixed stack of toasts; Loader shows a full-screen overlay.
let pushToast = null;
let setLoader = null;

export function registerToast(fn) {
  pushToast = fn;
}
export function registerLoader(fn) {
  setLoader = fn;
}

export function showToast(message, type = 'info') {
  if (pushToast) pushToast(message, type);
  else console.log(`[toast:${type}]`, message);
}

export const Loader = {
  show(text = 'Loading...') {
    if (setLoader) setLoader({ visible: true, text });
  },
  hide() {
    if (setLoader) setLoader({ visible: false, text: '' });
  },
};

export default function ToastHost() {
  const [toasts, setToasts] = useState([]);
  const [loader, setLoaderState] = useState({ visible: false, text: 'Loading...' });

  useState(() => {
    registerToast((message, type) => {
      const id = Date.now() + Math.random();
      setToasts((list) => [...list, { id, message, type }]);
      setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 4000);
    });
    registerLoader(setLoaderState);
  }, []);

  return (
    <>
      {/* Toasts */}
      <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 100000, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', pointerEvents: 'none' }}>
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              background: t.type === 'error' ? '#b3261e' : t.type === 'success' ? '#2e7d32' : 'var(--primary-dark, #6b4f1d)',
              color: '#fff',
              padding: '10px 18px',
              borderRadius: 999,
              boxShadow: '0 8px 24px rgba(0,0,0,.3)',
              fontSize: '.9rem',
              maxWidth: 420,
              textAlign: 'center',
            }}
          >
            {t.message}
          </div>
        ))}
      </div>

      {/* Loader overlay */}
      {loader.visible && (
        <div className="loader-overlay" style={{ position: 'fixed', inset: 0, zIndex: 99999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,252,240,.85)' }}>
          <div className="loader-content" style={{ textAlign: 'center' }}>
            <div className="buffering-icon"></div>
            <p id="loader-text" style={{ marginTop: 12 }}>{loader.text}</p>
          </div>
        </div>
      )}
    </>
  );
}
