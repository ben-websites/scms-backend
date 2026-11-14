# Multi-tenant model

The system runs many clubs out of one database. Nothing in the workspace knows
about "clubs" as a filtering concern - isolation is a database guarantee.

## The two shells

| Shell | Routes | Who | Sign-in |
| --- | --- | --- | --- |
| Website | `/`, `/about`, `/services`, `/clubs`, `/clubs/:slug`, `/for-clubs` | anyone | none |
| Owner onboarding | `/for-clubs` → `/sell/subscribe` → `/sell/status` | club buyers | Google |
| Workspace | `/admin/*`, `/coach/*`, `/user/*` | one club's staff and members | email + password |
| Platform console | `/platform/*` | the software owner | Google (or the env fallback) |

The website and the workspace share a React app but not a layout: the website
shell has no link into the workspace, and the workspace shell has no link back.
That is what allows the two halves to be split into separate builds later.

## Where a request gets its club

1. The JWT carries `clubId` (minted by `POST /auth/login` or `/auth/select-club`
   after a `ClubUsers` check).
2. `resolveTenant` puts `{ clubId }` into an `AsyncLocalStorage`.
3. `config/db.js` opens one transaction per query batch and, for a club
   context, first runs `set local role scms_app` (see below), then
   `set_config('app.club_id', …, true)` / `set_config('app.platform_mode', …, true)`.
4. Every club-owned table has `ClubID` plus
   `ENABLE`/`FORCE ROW LEVEL SECURITY` and the policy

   ```sql
   using (platform_mode() or ClubID = current_club())
   with check (platform_mode() or ClubID = current_club())
   ```

`FORCE` alone is not enough. Managed Postgres hands `BYPASSRLS` to its default
role - Neon does it for `neondb_owner` - and PostgreSQL skips every policy,
forced or not, for a role that carries it. So the app keeps the owner
connection for DDL only and switches each club-scoped transaction into
`scms_app`: a `NOLOGIN` role with plain DML grants and no `BYPASSRLS`, created
by `db/migrations/003_tenant_app_role.sql`. `set local` makes the switch
transaction scoped, so the connection is back to the owner - free to run the
schema DDL on the next boot - the moment the batch commits.

A query that runs with a club context therefore returns that club's rows and
nothing else; one that runs with no context at all returns **zero rows**. That
is the fail-closed default the whole design rests on.

## Cross-tenant reads

`publicScope` (the website) and `platformOnly` (the console) run in platform
mode. Those two are the only places that may see more than one club, and both
list their returned columns explicitly - no `SELECT *` reaches a visitor.

`ClubUsers` is deliberately *not* RLS-protected: it is the cross-tenant lookup
performed at sign-in, and every query against it filters on the authenticated
`UserID`.

## Provisioning a club

`PUT /platform/requests/:id/review` with `action=approve` runs in a single
transaction and creates, in order: the `Clubs` row, its `Subscriptions` row,
the owner's `ClubUsers` admin membership (on their real Google email, with a
generated temporary password), the starter `ClubSettings`, and a welcome
`Notifications` row. A half-created club cannot exist.

## Environment

See `.env.example`. The two that change the shape of the system:

- `GOOGLE_CLIENT_ID` - unset means the Google button shows a config notice and
  email + password keeps working. It never crashes the boot.
- `PLATFORM_ADMIN_EMAILS` - the allow-list for `/platform`. Those accounts are
  created/refreshed as `Role = 'super_admin'` on every boot.

## Verifying isolation

Per tenant, as a club admin, these must return 404 or an empty list:

```
GET /api/admin/vouchers          (another club's voucher id)
GET /api/admin/memberships       (another club's membership id)
GET /api/admin/payments          (another club's payment id)
```

In psql the same holds, but only *after* the role switch - connecting as the
owner and counting shows every row, because the owner carries `BYPASSRLS`:

```sql
begin;
set local role scms_app;                          -- drop the bypass
select count(*) from feevouchers;                 -- 0: no club in context
select set_config('app.club_id', '1', true);
select count(*) from feevouchers;                 -- club 1 only
rollback;
```

```sql
select rolbypassrls from pg_roles where rolname = 'scms_app';   -- must be f
```

If that returns `t`, isolation is off and `verify-live.js` / the boot log will
be the only thing between a bug and another club's data.

Manual walk-through:

1. Approve a request in `/platform/requests`; hand the credentials over.
2. Owner signs in at `/owner/login` with Google → lands on `/admin/dashboard`
   with an empty club.
3. Fill in `/admin/club-profile`, add a membership plan and a sport.
4. `/clubs` lists the new club; `/clubs/:slug` shows only what the owner entered.
5. A member applies from the club page → the club sees the application in
   `/admin/approvals`, and the member sees nothing from any other club.
