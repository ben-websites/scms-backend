-- ============================================================
-- 002_multi_tenant.sql
--
-- Upgrades a single-club SCMS database to the multi-tenant model.
-- Everything here is idempotent: it is safe to run against a fresh
-- database (where db/schema.sql already created the new shape) and
-- against the original live database (where the tables have no ClubID).
--
-- Order matters:
--   1. helper functions
--   2. platform rows (club #1 + software plans)
--   3. ClubID columns + backfill of every club-owned table
--   4. index / primary key rewrites
--   5. ClubUsers backfill
--   6. row level security (last: the steps above must not be blocked by it)
-- ============================================================

-- 1. Helper functions ---------------------------------------------
-- Repeated from db/schema.sql so the migration is self-contained.
create or replace function current_club()
returns integer
language sql
stable
as $$ select nullif(current_setting('app.club_id', true), '')::integer $$;

create or replace function platform_mode()
returns boolean
language sql
stable
as $$ select coalesce(current_setting('app.platform_mode', true), '') = 'true' $$;

-- 2. Platform rows ------------------------------------------------

-- Club #1 owns all data that existed before multi-tenancy. Its name is taken
-- from the existing ClubSettings row so nothing is renamed under the owner.
insert into clubs (slug, clubname, legalname, tagline, description, contactemail, contactphone, city, country, status, createdat, approvedat)
select
  'sportshub',
  coalesce((select settingvalue from clubsettings where settingkey = 'ClubName' limit 1), 'Sports Hub'),
  coalesce((select settingvalue from clubsettings where settingkey = 'ClubName' limit 1), 'Sports Hub'),
  'Multi-sport club powered by Sports Hub',
  'Our flagship club: cricket, swimming, tennis, badminton, squash and a full performance gym.',
  coalesce((select settingvalue from clubsettings where settingkey = 'ClubEmail' limit 1), 'info@sportshub.com'),
  coalesce((select settingvalue from clubsettings where settingkey = 'ClubPhone' limit 1), '+92 300 1234567'),
  'Lahore',
  'Pakistan',
  'Active',
  now(),
  now()
where not exists (select 1 from clubs)
on conflict (slug) do nothing;

-- The original admin becomes the owner of club #1 when no owner is set yet.
update clubs
set owneruserid = (select userid from users where role = 'admin' order by userid limit 1)
where owneruserid is null
  and slug = 'sportshub'
  and exists (select 1 from users where role = 'admin');

-- The software's own subscription tiers (what a club owner buys).
insert into platformplans (planname, description, pricemonthly, priceyearly, maxmembers, maxcoaches, maxsports, features, isactive)
values
  ('Starter', 'For a single-location club finding its feet.', 5000, 50000, 150, 3, 5,
   'Member management, memberships and plans, monthly fee vouchers, manual payment verification, announcements.', 1),
  ('Growth', 'For busy clubs running coaching, events and payroll.', 12000, 120000, 800, 12, 12,
   'Everything in Starter, plus coaches and trainers, staff attendance, salary register, equipment, teams, tournaments, reports.', 1),
  ('Enterprise', 'For multi-sport academies and club groups.', 25000, 250000, 5000, 60, 40,
   'Everything in Growth, plus unlimited events, priority support and a public club profile page.', 1)
on conflict (planname) do nothing;

-- 3. ClubID columns -----------------------------------------------
do $$
declare
  t text;
  club_tables text[] := array[
    'adminlogs', 'advancevouchermonths', 'announcements', 'attendance', 'clubsettings',
    'coaches', 'equipment', 'equipmentissues', 'eventregistrations', 'events',
    'feevouchers', 'memberperformance', 'memberprepayments', 'membershipapplications',
    'membershipplans', 'memberships', 'notifications', 'paymentreceipts', 'payments',
    'salarypayments', 'services', 'sportenrollments', 'sports', 'staffattendance',
    'teammembers', 'teams', 'tournamentmatches', 'tournaments', 'trainers', 'trainingschedules'
  ];
  default_club integer;
begin
  select min(clubid) into default_club from clubs;

  foreach t in array club_tables loop
    execute format('alter table %I add column if not exists ClubID integer', t);

    if default_club is not null then
      execute format('update %I set ClubID = $1 where ClubID is null', t) using default_club;
    end if;

    execute format('alter table %I alter column ClubID set default current_club()', t);

    -- Notifications are allowed to be platform-wide (ClubID null).
    if t <> 'notifications' then
      execute format('alter table %I alter column ClubID set not null', t);
    end if;
  end loop;
end $$;

-- 4. Uniqueness must become per-club ------------------------------
-- Two clubs may both own a "Cricket Nets" facility, a voucher numbered
-- V-2026-0001 or a membership numbered M-0001.
-- Names stay unquoted on purpose: the original DDL created them unquoted, so
-- they are stored lower case and a quoted identifier would not match.
drop index if exists UQ__Sports__14A9DBB0267C598D;
create unique index if not exists UQ__Sports__14A9DBB0267C598D on sports (ClubID, SportName);

drop index if exists UQ__FeeVouch__56C64C173272F9DB;
create unique index if not exists UQ__FeeVouch__56C64C173272F9DB on feevouchers (ClubID, VoucherNumber);

drop index if exists UQ__Membersh__87ECFB6A82342292;
create unique index if not exists UQ__Membersh__87ECFB6A82342292 on memberships (ClubID, MembershipNumber);

-- ClubSettings primary key: (SettingKey) -> (ClubID, SettingKey)
do $$
declare
  pk_name text;
begin
  select conname into pk_name
  from pg_constraint
  where conrelid = 'clubsettings'::regclass
    and contype = 'p'
    and array_length(conkey, 1) = 1;

  if pk_name is not null then
    execute format('alter table clubsettings drop constraint %I', pk_name);
    alter table clubsettings
      add constraint PK__ClubSett__01E719AC5AA4F6FE primary key (ClubID, SettingKey);
  end if;
end $$;

-- 5. Bootstrap membership rows for club #1 ------------------------
-- Every pre-existing account keeps working: admins stay admins, coaches stay
-- coaches and members stay members, but now through ClubUsers.
--
-- ClubUsers is the one cross-tenant table, so it is not RLS protected. The
-- column default still comes from the request context, which lets the club
-- scoped code paths insert a join row without naming the club explicitly.
alter table clubusers alter column clubid set default current_club();

alter table clubusers alter column role type varchar(20);

insert into clubusers (clubid, userid, role, isactive, joinedat)
select
  c.clubid,
  u.userid,
  case
    when u.role = 'admin' then 'admin'
    when u.role = 'coach' then 'coach'
    else 'member'
  end,
  u.isactive,
  coalesce(u.createdat, now())
from users u
cross join (select clubid from clubs where slug = 'sportshub' limit 1) c
where u.role in ('admin', 'coach', 'user')
  and not exists (
    select 1 from clubusers cu where cu.clubid = c.clubid and cu.userid = u.userid
  );

-- 6. Identity upgrades on Users -----------------------------------
alter table users alter column passwordhash drop not null;
alter table users alter column role type varchar(20);
alter table users add column if not exists googleSub varchar(255);
alter table users add column if not exists authProvider varchar(20);
alter table users add column if not exists lastLoginAt timestamp;

update users set authProvider = 'password' where authProvider is null;

create unique index if not exists UQ_Users_GoogleSub on users (googleSub);

-- Widen the role check to allow the platform owner account.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'users'::regclass
      and conname = 'ck_users_role'
      and pg_get_constraintdef(oid) not like '%super_admin%'
  ) then
    alter table users drop constraint ck_users_role;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'users'::regclass
      and conname = 'ck_users_role'
  ) then
    alter table users
      add constraint CK_Users_Role check (Role='coach' OR Role='admin' OR Role='user' OR Role='super_admin');
  end if;
end $$;

-- 7. Row level security -------------------------------------------
-- FORCE is required: the application connects as the table owner, and
-- PostgreSQL skips policies for the owner unless they are forced.
do $$
declare
  t text;
  club_tables text[] := array[
    'adminlogs', 'advancevouchermonths', 'announcements', 'attendance', 'clubsettings',
    'coaches', 'equipment', 'equipmentissues', 'eventregistrations', 'events',
    'feevouchers', 'memberperformance', 'memberprepayments', 'membershipapplications',
    'membershipplans', 'memberships', 'notifications', 'paymentreceipts', 'payments',
    'salarypayments', 'services', 'sportenrollments', 'sports', 'staffattendance',
    'teammembers', 'teams', 'tournamentmatches', 'tournaments', 'trainers', 'trainingschedules'
  ];
begin
  foreach t in array club_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);

    -- Recreate from scratch so a policy tweak in a later migration is
    -- picked up instead of silently keeping the old definition.
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I using (platform_mode() or ClubID = current_club()) with check (platform_mode() or ClubID = current_club())',
      t
    );
  end loop;
end $$;
