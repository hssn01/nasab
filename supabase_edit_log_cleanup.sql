-- =============================================================================
-- Nasab — stop the per-row audit log and reclaim its space
--
-- Why: trg_persons_log wrote old_row + new_row for every UPDATE/DELETE on
-- persons. Because the app upserted all ~2,200 persons on every save, the log
-- reached 1,204,054 rows / 1,328 MB in ten days. Nothing in the app reads it.
--
-- Run this in Supabase -> SQL Editor. TRUNCATE swaps the table file and returns
-- the space immediately, so no VACUUM FULL is needed.
--
-- The application change (saving only changed rows) ships with this migration,
-- so the log cannot refill at the old rate even if it is re-enabled later.
-- =============================================================================

-- 1. Stop logging every person change.
drop trigger if exists trg_persons_log on public.persons;
drop function if exists public.log_person_change();

-- 2. Drop the 1.2M audit rows and give the ~1.3 GB back to the instance.
truncate table public.edit_log;

-- 3. Verify (expected: edit_log ~8 kB, database ~10-15 MB).
select
  pg_size_pretty(pg_total_relation_size('public.edit_log')) as edit_log_size,
  pg_size_pretty(pg_database_size(current_database())) as database_size;
