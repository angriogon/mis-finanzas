-- Control de Finanzas: esquema seguro de sincronización e ingreso desde Atajos iOS.
-- Ejecutar una sola vez en Supabase > SQL Editor.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.finance_snapshots (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default jsonb_build_object(
    'schemaVersion', 1,
    'transactions', '[]'::jsonb,
    'fixedItems', '[]'::jsonb,
    'trash', '[]'::jsonb,
    'categoryOptions', '{}'::jsonb,
    'calendarNotes', '[]'::jsonb
  ),
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.wallet_ingest_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.wallet_ingest_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  external_id text not null,
  amount numeric(12,2) not null check (amount > 0),
  concept text not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (user_id, external_id)
);

alter table public.finance_snapshots enable row level security;
alter table public.wallet_ingest_tokens enable row level security;
alter table public.wallet_ingest_events enable row level security;

drop policy if exists "Users read own finance snapshot" on public.finance_snapshots;
create policy "Users read own finance snapshot"
  on public.finance_snapshots for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users insert own finance snapshot" on public.finance_snapshots;
create policy "Users insert own finance snapshot"
  on public.finance_snapshots for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users update own finance snapshot" on public.finance_snapshots;
create policy "Users update own finance snapshot"
  on public.finance_snapshots for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users manage own wallet token" on public.wallet_ingest_tokens;
create policy "Users manage own wallet token"
  on public.wallet_ingest_tokens for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.finance_snapshots from anon;
revoke all on public.wallet_ingest_tokens from anon;
revoke all on public.wallet_ingest_events from anon, authenticated;
grant select, insert, update on public.finance_snapshots to authenticated;
grant select, insert, update, delete on public.wallet_ingest_tokens to authenticated;

create or replace function public.save_finance_snapshot(
  p_state jsonb,
  p_expected_revision bigint
)
returns table(revision bigint, updated_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_row public.finance_snapshots%rowtype;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_state is null or jsonb_typeof(p_state) <> 'object' then
    raise exception 'INVALID_STATE' using errcode = '22023';
  end if;

  insert into public.finance_snapshots(user_id, state, revision, updated_at)
  values (v_user_id, p_state, 1, now())
  on conflict (user_id) do nothing
  returning * into v_row;

  if found then
    return query select v_row.revision, v_row.updated_at;
    return;
  end if;

  update public.finance_snapshots as snapshot
  set state = p_state,
      revision = snapshot.revision + 1,
      updated_at = now()
  where snapshot.user_id = v_user_id
    and snapshot.revision = p_expected_revision
  returning snapshot.* into v_row;

  if not found then
    raise exception 'SYNC_CONFLICT' using errcode = '40001';
  end if;

  return query select v_row.revision, v_row.updated_at;
end;
$$;

create or replace function public.set_wallet_ingest_token(p_token text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_hash text;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_token is null or length(p_token) < 40 or length(p_token) > 200 then
    raise exception 'INVALID_TOKEN' using errcode = '22023';
  end if;

  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');
  insert into public.wallet_ingest_tokens(user_id, token_hash, created_at, updated_at)
  values (v_user_id, v_hash, now(), now())
  on conflict (user_id) do update
  set token_hash = excluded.token_hash,
      updated_at = now();
end;
$$;

create or replace function public.ingest_wallet_payment(
  p_token text,
  p_amount numeric,
  p_concept text,
  p_external_id text default null,
  p_occurred_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_token_hash text;
  v_external_id text;
  v_concept text;
  v_occurred_at timestamptz := coalesce(p_occurred_at, now());
  v_event_id uuid;
  v_transaction_id uuid := gen_random_uuid();
  v_transaction jsonb;
  v_revision bigint;
begin
  if p_token is null or length(p_token) < 40 or length(p_token) > 200 then
    raise exception 'INVALID_WALLET_TOKEN' using errcode = '28000';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000 then
    raise exception 'INVALID_AMOUNT' using errcode = '22023';
  end if;

  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');
  select token.user_id into v_user_id
  from public.wallet_ingest_tokens as token
  where token.token_hash = v_token_hash;

  if v_user_id is null then
    raise exception 'INVALID_WALLET_TOKEN' using errcode = '28000';
  end if;

  v_concept := left(coalesce(nullif(btrim(p_concept), ''), 'Pago con tarjeta'), 160);
  v_external_id := left(coalesce(
    nullif(btrim(p_external_id), ''),
    encode(extensions.digest(concat(v_user_id::text, '|', p_amount::text, '|', v_concept, '|', date_trunc('minute', v_occurred_at)::text), 'sha256'), 'hex')
  ), 200);

  insert into public.wallet_ingest_events(user_id, external_id, amount, concept, occurred_at)
  values (v_user_id, v_external_id, round(p_amount, 2), v_concept, v_occurred_at)
  on conflict (user_id, external_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select snapshot.revision into v_revision
    from public.finance_snapshots as snapshot
    where snapshot.user_id = v_user_id;
    return jsonb_build_object('ok', true, 'duplicate', true, 'revision', coalesce(v_revision, 0));
  end if;

  v_transaction := jsonb_build_object(
    'id', v_transaction_id::text,
    'externalId', v_external_id,
    'source', 'ios-wallet-shortcut',
    'account', 'gasto',
    'type', 'expense',
    'amount', round(p_amount, 2),
    'concept', v_concept,
    'category', 'Apple Pay / Tarjeta',
    'date', to_char(v_occurred_at at time zone 'Europe/Madrid', 'DD/MM/YYYY'),
    'timestamp', floor(extract(epoch from v_occurred_at) * 1000)::bigint
  );

  insert into public.finance_snapshots(user_id, state, revision, updated_at)
  values (
    v_user_id,
    jsonb_build_object(
      'schemaVersion', 1,
      'transactions', jsonb_build_array(v_transaction),
      'fixedItems', '[]'::jsonb,
      'trash', '[]'::jsonb,
      'categoryOptions', '{}'::jsonb,
      'calendarNotes', '[]'::jsonb
    ),
    1,
    now()
  )
  on conflict (user_id) do update
  set state = jsonb_set(
        public.finance_snapshots.state,
        '{transactions}',
        jsonb_build_array(v_transaction) || coalesce(public.finance_snapshots.state->'transactions', '[]'::jsonb),
        true
      ),
      revision = public.finance_snapshots.revision + 1,
      updated_at = now()
  returning revision into v_revision;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'transaction_id', v_transaction_id,
    'revision', v_revision
  );
end;
$$;

revoke all on function public.save_finance_snapshot(jsonb, bigint) from public, anon;
revoke all on function public.set_wallet_ingest_token(text) from public, anon;
revoke all on function public.ingest_wallet_payment(text, numeric, text, text, timestamptz) from public;
grant execute on function public.save_finance_snapshot(jsonb, bigint) to authenticated;
grant execute on function public.set_wallet_ingest_token(text) to authenticated;
grant execute on function public.ingest_wallet_payment(text, numeric, text, text, timestamptz) to anon, authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'finance_snapshots'
  ) then
    alter publication supabase_realtime add table public.finance_snapshots;
  end if;
end $$;
