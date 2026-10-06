# Nastavení Supabase

1. Vytvořte projekt v Supabase.
2. Otevřete **SQL Editor** a spusťte celý obsah souboru [`supabase/schema.sql`](./supabase/schema.sql). Skript nastaví RLS, omezí přístup klientských rolí a vytvoří atomické limity požadavků a zámky konverzací pro více instancí serveru. Po změně schématu spusťte aktualizovaný skript znovu.
3. V **Project Connect** zkopírujte Project URL a v **Settings → API Keys** vytvořte serverový `Secret key` (`sb_secret_...`). Nepoužívejte publishable key pro server a secret key nikdy nevkládejte do frontendu.
4. Do lokálního `.env` doplňte:

   ```env
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SECRET_KEY=sb_secret_...
   ```

5. Restartujte `npm run dev`.

Backend ukládá aktivní konverzace do `public.chat_sessions`. Relace vyprší po 30 dnech neaktivity a běžící backend průběžně odstraňuje expirované řádky každých 10 minut. Frontend ukládá kopii chatové historie v prohlížeči na stejnou dobu a při návratu odstraní expirovanou kopii. Tabulky mají zapnuté RLS a klientské role k nim nemají přístup; Supabase secret key používá pouze Express server.

`CORS_ORIGIN` je nutné nastavit na adresu frontendové stránky, pokud produkční frontend volá backend přímo z jiné domény. Při lokálním vývoji jde `/api` přes Vite proxy.

Volitelně nastavte `TRUST_PROXY_HOPS` na přesný počet důvěryhodných proxy před Express serverem; bez proxy tuto proměnnou nechte vypnutou. `ENABLE_HSTS=true` zapněte pouze pokud veřejná doména vždy používá HTTPS.

Po dokončení konzultace webhook Make.com dostane pouze omezený JSON payload `{ recommendation, contact: { email, phone } }`; celá historie chatu ani ID relace se do webhooku neposílají. Upravte mapování svého Make scénáře na tato pole. Pokud používáte samostatnou produkční doménu backendu, nastavte `CORS_ORIGIN` na přesnou doménu webu a `VITE_API_BASE_URL` při sestavení frontendu na HTTPS adresu API.

Produkční sestavení přidává Content Security Policy; serverové API také posílá bezpečnostní hlavičky. Při hostování statických souborů nastavte na hostingu hlavičky `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` a `Permissions-Policy` (Vite Preview je nastavuje samo). Zapněte HSTS na hostingové vrstvě, pokud doména běží výhradně přes HTTPS.
