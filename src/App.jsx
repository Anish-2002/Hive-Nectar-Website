import { Routes, Route, Navigate } from 'react-router-dom';
import LegacyPage, { LEGACY_PAGES } from './components/LegacyPage.jsx';
import AdminApp from './admin/AdminApp.jsx';

/**
 * Route table — one route per original page, addressed by the *original* file
 * name so the URL stays identical to the vanilla site.
 *
 * Why the `.html` route paths matter: `js/app.js` decides what to initialise
 * from `window.location.pathname` (`path.includes('profile.html')`,
 * `path.includes('board.html')`, `path.includes('contact.html')`, …). Keeping
 * the real file name in the URL means the original bootstrap behaves exactly
 * as it does on the live site — no forked code, no reimplementation.
 *
 * `/index.html` (and `/`) is the original redirect shim, so it forwards to
 * The Meadow exactly as the vanilla index.html does.
 *
 * Administration is the one surface that is NOT served by the legacy pages any
 * more. The five legacy admin screens (CRM, admin-crm, admin_comms, admin_inbox,
 * admin-achievements) were table-writing clients that RLS silently blocked; they
 * are replaced by `/admin`, which talks to the gated admin_* RPCs. Their old URLs
 * redirect there so existing in-page links keep working.
 */
const ADMIN_PAGES = ['CRM.html', 'admin-achievements.html', 'admin_comms.html', 'admin-crm.html', 'admin_inbox.html'];
const PAGE_ROUTES = LEGACY_PAGES.filter((file) => file !== 'index.html' && !ADMIN_PAGES.includes(file));

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/the-meadow.html" replace />} />
      <Route path="/index.html" element={<Navigate to="/the-meadow.html" replace />} />
      <Route path="/admin" element={<AdminApp />} />
      <Route path="/admin.html" element={<Navigate to="/admin" replace />} />
      {ADMIN_PAGES.map((file) => (
        <Route key={file} path={`/${file}`} element={<Navigate to="/admin" replace />} />
      ))}
      {PAGE_ROUTES.map((file) => (
        <Route key={file} path={`/${file}`} element={<LegacyPage file={file} />} />
      ))}
      <Route path="*" element={<Navigate to="/the-meadow.html" replace />} />
    </Routes>
  );
}
