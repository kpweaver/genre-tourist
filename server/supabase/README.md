# Supabase setup

## Chart cache table

1. Open [Supabase Dashboard](https://supabase.com/dashboard) → your project.
2. Go to **SQL Editor** → **New query**.
3. Paste the contents of `migrations/001_rym_charts_cache.sql`.
4. Click **Run**.

The `rym_charts_cache` table will be created. The server uses it to cache AOTY chart results for 24 hours per genre.
