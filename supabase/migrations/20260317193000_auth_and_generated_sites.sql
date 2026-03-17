create extension if not exists pgcrypto with schema extensions;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.generated_sites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  slug text not null,
  title text not null,
  topic text not null,
  page_mode text not null check (page_mode in ('conversion', 'editorial', 'hybrid')),
  existing_website text,
  colors jsonb not null default '[]'::jsonb,
  thumbnail_url text,
  site_url text not null,
  version_label text not null default 'Original version',
  metadata_url text,
  edit_source_slug text,
  start_prompt text,
  end_prompt text,
  video_prompt text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz
);

create unique index if not exists generated_sites_user_id_slug_key
  on public.generated_sites (user_id, slug);

create index if not exists generated_sites_user_id_created_at_idx
  on public.generated_sites (user_id, created_at desc);

create table if not exists public.build_jobs (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  slug text not null,
  topic text not null,
  page_mode text not null check (page_mode in ('conversion', 'editorial', 'hybrid')),
  status text not null check (status in ('queued', 'running', 'completed', 'failed')),
  logs jsonb not null default '[]'::jsonb,
  error text,
  site_url text,
  thumbnail_url text,
  metadata_url text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists build_jobs_user_id_created_at_idx
  on public.build_jobs (user_id, created_at desc);

drop trigger if exists set_generated_sites_updated_at on public.generated_sites;
create trigger set_generated_sites_updated_at
before update on public.generated_sites
for each row
execute function public.set_updated_at();

drop trigger if exists set_build_jobs_updated_at on public.build_jobs;
create trigger set_build_jobs_updated_at
before update on public.build_jobs
for each row
execute function public.set_updated_at();

alter table public.generated_sites enable row level security;
alter table public.build_jobs enable row level security;

drop policy if exists "generated_sites_select_own" on public.generated_sites;
create policy "generated_sites_select_own"
on public.generated_sites
for select
using (auth.uid() = user_id);

drop policy if exists "generated_sites_insert_own" on public.generated_sites;
create policy "generated_sites_insert_own"
on public.generated_sites
for insert
with check (auth.uid() = user_id);

drop policy if exists "generated_sites_update_own" on public.generated_sites;
create policy "generated_sites_update_own"
on public.generated_sites
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "generated_sites_delete_own" on public.generated_sites;
create policy "generated_sites_delete_own"
on public.generated_sites
for delete
using (auth.uid() = user_id);

drop policy if exists "build_jobs_select_own" on public.build_jobs;
create policy "build_jobs_select_own"
on public.build_jobs
for select
using (auth.uid() = user_id);

drop policy if exists "build_jobs_insert_own" on public.build_jobs;
create policy "build_jobs_insert_own"
on public.build_jobs
for insert
with check (auth.uid() = user_id);

drop policy if exists "build_jobs_update_own" on public.build_jobs;
create policy "build_jobs_update_own"
on public.build_jobs
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
