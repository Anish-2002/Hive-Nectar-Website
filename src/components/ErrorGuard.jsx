import { useState, useCallback, useEffect } from 'react';

// Port of js/error-guard.js — global floating error toasts.
// In the vanilla site this was injected on every page via a script tag;
// here it wraps the app so uncaught errors surface as floating cards.
export default function ErrorGuard({ children }) {
  const [errors, setErrors] = useState([]);

  const push = useCallback((msg) => {
    const id = Date.now() + Math.random();
    setErrors((list) => [...list, { id, msg }]);
    setTimeout(() => setErrors((list) => list.filter((e) => e.id !== id)), 6000);
  }, []);

  useEffect(() => {
    window.addEventListener('error', (e) => push(e.message || 'Unknown error'));
    window.addEventListener('unhandledrejection', (e) => push(e.reason?.message || 'Unhandled promise rejection'));
  }, [push]);

  return (
    <>
      {children}
      <div id="error-guard" style={{ position: 'fixed', top: 16, right: 16, zIndex: 99999, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 340 }}>
        {errors.map((e) => (
          <div
            key={e.id}
            style={{
              background: '#b3261e',
              color: '#fff',
              padding: '10px 14px',
              borderRadius: 12,
              boxShadow: '0 8px 24px rgba(0,0,0,.3)',
              fontSize: '.85rem',
              cursor: 'pointer',
            }}
            onClick={() => setErrors((list) => list.filter((x) => x.id !== e.id))}
          >
            <i className="fas fa-exclamation-triangle" style={{ marginRight: 8 }}></i>
            {e.msg}
          </div>
        ))}
      </div>
    </>
  );
}
