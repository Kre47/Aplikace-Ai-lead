import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import './App.css';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
const STORAGE_KEY = 'marek-consultation-v1';
const CHAT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_VISIBLE_MESSAGES = 100;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readSavedChat() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const saved = JSON.parse(raw);
        const expired = Number.isFinite(saved?.updatedAt) && Date.now() - saved.updatedAt > CHAT_TTL_MS;
        const invalid = !saved || !Number.isFinite(saved.updatedAt) || saved.updatedAt > Date.now() + 60_000
            || typeof saved.sessionId !== 'string' || !SESSION_ID_PATTERN.test(saved.sessionId) || !Array.isArray(saved.messages);
        if (expired || invalid) {
            localStorage.removeItem(STORAGE_KEY);
            return null;
        }
        return {
            sessionId: saved.sessionId,
            messages: saved.messages.filter((message) => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string'),
            isFinished: Boolean(saved.isFinished),
            handoffStatus: ['sent', 'failed', 'not_configured'].includes(saved.handoffStatus) ? saved.handoffStatus : null,
        };
    } catch {
        try { localStorage.removeItem(STORAGE_KEY); } catch { /* Storage may be disabled by the browser. */ }
        return null;
    }
}

function Arrow({ diagonal = false }) {
    return <span aria-hidden="true" className="arrow-mark">{diagonal ? '↗' : '→'}</span>;
}

function Brand({ light = false }) {
    return <a className={`brand${light ? ' brand-light' : ''}`} href="#domu" aria-label="Advela – úvodní stránka">
        <img src="/advela-logo.svg" alt="" />
    </a>;
}

function AdvelaMark() {
    return <svg className="advela-mark" viewBox="0 0 140 155" aria-hidden="true">
        <defs><linearGradient id="advela-mark-gradient" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor="#24c8ed" /><stop offset="1" stopColor="#a8ff4f" /></linearGradient></defs>
        <path d="M8 127C39 108 60 78 69 37c17 25 29 58 33 94-29-8-62-7-94-4Z" fill="none" stroke="url(#advela-mark-gradient)" strokeWidth="7" strokeLinejoin="round" />
        <path d="M16 116c26-20 44-46 54-78M9 141c33-12 65-17 102-10M39 112c23-21 38-46 46-77" fill="none" stroke="url(#advela-mark-gradient)" strokeWidth="5" strokeLinecap="round" />
        <path d="m91 8 5 12 13 1-10 8 3 13-11-7-11 7 3-13-10-8 13-1Z" fill="url(#advela-mark-gradient)" />
        <path d="m121 27 2 5 5 1-4 3 1 5-4-3-4 3 1-5-4-3 5-1Z" fill="#8fff72" />
        <circle cx="72" cy="14" r="3.5" fill="#53e7df" /><circle cx="117" cy="48" r="2.5" fill="#9eff62" />
    </svg>;
}

function Chat() {
    const [savedChat] = useState(readSavedChat);
    const [messages, setMessages] = useState(() => savedChat?.messages || []);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isFinished, setIsFinished] = useState(() => savedChat?.isFinished || false);
    const [handoffStatus, setHandoffStatus] = useState(() => savedChat?.handoffStatus || null);
    const [sendError, setSendError] = useState('');
    const [sessionId, setSessionId] = useState(() => savedChat?.sessionId || uuidv4());
    const messagesRef = useRef(null);
    const inputRef = useRef(null);
    const userMessageCount = messages.filter((message) => message.role === 'user').length;
    const currentStep = isFinished ? 3 : userMessageCount < 3 ? 1 : 2;

    useEffect(() => {
        const messageList = messagesRef.current;
        if (!messageList) return;
        messageList.scrollTo({ top: messageList.scrollHeight, behavior: 'smooth' });
    }, [messages, isLoading]);

    useEffect(() => {
        if (!inputRef.current) return;
        inputRef.current.style.height = 'auto';
        inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 132)}px`;
    }, [input]);

    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionId, messages, isFinished, handoffStatus, updatedAt: Date.now() }));
        } catch (error) {
            console.warn('Konverzaci se nepodařilo uložit v tomto prohlížeči.', error);
        }
    }, [sessionId, messages, isFinished, handoffStatus]);

    const sendMessage = async (event) => {
        event.preventDefault();
        if (!input.trim() || isLoading || isFinished) return;
        const userText = input.trim();
        setInput('');
        setSendError('');
        if (inputRef.current) inputRef.current.style.height = 'auto';
        setMessages((previous) => [...previous.slice(-(MAX_VISIBLE_MESSAGES - 1)), { role: 'user', content: userText }]);
        setIsLoading(true);
        try {
            const { data } = await axios.post(`${API_BASE_URL}/chat`, { sessionId, message: userText, resume: messages.length > 0 });
            setMessages((previous) => [...previous.slice(-(MAX_VISIBLE_MESSAGES - 1)), { role: 'assistant', content: data.reply }]);
            if (data.isReady) {
                setIsFinished(true);
                setHandoffStatus(data.handoffStatus || 'not_configured');
            }
        } catch (error) {
            console.error('Chyba odesílání:', error);
            const backendMessage = error.response?.data?.error || 'Omlouvám se, nastala technická chyba. Zkuste to prosím znovu.';
            setMessages((previous) => previous.at(-1)?.role === 'user' && previous.at(-1)?.content === userText ? previous.slice(0, -1) : previous);
            setInput(userText);
            setSendError(backendMessage);
        } finally {
            setIsLoading(false);
        }
    };

    const startNewConversation = () => {
        if (!isFinished && messages.length && !window.confirm('Začít novou konzultaci? Dosavadní konverzace se v tomto okně přestane zobrazovat.')) return;
        setSessionId(uuidv4()); setMessages([]); setInput(''); setIsFinished(false); setHandoffStatus(null); setSendError('');
        if (inputRef.current) inputRef.current.style.height = 'auto';
        inputRef.current?.focus();
    };

    const handleInputKeyDown = (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
        }
    };

    const chooseStarterPrompt = (prompt) => {
        setInput(prompt);
        inputRef.current?.focus({ preventScroll: true });
    };

    return <section className="consultation" id="konzultace" aria-labelledby="chat-title">
        <div className="consultation-copy">
            <div className="vela-portrait" aria-hidden="true"><span>V</span><i className="portrait-orbit orbit-a" /><i className="portrait-orbit orbit-b" /><i className="portrait-spark">✳</i></div>
            <div className="vela-intro">
                <span className="eyebrow eyebrow-light"><span className="eyebrow-dot" /> VAŠE AI PARŤAČKA PRO MARKETING</span>
                <h2 id="chat-title">Ahoj, já jsem <em>Vela.</em></h2>
                <p>Popište mi, kam chcete svůj byznys posunout. Doptám se na to důležité a pomůžu vám najít konkrétní další krok.</p>
                <div className="vela-expertise"><span>Strategie</span><span>Výkonnostní marketing</span><span>Automatizace</span></div>
            </div>
        </div>
        <div className="chat-card" role="region" aria-label="Online marketingová konzultace">
            <header className="chat-header">
                <div className="chat-person"><span className="person-avatar" aria-hidden="true">V</span><span><strong>Vela <span className="ai-badge">AI KONZULTANTKA</span></strong><small><i /> Advela · online</small></span></div>
                {messages.length > 0 && !isFinished && !isLoading && <button type="button" className="restart-button" onClick={startNewConversation}>Nový chat</button>}
                <div className="progress-track" role="group" aria-label={`Orientační průběh, krok ${currentStep} ze 3`}>
                    {['Vaše firma', 'Marketing', 'Doporučení'].map((label, index) => {
                        const step = index + 1;
                        return <div className={`progress-step ${step <= currentStep ? 'active' : ''} ${step === currentStep ? 'current' : ''}`} key={label}>
                            <span className="progress-number">{step < currentStep ? '✓' : step}</span><span>{label}</span>
                        </div>;
                    })}
                </div>
            </header>
            <div ref={messagesRef} className="messages" aria-live="polite" aria-relevant="additions text">
                {messages.length === 0 && <div className="empty-state">
                    <div className="welcome-orbit" aria-hidden="true">✳</div>
                    <p className="empty-title">Ahoj, jsem Vela. Co právě řešíte?</p>
                    <p className="empty-subtitle">Napište mi — společně najdeme další krok pro váš marketing.</p>
                    <div className="starter-prompts" aria-label="Návrhy na začátek chatu s Velou">{['Chci získat více zákazníků', 'Potřebuji rozjet e-shop', 'Chci zlepšit reklamu'].map((prompt) => <button className="starter-chip" key={prompt} type="button" onClick={() => chooseStarterPrompt(prompt)}>{prompt}<Arrow diagonal /></button>)}</div>
                </div>}
                {messages.map((msg, index) => <div className={`message-row ${msg.role}`} key={`${index}-${msg.role}`}>
                    {msg.role === 'assistant' && <div className="assistant-avatar" aria-hidden="true">V</div>}
                    <div className="message-bubble">{msg.content}</div>
                </div>)}
                {isLoading && <div className="message-row assistant"><div className="assistant-avatar" aria-hidden="true">V</div><div className="message-bubble typing"><span /><span /><span /><small>Vela píše…</small></div></div>}
            </div>
            {sendError && <p className="send-error" role="alert">{sendError}</p>}
            {isFinished && <div className="finished-panel" role="status"><div><strong>Konzultace je dokončená.</strong><span>{handoffStatus === 'sent' ? 'Podklady byly předány týmu Advela.' : handoffStatus === 'failed' ? 'Předání kontaktu se nezdařilo. Kontaktujte Advela přímo.' : 'Doporučení je připravené v tomto chatu; automatické předání kontaktu není nastavené.'}</span></div><button type="button" onClick={startNewConversation}>Nová konzultace</button></div>}
            <form className="composer" onSubmit={sendMessage}>
                <textarea ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={handleInputKeyDown} placeholder={isFinished ? 'Konverzace byla ukončena.' : 'Napište odpověď…'} aria-label="Napište odpověď" aria-describedby="composer-help" maxLength={4000} rows={1} disabled={isLoading || isFinished} />
                <button type="submit" disabled={isLoading || isFinished || !input.trim()}><span>Odeslat</span><span className="send-arrow" aria-hidden="true">↑</span></button>
            </form>
            <p className="privacy-note" id="composer-help">Enter odešle zprávu · Shift+Enter přidá řádek. Konverzace se ukládá v Supabase a tento prohlížeč ji obnoví po dobu 30 dnů. <a href="#soukromi">Jak nakládáme s údaji</a>.</p>
        </div>
    </section>;
}

const services = [
    { number: '01', title: 'Strategie, která drží směr', body: 'Najdeme, kde se ztrácí zákazníci, a nastavíme priority podle toho, co má pro vaše podnikání největší dopad.', tags: ['Strategie', 'Analýza'] },
    { number: '02', title: 'Výkon, který jde změřit', body: 'Propojíme reklamu, web a data. Rozpočet pak pracuje na cílech, které dávají smysl vašemu podnikání.', tags: ['Google & Meta', 'Optimalizace'] },
    { number: '03', title: 'Zákazníci, kteří se vracejí', body: 'Vytvoříme návaznost přes e-mail a automatizace, aby dobrá zkušenost nekončila první objednávkou.', tags: ['E-mailing', 'Automatizace'] },
];

const steps = [
    { number: '01', title: 'Poznáme váš byznys', text: 'Začneme cíli, zákazníky a tím, co už dnes funguje.' },
    { number: '02', title: 'Najdeme příležitost', text: 'Prověříme web, kampaně i cestu od prvního kliknutí k objednávce.' },
    { number: '03', title: 'Navrhneme další krok', text: 'Dostanete konkrétní doporučení a rozpočet odpovídající vašim ambicím.' },
];

export default function App() {
    const [menuOpen, setMenuOpen] = useState(false);
    useLayoutEffect(() => {
        const previousScrollRestoration = window.history.scrollRestoration;
        const root = document.documentElement;
        const previousScrollBehavior = root.style.scrollBehavior;
        window.history.scrollRestoration = 'manual';

        if (window.location.hash) {
            window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
        }

        root.style.scrollBehavior = 'auto';
        window.scrollTo(0, 0);
        const frame = window.requestAnimationFrame(() => {
            root.style.scrollBehavior = previousScrollBehavior;
        });

        return () => {
            window.cancelAnimationFrame(frame);
            root.style.scrollBehavior = previousScrollBehavior;
            window.history.scrollRestoration = previousScrollRestoration;
        };
    }, []);

    useEffect(() => {
        document.title = 'Advela — Marketing, který posouvá byznys';
        const description = document.querySelector('meta[name="description"]');
        description?.setAttribute('content', 'Pomáháme menším a středním firmám růst díky chytré strategii, výkonnostnímu marketingu a automatizaci.');
    }, []);

    return <div className="site-shell" id="domu">
        <header className="site-header">
            <div className="header-inner"><Brand />
                <button className="menu-toggle" type="button" aria-expanded={menuOpen} aria-label={menuOpen ? 'Zavřít navigaci' : 'Otevřít navigaci'} onClick={() => setMenuOpen(!menuOpen)}><span /><span /></button>
                <nav className={menuOpen ? 'nav-open' : ''} aria-label="Hlavní navigace" onClick={() => setMenuOpen(false)}><a href="#sluzby">Co děláme</a><a href="#postup">Jak pracujeme</a><a href="#o-nas">O nás</a><a className="nav-cta" href="#konzultace">Chatovat s Velou <Arrow diagonal /></a></nav>
            </div>
        </header>

        <main>
            <section className="hero">
                <div className="hero-inner">
                    <div className="hero-copy"><span className="eyebrow"><span className="eyebrow-dot" /> MARKETINGOVÝ PARTNER PRO VÁŠ RŮST</span>
                        <h1>Víc než marketing.<br /><em>Skutečný posun.</em></h1>
                        <p className="hero-lead">Pomáháme dobrým firmám růst. Propojíme strategii, reklamu a automatizaci do jednoho funkčního celku.</p>
                        <div className="hero-actions"><a className="button button-dark" href="#konzultace">Chatovat s Velou <Arrow diagonal /></a><a className="text-link" href="#postup">Poznat náš přístup <Arrow /></a></div>
                        <div className="hero-note"><div className="avatar-stack" aria-hidden="true"><span>T</span><span>F</span><span>+</span></div><span>Osobní přístup. Jasné priority.<br /><strong>Žádné marketingové kouzlení.</strong></span></div>
                    </div>
                    <div className="hero-art" role="img" aria-label="Ilustrace propojených marketingových kanálů">
                        <div className="art-grid" />
                        <div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" />
                        <div className="art-center"><AdvelaMark /><small>VÁŠ BYZNYS</small><strong>Roste<br />s plánem.</strong><span className="art-spark">✳</span></div>
                        <div className="art-label label-strategy"><span>✦</span><small>STRATEGIE</small></div><div className="art-label label-ads"><span>↗</span><small>REKLAMA</small></div><div className="art-label label-data"><span>⌁</span><small>DATA</small></div>
                        <div className="art-caption"><span className="pulse-dot" /> JEDEN SMĚR. LEPŠÍ VÝSLEDKY.</div>
                    </div>
                </div>
                <div className="hero-bottom"><span>PRO FIRMY, KTERÉ CHTĚJÍ RŮST</span><span className="bottom-line" /><span>STRATEGIE <b>·</b> VÝKON <b>·</b> VZTAHY</span></div>
            </section>

            <section className="intro section-pad" id="o-nas"><div className="section-kicker">01 / PARTNERSTVÍ</div><div className="intro-grid"><h2>Marketing má<br />pracovat <em>pro vás.</em></h2><div className="intro-copy"><p>Neprodáváme univerzální balíčky. Nejprve pochopíme váš byznys, pak hledáme, co mu pomůže růst — od prvního kliknutí až po další objednávku.</p><a href="#postup" className="text-link">Takhle nad marketingem přemýšlíme <Arrow /></a></div></div></section>

            <section className="services section-pad" id="sluzby"><div className="section-heading"><div><div className="section-kicker">02 / CO DĚLÁME</div><h2>Vše do sebe<br /><em>musí zapadat.</em></h2></div><p>Silný marketing není součet nástrojů. Je to promyšlená cesta, na které každý krok podporuje ten další.</p></div>
                <div className="service-grid">{services.map((service) => <article className="service-card" key={service.number}><div className="service-top"><span>{service.number}</span><span className="service-icon" aria-hidden="true">{service.number === '01' ? '↗' : service.number === '02' ? '⌁' : '✳'}</span></div><h3>{service.title}</h3><p>{service.body}</p><div className="service-tags">{service.tags.map((tag) => <span key={tag}>{tag}</span>)}</div></article>)}</div>
            </section>

            <section className="process section-pad" id="postup"><div className="process-head"><div className="section-kicker">03 / JASNÝ POSTUP</div><h2>Nejdřív pochopit.<br /><em>Pak rozhýbat.</em></h2><p>Každé partnerství začíná dobrými otázkami. Odpovědi nám pomohou ukázat, kde leží vaše největší příležitost.</p></div><div className="step-list">{steps.map((step) => <article className="step-row" key={step.number}><span className="step-number">{step.number}</span><h3>{step.title}</h3><p>{step.text}</p><Arrow diagonal /></article>)}</div></section>

            <Chat />

            <section className="faq section-pad" id="soukromi"><div className="section-heading"><div><div className="section-kicker">04 / DOBRÉ VĚDĚT</div><h2>Otázky, které<br /><em>dávají smysl.</em></h2></div><p>Radši jasno hned na začátku. Tady jsou odpovědi na to, na co se nás ptáte nejčastěji.</p></div><div className="faq-list">
                <details><summary>Kolik spolupráce stojí?<span>+</span></summary><p>Rozsah se odvíjí od vašich cílů a situace. Orientačně začíná průběžná spolupráce na 15&nbsp;000 Kč měsíčně; rozvoj kampaní a automatizací obvykle na 30&nbsp;000 Kč měsíčně. Přesnější návrh připravíme až po poznání vašeho podnikání.</p></details>
                <details><summary>Musím se po konzultaci k něčemu zavázat?<span>+</span></summary><p>Ne. Úvodní rozhovor slouží k tomu, abychom zjistili, zda vám umíme pomoci. Návrh i navazující konzultace jsou nezávazné.</p></details>
                <details><summary>Kdo je Vela a s kým si v chatu píšu?<span>+</span></summary><p>Vela je AI konzultační asistentka Advely, která pomáhá připravit podklady pro konzultaci s Markem. Píšete si přímo s Velou, ne s člověkem. Zprávy se zpracovávají přes OpenAI a ukládají v Supabase i ve vašem prohlížeči; historie se po 30 dnech neaktivity automaticky maže. Pokud je automatické předání nastavené, Vela si před dokončením vyžádá e-mail nebo telefon pro zaslání doporučení a navázání na konzultaci. Týmu přes Make.com odejde pouze finální doporučení a zadaný kontakt — ne celá historie chatu. Nezadávejte citlivé osobní ani finanční údaje.</p></details>
            </div></section>

            <section className="closing"><div className="closing-inner"><span className="eyebrow eyebrow-light"><span className="eyebrow-dot" /> VELA JE PŘIPRAVENÁ SI S VÁMI POVÍDAT</span><h2>Řekněte Vele,<br /><em>kam se chcete posunout.</em></h2><p>Začněte chat. Vela se zeptá na váš byznys a pomůže vám najít směr pro další růst.</p><a className="button button-lime" href="#konzultace">Začít chatovat s Velou <Arrow diagonal /></a></div><span className="closing-mark" aria-hidden="true">✳</span></section>
        </main>

        <footer className="site-footer"><div className="footer-main"><Brand light /><p>Marketing, který dává vašemu růstu směr.</p><a href="#konzultace">Napište Vele <Arrow diagonal /></a></div><div className="footer-bottom"><span>© {new Date().getFullYear()} Advela</span><span>Strategie. Výkon. Dlouhodobý růst.</span><a href="#soukromi">Soukromí a práce s údaji</a></div></footer>
    </div>;
}
