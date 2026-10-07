-- Bütçe Takip — Uğur & İzgi
-- Ortak ev bütçesi: herkes kendi kayıtlarını girer, ikisi de hepsini görür.

-- ---------------------------------------------------------------
-- Profiller (hane üyeleri). En fazla 2 üye kabul edilir.
-- ---------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now()
);

-- Yardımcı fonksiyonlar API'de görünmeyen private şemasında durur.
create schema if not exists private;
grant usage on schema private to authenticated;

-- Yeni kullanıcı kaydolduğunda profil oluştur; hane doluysa (2 kişi) kaydı reddet.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $
begin
  -- Kayıt olma kapalı: Auth API'sinden gelen kayıtlar reddedilir, hesaplar yönetici SQL'i ile açılır.
  if session_user = 'supabase_auth_admin' then
    raise exception 'Kayıt olma kapalı.';
  end if;
  if (select count(*) from public.profiles) >= 2 then
    raise exception 'Bu hane zaten 2 üyeye sahip.';
  end if;
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Oturumdaki kullanıcı hane üyesi mi?
create or replace function private.is_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()));
$$;

revoke all on function private.is_member() from public, anon;
grant execute on function private.is_member() to authenticated;
revoke all on function private.handle_new_user() from public, anon, authenticated;

-- ---------------------------------------------------------------
-- Gelir / gider kayıtları
-- ---------------------------------------------------------------
create table public.transactions (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('income', 'expense')),
  amount numeric(14, 2) not null check (amount > 0),
  category text not null,
  note text,
  date date not null default current_date,
  created_at timestamptz not null default now()
);
create index transactions_date_idx on public.transactions (date);
create index transactions_user_id_idx on public.transactions (user_id);

-- ---------------------------------------------------------------
-- Yatırımlar (kenara atılan paranın nereye gittiği)
-- ---------------------------------------------------------------
create table public.investments (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  asset_type text not null,
  description text,
  amount numeric(14, 2) not null check (amount > 0),
  quantity numeric(18, 6),
  date date not null default current_date,
  -- Hangi ayın kenarda kalan parasıyla yapıldı (ayın 1'i). Null: kenardaki paraya bağlı değil.
  -- Bağlı yatırımlar o ayın "kenara kalan" tutarından düşülür.
  funded_month date check (funded_month is null or extract(day from funded_month) = 1),
  created_at timestamptz not null default now()
);
create index investments_date_idx on public.investments (date);
create index investments_user_id_idx on public.investments (user_id);

-- ---------------------------------------------------------------
-- Beklenen (potansiyel) gelirler. Taksitli ödemede her taksit ayrı satırdır,
-- aynı plan_id ile bağlanır (installment_no / installment_count: 2/5 gibi).
-- ---------------------------------------------------------------
create table public.expected_incomes (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  source text not null,
  amount numeric(14, 2) not null check (amount > 0),
  date date not null,
  note text,
  plan_id uuid,
  installment_no int,
  installment_count int,
  received boolean not null default false,
  created_at timestamptz not null default now(),
  check ((plan_id is null) = (installment_no is null) and (plan_id is null) = (installment_count is null)),
  check (installment_no is null or installment_no between 1 and installment_count)
);
create index expected_incomes_date_idx on public.expected_incomes (date);
create index expected_incomes_user_id_idx on public.expected_incomes (user_id);
create index expected_incomes_plan_id_idx on public.expected_incomes (plan_id);

-- ---------------------------------------------------------------
-- Ortak alışveriş listesi
-- ---------------------------------------------------------------
create table public.shopping_items (
  id bigint generated always as identity primary key,
  name text not null,
  quantity text,
  checked boolean not null default false,
  added_by uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  checked_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index shopping_items_added_by_idx on public.shopping_items (added_by);
create index shopping_items_checked_by_idx on public.shopping_items (checked_by);

-- ---------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.transactions enable row level security;
alter table public.investments enable row level security;
alter table public.shopping_items enable row level security;

-- Profiller: üyeler birbirini görür, herkes kendi adını değiştirebilir.
create policy "profiles_select" on public.profiles
  for select to authenticated using ((select private.is_member()));
create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Gelir/gider: üyeler hepsini görür, sadece kendi kaydını ekler/düzenler/siler.
create policy "transactions_select" on public.transactions
  for select to authenticated using ((select private.is_member()));
create policy "transactions_insert_own" on public.transactions
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "transactions_update_own" on public.transactions
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "transactions_delete_own" on public.transactions
  for delete to authenticated using (user_id = (select auth.uid()));

-- Yatırımlar: aynı kurallar.
create policy "investments_select" on public.investments
  for select to authenticated using ((select private.is_member()));
create policy "investments_insert_own" on public.investments
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "investments_update_own" on public.investments
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "investments_delete_own" on public.investments
  for delete to authenticated using (user_id = (select auth.uid()));

-- Beklenen gelirler: aynı kurallar.
alter table public.expected_incomes enable row level security;
create policy "expected_select" on public.expected_incomes
  for select to authenticated using ((select private.is_member()));
create policy "expected_insert_own" on public.expected_incomes
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "expected_update_own" on public.expected_incomes
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "expected_delete_own" on public.expected_incomes
  for delete to authenticated using (user_id = (select auth.uid()));

-- Alışveriş listesi: ortak, iki üye de her şeyi yapabilir.
create policy "shopping_select" on public.shopping_items
  for select to authenticated using ((select private.is_member()));
create policy "shopping_insert" on public.shopping_items
  for insert to authenticated with check ((select private.is_member()) and added_by = (select auth.uid()));
create policy "shopping_update" on public.shopping_items
  for update to authenticated using ((select private.is_member())) with check ((select private.is_member()));
create policy "shopping_delete" on public.shopping_items
  for delete to authenticated using ((select private.is_member()));

-- ---------------------------------------------------------------
-- Canlı senkron (bir telefonda eklenen diğerinde anında görünsün)
-- ---------------------------------------------------------------
alter publication supabase_realtime add table public.transactions, public.investments, public.shopping_items,
  public.expected_incomes;
