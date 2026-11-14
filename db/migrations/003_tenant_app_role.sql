-- ============================================================
-- 003_tenant_app_role.sql
--
-- Makes row level security actually apply on providers that hand BYPASSRLS
-- to their default role. Neon does exactly that for the database owner:
-- `select rolbypassrls from pg_roles where rolname = current_user` returns
-- true, and PostgreSQL skips every policy - even a FORCEd one - for such a
-- role. The policies installed by 002_multi_tenant.sql were therefore inert,
-- and a browser could have read another club's rows.
--
-- The fix keeps the owner connection (initSchema needs it to run DDL) and
-- adds a second, powerless role that club scoped transactions switch into
-- with `set local role`. Because the switch is transaction local, the
-- connection is back to the owner as soon as the statement batch commits, so
-- the bypass privilege never reaches a tenant query.
--
-- Idempotent.
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'scms_app') then
    create role scms_app nologin nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end $$;

-- The connecting role has to be a member to switch into it. CURRENT_USER is
-- whatever DATABASE_URL resolves to (neondb_owner on Neon, a database user
-- elsewhere), so nothing is hard coded.
grant scms_app to current_user;

grant usage on schema public to scms_app;
grant select, insert, update, delete on all tables in schema public to scms_app;
grant usage, select on all sequences in schema public to scms_app;

-- Objects created later (a future migration, a restored dump) inherit the
-- same grants, so a new table cannot quietly become unreadable to tenants.
alter default privileges in schema public
  grant select, insert, update, delete on tables to scms_app;
alter default privileges in schema public
  grant usage, select on sequences to scms_app;

comment on role scms_app is
  'Tenant runtime role: no BYPASSRLS, so the tenant_isolation policies apply. Switched into per request by config/db.js.';
