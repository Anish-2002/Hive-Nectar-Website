import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  Award,
  Bell,
  ChartLine,
  ChevronDown,
  ChevronLeft,
  ClipboardCheck,
  ClipboardList,
  Coins,
  CreditCard,
  Droplets,
  ExternalLink,
  FileSearch,
  FileText,
  Flag,
  Gauge,
  Globe,
  Handshake,
  HeartPulse,
  History,
  Inbox,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Mail,
  Megaphone,
  Menu,
  NotebookPen,
  Package,
  Palette,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  TrendingUp,
  Users,
  UsersRound,
  X,
} from 'lucide-react';
import { supabase } from '../lib/supabase.js';
import { rpc, rows } from './api.js';
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
import { MailSection } from './sections-mail.jsx';
import { DashboardSection } from './sections-dashboard.jsx';
import {
  ActivityFeedSection,
  ReflectionsSection,
  SigmaInboxSection,
  TicketHistorySection,
  GiftFulfilmentSection,
} from './sections-phase-a.jsx';
// The design system loads LAST, and in this order: ds-legacy.css re-points the
// four older admin stylesheets at the tokens, then ds.css — the tokens, the
// application shell and the type scale — lands on top, so a generated size can
// never beat a deliberate one. Both use the compound `.adm-shell.ds-shell`
// prefix so they win on specificity whatever the section modules import first.
import './ds-legacy.css';
import './ds.css';

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
 *
 * The shell (sidebar, top bar, page frame) is the design-system layer: it renders
 * chrome only, and every figure it shows comes from an admin_* RPC.
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
      { id: 'memberships', label: 'Memberships', component: SubscriptionsSection },
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
      { id: 'mail', label: 'Mail Queue', component: MailSection },
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

/**
 * One icon per destination. Lucide, 1.5px stroke, sized by the stylesheet — the
 * same visual language as the reference design, and no emoji anywhere.
 */
const NAV_ICONS = {
  dashboard: LayoutDashboard,
  'activity-feed': Activity,
  analytics: ChartLine,
  overview: Gauge,
  members: Users,
  review: ClipboardCheck,
  reflections: NotebookPen,
  'sigma-logs': FileSearch,
  nectar: Droplets,
  logs: ClipboardList,
  progress: TrendingUp,
  recognition: Award,
  'gift-fulfilment': Package,
  memberships: CreditCard,
  tasks: ListChecks,
  themes: Palette,
  tokens: Coins,
  milestones: Flag,
  collaborations: Handshake,
  'support-inbox': Inbox,
  'ticket-history': History,
  communications: Megaphone,
  notifications: Bell,
  mail: Mail,
  hub: Globe,
  nav: Menu,
  social: Share2,
  policy: FileText,
  founders: UsersRound,
  team: ShieldCheck,
  audit: ClipboardList,
  health: HeartPulse,
  settings: Settings,
};

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
const RAIL_KEY = 'hive.admin.shell.rail';

/**
 * The four queues the notification indicator reads. Each one is the same
 * admin_* RPC the corresponding screen uses (Support Inbox calls
 * admin_get_tickets, Mail Queue calls admin_get_mail_outbox, …), asked with a
 * one-row page because only the totals are wanted.
 *
 * `count` extracts the real figure from that RPC's payload; when an RPC has no
 * figure to give (the fulfilment queue reports an empty `counts`) the value is
 * null and the indicator shows nothing rather than a guess.
 *
 * `watch` marks the queues that are waiting on an administrator: those are the
 * ones that roll up into the badge number. A queue depth that nobody has to act
 * on (everything in the sigma inbox) is listed but not counted.
 */
const BELL_QUEUES = [
  {
    key: 'review',
    label: 'Member reviews waiting on a decision',
    section: 'review',
    call: () => rpc('admin_get_review_queue', { p_status: 'new', p_limit: 1, p_offset: 0 }),
    count: (p) => countOf(p?.counts?.new),
    watch: true,
  },
  {
    key: 'tickets',
    label: 'New support tickets',
    section: 'support-inbox',
    call: () => rpc('admin_get_tickets', { p_status: 'new', p_limit: 1, p_offset: 0 }),
    count: (p) => countOf(p?.counts?.new),
    watch: true,
  },
  {
    key: 'mail',
    label: 'Mail the transport could not send',
    section: 'mail',
    call: () => rpc('admin_get_mail_outbox', { p_status: 'failed', p_limit: 1, p_offset: 0 }),
    count: (p) => countOf(p?.total),
    watch: true,
  },
  {
    key: 'sigma',
    label: 'Sigma logs sitting in the inbox',
    section: 'sigma-logs',
    call: () => rpc('admin_get_sigma_inbox', { p_status: null, p_limit: 1, p_offset: 0 }),
    count: (p) => countOf(p?.total),
    watch: false,
  },
];

// Sections that show a queue position next to their name, and which queue.
const NAV_BADGES = {
  review: 'review',
  'support-inbox': 'tickets',
  mail: 'mail',
  'sigma-logs': 'sigma',
};

/** A real number, or null. Never coerces a missing figure into a zero. */
function countOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

// The sidebar keeps the section label one glance away when it is collapsed to
// the icon rail: the title attribute carries it, and so does the tooltip rule in
// ds.css. No extra markup is needed.

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

function readRail() {
  try {
    return window.localStorage.getItem(RAIL_KEY) === '1';
  } catch {
    return false;
  }
}

function writeRail(isRail) {
  try {
    window.localStorage.setItem(RAIL_KEY, isRail ? '1' : '0');
  } catch {
    // Storage unavailable: the rail still works for this session.
  }
}

export default function AdminApp() {
  const [gate, setGate] = useState({ state: 'loading' });
  const [toast, setToast] = useState(null);
  const [invites, setInvites] = useState([]);
  const [myRole, setMyRole] = useState(null);
  const [nonce, setNonce] = useState(0);
  const [rail, setRail] = useState(readRail);
  const [queues, setQueues] = useState({ state: 'idle', values: {} });
  const [bellOpen, setBellOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [people, setPeople] = useState(null);
  const [openGroups, setOpenGroups] = useState(() => {
    const initial = {};
    for (const g of NAV_GROUPS) initial[g.id] = readGroupOpen(g.id, g.defaultOpen);
    return initial;
  });
  const navigate = useNavigate();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const active = params.get('section') || 'overview';
  const inviteToken = params.get('invite');
  const reloadEverything = useCallback(() => setNonce((n) => n + 1), []);
  const barRef = useRef(null);

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

  /**
   * The queue figures behind the notification indicator. Every call is the RPC a
   * screen already uses; a queue that fails to answer is reported as unknown and
   * contributes nothing to the badge, so a failed read can never look like work.
   */
  const loadQueues = useCallback(async () => {
    setQueues((q) => ({ ...q, state: 'loading' }));
    const values = {};
    let failed = 0;
    for (const queue of BELL_QUEUES) {
      try {
        const payload = await queue.call();
        values[queue.key] = queue.count(payload);
      } catch {
        values[queue.key] = null;
        failed += 1;
      }
    }
    setQueues({ state: failed === BELL_QUEUES.length ? 'error' : 'ready', values });
  }, []);

  useEffect(() => {
    if (gate.state !== 'ok') return undefined;
    let alive = true;
    (async () => {
      const values = {};
      let failed = 0;
      for (const queue of BELL_QUEUES) {
        try {
          const payload = await queue.call();
          values[queue.key] = queue.count(payload);
        } catch {
          values[queue.key] = null;
          failed += 1;
        }
      }
      if (alive) setQueues({ state: failed === BELL_QUEUES.length ? 'error' : 'ready', values });
    })();
    // Long enough not to hammer the database, short enough that a queue position
    // is never stale by more than a couple of minutes.
    const timer = setInterval(() => { if (alive) loadQueues(); }, 120000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [gate.state, loadQueues]);

  // Popovers close on an outside click and on Escape, the way every other
  // desktop application behaves.
  useEffect(() => {
    const onDown = (event) => {
      if (barRef.current && !barRef.current.contains(event.target)) {
        setBellOpen(false);
        setMenuOpen(false);
        setSearchOpen(false);
      }
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        setBellOpen(false);
        setMenuOpen(false);
        setSearchOpen(false);
      }
      if (event.key === '/' && !event.metaKey && !event.ctrlKey) {
        const tag = String((event.target && event.target.tagName) || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        event.preventDefault();
        setSearchOpen(true);
        const box = document.querySelector('.ds-search input');
        if (box) box.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

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

  const toggleRail = () => {
    setRail((prev) => {
      writeRail(!prev);
      return !prev;
    });
  };

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
  const activeGroup = NAV_GROUPS.find((g) => g.id === activeHostId);

  // ── global search ────────────────────────────────────────────────────────
  // Two real sources: the destinations this shell can open, and the member list
  // the Members screen itself reads (admin_get_users, the same RPC). Nothing is
  // indexed twice and nothing is invented.
  const needle = query.trim().toLowerCase();
  const sectionHits = useMemo(() => {
    if (!needle) return [];
    return NAV_SECTIONS.filter((n) => n.label.toLowerCase().includes(needle)
      || n.id.includes(needle.replace(/\s+/g, '-'))).slice(0, 6);
  }, [needle]);

  useEffect(() => {
    if (gate.state !== 'ok' || needle.length < 2 || people) return undefined;
    let alive = true;
    (async () => {
      try {
        const payload = await rpc('admin_get_users');
        if (alive) setPeople(rows(payload));
      } catch {
        if (alive) setPeople([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [gate.state, needle, people]);

  const peopleHits = useMemo(() => {
    if (!needle || needle.length < 2 || !people) return [];
    return people.filter((u) => [u.first_name, u.last_name, u.username, u.email]
      .some((v) => String(v || '').toLowerCase().includes(needle))).slice(0, 6);
  }, [needle, people]);

  const watched = BELL_QUEUES.filter((q) => q.watch);
  const anyUnknown = watched.some((q) => countOf(queues.values[q.key]) === null);
  const badge = watched.reduce((sum, q) => sum + (countOf(queues.values[q.key]) || 0), 0);

  const openPeople = (id) => {
    setSearchOpen(false);
    setQuery('');
    navigate(`/admin?section=members&member=${encodeURIComponent(id)}`);
  };
  const openSection = (target) => {
    setSearchOpen(false);
    setQuery('');
    select(target);
  };

  if (gate.state === 'loading') {
    return <Screen title="Administration"><p>Checking your access.</p></Screen>;
  }
  if (gate.state === 'anon') {
    return (
      <Screen title="Administration">
        <p>You need to sign in with an administrator account.</p>
        <p><Link className="ds-btn ds-btn--primary" to="/login.html">Sign in</Link></p>
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
        <p><Link className="ds-btn" to="/the-meadow.html">Back to The Meadow</Link></p>
      </Screen>
    );
  }
  if (gate.state === 'error') {
    return (
      <Screen title="Administration">
        <div className="ds-error">{gate.message}</div>
        <p><Link className="ds-btn" to="/login.html">Sign in again</Link></p>
      </Screen>
    );
  }

  return (
    <div className={`adm-shell ds-shell${rail ? ' is-rail' : ''}`}>
      <aside className="ds-side">
        <div className="ds-brand">
          <span className="ds-brand-mark" aria-hidden="true">HN</span>
          <span className="ds-brand-text">
            <strong>Hive Nectar</strong>
            <span>Admin CRM</span>
          </span>
        </div>

        <nav className="ds-nav" aria-label="Administration sections">
          {NAV_GROUPS.map((group) => {
            // Open if the user left it open, or if it hosts the active section
            // (see activeHostId) so a deep link is never left hidden.
            const isOpen = Boolean(openGroups[group.id]) || activeHostId === group.id;
            const panelId = `adm-nav-panel-${group.id}`;
            return (
              <div className="ds-nav-group" key={group.id}>
                <button
                  type="button"
                  className="ds-nav-toggle"
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  title={group.label}
                  onClick={() => toggleGroup(group.id)}
                >
                  <span className="ds-nav-toggle-label">{group.label}</span>
                  <ChevronDown className="ds-nav-chevron" size={14} aria-hidden="true" />
                </button>
                <div className="ds-nav-panel" id={panelId} hidden={!isOpen}>
                  {group.items.map((n) => {
                    const Icon = NAV_ICONS[n.id] || LayoutDashboard;
                    const queueKey = NAV_BADGES[n.id];
                    const queueCount = queueKey ? countOf(queues.values[queueKey]) : null;
                    return (
                      <button
                        key={n.id}
                        type="button"
                        className={`ds-nav-item${n.id === active ? ' is-active' : ''}`}
                        onClick={() => select(n.id)}
                        title={n.label}
                        aria-current={n.id === active ? 'page' : undefined}
                      >
                        <Icon className="ds-nav-icon" size={16} aria-hidden="true" />
                        <span className="ds-nav-label">{n.label}</span>
                        {queueCount ? (
                          <span className="ds-nav-count" title={`${queueCount} waiting`}>{queueCount}</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>

        <div className="ds-side-foot">
          <button
            type="button"
            className="ds-rail-toggle"
            onClick={toggleRail}
            title={rail ? 'Expand the menu' : 'Collapse the menu'}
          >
            {rail ? <ChevronRight size={16} aria-hidden="true" /> : <ChevronLeft size={16} aria-hidden="true" />}
            <span className="ds-nav-label">{rail ? 'Expand menu' : 'Collapse menu'}</span>
          </button>
        </div>
      </aside>

      <div className="ds-body">
        <header className="ds-topbar" ref={barRef}>
          <div className="ds-crumbs" aria-label="Breadcrumb">
            <button
              type="button"
              className="ds-sidebar-toggle"
              onClick={toggleRail}
              title={rail ? 'Expand the menu' : 'Collapse the menu'}
              aria-label={rail ? 'Expand the menu' : 'Collapse the menu'}
            >
              <Menu size={18} aria-hidden="true" />
            </button>
            <span className="ds-crumbs-group">{activeGroup ? activeGroup.label : 'ADMINISTRATION'}</span>
            <span className="ds-crumb-sep" aria-hidden="true">/</span>
            <span className="ds-crumb-current">{current.label}</span>
          </div>

          <div className="ds-search" role="search">
            <Search className="ds-search-icon" size={16} aria-hidden="true" />
            <input
              type="search"
              value={query}
              placeholder="Search sections and members…"
              aria-label="Search sections and members"
              onFocus={() => setSearchOpen(true)}
              onChange={(e) => { setQuery(e.target.value); setSearchOpen(true); }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                if (sectionHits.length) openSection(sectionHits[0].id);
                else if (peopleHits.length) openPeople(peopleHits[0].id);
              }}
            />
            {query ? (
              <button type="button" className="ds-search-clear" onClick={() => setQuery('')} aria-label="Clear the search">
                <X size={14} aria-hidden="true" />
              </button>
            ) : null}
            {searchOpen && needle ? (
              <div className="ds-search-panel">
                {sectionHits.length ? (
                  <>
                    <p className="ds-search-group">Sections</p>
                    {sectionHits.map((n) => (
                      <button key={n.id} type="button" className="ds-search-hit" onClick={() => openSection(n.id)}>
                        <span>{n.label}</span>
                        <span className="ds-search-hit-note">{n.id}</span>
                      </button>
                    ))}
                  </>
                ) : null}
                {peopleHits.length ? (
                  <>
                    <p className="ds-search-group">Members</p>
                    {peopleHits.map((u) => (
                      <button key={u.id} type="button" className="ds-search-hit" onClick={() => openPeople(u.id)}>
                        <span>{[u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || u.email}</span>
                        <span className="ds-search-hit-note">{u.email || u.username}</span>
                      </button>
                    ))}
                  </>
                ) : null}
                {!sectionHits.length && !peopleHits.length ? (
                  <p className="ds-search-none">
                    {people === null && needle.length >= 2 ? 'Searching…' : 'Nothing matches that.'}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="ds-actions">
            <span className="ds-menu-wrap">
              <button
                type="button"
                className="ds-icon-btn"
                aria-label={badge ? `${badge} items need attention` : 'Nothing needs attention'}
                aria-expanded={bellOpen}
                onClick={() => {
                  setMenuOpen(false);
                  setBellOpen((open) => {
                    if (!open) loadQueues();
                    return !open;
                  });
                }}
              >
                <Bell size={18} aria-hidden="true" />
                {badge ? <span className="ds-bell-count">{badge > 99 ? '99+' : badge}</span> : null}
                {!badge && anyUnknown && queues.state === 'ready' ? <span className="ds-bell-unknown" /> : null}
              </button>

              {bellOpen ? (
                <div className="ds-menu ds-menu--bell">
                  <p className="ds-menu-head">Queues</p>
                  {queues.state === 'loading' && !Object.keys(queues.values).length ? (
                    <p className="ds-menu-note">Reading the queues…</p>
                  ) : null}
                  {queues.state === 'error' ? (
                    <p className="ds-menu-note">The queues could not be read. The sections still work.</p>
                  ) : null}
                  {BELL_QUEUES.map((q) => {
                    const value = countOf(queues.values[q.key]);
                    return (
                      <button
                        key={q.key}
                        type="button"
                        className="ds-menu-item"
                        onClick={() => { setBellOpen(false); select(q.section); }}
                      >
                        <span className="ds-menu-item-label">{q.label}</span>
                        <span className={`ds-menu-item-value${value ? ' is-live' : ''}`}>
                          {value === null ? '—' : value}
                        </span>
                      </button>
                    );
                  })}
                  <button type="button" className="ds-menu-foot" onClick={loadQueues}>Re-check the queues</button>
                </div>
              ) : null}
            </span>

            <span className="ds-menu-wrap">
              <button
                type="button"
                className="ds-avatar"
                aria-expanded={menuOpen}
                onClick={() => {
                  setBellOpen(false);
                  setMenuOpen((open) => !open);
                }}
              >
                <span className="ds-avatar-initials" aria-hidden="true">
                  {String(gate.email || '?').slice(0, 1).toUpperCase()}
                </span>
                <ChevronDown size={14} aria-hidden="true" />
              </button>

              {menuOpen ? (
                <div className="ds-menu">
                  <div className="ds-menu-identity">
                    <span className="ds-avatar-initials" aria-hidden="true">
                      {String(gate.email || '?').slice(0, 1).toUpperCase()}
                    </span>
                    <span>
                      <strong>{gate.email}</strong>
                      <span className="ds-menu-note">{myRole && myRole.label ? myRole.label : 'Administrator'}</span>
                    </span>
                  </div>
                  <Link className="ds-menu-item" to="/the-meadow.html">
                    <span className="ds-menu-item-label">Member site</span>
                    <ExternalLink size={14} aria-hidden="true" />
                  </Link>
                  <button
                    type="button"
                    className="ds-menu-item"
                    onClick={async () => {
                      await supabase.auth.signOut();
                      window.location.href = '/login.html';
                    }}
                  >
                    <span className="ds-menu-item-label">Sign out</span>
                    <LogOut size={14} aria-hidden="true" />
                  </button>
                </div>
              ) : null}
            </span>
          </div>
        </header>

        <main className="adm-main ds-main">
          <div className="ds-page">
            {inviteToken || invites.length ? (
              <InviteAcceptPanel token={inviteToken} onAccepted={reloadEverything} />
            ) : null}
            <Current notify={notify} onNavigate={navigateToSection} navigableIds={NAV_TARGETS} />
          </div>
        </main>
      </div>

      {toast ? <div className={`ds-toast ds-toast--${toast.kind}`}>{toast.message}</div> : null}
    </div>
  );
}

function Screen({ title, children }) {
  return (
    <div className="adm-gate ds-gate">
      <div className="adm-gate-card ds-gate-card">
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}
