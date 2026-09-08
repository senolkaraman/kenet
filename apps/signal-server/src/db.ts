import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { env } from "./env.js";

let activePool: Pool | undefined;

/** Test seam: swap in a pg-mem pool before importing handlers. */
export const setPool = (pool: Pool): void => {
  activePool = pool;
};

export const pool = (): Pool => {
  if (!activePool) {
    if (!env.databaseUrl) {
      activePool = new Pool({ max: 8 });
    } else {
      // Managed Postgres (Neon, Supabase, …) needs TLS but ships a CA chain Node doesn't bundle;
      // a local socket / Cloud SQL unix socket / localhost does not. Detect and only force TLS
      // (without strict CA verification) for the remote-host case.
      const url = env.databaseUrl;
      const remote = !url.includes("/cloudsql/") && !/@(localhost|127\.0\.0\.1|\[::1\])/.test(url);
      activePool = new Pool({
        connectionString: url,
        max: 8,
        ...(remote ? { ssl: { rejectUnauthorized: false } } : {})
      });
    }
  }
  return activePool;
};

export const query = <T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) =>
  pool().query<T>(text, params);

// gen_random_uuid() and now() are built into Postgres 13+ (Cloud SQL runs 15/16).
const MIGRATIONS: string[] = [
  `create table if not exists users (
     id uuid primary key default gen_random_uuid(),
     email text unique not null,
     password_hash text not null,
     created_at timestamptz not null default now()
   )`,
  `create table if not exists devices (
     id text primary key,
     user_id uuid not null references users(id) on delete cascade,
     name text not null,
     unattended_hash text,
     last_seen_at timestamptz,
     created_at timestamptz not null default now()
   )`,
  `create index if not exists devices_user_id_idx on devices(user_id)`,
  `create table if not exists connection_events (
     id bigserial primary key,
     user_id uuid not null references users(id) on delete cascade,
     actor_device_id text,
     target_device_id text,
     kind text not null,
     at timestamptz not null default now()
   )`,
  `create index if not exists connection_events_user_id_idx2 on connection_events(user_id, id desc)`,
  `create table if not exists password_resets (
     token_hash text primary key,
     user_id uuid not null references users(id) on delete cascade,
     expires_at timestamptz not null,
     created_at timestamptz not null default now()
   )`,
  // ---- billing / teams ----
  `alter table users add column if not exists plan text not null default 'free'`,
  `alter table users add column if not exists stripe_customer_id text`,
  `alter table users add column if not exists subscription_status text`,
  `alter table users add column if not exists plan_renews_at timestamptz`,
  `create table if not exists organizations (
     id uuid primary key default gen_random_uuid(),
     name text not null,
     owner_user_id uuid not null references users(id) on delete cascade,
     stripe_customer_id text,
     stripe_subscription_id text,
     subscription_status text,
     seats integer not null default 1,
     plan_renews_at timestamptz,
     created_at timestamptz not null default now()
   )`,
  `create table if not exists org_members (
     org_id uuid not null references organizations(id) on delete cascade,
     user_id uuid not null references users(id) on delete cascade,
     role text not null default 'member',
     joined_at timestamptz not null default now(),
     primary key (org_id, user_id)
   )`,
  `create table if not exists org_invites (
     id uuid primary key default gen_random_uuid(),
     org_id uuid not null references organizations(id) on delete cascade,
     email text not null,
     role text not null default 'member',
     token_hash text not null,
     expires_at timestamptz not null,
     created_at timestamptz not null default now()
   )`,
  `create index if not exists org_invites_email_idx on org_invites(email)`,
  `alter table devices add column if not exists org_id uuid references organizations(id) on delete set null`,
  // ---- TOTP two-factor auth ----
  `alter table users add column if not exists totp_secret text`,
  `alter table users add column if not exists totp_enabled boolean not null default false`,
  `alter table users add column if not exists totp_recovery_hashes text[] not null default '{}'`,
  // ---- Wake-on-LAN ----
  `alter table devices add column if not exists mac_address text`,
  `alter table devices add column if not exists last_subnet text`,
  // ---- Admin panel ----
  `alter table users add column if not exists is_admin boolean not null default false`,
  `alter table users add column if not exists disabled boolean not null default false`,
  `alter table users add column if not exists device_limit_override integer`,
  `alter table users add column if not exists notes text`
];

export const migrate = async (): Promise<void> => {
  const client: PoolClient = await pool().connect();
  try {
    for (const statement of MIGRATIONS) await client.query(statement);
  } finally {
    client.release();
  }
};
