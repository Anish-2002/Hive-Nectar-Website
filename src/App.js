import { useEffect } from "react";

function App() {
  useEffect(() => {
    // Redirect to the static index.html
    window.location.href = '/index.html';
  }, []);

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      height: '100vh',
      fontFamily: 'system-ui, sans-serif'
    }}>
      <p>Redirecting to Hive Nectar...</p>
    </div>
  );
}

export default App;
