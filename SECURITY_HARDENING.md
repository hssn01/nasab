# Security hardening — server-verified editor PIN

This change makes the public viewer read-only and moves editor authentication to
the server:

- **Public (anon):** can read `trees`, `persons`, `unions`, and `tree_links`.
- **Editor:** signs in through the `editor-login` Edge Function with a passcode;
  the function verifies the passcode against a server-side secret and returns a
  Supabase Auth session for the shared editor account.
- **Writes:** only that authenticated editor account can insert/update/delete.
  Knowing the public anon key or forging the old client-side unlock flag is not
  enough.

The old `2233` passcode is still in Git history. **Choose a new passcode before
deploying.** A long random passphrase (12+ characters, or 10+ random digits) is
strongly recommended.

---

## 1. Create the shared editor account

In Supabase Dashboard → **Authentication → Users**, create one user:

- Email: e.g. `editor@your-domain.example`
- Password: a random value is fine. The login function does **not** use the
  password; it generates a server-side magic-link session for this account, so
  no editor password secret is needed.

Then run this in the SQL editor, replacing the email:

```sql
UPDATE auth.users
SET raw_app_meta_data =
      coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"editor"}'::jsonb
WHERE email = 'editor@your-domain.example';

SELECT email, raw_app_meta_data
FROM auth.users
WHERE raw_app_meta_data ->> 'role' = 'editor';
```

The `role: editor` claim is what the RLS policies check.

## 2. Run the security SQL

Open Supabase Dashboard → **SQL Editor** and run
[`supabase_security_hardening.sql`](./supabase_security_hardening.sql).

> **Review first:** the script drops *all* existing policies on `trees`,
> `persons`, `unions`, `tree_links`, and `sessions`, then creates the new
> policies. If you added custom policies, back them up before running.

It replaces the old `FOR ALL USING (true)` policies, enables RLS on the data
tables, grants public `SELECT`, and restricts writes to the editor JWT. It also
creates `editor_login_attempts` for rate limiting and backfills the
`linked_from` column. If your `trees` table predates that column, the script adds
it with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` before the backfill.

## 3. Configure the Edge Function secret

Only one application secret is needed:

```bash
supabase secrets set EDITOR_PIN='replace-with-a-new-strong-passcode'
```

`SUPABASE_URL` is provided automatically. The function reads either the legacy
`SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` variables or the newer
`SUPABASE_PUBLISHABLE_KEYS` / `SUPABASE_SECRET_KEYS` dictionaries, so no extra
Supabase secrets are required.

The function finds the shared account by `app_metadata.role = 'editor'`, creates
a one-time magic-link token for it with the service role, and exchanges that for
a session. There is no `EDITOR_EMAIL`, `EDITOR_PASSWORD`, `ALLOWED_ORIGINS`, or
`RATE_LIMIT_SALT` secret. CORS is open because the PIN is the credential; CORS
was never the security boundary.

## 4. Deploy the Edge Function

```bash
supabase functions deploy editor-login --no-verify-jwt
```

`--no-verify-jwt` is required because visitors call this function before they
have a session; the passcode is the credential.

## 5. Configure and deploy the app

Set the build environment variables:

```bash
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_ANON_KEY
```

The Vite config also exposes `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, so deployments that already use those
names work without renaming them. The public publishable key is safe to ship in
the client bundle; the secret key is not.

The public viewer is read-only in code. Editors open the protected editor and
enter the new passcode; the app receives a Supabase Auth session and all writes
go through RLS.

## 6. Verify the lockdown

Use the public anon key (the one shipped in the client) to confirm reads work and
writes fail.

```bash
PROJECT_URL='https://YOUR_PROJECT.supabase.co'
ANON_KEY='YOUR_ANON_KEY'
TREE_ID='YOUR_TREE_UUID'

# Should return rows
curl "$PROJECT_URL/rest/v1/trees?select=id,name&limit=1" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY"

# Should affect 0 rows (PostgREST may return 204 with an empty body, or [] here)
curl -X PATCH "$PROJECT_URL/rest/v1/trees?id=eq.$TREE_ID" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{"name":"should-not-work"}'
```

Then re-read the tree and confirm its name did not change.

Then test the login function:

```bash
curl -X POST "$PROJECT_URL/functions/v1/editor-login" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "Content-Type: application/json" \
  -H "Origin: https://your-app.example" \
  -d '{"pin":"YOUR_NEW_PASSCODE"}'
```

It should return `access_token` and `refresh_token`. Using the access token in a
PATCH request should succeed.

## 7. Check for previously corrupted trees

The save guard prevents new merged-display writes, but it cannot repair a tree
that was already overwritten before the fix. This query flags likely-merged
states (virtual common roots, branch metadata, or linked spouses):

```sql
SELECT id, name, updated_at
FROM public.trees
WHERE state::text LIKE '%__COMMON_ROOT__%'
   OR state::text LIKE '%"branchMeta"%'
   OR state::text LIKE '%"linkedSpouse"%'
ORDER BY updated_at DESC;
```

A healthy base tree normally contains none of those markers. If a row is
flagged, restore that tree's `state` from a backup or from the original source
tree. Until it is repaired, the app will load it for viewing but the save guard
will refuse to overwrite it (this protects the remaining data).

## 8. Operational notes

- **Offline edits:** local edits still go to IndexedDB. They sync when the editor
  has a valid Supabase session. If the session expires, re-enter the passcode;
  the local edits remain queued.
- **Passcode rotation:** update the `EDITOR_PIN` secret first, then sign out the
  shared user's sessions. Changing the PIN does not invalidate access or refresh
  tokens that were already issued. A function redeploy is not required, but is
  harmless. No client rebuild is needed.
- **Revoking a device:** the lock button signs out only the current browser
  (`scope: 'local'`) so other editors are not logged out. To invalidate all
  existing editor sessions, use the Supabase Dashboard → Authentication → Users
  and sign out the shared user's sessions.
- **UI gate vs. security:** `sessionStorage` still controls whether edit buttons
  are shown, but it is only a convenience. RLS is the security boundary; a forged
  UI flag cannot write data.
