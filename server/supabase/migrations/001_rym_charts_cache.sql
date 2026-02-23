-- Chart cache for AOTY genre charts (24h TTL).
-- Run this in Supabase Dashboard → SQL Editor → New query, then Run.

create table if not exists public.rym_charts_cache (
  id uuid primary key default gen_random_uuid(),
  genre text not null unique,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Optional: index for fast lookups by genre (unique already gives one)
create index if not exists rym_charts_cache_genre_idx on public.rym_charts_cache (genre);

-- RLS: only server (service_role) can access; anon/authenticated have no policy so no access
alter table public.rym_charts_cache enable row level security;

comment on table public.rym_charts_cache is 'Cached AOTY genre chart data; refreshed after 24h';
