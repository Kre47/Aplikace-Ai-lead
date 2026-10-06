-- Run this in Supabase Dashboard → SQL Editor before starting the app.
create table if not exists public.chat_sessions (
  session_id text primary key constraint chat_sessions_session_id_uuid_check
    check (session_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  messages jsonb not null check (jsonb_typeof(messages) = 'array'),
  status text not null default 'active' check (status in ('active', 'completed')),
  handoff_status text check (handoff_status in ('pending', 'sent', 'failed', 'not_configured')),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

do $block$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.chat_sessions'::regclass
      and conname = 'chat_sessions_session_id_uuid_check'
  ) then
    alter table public.chat_sessions
      add constraint chat_sessions_session_id_uuid_check
      check (session_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') not valid;
  end if;
end;
$block$;

alter table public.chat_sessions validate constraint chat_sessions_session_id_uuid_check;

create index if not exists chat_sessions_expires_at_idx
  on public.chat_sessions (expires_at);

create table if not exists public.chat_rate_limits (
  bucket_key text not null check (char_length(bucket_key) between 1 and 64),
  window_start timestamptz not null,
  hit_count integer not null check (hit_count > 0),
  expires_at timestamptz not null,
  primary key (bucket_key, window_start)
);

create index if not exists chat_rate_limits_expires_at_idx
  on public.chat_rate_limits (expires_at);

create table if not exists public.chat_session_locks (
  session_id text primary key constraint chat_session_locks_session_id_uuid_check
    check (session_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  lock_token uuid not null,
  expires_at timestamptz not null
);

do $block$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.chat_session_locks'::regclass
      and conname = 'chat_session_locks_session_id_uuid_check'
  ) then
    alter table public.chat_session_locks
      add constraint chat_session_locks_session_id_uuid_check
      check (session_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') not valid;
  end if;
end;
$block$;

alter table public.chat_session_locks validate constraint chat_session_locks_session_id_uuid_check;

create index if not exists chat_session_locks_expires_at_idx
  on public.chat_session_locks (expires_at);

alter table public.chat_sessions enable row level security;
alter table public.chat_rate_limits enable row level security;
alter table public.chat_session_locks enable row level security;

-- The table is accessed only by the server using its Supabase secret key.
revoke all on table public.chat_sessions from public, anon, authenticated;
grant all on table public.chat_sessions to service_role;
revoke all on table public.chat_rate_limits from public, anon, authenticated;
grant all on table public.chat_rate_limits to service_role;
revoke all on table public.chat_session_locks from public, anon, authenticated;
grant all on table public.chat_session_locks to service_role;

create or replace function public.consume_chat_rate_limit(
  p_bucket_key text,
  p_limit integer,
  p_window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_window_start timestamptz;
  v_hit_count integer;
begin
  if p_bucket_key is null or char_length(p_bucket_key) not between 1 and 64
    or p_limit is null or p_limit < 1
    or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 3600 then
    raise exception 'Invalid chat rate limit parameters';
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );

  insert into public.chat_rate_limits (bucket_key, window_start, hit_count, expires_at)
  values (p_bucket_key, v_window_start, 1, v_window_start + make_interval(secs => p_window_seconds * 2))
  on conflict (bucket_key, window_start) do update
    set hit_count = public.chat_rate_limits.hit_count + 1
  returning hit_count into v_hit_count;

  return v_hit_count <= p_limit;
end;
$function$;
revoke all on function public.consume_chat_rate_limit(text, integer, integer) from public, anon, authenticated;

create or replace function public.acquire_chat_session_lock(
  p_session_id text,
  p_lock_token uuid,
  p_lease_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_acquired boolean;
begin
  if p_session_id is null or p_session_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_lock_token is null or p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'Invalid chat session lock parameters';
  end if;

  insert into public.chat_session_locks (session_id, lock_token, expires_at)
  values (p_session_id, p_lock_token, clock_timestamp() + make_interval(secs => p_lease_seconds))
  on conflict (session_id) do update
    set lock_token = excluded.lock_token,
        expires_at = excluded.expires_at
    where public.chat_session_locks.expires_at <= clock_timestamp()
  returning true into v_acquired;

  return coalesce(v_acquired, false);
end;
$function$;
revoke all on function public.acquire_chat_session_lock(text, uuid, integer) from public, anon, authenticated;

create or replace function public.release_chat_session_lock(
  p_session_id text,
  p_lock_token uuid
) returns void
language sql
security definer
set search_path = pg_catalog, public
as $function$
  delete from public.chat_session_locks
  where session_id = p_session_id and lock_token = p_lock_token;
$function$;
revoke all on function public.release_chat_session_lock(text, uuid) from public, anon, authenticated;

revoke all on function public.consume_chat_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_chat_rate_limit(text, integer, integer) to service_role;
revoke all on function public.acquire_chat_session_lock(text, uuid, integer) from public, anon, authenticated;
grant execute on function public.acquire_chat_session_lock(text, uuid, integer) to service_role;
revoke all on function public.release_chat_session_lock(text, uuid) from public, anon, authenticated;
grant execute on function public.release_chat_session_lock(text, uuid) to service_role;
