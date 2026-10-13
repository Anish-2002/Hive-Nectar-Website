import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';

// Port of the shared header/footer from the vanilla site (the-meadow.html etc.)
export default function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);

  const link = (to, label, cls = '') => (
    <NavLink
      to={to}
      className={({ isActive }) => (isActive ? `active ${cls}` : cls)}
      onClick={() => setMenuOpen(false)}
    >
      {label}
    </NavLink>
  );

  return (
    <>
      <header className="header" data-testid="main-header">
        <Link to="/meadow" className="logo-area" data-testid="logo-link">
          <div className="brandmark">
            <img src="./newlogo.webp" alt="The Meadow Logo" className="logo-img" />
          </div>
          <span className="brand-title">THE MEADOW</span>
        </Link>
        <button
          className="menu-toggle"
          aria-label="Toggle Menu"
          data-testid="menu-toggle"
          onClick={() => setMenuOpen((o) => !o)}
        >
          <i className="fas fa-bars"></i>
        </button>
        <nav className={`nav-links${menuOpen ? ' open' : ''}`} id="navLinks" data-testid="nav-links">
          {link('/meadow', 'The Meadow')}
          {link('/pollenpop', 'PollenPop')}
          {link('/board', 'Communication Board')}
          {link('/faq', 'FAQ')}
          {link('/contact', 'Contact')}
          {link('/login', 'Login to Pollen Pop')}
        </nav>
      </header>

      <main className="wrap">
        <Outlet />
      </main>

      <footer className="footer" data-testid="footer">
        <div className="footer-links">
          <Link to="/profile">My Profile</Link> <span>|</span>
          <Link to="/founders">Founders</Link>
        </div>
        <div
          className="social-footer"
          style={{ marginTop: 16, display: 'flex', justifyContent: 'center', gap: 20 }}
        >
          <a href="#" target="_blank" rel="noopener noreferrer" aria-label="Facebook" style={{ color: 'var(--primary-dark)', fontSize: '1.2rem' }}>
            <i className="fab fa-facebook-f"></i>
          </a>
          <a href="#" target="_blank" rel="noopener noreferrer" aria-label="Instagram" style={{ color: 'var(--primary-dark)', fontSize: '1.2rem' }}>
            <i className="fab fa-instagram"></i>
          </a>
          <a href="#" target="_blank" rel="noopener noreferrer" aria-label="X (Twitter)" style={{ color: 'var(--primary-dark)', fontSize: '1.2rem' }}>
            <i className="fab fa-x-twitter"></i>
          </a>
        </div>
        <p>&copy; 2025 The Meadow. All rights reserved.</p>
      </footer>
    </>
  );
}
