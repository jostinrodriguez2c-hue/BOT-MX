create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  category text not null default '',
  unit text not null check (char_length(unit) between 1 and 30),
  stock integer not null default 0 check (stock >= 0),
  reserved integer not null default 0 check (reserved >= 0 and reserved <= stock),
  sold integer not null default 0 check (sold >= 0),
  price_cents integer not null check (price_cents > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_categories (
  name text primary key check (char_length(name) between 1 and 80)
);

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.organization_catalogs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('company', 'department', 'job')),
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '',
  created_at timestamptz not null default now(),
  unique (kind, name)
);

create table if not exists public.worker_roles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 1 and 80),
  permissions text[] not null default '{}',
  created_at timestamptz not null default now(),
  check (permissions <@ array[
    'inventory_view',
    'sales_register',
    'products_manage',
    'workers_directory',
    'applications_review',
    'catalog_manage'
  ]::text[])
);

insert into public.worker_roles (name, permissions)
values (
  'Trabajador',
  array['inventory_view', 'sales_register', 'products_manage', 'workers_directory']::text[]
)
on conflict (name) do update set permissions = excluded.permissions;

create table if not exists public.worker_applications (
  email text primary key check (char_length(email) between 3 and 254),
  name text not null default '',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'terminated')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  department text not null default '',
  position text not null default '',
  company text not null default '',
  role_id uuid references public.worker_roles(id) on delete set null
);

alter table public.worker_applications add column if not exists name text not null default '';
alter table public.worker_applications add column if not exists department text not null default '';
alter table public.worker_applications add column if not exists position text not null default '';
alter table public.worker_applications add column if not exists company text not null default '';
alter table public.worker_applications add column if not exists role_id uuid references public.worker_roles(id) on delete set null;
insert into public.organization_catalogs (kind, name)
select 'department', trim(department)
from public.worker_applications
where trim(department) <> ''
on conflict (kind, name) do nothing;
insert into public.organization_catalogs (kind, name)
select 'job', trim(position)
from public.worker_applications
where trim(position) <> ''
on conflict (kind, name) do nothing;
insert into public.organization_catalogs (kind, name)
select 'company', trim(company)
from public.worker_applications
where trim(company) <> ''
on conflict (kind, name) do nothing;
update public.worker_applications
set role_id = (select id from public.worker_roles where name = 'Trabajador')
where status = 'approved' and role_id is null;
alter table public.worker_applications drop constraint if exists worker_applications_status_check;
alter table public.worker_applications
  add constraint worker_applications_status_check
  check (status in ('pending', 'approved', 'rejected', 'terminated'));

create table if not exists public.worker_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique check (char_length(email) between 3 and 254),
  name text not null default '',
  created_at timestamptz not null default now()
);

alter table public.worker_users add column if not exists name text not null default '';

create table if not exists public.worker_signup_attempts (
  email text primary key check (char_length(email) between 3 and 254),
  attempted_at timestamptz not null
);

create or replace function public.claim_worker_signup(p_email text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(p_email));
  v_attempted_at timestamptz;
  v_retry_seconds integer;
begin
  if v_email is null or char_length(v_email) not between 3 and 254 then
    raise exception 'invalid_signup_email';
  end if;

  perform pg_advisory_xact_lock(hashtext('worker-signup:' || v_email));
  select attempted_at into v_attempted_at
    from public.worker_signup_attempts
    where email = v_email
    for update;

  if found and v_attempted_at > now() - interval '30 seconds' then
    v_retry_seconds := ceil(extract(epoch from (v_attempted_at + interval '30 seconds' - now())))::integer;
    return greatest(v_retry_seconds, 1);
  end if;

  insert into public.worker_signup_attempts (email, attempted_at)
    values (v_email, now())
    on conflict (email) do update set attempted_at = excluded.attempted_at;
  return 0;
end;
$$;

create table if not exists public.worker_warnings (
  id uuid primary key default gen_random_uuid(),
  email text not null references public.worker_applications(email) on delete cascade,
  message text not null check (char_length(message) between 1 and 500),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.activity_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text not null default '',
  actor_name text not null default '',
  event_type text not null check (char_length(event_type) between 1 and 80),
  summary text not null check (char_length(summary) between 1 and 160),
  details jsonb not null default '{}'::jsonb,
  visibility text not null default 'admin' check (visibility in ('public', 'admin', 'worker')),
  recipient_email text,
  created_at timestamptz not null default now(),
  check (visibility <> 'worker' or recipient_email is not null)
);

create table if not exists public.notification_reads (
  reader_email text primary key check (char_length(reader_email) between 3 and 254),
  last_read_at timestamptz not null default now()
);

alter table public.activity_events enable row level security;
alter table public.notification_reads enable row level security;

create index if not exists activity_events_visibility_created_idx
  on public.activity_events (visibility, created_at desc);
create index if not exists activity_events_actor_created_idx
  on public.activity_events (actor_email, created_at desc);
create index if not exists activity_events_recipient_created_idx
  on public.activity_events (recipient_email, created_at desc)
  where recipient_email is not null;

create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  product_name text not null,
  unit text not null,
  quantity integer not null check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents > 0),
  total_cents integer not null check (total_cents > 0),
  currency text not null default 'USD' check (currency = 'USD'),
  customer_name text not null check (char_length(customer_name) between 1 and 100),
  contact text not null check (char_length(contact) between 1 and 120),
  email text not null,
  status text not null default 'pending_otp'
    check (status in ('pending_otp', 'pending_payment', 'paid', 'paid_review', 'expired', 'cancelled')),
  otp_hash text not null,
  otp_expires_at timestamptz not null,
  otp_attempts integer not null default 0 check (otp_attempts between 0 and 5),
  otp_used boolean not null default false,
  payment_id text unique,
  preference_id text,
  payment_url text,
  payment_expires_at timestamptz,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create index if not exists purchase_orders_status_expiry_idx
  on public.purchase_orders (status, payment_expires_at);
create index if not exists purchase_orders_email_created_idx
  on public.purchase_orders (email, created_at desc);

create table if not exists public.purchase_rate_limits (
  bucket text not null check (bucket in ('email', 'ip')),
  key text not null,
  window_started_at timestamptz not null,
  request_count integer not null default 0,
  last_sent_at timestamptz not null,
  primary key (bucket, key)
);

alter table public.products enable row level security;
alter table public.product_categories enable row level security;
alter table public.admin_users enable row level security;
alter table public.organization_catalogs enable row level security;
alter table public.worker_roles enable row level security;
alter table public.worker_applications enable row level security;
alter table public.worker_users enable row level security;
alter table public.worker_signup_attempts enable row level security;
alter table public.worker_warnings enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_rate_limits enable row level security;

revoke all on public.products, public.product_categories, public.admin_users, public.organization_catalogs, public.worker_roles,
  public.worker_applications, public.worker_users, public.worker_signup_attempts, public.worker_warnings, public.activity_events, public.notification_reads, public.purchase_orders, public.purchase_rate_limits
  from anon, authenticated;
grant all on public.products, public.product_categories, public.admin_users, public.organization_catalogs, public.worker_roles,
  public.worker_applications, public.worker_users, public.worker_signup_attempts, public.worker_warnings, public.activity_events, public.notification_reads, public.purchase_orders, public.purchase_rate_limits
  to service_role;

create or replace function public.create_purchase_request(
  p_product_id uuid,
  p_quantity integer,
  p_email text,
  p_customer_name text,
  p_contact text,
  p_otp_hash text,
  p_otp_expires_at timestamptz,
  p_ip_hash text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.products%rowtype;
  v_order_id uuid;
  v_bucket text;
  v_key text;
  v_limit integer;
  v_rate public.purchase_rate_limits%rowtype;
begin
  perform public.release_expired_orders();
  select * into v_product from public.products
    where id = p_product_id and active = true for update;
  if not found or p_quantity < 1 or v_product.stock - v_product.reserved < p_quantity then
    raise exception 'product_unavailable';
  end if;
  if v_product.price_cents <= 0 then
    raise exception 'product_price_missing';
  end if;

  for v_bucket, v_key, v_limit in
    select 'email', lower(trim(p_email)), 5
    union all
    select 'ip', p_ip_hash, 15
  loop
    perform pg_advisory_xact_lock(hashtext(v_bucket || ':' || v_key));
    select * into v_rate from public.purchase_rate_limits
      where bucket = v_bucket and key = v_key for update;
    if found then
      if now() - v_rate.last_sent_at < interval '60 seconds' then
        raise exception 'otp_rate_limited';
      end if;
      if now() - v_rate.window_started_at >= interval '1 hour' then
        update public.purchase_rate_limits set
          window_started_at = now(), request_count = 1, last_sent_at = now()
          where bucket = v_bucket and key = v_key;
      elsif v_rate.request_count >= v_limit then
        raise exception 'otp_rate_limited';
      else
        update public.purchase_rate_limits set
          request_count = request_count + 1, last_sent_at = now()
          where bucket = v_bucket and key = v_key;
      end if;
    else
      insert into public.purchase_rate_limits (bucket, key, window_started_at, request_count, last_sent_at)
        values (v_bucket, v_key, now(), 1, now());
    end if;
  end loop;

  insert into public.purchase_orders (
    product_id, product_name, unit, quantity, unit_price_cents, total_cents,
    customer_name, contact, email, otp_hash, otp_expires_at
  ) values (
    v_product.id, v_product.name, v_product.unit, p_quantity, v_product.price_cents,
    v_product.price_cents * p_quantity, trim(p_customer_name), trim(p_contact),
    lower(trim(p_email)), p_otp_hash, p_otp_expires_at
  ) returning id into v_order_id;
  return v_order_id;
end;
$$;

create or replace function public.verify_purchase_code(p_order_id uuid, p_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.purchase_orders%rowtype;
  v_product public.products%rowtype;
begin
  select * into v_order from public.purchase_orders where id = p_order_id for update;
  if not found or v_order.status <> 'pending_otp' or v_order.otp_used
    or v_order.otp_expires_at <= now() or v_order.otp_attempts >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'expired_or_used');
  end if;
  if v_order.otp_hash <> p_code_hash then
    update public.purchase_orders set otp_attempts = otp_attempts + 1 where id = p_order_id;
    return jsonb_build_object('ok', false, 'reason', 'invalid_code');
  end if;

  select * into v_product from public.products
    where id = v_order.product_id and active = true for update;
  if not found or v_product.stock - v_product.reserved < v_order.quantity then
    return jsonb_build_object('ok', false, 'reason', 'product_unavailable');
  end if;

  update public.products set reserved = reserved + v_order.quantity, updated_at = now()
    where id = v_product.id;
  update public.purchase_orders set
    status = 'pending_payment', otp_used = true, payment_expires_at = now() + interval '30 minutes'
    where id = p_order_id;
  return jsonb_build_object(
    'ok', true,
    'order', jsonb_build_object(
      'id', v_order.id,
      'product_id', v_order.product_id,
      'product_name', v_order.product_name,
      'quantity', v_order.quantity,
      'unit', v_order.unit,
      'unit_price_cents', v_order.unit_price_cents,
      'total_cents', v_order.total_cents,
      'currency', v_order.currency,
      'payment_expires_at', now() + interval '30 minutes'
    )
  );
end;
$$;

create or replace function public.release_expired_orders()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.purchase_orders%rowtype;
  v_count integer := 0;
begin
  update public.purchase_orders set status = 'expired'
    where status = 'pending_otp' and otp_expires_at <= now();
  for v_order in
    select * from public.purchase_orders
      where status = 'pending_payment' and payment_expires_at <= now()
      for update skip locked
  loop
    update public.products set
      reserved = greatest(0, reserved - v_order.quantity), updated_at = now()
      where id = v_order.product_id;
    update public.purchase_orders set status = 'expired' where id = v_order.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.cancel_purchase_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.purchase_orders%rowtype;
begin
  select * into v_order from public.purchase_orders where id = p_order_id for update;
  if not found or v_order.status <> 'pending_payment' then return; end if;
  update public.products set reserved = greatest(0, reserved - v_order.quantity), updated_at = now()
    where id = v_order.product_id;
  update public.purchase_orders set status = 'cancelled' where id = v_order.id;
end;
$$;

create or replace function public.confirm_paid_purchase(
  p_order_id uuid,
  p_payment_id text,
  p_total_cents integer
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.purchase_orders%rowtype;
begin
  select * into v_order from public.purchase_orders where id = p_order_id for update;
  if not found or v_order.total_cents <> p_total_cents then
    raise exception 'payment_order_mismatch';
  end if;
  if v_order.status = 'paid' then return 'paid'; end if;
  if v_order.status <> 'pending_payment' or v_order.payment_expires_at <= now() then
    update public.purchase_orders set status = 'paid_review', payment_id = p_payment_id
      where id = p_order_id and status <> 'paid';
    return 'paid_review';
  end if;

  update public.products set
    stock = stock - v_order.quantity,
    reserved = greatest(0, reserved - v_order.quantity),
    sold = sold + v_order.quantity,
    updated_at = now()
    where id = v_order.product_id and stock >= v_order.quantity and reserved >= v_order.quantity;
  if not found then
    update public.purchase_orders set status = 'paid_review', payment_id = p_payment_id
      where id = p_order_id;
    return 'paid_review';
  end if;
  update public.purchase_orders set
    status = 'paid', payment_id = p_payment_id, paid_at = now()
    where id = p_order_id;
  return 'paid';
end;
$$;

create or replace function public.register_manual_sale(p_product_id uuid, p_quantity integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.products set
    stock = stock - p_quantity, sold = sold + p_quantity, updated_at = now()
    where id = p_product_id and active = true
      and p_quantity > 0 and stock - reserved >= p_quantity;
  if not found then raise exception 'product_unavailable'; end if;
end;
$$;

create or replace function public.register_demo_purchase(
  p_product_id uuid,
  p_quantity integer,
  p_ip_hash text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.products%rowtype;
  v_rate public.purchase_rate_limits%rowtype;
begin
  if p_quantity < 1 or p_quantity > 1000 or char_length(p_ip_hash) <> 64 then
    raise exception 'invalid_demo_purchase';
  end if;

  select * into v_product from public.products
    where id = p_product_id and active = true for update;
  if not found or v_product.stock - v_product.reserved < p_quantity then
    raise exception 'product_unavailable';
  end if;

  perform pg_advisory_xact_lock(hashtext('demo:' || p_ip_hash));
  select * into v_rate from public.purchase_rate_limits
    where bucket = 'ip' and key = p_ip_hash for update;
  if found then
    if now() - v_rate.last_sent_at < interval '2 seconds' then
      raise exception 'demo_rate_limited';
    end if;
    if now() - v_rate.window_started_at >= interval '1 hour' then
      update public.purchase_rate_limits set
        window_started_at = now(), request_count = 1, last_sent_at = now()
        where bucket = 'ip' and key = p_ip_hash;
    elsif v_rate.request_count >= 30 then
      raise exception 'demo_rate_limited';
    else
      update public.purchase_rate_limits set
        request_count = request_count + 1, last_sent_at = now()
        where bucket = 'ip' and key = p_ip_hash;
    end if;
  else
    insert into public.purchase_rate_limits (bucket, key, window_started_at, request_count, last_sent_at)
      values ('ip', p_ip_hash, now(), 1, now());
  end if;

  update public.products set
    stock = stock - p_quantity,
    sold = sold + p_quantity,
    updated_at = now()
    where id = p_product_id and active = true and stock - reserved >= p_quantity;
  if not found then raise exception 'product_unavailable'; end if;

  insert into public.activity_events (
    actor_name, event_type, summary, details, visibility
  ) values (
    'Visitante',
    'purchase',
    'Compra simulada: ' || v_product.name,
    jsonb_build_object(
      'product_name', v_product.name,
      'quantity', p_quantity,
      'unit', v_product.unit,
      'total_cents', v_product.price_cents * p_quantity,
      'currency', 'USD'
    ),
    'public'
  );
end;
$$;

revoke all on function public.create_purchase_request(uuid, integer, text, text, text, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.verify_purchase_code(uuid, text) from public, anon, authenticated;
revoke all on function public.release_expired_orders() from public, anon, authenticated;
revoke all on function public.cancel_purchase_order(uuid) from public, anon, authenticated;
revoke all on function public.confirm_paid_purchase(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.register_manual_sale(uuid, integer) from public, anon, authenticated;
revoke all on function public.register_demo_purchase(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.claim_worker_signup(text) from public, anon, authenticated;
grant execute on function public.create_purchase_request(uuid, integer, text, text, text, text, timestamptz, text) to service_role;
grant execute on function public.verify_purchase_code(uuid, text) to service_role;
grant execute on function public.release_expired_orders() to service_role;
grant execute on function public.cancel_purchase_order(uuid) to service_role;
grant execute on function public.confirm_paid_purchase(uuid, text, integer) to service_role;
grant execute on function public.register_manual_sale(uuid, integer) to service_role;
grant execute on function public.register_demo_purchase(uuid, integer, text) to service_role;
grant execute on function public.claim_worker_signup(text) to service_role;

create or replace function public.count_unread_notifications(
  p_reader_email text,
  p_reader_role text
) returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select count(*)
  from public.activity_events e
  where e.created_at > coalesce(
    (
      select r.last_read_at
      from public.notification_reads r
      where r.reader_email = lower(p_reader_email)
    ),
    '-infinity'::timestamptz
  )
  and e.recipient_email = lower(p_reader_email)
  and e.visibility = case
    when p_reader_role = 'admin' then 'admin'
    when p_reader_role = 'worker' then 'worker'
    else ''
  end;
$$;

revoke all on function public.count_unread_notifications(text, text) from public, anon, authenticated;
grant execute on function public.count_unread_notifications(text, text) to service_role;
