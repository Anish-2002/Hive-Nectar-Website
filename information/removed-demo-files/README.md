# Removed from `public/` — 13 October 2026

Three demo files were removed from the served tree. None of them was referenced by any
page, script or component (verified by a whole-tree grep, excluding `node_modules` and
`dist`), so removing them cannot change what any visitor or member does. They were copied
into `public/` by the byte-parity port, which reproduced the original tree file-for-file —
including files that the audit (guide finding 8) lists as "served publicly although they are
not part of the product".

| file | why it went |
|---|---|
| `public/users.json` | **Plaintext demo credentials** (`bee@hivenectar.com` / `password123`) served at `/users.json`. Not a product file; nothing reads it. |
| `public/admin_comms.json` | Static demo broadcast list, superseded by the `communications` table + its admin RPCs. |
| `public/tasks_master.json` | Static task catalogue copy; the live task engine reads the database. |

Kept, on purpose: `src/legacy/testjar.html`. The name is misleading — it is the
**Honey Jar lid decorator**, a real member page, and it is wired into the app by the
`import.meta.glob('../legacy/*.html')` in `src/components/LegacyPage.jsx`.

The byte-parity manifest in `verification/` still lists all three; it is the record of the
port as it was made, and is not regenerated to hide the change.
