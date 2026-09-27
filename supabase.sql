-- AmakaConnect042 core schema. Run in Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  username text unique,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  currency text not null default 'NGN' check (currency = 'NGN'),
  balance numeric(18,2) not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.funding_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(18,2) not null check (amount > 0),
  payment_reference text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('funding','data','airtime','refund')),
  amount numeric(18,2) not null check (amount >= 0),
  network text,
  phone text,
  description text,
  status text not null default 'pending' check (status in ('pending','successful','failed','reversed')),
  provider_reference text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.wallets enable row level security;
alter table public.funding_requests enable row level security;
alter table public.transactions enable row level security;

drop policy if exists "profile own read" on public.profiles;
create policy "profile own read" on public.profiles for select using (auth.uid() = id);
drop policy if exists "profile own update" on public.profiles;
create policy "profile own update" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
drop policy if exists "wallet own read" on public.wallets;
create policy "wallet own read" on public.wallets for select using (auth.uid() = user_id);
drop policy if exists "funding own read" on public.funding_requests;
create policy "funding own read" on public.funding_requests for select using (auth.uid() = user_id);
drop policy if exists "funding own create" on public.funding_requests;
create policy "funding own create" on public.funding_requests for insert with check (auth.uid() = user_id and status = 'pending');
drop policy if exists "transactions own read" on public.transactions;
create policy "transactions own read" on public.transactions for select using (auth.uid() = user_id);

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.profiles(id,full_name,phone) values(new.id,coalesce(new.raw_user_meta_data->>'full_name',''),new.raw_user_meta_data->>'phone') on conflict do nothing;
  insert into public.wallets(user_id) values(new.id) on conflict do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

-- Atomic debit for server-side purchases only. Never grant execute to anon/authenticated.
create or replace function public.debit_wallet(p_user_id uuid,p_amount numeric) returns numeric language plpgsql security definer set search_path=public as $$
declare new_balance numeric;
begin
  if p_amount <= 0 then raise exception 'Invalid amount'; end if;
  update public.wallets set balance=balance-p_amount,updated_at=now()
  where user_id=p_user_id and balance>=p_amount returning balance into new_balance;
  if new_balance is null then raise exception 'Insufficient wallet balance'; end if;
  return new_balance;
end; $$;
revoke all on function public.debit_wallet(uuid,numeric) from public, anon, authenticated;

-- ===== Production transaction + admin layer =====
alter table public.transactions add column if not exists idempotency_key text;
create unique index if not exists transactions_user_idempotency_uidx on public.transactions(user_id,idempotency_key) where idempotency_key is not null;

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admin_users enable row level security;

create or replace function public.reserve_vtu_purchase(p_user_id uuid,p_type text,p_amount numeric,p_network text,p_phone text,p_idempotency_key text)
returns uuid language plpgsql security definer set search_path=public as $$
declare tx uuid; existing uuid;
begin
  select id into existing from transactions where user_id=p_user_id and idempotency_key=p_idempotency_key;
  if existing is not null then return existing; end if;
  if p_type not in ('data','airtime') or p_amount<=0 then raise exception 'Invalid purchase'; end if;
  perform public.debit_wallet(p_user_id,p_amount);
  insert into transactions(user_id,type,amount,network,phone,description,status,idempotency_key)
  values(p_user_id,p_type,p_amount,p_network,p_phone,case when p_type='data' then 'Data purchase' else 'Airtime purchase' end,'pending',p_idempotency_key)
  returning id into tx;
  return tx;
end; $$;
revoke all on function public.reserve_vtu_purchase(uuid,text,numeric,text,text,text) from public,anon,authenticated;

create or replace function public.complete_vtu_purchase(p_transaction_id uuid,p_provider_reference text,p_provider_status text)
returns void language plpgsql security definer set search_path=public as $$
begin
 update transactions set provider_reference=p_provider_reference,status=case when lower(p_provider_status) in ('successful','success','completed') then 'successful' when lower(p_provider_status) in ('failed','reversed','cancelled') then 'failed' else 'pending' end where id=p_transaction_id;
end; $$;
revoke all on function public.complete_vtu_purchase(uuid,text,text) from public,anon,authenticated;

create or replace function public.refund_vtu_purchase(p_transaction_id uuid,p_reason text)
returns void language plpgsql security definer set search_path=public as $$
declare r transactions%rowtype;
begin
 select * into r from transactions where id=p_transaction_id for update;
 if not found or r.status in ('failed','reversed') then return; end if;
 update wallets set balance=balance+r.amount,updated_at=now() where user_id=r.user_id;
 update transactions set status='reversed',description=coalesce(p_reason,'Purchase reversed') where id=r.id;
 insert into transactions(user_id,type,amount,description,status,provider_reference) values(r.user_id,'refund',r.amount,'Refund: '||coalesce(p_reason,'purchase reversed'),'successful',r.provider_reference);
end; $$;
revoke all on function public.refund_vtu_purchase(uuid,text) from public,anon,authenticated;

create or replace function public.review_funding_request(p_request_id uuid,p_status text,p_admin_id uuid)
returns numeric language plpgsql security definer set search_path=public as $$
declare r funding_requests%rowtype; b numeric;
begin
 if not exists(select 1 from admin_users where user_id=p_admin_id) then raise exception 'Admin access required'; end if;
 if p_status not in ('approved','rejected') then raise exception 'Invalid review status'; end if;
 select * into r from funding_requests where id=p_request_id for update;
 if not found then raise exception 'Funding request not found'; end if;
 if r.status<>'pending' then raise exception 'Funding request already reviewed'; end if;
 update funding_requests set status=p_status,reviewed_at=now() where id=r.id;
 if p_status='approved' then
   update wallets set balance=balance+r.amount,updated_at=now() where user_id=r.user_id returning balance into b;
   insert into transactions(user_id,type,amount,description,status,provider_reference) values(r.user_id,'funding',r.amount,'Wallet funding','successful',r.payment_reference);
 else select balance into b from wallets where user_id=r.user_id; end if;
 return b;
end; $$;
revoke all on function public.review_funding_request(uuid,text,uuid) from public,anon,authenticated;
