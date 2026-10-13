import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import './admin.css';
import {
  OverviewSection,
  AnalyticsSection,
  MembersSection,
  SubscriptionsSection,
  CrudSection,
  CommunicationsSection,
  LogsSection,
  CollaborationsSection,
  ProgressSection,
  TeamSection,
  AuditSection,
  InviteAcceptPanel,
} from './sections.jsx';
import {
  ReviewCentreSection,
  RecognitionSection,
  SupportInboxSection,
  NectarLedgerSection,
  NotificationsSection,
  SettingsSection,
  IntegrationHealthSection,
} from './sections-crm.jsx';
import { DashboardSection } from './sections-dashboard.jsx';
import {
  ActivityFeedSection,
  ReflectionsSection,
  SigmaInboxSection,
  TicketHistorySection,
  GiftFulfilmentSection,
} from './sections-phase-a.jsx';

/**
 * The administration surface for Hive Nectar.
 *
 * Design rules this file exists to enforce:
 *  - Nothing here reads a table directly. RLS on the Hive tables only exposes a
 *    member's own row, so a direct .from() query returns the wrong rows or none at
 *    all. Every read and write goes through an admin_* RPC.
 *  - Reachability is decided by the database, not the browser: admin_ok() is
 *    evaluated as the caller, so hiding a button is never the control.
 *  - No member-facing code is imported here, and no member-facing table is
 *    written by anything in this directory.
 */

const TasksSection = (p) => <CrudSection entity="tasks" {...p} />;
const ThemesSection = (p) => <CrudSection entity="themes" {...p} />;
const TokensSection = (p) => <CrudSection entity="tokens" {...p} />;
const MilestonesSection = (p) => <CrudSection entity="milestones" {...p} />;
const HubContentSection = (p) => <CrudSection entity="hub" {...p} />;
const NavMenuSection = (p) => <CrudSection entity="nav" {...p} />;
const SocialLinksSection = (p) => <CrudSection entity="social" {...p} />;
const PolicyBriefsSection = (p) => <CrudSection entity="policy" {...p} />;
const FoundersSection = (p) => <CrudSection entity="founder" {...p} />;

/**
 * The navigation, grouped. This is a re-grouping of the previous flat list, not a
 * rewrite: every section that was reachable before is still reachable, under the
 * same id (so existing links such as /admin?section=review keep working).
 *
 * Only entries backed by a real component live here. Modules with no data model
 * yet (the deferred content/business screens) are deliberately absent rather than
 * shown disabled, because a menu item must never lead to a non-functional screen.
 *
 * `defaultOpen` seeds the collapse state on first visit; after that the choice is
 * read back from localStorage (see readGroupOpen/writeGroupOpen).
 */
const NAV_GROUPS = [
  {
    id: 'overview',
    label: 'OVERVIEW',
    defaultOpen: true,
    items: [
      { id: 'dashboard', label: 'Dashboard', component: DashboardSection },
      { id: 'activity-feed', label: 'Activity Feed', component: ActivityFeedSection },
      { id: 'analytics', label: 'Analytics', component: AnalyticsSection },
      { id: 'overview', label: 'Overview', component: OverviewSection },
    ],
  },
  {
    id: 'members-recognition',
    label: 'MEMBERS & RECOGNITION',
    defaultOpen: true,
    items: [
      { id: 'members', label: 'Members', component: MembersSection },
      { id: 'review', label: 'Member Reviews', component: ReviewCentreSection },
      { id: 'reflections', label: 'Reflections', component: ReflectionsSection },
      { id: 'sigma-logs', label: 'Sigma Logs', component: SigmaInboxSection },
      { id: 'nectar', label: 'Nectar & Impact', component: NectarLedgerSection },
      { id: 'logs', label: 'Impact Logs', component: LogsSection },
      { id: 'progress', label: 'Member Progress', component: ProgressSection },
      { id: 'recognition', label: 'Recognition & Rewards', component: RecognitionSection },
      { id: 'gift-fulfilment', label: 'Physical Gift Fulfilment', component: GiftFulfilmentSection },
      { id: 'memberships', label: 'Memberships & Subscriptions', component: SubscriptionsSection },
    ],
  },
  {
    id: 'the-meadow',
    label: 'THE MEADOW',
    defaultOpen: false,
    items: [
      { id: 'tasks', label: 'Tasks', component: TasksSection },
      { id: 'themes', label: 'Themes & Stages', component: ThemesSection },
      { id: 'tokens', label: 'Tokens & Achievements', component: TokensSection },
      { id: 'milestones', label: 'Milestones & Badges', component: MilestonesSection },
      { id: 'collaborations', label: 'Collaborations & Invitations', component: CollaborationsSection },
    ],
  },
  {
    id: 'communications',
    label: 'COMMUNICATIONS',
    defaultOpen: false,
    items: [
      { id: 'support-inbox', label: 'Support Inbox', component: SupportInboxSection },
      { id: 'ticket-history', label: 'Ticket History', component: TicketHistorySection },
      { id: 'communications', label: 'Communication Board', component: CommunicationsSection },
      { id: 'notifications', label: 'Email & Notifications', component: NotificationsSection },
    ],
  },
  {
    id: 'content-business',
    label: 'CONTENT & BUSINESS',
    defaultOpen: false,
    items: [
      { id: 'hub', label: 'Website CMS', component: HubContentSection },
      { id: 'nav', label: 'Navigation Menu', component: NavMenuSection },
      { id: 'social', label: 'Social Links', component: SocialLinksSection },
      { id: 'policy', label: 'Policy Briefs', component: PolicyBriefsSection },
      { id: 'founders', label: 'Founders', component: FoundersSection },
    ],
  },
  {
    id: 'operations',
    label: 'OPERATIONS',
    defaultOpen: false,
    items: [
      { id: 'team', label: 'Admin Team & Permissions', component: TeamSection },
      { id: 'audit', label: 'Audit Logs', component: AuditSection },
      { id: 'health', label: 'System Health', component: IntegrationHealthSection },
      { id: 'settings', label: 'Settings', component: SettingsSection },
    ],
  },
];

const NAV_SECTIONS = NAV_GROUPS.flatMap((g) => g.items);

// Section ids the dashboard's metric cards may navigate to. The RPC's `links`
// object uses its own ids for a couple of groups, so those are translated here.
// 'billing' is intentionally absent: that screen is deferred, so a billing card
// is rendered as a plain, non-clickable card instead of a dead link.
const SECTION_ALIASES = { 'member-reviews': 'review' };
const NAV_TARGETS = new Set([
  ...NAV_SECTIONS.map((n) => n.id),
  // The RPC's `links` object names a couple of groups with its own ids, so the
  // alias keys count as navigable targets too.
  ...Object.keys(SECTION_ALIASES),
]);

const NAV_OPEN_PREFIX = 'hive.admin.nav.';

/** Open/closed for one group, falling back to the seed when nothing is stored. */
function readGroupOpen(groupId, fallback) {
  try {
    const stored = window.localStorage.getItem(NAV_OPEN_PREFIX + groupId);
    if (stored === 'open') return true;
    if (stored === 'closed') return false;
  } catch {
    // Private mode / storage disabled: fall through to the default.
  }
  return fallback;
}

function writeGroupOpen(groupId, isOpen) {
  try {
    window.localStorage.setItem(NAV_OPEN_PREFIX + groupId, isOpen ? 'open' : 'closed');
  } catch {
    // Storage unavailable: the toggle still works for this session.
  }
}

export default function AdminApp() {
  const [gate, setGate] = useState({ state: 'loading' });
  const [toast, setToast] = useState(null);
  const [invites, setInvites] = useState([]);
  const [myRole, setMyRole] = useState(null);
  const [nonce, setNonce] = useState(0);
  const [openGroups, setOpenGroups] = useState(() => {
    const initial = {};
    for (const g of NAV_GROUPS) initial[g.id] = readGroupOpen(g.id, g.defaultOpen);
    return initial;
  });
  const navigate = useNavigate();
  const location = useLocation();
  const active = new URLSearchParams(location.search).get('section') || 'overview';
  const inviteToken = new URLSearchParams(location.search).get('invite');
  const reloadEverything = useCallback(() => setNonce((n) => n + 1), []);

  const notify = useCallback((message, kind = 'ok') => setToast({ message, kind, at: Date.now() }), []);

  useEffect(() => {
    document.title = 'Administration - Hive Nectar';
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
          if (alive) setGate({ state: 'anon' });
          return;
        }
        const { data, error } = await supabase.rpc('admin_ok');
        if (error) throw new Error(error.message);
        const isAdmin = data === true || data === 'true';
        if (alive) {
          setGate(isAdmin
            ? { state: 'ok', email: session.user.email }
            : { state: 'denied', email: session.user.email });
        }
        // Any signed-in person may be holding an invitation, so this is asked for
        // regardless of whether they are already an admin. The database decides
        // what it means; nothing here grants anything.
        const ctx = await supabase.rpc('admin_get_my_context');
        if (alive && !ctx.error && ctx.data && typeof ctx.data === 'object') {
          setMyRole(ctx.data);
          setInvites(Array.isArray(ctx.data.pending_invitations) ? ctx.data.pending_invitations : []);
        }
      } catch (e) {
        // Also covers the unconfigured-client case: if the anon key is missing,
        // supabase is a Proxy whose members throw, and the panel must say so
        // rather than spin forever.
        if (alive) setGate({ state: 'error', message: e && e.message ? e.message : String(e) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [nonce]);

  const toggleGroup = useCallback((groupId) => {
    setOpenGroups((prev) => {
      const next = { ...prev, [groupId]: !prev[groupId] };
      writeGroupOpen(groupId, next[groupId]);
      return next;
    });
  }, []);

  // Section changes go through the router so the URL stays shareable and the
  // browser's back button behaves.
  const select = (id) => navigate(`/admin?section=${id}`);

  // The group that hosts the active section, if any. Landing on a section that
  // lives in a collapsed group (a deep link, or a dashboard card) must reveal
  // it so the current screen is never hidden. Derived during render rather than
  // in an effect: it is a pure function of the URL, so there is nothing to
  // synchronise and no extra render pass.
  const activeHostId = NAV_GROUPS.find((g) => g.items.some((n) => n.id === active))?.id;

  // Metric cards hand back the section id the RPC chose for that group; unknown
  // ids (a deferred screen) are ignored rather than routed to a blank page.
  const navigateToSection = (sectionId) => {
    const target = SECTION_ALIASES[sectionId] || sectionId;
    if (NAV_TARGETS.has(target)) select(target);
  };

  const current = NAV_SECTIONS.find((n) => n.id === active) || NAV_SECTIONS[0];
  const Current = current.component;

  if (gate.state === 'loading') {
    return <Screen title="Administration"><p>Checking your access.</p></Screen>;
  }
  if (gate.state === 'anon') {
    return (
      <Screen title="Administration">
        <p>You need to sign in with an administrator account.</p>
        <p><Link className="adm-btn adm-btn--primary" to="/login.html">Sign in</Link></p>
      </Screen>
    );
  }
  if (gate.state === 'denied') {
    if (inviteToken || invites.length) {
      return (
        <Screen title="You have been invited">
          <p>An invitation is waiting for {gate.email}. Accepting it needs no other approval.</p>
          <InviteAcceptPanel token={inviteToken} onAccepted={reloadEverything} />
        </Screen>
      );
    }
    return (
      <Screen title="Access denied">
        <p>{gate.email} is not an administrator on this project.</p>
        <p><Link className="adm-btn" to="/the-meadow.html">Back to The Meadow</Link></p>
      </Screen>
    );
  }
  if (gate.state === 'error') {
    return (
      <Screen title="Administration">
        <div className="adm-error">{gate.message}</div>
        <p><Link className="adm-btn" to="/login.html">Sign in again</Link></p>
      </Screen>
    );
  }

  return (
    <div className="adm-shell">
      <aside className="adm-side">
        <div className="adm-brand">
          <strong>Hive Nectar</strong>
          <span>Administration</span>
        </div>
        <nav>
          {NAV_GROUPS.map((group) => {
            // Open if the user left it open, or if it hosts the active section
            // (see activeHostId) so a deep link is never left hidden.
            const isOpen = Boolean(openGroups[group.id]) || activeHostId === group.id;
            const panelId = `adm-nav-panel-${group.id}`;
            return (
              <div className="adm-nav-group" key={group.id}>
                <button
                  type="button"
                  className="adm-nav-toggle"
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onClick={() => toggleGroup(group.id)}
                >
                  {group.label}
                </button>
                <div className="adm-nav-panel" id={panelId} hidden={!isOpen}>
                  {group.items.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      className={n.id === active ? 'is-active' : undefined}
                      onClick={() => select(n.id)}
                    >
                      {n.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </nav>
        <div className="adm-side-foot">
          <span>{gate.email}</span>
          {myRole && myRole.label ? <span className="adm-note">{myRole.label}</span> : null}
          <Link to="/the-meadow.html">Member site</Link>
          <button
            type="button"
            onClick={async () => {
              await supabase.auth.signOut();
              window.location.href = '/login.html';
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="adm-main">
        {inviteToken || invites.length ? (
          <InviteAcceptPanel token={inviteToken} onAccepted={reloadEverything} />
        ) : null}
        <Current notify={notify} onNavigate={navigateToSection} navigableIds={NAV_TARGETS} />
      </main>
      {toast ? <div className={`adm-toast adm-toast--${toast.kind}`}>{toast.message}</div> : null}
    </div>
  );
}

function Screen({ title, children }) {
  return (
    <div className="adm-gate">
      <div className="adm-gate-card">
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}
