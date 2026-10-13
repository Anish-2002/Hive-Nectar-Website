# HIVE NECTAR — COMPLETE CUSTOM ADMIN CRM
## Master Implementation Prompt for Hermes

You are the lead software architect, full-stack engineer, UI/UX designer, database engineer and QA specialist for Hive Nectar.

**OBJECTIVE:** Build a premium, fully functional, custom-owned administration CRM that becomes the single operational command centre for the entire Hive Nectar ecosystem.

We are **NOT using Twenty CRM, Zendesk or an external CRM product**. We are building our own system, using Supabase as our existing backend.

The CRM must enable administrators to manage members, support requests, reflections, Sigma logs, nectar points, tasks, achievements, memberships, communications, PollenPop, website content and physical rewards without manually editing Supabase.

Every visible feature must be genuinely functional, connected to real data, secure and tested end to end.

## 1. Mandatory Engineering Requirements

Before writing code:

1. Read `HIVE-MEADOWS-GUIDE.md` completely.
2. Inspect the actual repository, Supabase database, existing administration pages, RLS policies, SQL functions, Stripe integrations and Brevo email configuration.
3. Document existing functionality, broken workflows, missing components and required extensions.
4. Reuse existing working architecture where suitable. Never duplicate the game engine or create unnecessary parallel data.
5. Do not invent schemas, routes, functions, credentials, test results or deployment status.
6. Preserve all existing member-facing features, data, progress, subscriptions, tokens and achievements.
7. Implement every module end to end, including frontend, backend, permissions, persistence and testing.
8. Never present placeholder UI, mocked data or disconnected controls as working functionality.

Inspect known issues involving admin RPC usage, disconnected localStorage pages, broadcast message fields, missing email functions, incomplete management buttons and inconsistencies in reward/progression logic.

Use verified findings rather than assuming the guide perfectly reflects the latest deployment.

## 2. System Architecture

- Keep the existing Hive Nectar public website deployed independently through Vercel.
- Retain the existing Supabase project as the authoritative database and authentication system.
- Keep Stripe as the payment and subscription source of truth.
- Use Brevo for email where the configured integration supports the required workflow.
- Develop the CRM as a separate, maintainable web application.
- Initially run it on **localhost**, without requiring a VPS.
- Prepare for later deployment to a secure admin subdomain.
- New signups, reflections, Sigma submissions, tickets, achievements and payments must appear automatically through reliable realtime updates or refresh mechanisms.
- Use authenticated server-side endpoints and existing privileged Supabase RPCs where appropriate.
- Never expose service-role credentials, Stripe secrets or email credentials to browsers.
- Apply server-enforced role-based permissions, audit logs and secure error handling.

## 3. UI/UX — Premium Enterprise Admin Design

Create a sophisticated, minimalist SaaS dashboard comparable in usability to established enterprise administration software.

**Design system:**
- White and soft ivory surfaces.
- Charcoal/navy text.
- Light grey dividers and borders.
- Subtle Hive Nectar gold (`#D9A441`) and restrained forest-green accents.
- Professional typography, consistent spacing and balanced visual hierarchy.
- Lucide or Font Awesome icons throughout.
- Responsive desktop, laptop and tablet layouts.
- Collapsible sidebar, searchable tables, drawers, modals and polished forms.
- Proper loading, empty, error and success states.
- Accessibility, keyboard navigation and readable contrast.
- Absolutely no decorative emojis, cartoon-like elements, unnecessary gradients or generic AI-generated visual styling.

Preserve canonical stored values even when the interface displays cleaned text.

**CRM Navigation:**

OVERVIEW
- Dashboard
- Activity Feed
- Analytics

MEMBERS & RECOGNITION
- Members
- Member Reviews
- Reflections
- Sigma Logs
- Nectar & Impact
- Recognition & Rewards
- Physical Gift Fulfilment
- Memberships & Subscriptions

THE MEADOW
- Tasks
- Themes & Stages
- Tokens & Achievements
- Milestones & Badges
- Honey Jar
- Collaborations & Invitations

COMMUNICATIONS
- Support Inbox
- Ticket History
- Communication Board
- Announcements
- Email & Notifications

CONTENT & BUSINESS
- Website CMS
- PollenPop
- TRail / Resources
- FAQ & Knowledge Base
- Feedback & Suggestions

OPERATIONS
- Billing & Payments
- Admin Team & Permissions
- Audit Logs
- System Health
- Settings

Group related menu items intelligently and permit collapsing sections. No menu item should lead to a non-functional screen.

## 4. Main Dashboard

Show real operational metrics:

- Total members and new registrations.
- Active and inactive members, using clearly defined activity criteria.
- Free versus paid memberships.
- Active subscriptions, renewals, cancellations and verified revenue.
- Completed tasks and member engagement.
- Nectar awarded and recorded impact.
- Tokens, milestones and badges awarded.
- New reflections and Sigma logs awaiting review.
- Members nominated for gifts.
- Gifts awaiting approval, packing and dispatch.
- New, unanswered and overdue support tickets.
- Recent administrative and member activity.
- Integration errors and system health.

Include date filters, meaningful charts, activity trends and clickable metric cards linking to their corresponding data.

Do not invent metrics or silently display zero when data retrieval fails.

## 5. Complete Member Management

New members must automatically appear in the CRM after successful signup.

Provide a searchable, filterable directory with avatars, names, emails, tiers, nectar totals, recent activity and outstanding review indicators.

Clicking a member opens a complete **360-degree member profile** with tabs:

- Overview
- Personal & Membership Details
- Tasks & Progress
- Reflections
- Sigma Logs
- Nectar & Impact
- Tokens, Badges & Milestones
- Honey Jar
- Collaborations
- Recognition & Physical Gifts
- Support History
- Internal Notes & Audit History

Show numerical notification indicators beside the member avatar and relevant tabs when administrator action is outstanding.

For example, two new reflections and one unreviewed Sigma log should produce a count of three outstanding review items.

These numbers must update when items are reviewed, without removing the original submissions.

Authorised administrators may update permitted member information, manage access, investigate errors and make controlled nectar adjustments with reasons, before/after values and complete audit history.

## 6. Member Review Centre — Core Feature

Build a dedicated administrative review system for member contributions.

Inspect and securely integrate existing `sigma_logs`, `task_sigma_logs`, task completion records, available evidence and badge submissions.

Distinguish:
- Task reflections tied to completed tasks.
- General Sigma improvement logs.
- Task evidence and comments.
- Pending achievement submissions.
- Member activity and nectar events.

**Review statuses:** New, In Review, Needs Clarification, Reviewed and Flagged.

Provide assignment, filters, search, review dates, reviewer identities, internal notes and history.

Administrators must be able to:
- Open and read the full submission.
- View associated member and task details.
- Review the actual Sigma Define/Measure/Analyse/Improve/Control content.
- Acknowledge or flag contributions.
- Request clarification.
- Send a private member-visible response through a functioning messaging channel.
- Mark the item reviewed.
- Navigate to the member's other contributions.
- Nominate the member for recognition.

Do not mistake the member-facing count of missing reflections for administrator-pending review counts.

Do not automatically change nectar or achievements simply because content has been reviewed.

Provide a chronological member contribution timeline.

## 7. Nectar, Tasks and Achievement Management

Build functional administration for tasks, themes, stages, categories, nectar, progress, tokens, badges and milestones.

Support authorised creation, editing, duplication, activation, archiving, artwork upload, eligibility configuration and member-level inspection.

Preserve the existing task sequencing, tier gates, Novice/Experienced states and applicable cooldown behaviour unless a verified, explicitly approved change is required.

Show genuine nectar earning history, task statistics, approved adjustments and impact calculations. Where historical transaction data is insufficient, implement a future-safe ledger without fabricating historical transactions.

Provide a transparent distinction between:
- Nectar actually earned.
- Member contributions awaiting review.
- Recognition eligibility.
- Physical gifts approved or delivered.

Nectar must not automatically become redeemable currency or guarantee a physical gift unless the business rules explicitly establish that arrangement.

Support controlled achievement approvals and manual corrections with complete audit trails.

## 8. Recognition & Physical Gift Fulfilment — Core Feature

Create a complete native rewards management system.

Administrators need to evaluate meaningful member contributions and recognise members with physical gifts such as PollenPop packs, seed kits, certificates or approved merchandise.

Create:

**Recognition Dashboard**
- Potential recognition candidates.
- Pending nominations.
- Approved rewards.
- Previous gifts by member.
- Recognition history and expenditure.

**Gift Catalogue**
- Gift name, description, image and SKU.
- Stock quantity.
- Unit cost.
- Availability and eligibility rules.
- Active/inactive status.

**Recognition Workflow**
1. Administrator reviews member contributions.
2. Administrator nominates the member with a documented reason.
3. The system records supporting reflection, Sigma, task or milestone references.
4. An authorised administrator approves or rejects the nomination.
5. The member is notified and can accept or decline.
6. If accepted, the member securely submits delivery details.
7. Staff allocate inventory and prepare the parcel.
8. Staff enter carrier and tracking details.
9. The reward is dispatched.
10. Delivery status and fulfilment history are recorded.

Statuses must cover Nominated, Approved, Awaiting Acceptance, Awaiting Address, Ready to Pack, Packed, Shipped, Delivered, Completed, Rejected, Declined, Cancelled and Delivery Failed as appropriate.

Prevent duplicate awards, stock miscalculations and repeat fulfilment on retries.

Show previous gifts on the member's profile so administrators can make informed, fair recognition decisions.

Optional eligibility suggestions may use configurable task, nectar, milestone and contribution criteria, but must not automatically promise a reward.

Collect shipping addresses only when necessary and with appropriate member consent. Restrict access, apply secure retention rules and never display shipping details in general analytics.

## 9. Support Inbox — Zendesk-Style Functionality

Build a fully operational customer support system directly inside the CRM.

All website contact forms, member support requests, PollenPop enquiries and configured support email submissions must enter a unified ticket database.

Each request receives a unique ticket ID.

**Statuses:** New, Open, Pending Customer, Pending Internal, Resolved and Closed.

**Support UI:**
- Left: ticket inbox, saved filters, priority and assignment.
- Centre: chronological conversation and reply composer.
- Right: member profile, previous tickets, membership details and internal notes.

Administrators must be able to:
- View and assign tickets.
- Reply directly from the CRM through real email or authenticated member messaging.
- Add internal notes invisible to customers.
- Attach files securely.
- Change status, category and priority.
- Use saved response templates.
- Merge genuine duplicates.
- Resolve, close or reopen tickets.
- See complete conversation history and delivery outcomes.
- Track response times and optional SLA targets.

A customer reply must appear under the same original ticket.

Use real authenticated outbound email and a verified inbound-email/webhook mechanism where email replies are supported.

A reply must not be marked successfully delivered merely because the CRM saved its text. Handle provider failures, retries, duplicate webhooks and ticket matching reliably.

Connect gift-related enquiries to this Support Inbox.

## 10. Communications, Content and PollenPop

Provide a working Communication Board editor for announcements, updates, security notices and community communications.

Support drafts, preview, publication, editing, archive and history.

Ensure published messages display complete content correctly on the existing website.

Build real content management for appropriate editable parts of:
- Landing page.
- FAQ and support information.
- The Meadow.
- TRail resources.
- Navigation and links.
- PollenPop information.
- Shared site settings and approved branding assets.

Do not claim static content is dynamically editable unless the actual website reads it from the configured CMS.

For PollenPop, provide an administrative view for enquiries, early access, member benefits and any verified approval workflow. Do not assume product ordering or fulfilment capabilities exist until inspected.

## 11. Subscriptions, Payments and Notifications

Show membership tiers, verified Stripe subscriptions, renewals, cancellations, failed payments, payment history and revenue.

Stripe must remain authoritative for actual billing actions.

Provide permitted subscription actions through secure integrations, not fake database-only state changes.

Implement a central notifications system for support replies, member communications, gift approvals, shipping updates and relevant administrative events.

Include delivery history, failure states and retries.

Show real integration health, webhook outcomes and scheduled-job status.

## 12. Administrator Roles and Security

Implement:

- Super Admin
- Administrator
- Member Reviewer
- Support Agent
- Rewards/Fulfilment Manager
- Content Editor
- Read-Only Analyst

Allow secure email invitations and enforce permissions on the backend, not just by hiding buttons.

A reviewer must not automatically gain the ability to alter payments or access unnecessary personal data.

Audit all sensitive actions, including nectar adjustments, gift approvals, address access, ticket replies, permission changes and destructive operations.

Provide secure session handling, input validation, rate limiting, protected file storage and prevention of cross-member data access.

## 13. End-to-End Testing and Delivery

Do not stop when the interface looks finished.

Verify the complete real workflows:

1. New member signup appears automatically.
2. Member profile displays correct progress and nectar.
3. New reflection appears in the admin Review Inbox.
4. Review indicators update correctly after review.
5. Sigma submissions display their complete content.
6. Administrator communicates with the member.
7. Administrator nominates and approves a physical gift.
8. Member securely accepts and provides delivery details.
9. Gift inventory, packing, shipping and tracking work.
10. Ticket creation, reply, customer response, resolution and reopening work.
11. Announcements publish correctly to the existing website.
12. Task and achievement management persists safely.
13. Subscription figures match verified Stripe data.
14. Permissions prevent unauthorised access.
15. Existing website and member journeys remain functional.

Test loading, validation, persistence, error handling, retries, concurrency and actual provider interactions.

**Required final report:**
- Implemented modules and working features.
- Files changed and database migrations.
- Build and test results with evidence.
- Security verification.
- External integration blockers.
- Remaining incomplete items.
- Local startup instructions.
- Exact production deployment requirements.

Do not describe unfinished features as completed.

## FINAL PRODUCT EXPECTATION

Hive Nectar CRM must become one professional, intuitive administrative platform.

An administrator should be able to open a member, understand their membership, inspect tasks, read reflections and Sigma logs, see actual nectar earned, review achievements, communicate with the member, nominate them for a physical gift, approve that gift and manage its delivery — all within one connected workflow.

At the same time, the team must be able to manage customer support, communications, content, billing and core operations without working across disconnected administration pages.

**Build for operational reliability, privacy, consistency, excellent UI and full end-to-end functionality. No Twenty CRM. No decorative emojis. No fake data. No dummy buttons. No unverified completion claims. Protect the existing production website and member data throughout development.**
