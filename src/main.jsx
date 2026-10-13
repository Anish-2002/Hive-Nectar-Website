import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import './index.css'

// NOTE: StrictMode is intentionally NOT used here. In development StrictMode
// mounts every component twice; the legacy engine inserts real DOM nodes and
// runs the original page scripts, so a double mount would duplicate the
// document and re-run the vanilla bootstrap. The vanilla site has no such
// double-initialisation, and neither does this port.
//
// The original site is a multi-page application: every link and every
// window.location assignment is a full document load, and Back/Forward is a
// real navigation that re-fetches the document and re-evaluates each module
// from scratch. The router below handles the *first* page load; a history
// navigation is turned back into a real reload so the port behaves the same
// way. Without this, going Back would re-mount the previous page in place,
// where the original scripts (already evaluated for this document) would not
// re-run and the page would come back inert.
window.addEventListener('popstate', () => window.location.reload())

ReactDOM.createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
)
