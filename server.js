import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { OpenAI } from 'openai';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

dotenv.config();

const SYSTEM_PROMPT = `
## 1. Identity
You are Vela, the AI marketing consultation assistant for Marek at Advela.
You help small and medium enterprises (SMEs) get their marketing and sales moving, and
prepare a useful first recommendation for a consultation with Marek. You act as a hybrid
of a business auditor, solution architect, and advisor.

You're talking to clients, not friends:
- ALWAYS use formal/polite address (never casual, even if the client is casual with you).
- Introduce yourself as Vela, Marek's AI consultation assistant. Be transparent that
  you are an automated assistant. Never claim to be Marek or a human. If asked directly,
  answer plainly that you are an AI assistant helping prepare the consultation.
- Avoid typical AI phrasing ("As an AI...", "I'd be happy to help you with...",
  "Here's an overview:", excessive emoji, perfectly uniform bullet lists for everything).
- Write like a courteous, down-to-earth person in a business chat: short sentences,
  natural language, no overfamiliarity, but no stiff bureaucratic tone either. Be direct
  and pragmatic, no unnecessary jargon.
- If someone asks whether you're an AI, answer plainly and naturally.

## 2. Ecosystem you understand
CMS/e-commerce: WordPress, Shopify.
Ads/social: Meta Ads, Instagram Ads, Google Ads, TikTok Ads, LinkedIn.
Email/CRM: Mailchimp, Klaviyo, Brevo, ActiveCampaign, HubSpot.
Automation: Make.com, n8n, Zapier, REST API.

## 3. Interaction rule (critical)
Do not ask everything at once. In each message ask only 1 to 2 targeted questions,
wait for the client's answer, then continue. Never a long form.

## 4. Phase 1 — Information gathering
Introduce yourself as Vela, Marek's online assistant, up front (once, briefly, politely)
and immediately ask the first 1-2 questions (company name and industry). Gradually find out:
1. Business profile: company name, industry/niche, target location.
2. Current setup: website/e-shop platform (WordPress/Shopify/custom/none), active ad
    channels (Meta/Google/none), email marketing tool.
3. Goal and budget: main objective (leads, e-commerce sales, brand awareness) and
    approximate monthly marketing budget.

{{CONTACT_HANDOFF_GUIDANCE}}

## 5. Phase 2 — Audit and recommendation
Evaluate the inputs and assign the client to a scenario:
- **Scenario A (Foundational Build):** weak/missing website + no active ads
  → website build (WordPress/Shopify) + email sequences + pilot Meta Ads campaign.
- **Scenario B (Performance Scaling):** functional website with existing traffic/ads
  → conversion optimization + Meta Ads retargeting + email automation
  (Klaviyo/Brevo/Make.com).
- **Scenario C (High-Value / Regional Lead):** budget over 50,000 CZK/month (or
  equivalent local currency) OR complex/non-standard requirements → prepare a brief
  handoff summary for a regional specialist for a personal consultation, instead of
  a generic package.

## 6. Pricing framework
- Starter retainer (setup & maintenance): ~15,000–25,000 CZK/month (or equivalent).
- Growth retainer (active campaign management + automation): ~30,000–50,000 CZK/month.
- Enterprise / custom: handled individually via regional consultation (Scenario C).

## 7. Final summary — format (SHORT, 6-10 lines, not an essay)
1. **What I see** — 1-2 sentences on the main gap/opportunity.
2. **What I'd do** — which scenario/scope of work (A/B/C) and why, in one sentence.
3. **Pricing** — Month 1 (setup) vs. Month 2+ (ongoing), estimate per the pricing
    framework (for Scenario C: note that the regional specialist will confirm pricing).
4. **Next step** — {{FINAL_NEXT_STEP_GUIDANCE}}

No extra fluff, no "Hope this helps" at the end.

## 8. Technical marker (for the UI, not the client)
Once the final summary (all 4 blocks) is complete in the current message, append to the
very end of the message, on a new line, exactly and only: ##READY##
Never use this string in any other message. The client must never see it.
`.trim();

export const sessions = Object.create(null);
const sessionActivity = new Map();
const completedSessions = new Map();
const activeSessions = new Set();

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MEMORY_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 500;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_MESSAGES = 31;
const IP_RATE_LIMIT = 120;
const SESSION_RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 1000;
const SESSION_LOCK_SECONDS = 180;
const DATABASE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

function extractContactDetails(messages) {
  const contact = { email: null, phone: null };
  for (const item of messages) {
    if (item?.role !== 'user' || typeof item.content !== 'string') continue;
    contact.email ||= item.content.match(EMAIL_PATTERN)?.[0] ?? null;
    if (!contact.phone) {
      const candidates = item.content.match(/(?:\+|\d)[\d\s()./-]{7,}\d/g) || [];
      const validPhone = candidates.find((candidate) => {
        const digitCount = candidate.replace(/\D/g, '').length;
        return digitCount >= 9 && digitCount <= 15;
      });
      contact.phone = validPhone?.trim() ?? null;
    }
  }
  return contact;
}

function hasValidHandoffContext(messages, contact) {
  if (!contact.email && !contact.phone) return false;
  const userTurnCount = messages.filter((item) => item?.role === 'user').length;
  if (userTurnCount < 3) return false;

  const contactMessageIndexes = messages.flatMap((item, index) => {
    if (item?.role !== 'user' || typeof item.content !== 'string') return [];
    const hasEmail = EMAIL_PATTERN.test(item.content);
    const hasPhone = Boolean(extractContactDetails([item]).phone);
    return hasEmail || hasPhone ? [index] : [];
  });

  return contactMessageIndexes.some((index) => {
    const assistantContext = messages.slice(0, index)
      .filter((item) => item?.role === 'assistant')
      .map((item) => item.content)
      .join('\n')
      .toLocaleLowerCase('cs-CZ');
    const mentionedContact = /e[ -]?mail|telefon/.test(assistantContext);
    const explainedPurpose = /návrh|poslat|zaslat|navázat|konzultac|kontaktovat/.test(assistantContext);
    return mentionedContact && explainedPurpose;
  });
}

function hashRateLimitKey(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function consumePersistentRateLimit(supabase, bucketKey, limit) {
  try {
    const { data, error } = await supabase.rpc('consume_chat_rate_limit', {
      p_bucket_key: hashRateLimitKey(bucketKey),
      p_limit: limit,
      p_window_seconds: RATE_WINDOW_MS / 1000,
    });
    if (error || typeof data !== 'boolean') return { allowed: false, error };
    return { allowed: data, error: null };
  } catch (error) {
    return { allowed: false, error };
  }
}

function cleanupExpiredSessions(now = Date.now()) {
  for (const [id, lastActive] of sessionActivity) {
    if (now - lastActive > MEMORY_CACHE_TTL_MS && !activeSessions.has(id)) {
      delete sessions[id];
      sessionActivity.delete(id);
      completedSessions.delete(id);
    }
  }
}

const cleanupTimer = setInterval(cleanupExpiredSessions, 10 * 60 * 1000);
cleanupTimer.unref?.();

const normalizeEnvValue = (value) => (value == null ? '' : String(value).trim());

async function safeSupabaseQuery(runQuery) {
  try {
    return await runQuery();
  } catch (error) {
    return { data: null, error };
  }
}

export function createApp({
  openaiClient = null,
  supabaseClient = null,
  makeWebhookUrl = normalizeEnvValue(process.env.MAKE_WEBHOOK_URL) || null,
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS);
  if (Number.isInteger(trustProxyHops) && trustProxyHops > 0 && trustProxyHops <= 5) {
    app.set('trust proxy', trustProxyHops);
  }
  const apiKey = normalizeEnvValue(process.env.OPENAI_API_KEY);
  const client = openaiClient ?? (apiKey ? new OpenAI({ apiKey, timeout: 60_000 }) : null);
  const supabaseUrl = normalizeEnvValue(process.env.SUPABASE_URL);
  const supabaseSecretKey = normalizeEnvValue(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
  const supabase = supabaseClient ?? (supabaseUrl && supabaseSecretKey
    ? createClient(supabaseUrl, supabaseSecretKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    : null);
  let lastDatabaseCleanup = 0;
  let databaseCleanupInProgress = false;
  const cleanupExpiredDatabaseData = async (now = Date.now()) => {
    if (!supabase || databaseCleanupInProgress || now - lastDatabaseCleanup < DATABASE_CLEANUP_INTERVAL_MS) return;
    lastDatabaseCleanup = now;
    databaseCleanupInProgress = true;
    try {
      const cleanupResults = await Promise.all([
        safeSupabaseQuery(() => supabase.from('chat_sessions').delete().lt('expires_at', new Date(now).toISOString())),
        safeSupabaseQuery(() => supabase.from('chat_rate_limits').delete().lt('expires_at', new Date(now).toISOString())),
        safeSupabaseQuery(() => supabase.from('chat_session_locks').delete().lt('expires_at', new Date(now).toISOString())),
      ]);
      for (const { error } of cleanupResults) {
        if (error) console.error('Úklid expirovaných dat se nezdařil. Kód:', error.code || 'neznámý');
      }
    } finally {
      databaseCleanupInProgress = false;
    }
  };
  if (supabase) {
    const databaseCleanupTimer = setInterval(() => {
      void cleanupExpiredDatabaseData().catch((error) => {
        console.error('Pravidelný úklid databáze selhal. Kód:', error.code || 'neznámý');
      });
    }, DATABASE_CLEANUP_INTERVAL_MS);
    databaseCleanupTimer.unref?.();
  }
  const systemPrompt = SYSTEM_PROMPT
    .replace('{{CONTACT_HANDOFF_GUIDANCE}}', makeWebhookUrl
      ? 'Before moving to Phase 2, briefly explain that the client can share an email or phone number so the team can send the proposal and follow up about the consultation. Ask for that contact, and do not proceed without it. Do not imply the contact is needed for any unrelated purpose. Once points 1-3 and contact information are available, naturally signal the transition to the proposal and continue to Phase 2.'
      : 'Do not ask for or encourage sharing contact details. Once you have enough information from points 1-3, naturally signal the transition and prepare a useful recommendation in this chat. Do not promise an email or human follow-up.')
    .replace('{{FINAL_NEXT_STEP_GUIDANCE}}', makeWebhookUrl
      ? 'one clear call to action, and say the team will follow up using the contact the client provided.'
      : 'one practical action the client can take, and say the recommendation is available in this chat with no automated follow-up.');
  const allowedOrigins = normalizeEnvValue(process.env.CORS_ORIGIN)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (process.env.ENABLE_HSTS === 'true' && req.secure) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });
  app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : false }));
  app.use(express.json({ limit: '16kb' }));
  app.use((error, _req, res, next) => {
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Požadavek je příliš velký.' });
    }
    if (error instanceof SyntaxError && error.status === 400) {
      return res.status(400).json({ error: 'Požadavek nemá platný formát JSON.' });
    }
    return next(error);
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', database: supabase ? 'configured' : 'not_configured' });
  });

  app.post('/api/chat', async (req, res) => {
    const { sessionId, message, resume = false } = req.body ?? {};

    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId) || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Chybí sessionId nebo message' });
    }
    if (typeof resume !== 'boolean') {
      return res.status(400).json({ error: 'Neplatný stav konverzace.' });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(413).json({ error: `Zpráva může mít nejvýše ${MAX_MESSAGE_LENGTH} znaků.` });
    }

    const now = Date.now();
    cleanupExpiredSessions(now);

    if (completedSessions.has(sessionId)) {
      return res.status(409).json({ error: 'Tato konverzace již byla dokončena.' });
    }
    if (activeSessions.has(sessionId)) {
      return res.status(409).json({ error: 'Zpráva se právě zpracovává. Počkejte prosím na odpověď.' });
    }

    if (!client || !client.apiKey) {
      return res.status(503).json({
        error: 'Chybí OPENAI_API_KEY. Nastav ho v .env nebo v prostředí.',
      });
    }

    if (!supabase) {
      return res.status(503).json({
        error: 'Chybí konfigurace Supabase. Nastavte SUPABASE_URL a SUPABASE_SECRET_KEY v prostředí serveru.',
      });
    }

    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const ipLimit = await consumePersistentRateLimit(supabase, `ip:${ip}`, IP_RATE_LIMIT);
    if (ipLimit.error) {
      console.error('Sdílený limit požadavků není dostupný. Kód:', ipLimit.error.code || 'neznámý');
      return res.status(503).json({ error: 'Chat je dočasně nedostupný. Zkuste to prosím za chvíli.' });
    }
    if (!ipLimit.allowed) {
      return res.status(429).json({ error: 'Z tohoto připojení přichází příliš mnoho požadavků. Chvíli počkejte a zkuste to znovu.' });
    }

    const sessionLimit = await consumePersistentRateLimit(supabase, `session:${sessionId}`, SESSION_RATE_LIMIT);
    if (sessionLimit.error) {
      console.error('Sdílený limit konverzace není dostupný. Kód:', sessionLimit.error.code || 'neznámý');
      return res.status(503).json({ error: 'Chat je dočasně nedostupný. Zkuste to prosím za chvíli.' });
    }
    if (!sessionLimit.allowed) {
      return res.status(429).json({ error: 'Posíláte zprávy příliš rychle. Chvíli počkejte a zkuste to znovu.' });
    }

    const lockToken = randomUUID();
    const { data: lockAcquired, error: lockError } = await safeSupabaseQuery(() => supabase.rpc('acquire_chat_session_lock', {
      p_session_id: sessionId,
      p_lock_token: lockToken,
      p_lease_seconds: SESSION_LOCK_SECONDS,
    }));
    if (lockError || typeof lockAcquired !== 'boolean') {
      console.error('Zámek konverzace není dostupný. Kód:', lockError?.code || 'neznámý');
      return res.status(503).json({ error: 'Chat je dočasně nedostupný. Zkuste to prosím za chvíli.' });
    }
    if (!lockAcquired) {
      return res.status(409).json({ error: 'Zpráva se právě zpracovává. Počkejte prosím na odpověď.' });
    }

    activeSessions.add(sessionId);
    let history = null;
    let previousHistory = [];
    try {
      await cleanupExpiredDatabaseData(now);

      // Always reload the durable history after taking the shared lock; another server
      // instance may have handled this conversation since our in-memory cache was updated.
      delete sessions[sessionId];
      const { data: storedSession, error: loadError } = await safeSupabaseQuery(() => supabase
        .from('chat_sessions')
        .select('messages, status, handoff_status, expires_at')
        .eq('session_id', sessionId)
        .maybeSingle());
      if (loadError) {
        console.error('Načtení Supabase session se nezdařilo. Kód:', loadError.code || 'neznámý');
        return res.status(503).json({ error: 'Nepodařilo se načíst konverzaci z databáze. Zkuste to prosím znovu.' });
      }

      let activeStoredSession = storedSession;
      if (activeStoredSession && Date.parse(activeStoredSession.expires_at) <= now) {
        const { error: deleteError } = await safeSupabaseQuery(() => supabase.from('chat_sessions').delete().eq('session_id', sessionId));
        if (deleteError) {
          console.error('Odstranění expirované Supabase session se nezdařilo. Kód:', deleteError.code || 'neznámý');
          return res.status(503).json({ error: 'Historii se nepodařilo bezpečně obnovit. Zkuste to prosím znovu.' });
        }
        activeStoredSession = null;
      }
      if (!activeStoredSession && resume) {
        return res.status(410).json({ error: 'Historie této konverzace už není dostupná v databázi. Začněte prosím novou konzultaci.' });
      }
      if (activeStoredSession) {
        if (!Array.isArray(activeStoredSession.messages)
          || activeStoredSession.messages.length < 1
          || activeStoredSession.messages.length > MAX_MESSAGES
          || activeStoredSession.messages[0]?.role !== 'system'
          || activeStoredSession.messages.some((item, index) =>
            !item || (index === 0 ? item.role !== 'system' : !['user', 'assistant'].includes(item.role))
            || typeof item.content !== 'string' || item.content.length > 20_000
          )) {
          console.error('Supabase session obsahuje neplatná data.');
          return res.status(500).json({ error: 'Uložená konverzace má neplatný formát.' });
        }
        if (activeStoredSession.status === 'completed') {
          completedSessions.set(sessionId, now);
          return res.status(409).json({ error: 'Tato konverzace již byla dokončena.' });
        }
        history = activeStoredSession.messages;
      }

      if (!history) {
        if (sessionActivity.size >= MAX_SESSIONS) {
          const oldest = [...sessionActivity.entries()].sort((a, b) => a[1] - b[1]).find(([id]) => !activeSessions.has(id));
          if (oldest) {
            delete sessions[oldest[0]];
            sessionActivity.delete(oldest[0]);
            completedSessions.delete(oldest[0]);
          } else {
            return res.status(503).json({ error: 'Chat je momentálně vytížený. Zkuste to prosím za chvíli.' });
          }
        }
        history = [{ role: 'system', content: systemPrompt }];
      }

      sessions[sessionId] = history;
      sessionActivity.set(sessionId, now);
      previousHistory = history.slice();
      history.push({ role: 'user', content: message.trim() });
      // Keep the system instructions and a bounded recent history to limit memory and token growth.
      if (history.length > MAX_MESSAGES) history.splice(1, history.length - MAX_MESSAGES);

      try {
      const completion = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: history,
        temperature: 0.7,
      });

      const modelReply = completion.choices[0]?.message?.content;
      let reply = typeof modelReply === 'string' ? modelReply : 'Omlouvám se, nepodařilo se vygenerovat odpověď.';
      const modelSignaledReady = reply.includes('##READY##');
      const contact = extractContactDetails(history);
      const hasContact = Boolean(contact.email || contact.phone);
      const isReady = modelSignaledReady && (!makeWebhookUrl || hasValidHandoffContext(history, contact));
      let handoffStatus = 'not_configured';

      if (modelSignaledReady) {
        reply = reply.replace(/##READY##/g, '').trim();
      }
      if (modelSignaledReady && !isReady) {
        reply = hasContact
          ? 'Děkuji, kontakt mám. Ještě mi prosím napište, jaký je váš hlavní cíl marketingu a jaký měsíční rozpočet zvažujete. Potom připravím doporučení.'
          : 'Ještě než pro vás připravím finální doporučení, pošlete mi prosím e-mail nebo telefon, na který jej mohu poslat.';
      }

      history.push({ role: 'assistant', content: reply });
      handoffStatus = isReady ? (makeWebhookUrl ? 'pending' : 'not_configured') : null;
      const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
      const { error: saveError } = await safeSupabaseQuery(() => supabase.from('chat_sessions').upsert({
        session_id: sessionId,
        messages: history,
        status: isReady ? 'completed' : 'active',
        handoff_status: handoffStatus,
        expires_at: expiresAt,
        updated_at: new Date(now).toISOString(),
      }, { onConflict: 'session_id' }));
      if (saveError) {
        const persistenceError = new Error('Nepodařilo se uložit konverzaci do Supabase.');
        persistenceError.isPersistenceError = true;
        persistenceError.cause = saveError;
        throw persistenceError;
      }
      sessionActivity.set(sessionId, now);

      if (isReady) {
        completedSessions.set(sessionId, now);
        if (makeWebhookUrl) {
          try {
            await axios.post(makeWebhookUrl, {
              recommendation: reply,
              contact,
            }, { timeout: 10_000, maxRedirects: 0 });
            handoffStatus = 'sent';
            console.log('[ACTION] Dokončená konzultace byla předána do Make.com.');
          } catch (err) {
            handoffStatus = 'failed';
            reply += '\n\nPředání kontaktu do týmu se technicky nezdařilo. Pro jistotu kontaktujte Advela přímo.';
            history[history.length - 1].content = reply;
            console.error('Předání do Make.com se nezdařilo. HTTP status:', err.response?.status || 'nedostupný');
          }
          const { error: handoffSaveError } = await safeSupabaseQuery(() => supabase.from('chat_sessions').update({
            messages: history,
            handoff_status: handoffStatus,
            updated_at: new Date().toISOString(),
          }).eq('session_id', sessionId));
          if (handoffSaveError) console.error('Uložení stavu předání do Supabase se nezdařilo. Kód:', handoffSaveError.code || 'neznámý');
        }
      }

      return res.json({ reply, isReady, handoffStatus: isReady ? handoffStatus : null });
      } catch (error) {
        // Restore the last durable state so a retry does not duplicate the failed request.
        history.splice(0, history.length, ...previousHistory);
        const status = error.status || error.response?.status || 500;
        const responseData = error.response?.data;
        const openAiMessage = responseData?.error?.message || responseData?.message || error.message || 'Chyba při komunikaci s AI';
        const text = String(openAiMessage).toLowerCase();
        const isQuotaError = text.includes('no credits remaining') || text.includes('insufficient_quota') || text.includes('quota');
        const isProviderRateLimit = status === 429 && !isQuotaError;

        console.error('Chyba OpenAI API, HTTP status:', status);
        return res.status(isQuotaError || isProviderRateLimit ? 429 : 500).json({
          error: error.isPersistenceError
            ? 'Nepodařilo se bezpečně uložit konverzaci do databáze. Zkuste zprávu odeslat znovu.'
            : isQuotaError
              ? 'OpenAI účet nemá dostatek kreditů. Přidejte kredity v OpenAI dashboardu a zkuste to znovu.'
              : isProviderRateLimit
                ? 'AI služba teď dostává příliš mnoho požadavků. Chvíli počkejte a zkuste to znovu.'
              : 'Chyba při komunikaci s AI',
        });
      }
    } finally {
      activeSessions.delete(sessionId);
      const { error: releaseError } = await safeSupabaseQuery(() => supabase.rpc('release_chat_session_lock', {
        p_session_id: sessionId,
        p_lock_token: lockToken,
      }));
      if (releaseError) console.error('Uvolnění zámku konverzace se nezdařilo. Kód:', releaseError.code || 'neznámý');
    }
  });

  return app;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const app = createApp();
  const port = Number(process.env.PORT) || 3001;

  app.listen(port, () => {
    console.log(`Backend běží na portu ${port}`);
  });
}
