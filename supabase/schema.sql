create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  email text check (email is null or char_length(email) <= 254),
  address text check (address is null or char_length(address) <= 1000),
  logo_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint businesses_user_name_key unique (user_id, name)
);

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  email text check (email is null or char_length(email) <= 254),
  phone text check (phone is null or char_length(phone) <= 60),
  address text check (address is null or char_length(address) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clients_user_business_name_key unique (user_id, business_id, name)
);

create index if not exists clients_user_business_name_idx
  on public.clients (user_id, business_id, name);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  client_id uuid references public.clients (id) on delete set null,
  document_type text not null default 'invoice' check (document_type in ('quote', 'invoice')),
  invoice_number text not null check (char_length(invoice_number) between 1 and 40),
  issuer_name text not null check (char_length(issuer_name) between 1 and 160),
  issuer_email text check (issuer_email is null or char_length(issuer_email) <= 254),
  issuer_address text check (issuer_address is null or char_length(issuer_address) <= 1000),
  client_name text not null check (char_length(client_name) between 1 and 160),
  client_email text check (client_email is null or char_length(client_email) <= 254),
  client_address text check (client_address is null or char_length(client_address) <= 1000),
  issue_date date not null,
  due_date date not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  tax_rate numeric(5, 2) not null default 0 check (tax_rate between 0 and 100),
  discount_type text not null default 'amount' check (discount_type in ('amount', 'percent')),
  discount_value numeric(12, 2) not null default 0,
  notes text check (notes is null or char_length(notes) <= 3000),
  status text not null default 'draft' check (status in ('draft', 'sent', 'paid')),
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invoices_business_number_key unique (business_id, invoice_number),
  constraint invoices_due_after_issue check (due_date >= issue_date),
  constraint invoices_discount_percent_range check (discount_type != 'percent' or discount_value between -100 and 100)
);

alter table public.invoices add column if not exists business_id uuid references public.businesses (id) on delete cascade;
alter table public.invoices add column if not exists client_id uuid references public.clients (id) on delete set null;
alter table public.invoices add column if not exists document_type text not null default 'invoice';
alter table public.invoices add column if not exists discount_type text not null default 'amount';
alter table public.invoices add column if not exists discount_value numeric(12, 2) not null default 0;
alter table public.invoices drop constraint if exists invoices_document_type_check;
alter table public.invoices add constraint invoices_document_type_check
  check (document_type in ('quote', 'invoice'));
alter table public.invoices drop constraint if exists invoices_discount_type_check;
alter table public.invoices add constraint invoices_discount_type_check
  check (discount_type in ('amount', 'percent'));
alter table public.invoices drop constraint if exists invoices_discount_percent_range;
alter table public.invoices add constraint invoices_discount_percent_range
  check (discount_type != 'percent' or discount_value between -100 and 100);

insert into public.businesses (user_id, name, email, address)
select distinct on (user_id, issuer_name)
  user_id,
  left(issuer_name, 160),
  issuer_email,
  issuer_address
from public.invoices
where user_id is not null
order by user_id, issuer_name, created_at
on conflict (user_id, name) do nothing;

update public.invoices as invoice
set business_id = (
  select business.id
  from public.businesses as business
  where business.user_id = invoice.user_id
    and business.name = left(invoice.issuer_name, 160)
  order by business.created_at
  limit 1
)
where invoice.business_id is null;

alter table public.invoices alter column business_id set not null;
alter table public.invoices drop constraint if exists invoices_user_invoice_number_key;
create unique index if not exists invoices_business_number_idx
  on public.invoices (business_id, invoice_number);
create index if not exists invoices_user_created_at_idx
  on public.invoices (user_id, created_at desc);
create index if not exists invoices_business_created_at_idx
  on public.invoices (business_id, created_at desc);

alter table public.businesses enable row level security;
alter table public.clients enable row level security;
alter table public.invoices enable row level security;

drop policy if exists "Users can view their own businesses" on public.businesses;
create policy "Users can view their own businesses"
  on public.businesses for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own businesses" on public.businesses;
create policy "Users can create their own businesses"
  on public.businesses for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own businesses" on public.businesses;
create policy "Users can update their own businesses"
  on public.businesses for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own businesses" on public.businesses;
create policy "Users can delete their own businesses"
  on public.businesses for delete
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can view clients in their businesses" on public.clients;
create policy "Users can view clients in their businesses"
  on public.clients for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (select 1 from public.businesses b where b.id = public.clients.business_id and b.user_id = (select auth.uid()))
  );

drop policy if exists "Users can create clients in their businesses" on public.clients;
create policy "Users can create clients in their businesses"
  on public.clients for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.businesses b where b.id = public.clients.business_id and b.user_id = (select auth.uid()))
  );

drop policy if exists "Users can update clients in their businesses" on public.clients;
create policy "Users can update clients in their businesses"
  on public.clients for update
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (select 1 from public.businesses b where b.id = public.clients.business_id and b.user_id = (select auth.uid()))
  )
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.businesses b where b.id = public.clients.business_id and b.user_id = (select auth.uid()))
  );

drop policy if exists "Users can delete clients in their businesses" on public.clients;
create policy "Users can delete clients in their businesses"
  on public.clients for delete
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (select 1 from public.businesses b where b.id = public.invoices.business_id and b.user_id = (select auth.uid()))
  );

drop policy if exists "Users can view invoices in their businesses" on public.invoices;
drop policy if exists "Users can view their own invoices" on public.invoices;
create policy "Users can view invoices in their businesses"
  on public.invoices for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (select 1 from public.businesses b where b.id = business_id and b.user_id = (select auth.uid()))
  );

drop policy if exists "Users can create invoices in their businesses" on public.invoices;
drop policy if exists "Users can create their own invoices" on public.invoices;
create policy "Users can create invoices in their businesses"
  on public.invoices for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.businesses b where b.id = public.invoices.business_id and b.user_id = (select auth.uid()))
    and (client_id is null or exists (select 1 from public.clients c where c.id = public.invoices.client_id and c.business_id = public.invoices.business_id and c.user_id = (select auth.uid())))
  );

drop policy if exists "Users can update invoices in their businesses" on public.invoices;
drop policy if exists "Users can update their own invoices" on public.invoices;
create policy "Users can update invoices in their businesses"
  on public.invoices for update
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (select 1 from public.businesses b where b.id = public.invoices.business_id and b.user_id = (select auth.uid()))
  )
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.businesses b where b.id = public.invoices.business_id and b.user_id = (select auth.uid()))
    and (client_id is null or exists (select 1 from public.clients c where c.id = public.invoices.client_id and c.business_id = public.invoices.business_id and c.user_id = (select auth.uid())))
  );

drop policy if exists "Users can delete invoices in their businesses" on public.invoices;
drop policy if exists "Users can delete their own invoices" on public.invoices;
create policy "Users can delete invoices in their businesses"
  on public.invoices for delete
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (select 1 from public.businesses b where b.id = public.invoices.business_id and b.user_id = (select auth.uid()))
  );

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_business_updated_at on public.businesses;
create trigger set_business_updated_at
  before update on public.businesses
  for each row execute function public.set_updated_at();

drop trigger if exists set_client_updated_at on public.clients;
create trigger set_client_updated_at
  before update on public.clients
  for each row execute function public.set_updated_at();

drop trigger if exists set_invoice_updated_at on public.invoices;
create trigger set_invoice_updated_at
  before update on public.invoices
  for each row execute function public.set_updated_at();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('business-logos', 'business-logos', true, 2097152, array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Business logos are publicly viewable" on storage.objects;
create policy "Business logos are publicly viewable"
  on storage.objects for select
  to public
  using (bucket_id = 'business-logos');

drop policy if exists "Users can upload their own business logos" on storage.objects;
create policy "Users can upload their own business logos"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'business-logos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can update their own business logos" on storage.objects;
create policy "Users can update their own business logos"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'business-logos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'business-logos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can delete their own business logos" on storage.objects;
create policy "Users can delete their own business logos"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'business-logos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
