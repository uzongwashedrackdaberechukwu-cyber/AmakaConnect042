# AmakaConnect042 Functional VTU

This build contains the customer VTU dashboard, Supabase authentication, NGN wallet, funding requests, transaction history, exact ShadexGoLtd VTU catalogue/order integration, and a protected admin dashboard.

## 1. Supabase
Create a Supabase project and run `supabase.sql` in the SQL Editor.

Create the first admin account normally, get its Auth user UUID, then run:

```sql
insert into public.admin_users(user_id) values ('YOUR-AUTH-USER-UUID');
```

## 2. Browser configuration
Edit `dist/config.js` and set only the public Supabase URL/anon key and the real funding bank details. Never place the ShadexGoLtd key here.

## 3. Edge Functions
Deploy both functions:

```bash
supabase functions deploy shadex-proxy
supabase functions deploy admin-api
```

Set server secrets:

```bash
supabase secrets set SHADEX_API_BASE_URL=https://shadexgoltd.com
supabase secrets set SHADEX_API_KEY=YOUR_SHADEX_LIVE_KEY
```

The Shadex key must have `vtu:read`, `vtu:write`, and `orders:read` if order reconciliation/status checks are added.

## 4. Pages
- `dist/index.html` — customer app
- `dist/admin.html` — protected operations/admin dashboard

## 5. Important transaction behaviour
Customer wallet debit is atomic before the upstream purchase. Definite upstream 4xx rejection reverses the local debit. Upstream 5xx/uncertain responses stay pending rather than being refunded automatically, preventing a customer from receiving VTU value and a refund simultaneously.
