# HIVE NECTAR — CUSTOM ADMIN CRM
## Complete Design, Architecture and Implementation Brief

You are the lead full-stack engineer, product architect, UI/UX designer and quality assurance engineer for Hive Nectar.

**MISSION:** Build our own fully functional, production-quality administrative CRM to replace the existing fragmented Hive Nectar admin pages. We are NOT using Twenty CRM, Zendesk or another external CRM platform. We are developing and owning our entire administration system, with Zendesk-like support functionality built natively into it.

The CRM must become the **single command centre for operating Hive Nectar**. Every feature must work with real application data and persist changes correctly. A visually complete feature that does nothing is unacceptable.

## 1. Mandatory inspection before implementation

Read `HIVE-MEADOWS-GUIDE.md` in full, then inspect the actual repository, deployed Supabase schema, RLS policies, SQL functions, authentication, Stripe integration, email services and existing administration pages.

The guide is our primary reference but not proof of the current deployment. Verify any differences.

Identify what already exists, what works, what is broken, what is missing and what requires migration. Do not invent tables, functions, files, endpoints, deployment status or successful test results.

The guide previously identified several important gaps:
- Existing administration pages use direct table queries where privileged admin RPCs are needed.
- Some older admin inbox and communications pages use disconnected localStorage.
- Admin broadcasts have a `content` versus `message` mismatch.
- The configuration reader and generic email sender reference unavailable backend functions.
- Some achievement-management controls are unwired.
- Some task progression, guardrail and reward logic is incomplete or inconsistent.

Confirm these issues against the current system and address the ones needed for a functional CRM.

Preserve working member-facing behaviour. Do not silently change the earning engine or membership rules.

## 2. Architecture and hosting

- Keep the existing Hive Nectar website on its current Vercel deployment and existing domain, including `hivenectarwebsite.vercel.app` where applicable.
- Supabase remains the authoritative backend for users, tasks, progress, nectar, achievements, tickets and other application data.
- Stripe remains the payment processor and subscription authority.
- Build the CRM as a separate, maintainable web application connected securely to the same Supabase project.
- Initially, the CRM must run on localhost. **No VPS purchase is required.**
- Design it so that deployment to a private admin subdomain is straightforward later.
- Use the existing repository's proven technology where suitable. Choose additional backend infrastructure only where genuinely required.
- Never put service-role keys, SMTP secrets, Stripe secrets or privileged credentials in browser code.
- All sensitive operations must be server-authorised and audited.
- Public website, members and CRM must share the same authoritative data without manual synchronisation.
- New signups, task completions, tickets and payments must be reflected automatically after the corresponding source event, with reliable refresh or realtime subscriptions where appropriate.
- Do not introduce a second independent customer database or duplicate the existing game engine.

## 3. UI/UX — professional, premium administration software

The CRM should feel like a polished modern SaaS platform, not a generic generated dashboard.

**Visual direction:**
- Clean white and warm ivory backgrounds.
- Soft grey borders and restrained shadows.
- Deep charcoal/navy typography.
- Subtle Hive Nectar gold (`#D9A441`) and optional muted forest-green accents.
- Modern, highly legible typography and consistent spacing.
- Calm, minimal surfaces with clear information hierarchy.
- Use Lucide, Font Awesome or another consistent professional icon family.
- Absolutely NO decorative emojis, cartoon bees, AI-generated visual clichés, excessive gradients or random colourful badges.
- Preserve existing canonical database values, including symbols in stored stage literals. Clean them only for display.
- Make the layout responsive across desktop, laptop and tablet.

**Main layout:**

A collapsible left sidebar with grouped navigation:

**Overview**
- Dashboard
- Activity Feed
- Analytics

**Community**
- Members
- Memberships & Subscriptions
- Collaborations & Invitations
- Referrals

**The Meadow**
- Tasks
- Themes & Stages
- Nectar & Impact
- Tokens & Achievements
- Milestones & Badges
- Honey Jar

**Content**
- Website CMS
- Communication Board
- TRail / Resources
- PollenPop
- Announcements

**Customer Experience**
- Support Inbox
- Ticket History
- Knowledge Base / FAQ
- Feedback & Suggestions

**Operations**
- Payments & Billing
- Email & Notifications
- Admin Team
- Audit Logs
- System Health
- Settings

Navigation must adapt to the current administrator's permissions. Each menu item must lead to a functional page; do not display unfinished modules as operational.

Provide a global search, notification centre, administrator profile menu and breadcrumbs.

All tables need meaningful search, filters, sorting, pagination, loading states, error handling and sensible empty states. Forms need real validation and useful success/failure feedback.

Prefer drawers for quick edits, dedicated pages for complex management and confirmations for destructive operations.

## 4. Dashboard — Hive command centre

Create a useful operational overview showing real, correctly sourced data:

- Total members, new signups today, weekly and monthly growth.
- Active members and recent logins where reliably measurable.
- Free versus paid membership breakdown.
- Revenue, active subscriptions, cancellations and renewals from verified Stripe records.
- Tasks completed today, this week and this month.
- Nectar awarded and total points, with clear metric definitions.
- Tokens, badges and milestones awarded.
- Pending support tickets, unanswered tickets and overdue requests.
- Collaboration invitations and pending approvals.
- Recent communications and content activity.
- Operational errors and integration health.

Include real charts for membership growth, engagement, revenue and task activity, each with appropriate date filters.

Provide a chronological activity feed linked to the underlying member, ticket, task or transaction.

Never display fabricated metrics or silent zero values when data retrieval fails.

## 5. Member management — full 360-degree profile

When someone signs up through Hive Nectar, their profile must appear automatically in the CRM. Administrators must never have to enter new members manually.

The member directory needs searchable name, email, membership tier, account status, signup date, nectar points and recent activity.

Clicking a member opens a complete administrative profile containing:
- Personal details and account information.
- Membership and subscription history.
- Current tier and access entitlements.
- Nectar balance, earned points and progress.
- Novice/Experienced status and growth stages.
- Tasks completed, pending and available.
- Tokens, badges, milestones and Honey Jar decorations.
- Collaborations, invitations and referrals.
- Payment and billing history.
- All support tickets and communication history.
- Internal administrative notes.
- Activity and audit trail.

Allow authorised administrators to edit permitted profile information, manage access, investigate problems, adjust points through safe approved operations, review subscription status and perform controlled progress repairs.

For point adjustments, require a reason, show before/after values, log the responsible admin and prevent accidental duplicate changes.

Never bypass Stripe as the source of payment truth or grant privileges through unprotected client-side updates.

Provide export capabilities with permission checks.

## 6. Tasks, themes and nectar administration

Build a complete visual management system for the existing task engine.

Administrators must be able to:
- Create, edit, duplicate, activate, archive and organise tasks.
- Manage themes, categories, subcategories, stages and task order.
- Configure descriptions, eligibility, nectar rewards, impact factors and media.
- Manage tier visibility and membership restrictions.
- Understand and configure existing sequential task progression rules without accidentally bypassing them.
- View task completion and engagement statistics.
- Identify incomplete, duplicate, placeholder or inconsistent tasks.
- Preview what an eligible member would see.
- Track progress across theme/stage combinations.

Respect existing stage keys, the 24-hour sequential unlock behaviour and Novice/Experienced logic unless a separately reviewed migration explicitly changes them.

Nectar management must show awarded points, impact totals, levels, engagement bands, history and adjustments with a clear ledger and auditability.

For configurable guardrails or earning rules, inspect whether enforcement actually exists before exposing switches that claim to control it.

## 7. Achievements, tokens, milestones and Honey Jar

Create working CRUD and administration screens for tokens, milestone definitions, badges and their stages.

Support artwork uploads, previews, associated themes, eligibility thresholds, visibility and active/inactive states.

Show which users have earned each reward and why.

Allow authorised manual awards, corrections or revocations only where the verified business rules and secure backend support them, with full audit records.

Provide a Honey Jar administration view that can inspect a member's earned collectibles and saved decorations without unnecessarily changing the member's arrangement.

Do not silently rewrite historical points or trigger duplicated awards.

## 8. Support centre — Zendesk-like, built into our CRM

**This is one of the highest-priority modules and must be fully operational end to end.**

Any support request from the website's Contact page, logged-in member support form, PollenPop enquiry or configured support email channel must enter one central Support Inbox.

Each request becomes a ticket with a unique human-readable ticket number.

**Ticket statuses:**
- New
- Open
- Pending Customer
- Pending Internal
- Resolved
- Closed

Include separate priority (Low, Normal, High, Urgent), category, assigned administrator, tags and timestamps.

**Inbox layout:**

Use a three-column customer-support workspace:
1. Left: searchable ticket queue, filters, saved views and unread indicators.
2. Centre: complete chronological conversation with customer messages, admin replies and attachments.
3. Right: customer profile, membership tier, related tickets, activity, internal notes and ticket properties.

Support agents must be able to:
- Open and reply to a ticket directly inside the CRM.
- Send the customer a real email or member-visible response through the configured delivery channel.
- Keep all previous messages linked to the same ticket.
- Add private internal notes that customers cannot see.
- Assign and reassign tickets to administrators.
- Update ticket priority, category, tags and status.
- Save response templates and reusable replies.
- Attach files securely.
- Search conversation history.
- Merge confirmed duplicates and link related tickets.
- View response and resolution timestamps.
- Resolve a request using a **Resolve Ticket** action.
- Enter an optional resolution summary.
- Reopen a resolved ticket if the customer replies or an administrator chooses to reopen it.
- Archive closed tickets without losing history.

**Email and conversation requirements:**

Use our configured transactional email provider (currently Brevo where applicable), with server-side authenticated sending.

Sending a reply must actually deliver the message and save the provider message ID, delivery status and conversation record. Failed sends must be clearly identified, retryable and never falsely marked as delivered.

If customers can reply by email, configure a real inbound-email mechanism or supported provider webhook. Match incoming replies to existing tickets using a durable ticket reference and message headers, not only email subject text.

Website and member portal support requests must enter the same system without relying on browser localStorage.

For a logged-out visitor, identify the ticket through their submitted email and a secure reply/viewing mechanism; never expose other users' tickets.

Provide email notifications for submission acknowledgement, agent replies and resolution. Prevent duplicate tickets and duplicate outgoing replies on retries.

**Ticket lifecycle acceptance test:**

A visitor submits a support request → ticket appears as New in the CRM → admin opens and replies → customer receives the reply → customer responds through a supported channel → response appears in the same ticket → admin resolves the ticket → it moves to Resolved → all history remains visible → a new customer reply reopens the ticket according to policy.

This entire journey must be tested with genuine database writes and a verified email delivery path. If inbound email cannot work without additional provider configuration, report that explicit blocker rather than claiming the workflow is complete.

Include agent workload views, response-time reporting and configurable SLA targets.

## 9. Communications and content management

Build a real administrative editor for Hive Nectar's Communication Board.

Allow administrators to create, edit, schedule where supported, publish, archive and remove announcements using actual Supabase-backed records.

Include title, message, category, audience, media, publication status and author. New announcements must appear correctly on the public/member board without empty message bodies.

Support preview before publishing, publication history and admin activity logs.

Build an appropriate CMS for editable public content:
- Landing page sections.
- About and FAQ content.
- Contact information.
- Links and navigation.
- TRail resources, policy briefs, media and gardening content.
- PollenPop information and approved content.
- Shared site configuration, supported themes and imagery.

Do not pretend a static hardcoded page is CMS-managed. Where necessary, implement a real data-driven content path while preserving the existing visual structure and URLs.

Include a media library with upload validation and asset management.

For PollenPop, retain its invitation-only/manual approval approach until the verified product requirements say otherwise. Allow staff to review requests, respond, approve or reject with a reason and track the decision.

## 10. Subscriptions, billing and operational controls

Show Hive Nectar's verified tiers: Free, Hive+, Steward and Collective, mapped correctly to the existing tier model.

Provide a useful subscription directory, renewal dates, cancellations, failed payments, payment records and monthly revenue reporting.

Where Stripe permits, implement authorised customer-portal actions and supported refund/cancellation workflows through real server-side Stripe integration.

Never fake refunds, payouts or membership upgrades by merely editing displayed database values.

Add an operations view for email delivery, Stripe webhooks, scheduled jobs, missing integrations and backend errors. Include safe retry actions where appropriate.

## 11. Administrator access and security

Create an **Admin Team** section supporting invitations by email.

Roles should include Super Admin, Administrator, Support Agent, Content Editor and Read-Only Analyst, with configurable and enforced permissions.

The invitation process must verify the intended email recipient, use time-limited single-use tokens and provision the appropriate permissions only after secure acceptance.

An invited Support Agent must be able to handle authorised tickets without gaining access to Stripe secrets or dangerous database operations.

Implement server-enforced role-based permissions, secure sessions, appropriate RLS/RPC access, audit logging, rate limits, input validation and protection against unauthorised reads or writes.

Sensitive actions must record actor, timestamp, target, action and before/after details where appropriate.

Protect the final Super Admin from accidental lockout.

Member accounts must not gain CRM access merely by discovering the admin URL.

## 12. Settings and reliability

Provide real settings for notification preferences, ticket categories, support routing, email templates, site content configuration, branding assets, feature flags and configurable operational limits.

Implement durable storage and secure permissions for every setting.

Provide clear environment and integration indicators, particularly where live payments and live customer messages are involved.

Do not show a setting as editable unless its change genuinely affects the relevant system.

Implement responsive error handling, duplicate submission prevention, transactional changes where required and recoverable failure states.

## 13. Engineering execution and completion standard

Work from the actual repository, database and deployed services. Do not produce a prototype with non-functional buttons.

Use a traceable delivery approach:

**First — Audit**
Map every existing module, backend operation, dependency, schema, permission and gap. Report your findings.

**Second — Architecture**
Define the CRM structure, authentication and permission model, required database changes, integrations and migration strategy. Keep Supabase authoritative and preserve the live member application.

**Third — Implementation**
Build complete vertical features: frontend, backend, permissions, data persistence, notifications and tests. Reuse verified existing admin RPCs where suitable; securely extend them where insufficient.

**Fourth — Verification**
Test against real authorised and unauthorised accounts, representative members and safe test data.

**Required end-to-end checks:**
1. Member signup automatically becomes visible in CRM.
2. Member search and detail return the correct authorised data.
3. Task creation/editing persists and affects the correct member-facing experience.
4. Nectar adjustments have accurate balances and audit records.
5. Achievement management saves and displays correctly.
6. An announcement published in CRM appears with its complete content on the website.
7. A support request creates a real ticket.
8. Admin response is persisted and delivered.
9. Customer follow-up stays in the original conversation.
10. Resolution, reassignment, reopen and closed status work correctly.
11. Admin email invitations and permission boundaries work correctly.
12. Subscription reports match verified Stripe records.
13. Unauthorised access and cross-user data disclosure are denied.
14. Existing public website and member workflows pass regression tests.
15. Production build and application startup complete successfully.

Use unit, integration and browser-based end-to-end testing as appropriate. Verify actual database mutations, outbound message delivery and read-back state; not merely button clicks.

**Final delivery report must include:**
- What was implemented.
- Which features passed tests and supporting evidence.
- Existing bugs fixed.
- Database migrations and changed files.
- Real integration and deployment status.
- Remaining blockers, including external credentials or webhook setup.
- Security checks.
- Local development startup instructions.
- Exact next steps for production deployment.

Do not declare a module complete when only its UI works. Do not use mock data in operational screens and do not silently replace failed backend operations with successful-looking responses.

**FINAL EXPECTATION**

I want one premium, fast, organised and fully functional custom CRM where my team can manage virtually everything about Hive Nectar without opening Supabase for ordinary daily work.

The application must have the polish of an established SaaS platform, the customer-support practicality of Zendesk, and the operational reliability of a properly engineered production system.

Do not use Twenty CRM. Do not disrupt the existing website. Do not leave disconnected screens, dummy controls, fake metrics or unfinished workflows disguised as completed features.

Build and verify systematically until the agreed scope is operational, and clearly identify anything not yet proven working.
