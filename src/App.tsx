import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, BookOpen, Check, ChevronDown, Clock3, ExternalLink, Feather, Globe2, LoaderCircle, LockKeyhole, MessageCircle, Plus, RefreshCw, Settings2, ShieldCheck, Square, X } from 'lucide-react';
import { Message } from './components/Message';
import { SettingsPanel } from './components/SettingsPanel';
import { activeTab, inExtension, isPreview, loadSession, loadSettings, PageAccessError, readArticle, requestPageAccess, requestProviderAccess, saveSession, saveSettings } from './lib/browser';
import { defaultSettings, isLocalProvider, LANGUAGES, LENGTHS, PROVIDERS, validateProvider } from './lib/settings';
import { prepareInput, summaryInstruction, summaryLabel } from './lib/prompts';
import type { Article, ChatMessage, Settings, Theme } from './lib/types';
import { useTheme } from './lib/theme';
import { generate } from './providers';
import { credentials, lockVault } from './lib/vault';
import { VaultBoundary } from './components/VaultBoundary';
import { t, useInterfaceLanguage, useTranslation } from './lib/i18n';
import type { VaultPasswordChange } from './components/SettingsPanel';

const panelInstance = crypto.randomUUID();

export function App() {
  useEffect(() => {
    if (!inExtension) return;
    chrome.tabs.getCurrent(tab => {
      if (chrome.runtime.lastError || tab) return;
      chrome.windows.getCurrent(current => {
        if (chrome.runtime.lastError || current.id === undefined) return;
        // A unique fragment lets the worker identify this live native panel
        // even when Chromium omits its documentId/windowId from message senders.
        history.replaceState(null, '', `#panel-${panelInstance}`);
        void chrome.runtime.sendMessage({ type: 'REGISTER_SIDE_PANEL', windowId: current.id, instance: panelInstance }).catch(() => {});
      });
    });
    // Chrome versions before sidePanel.close() close their own panel document.
    // Only the native panel in the requested window may handle this message;
    // opening sidepanel.html in a regular tab must not make that tab close.
    const closePanel = (message: { type?: string; windowId?: number }, sender: chrome.runtime.MessageSender) => {
      if (sender.id !== chrome.runtime.id || sender.tab || message.type !== 'CLOSE_SIDE_PANEL') return;
      chrome.windows.getCurrent(current => {
        if (chrome.runtime.lastError || current.id !== message.windowId) return;
        chrome.tabs.getCurrent(tab => {
          if (chrome.runtime.lastError || tab) return;
          lockVault(false); window.close();
        });
      });
    };
    chrome.runtime.onMessage.addListener(closePanel);
    return () => chrome.runtime.onMessage.removeListener(closePanel);
  }, []);
  if (!inExtension && !isPreview) return <div className="install-message"><Feather size={32} /><h1>Save My Time</h1><p>{t("Load the")}{' '}<code>dist</code>{' '}{t("folder as an unpacked extension in Chrome or Brave, then open an article and click the extension icon.")}</p></div>;
  return <VaultBoundary><ReaderApp /></VaultBoundary>;
}

function ReaderApp() {
  useTranslation();
  const [settings, setSettings] = useState(defaultSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [themePreview, setThemePreview] = useState<Theme | null>(null);
  const [languagePreview, setLanguagePreview] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [article, setArticle] = useState<Article | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [reading, setReading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState('');
  const [needsPageAccess, setNeedsPageAccess] = useState(false);
  const [requestingAccess, setRequestingAccess] = useState(false);
  const [accessHelp, setAccessHelp] = useState('');
  const [error, setError] = useState('');
  const [storageNotice, setStorageNotice] = useState('');
  const [notices, setNotices] = useState<string[]>([]);
  const [question, setQuestion] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const targetRef = useRef<chrome.tabs.Tab | null>(null);
  const pendingAccessTab = useRef<number | null>(null);
  const articleRef = useRef<Article | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const settingsRef = useRef(settings);
  const revision = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  settingsRef.current = settings;
  useTheme(themePreview ?? settings.theme);
  useInterfaceLanguage(languagePreview ?? settings.uiLanguage);

  function commitMessages(next: ChatMessage[]) { messagesRef.current = next; setMessages(next); }
  function commitArticle(next: Article | null) { articleRef.current = next; setArticle(next); }

  function persist(tabId: number, source: Article, conversation: ChatMessage[]) {
    void saveSession(tabId, { article: source, messages: conversation, updatedAt: Date.now() })
      .catch(() => setStorageNotice(t("This conversation could not be saved for the browser session. You can still read and copy it here.")));
  }

  const loadCurrent = useCallback(async (forceRead = false) => {
    const oldTab = targetRef.current;
    if (controller.current && oldTab?.id && articleRef.current) {
      persist(oldTab.id, articleRef.current, messagesRef.current.map(m => m.status === 'streaming' ? { ...m, status: 'stopped' } : m));
    }
    controller.current?.abort(); controller.current = null;
    const version = ++revision.current;
    pendingAccessTab.current = null;
    setNeedsPageAccess(false); setRequestingAccess(false); setAccessHelp('');
    setBusy(false); setReading(true); setReadError(''); setError(''); setNotices([]); setQuestion(''); setSourceOpen(false);
    commitArticle(null); commitMessages([]);
    try {
      const tab = await activeTab();
      if (version !== revision.current) return;
      targetRef.current = tab;
      let cached = tab.url ? await loadSession(tab.id!, tab.url) : undefined;
      if (version !== revision.current) return;
      let source = !forceRead && cached ? cached.article : await readArticle(tab.id!);
      if (version !== revision.current) return;
      if (!cached) cached = await loadSession(tab.id!, source.url);
      if (version !== revision.current) return;
      const conversation = cached?.article.text === source.text ? cached.messages : [];
      // Use the freshly extracted metadata when a page was explicitly refreshed.
      if (!forceRead && cached) source = cached.article;
      commitArticle(source); commitMessages(conversation);
      persist(tab.id!, source, conversation);
    } catch (cause) {
      if (version === revision.current) {
        setReadError(cause instanceof Error ? cause.message : t("This page could not be read."));
        setNeedsPageAccess(cause instanceof PageAccessError);
      }
    } finally { if (version === revision.current) setReading(false); }
  }, []);

  async function allowPageAccess() {
    const tab = targetRef.current;
    if (!tab?.id || requestingAccess) return;
    const version = revision.current;
    pendingAccessTab.current = tab.id;
    setRequestingAccess(true); setAccessHelp('');
    try {
      const result = await requestPageAccess(tab);
      if (version !== revision.current) return;
      if (result === 'granted') await loadCurrent(true);
      else setAccessHelp(result === 'requested'
        ? t("Approve Save My Time in the browser’s site-access prompt near the address bar. You can also click the Save My Time toolbar icon (or press Alt+Shift+S) to read this page.")
        : t("Click the Save My Time toolbar icon, or press Alt+Shift+S while the article tab is active. This grants access to the current page."));
    } catch (cause) {
      if (version === revision.current) setAccessHelp(cause instanceof Error ? cause.message : t("Page access could not be requested. Try the toolbar icon."));
    } finally { if (version === revision.current) setRequestingAccess(false); }
  }

  useEffect(() => {
    let alive = true;
    void loadSettings().then(value => {
      if (!alive) return;
      setSettings(value); settingsRef.current = value; setReady(true); void loadCurrent();
    }).catch(() => { if (alive) { setReady(true); setStorageNotice(t("Settings could not be loaded. Check extension storage access.")); void loadCurrent(); } });
    if (!inExtension) return () => { alive = false; ++revision.current; controller.current?.abort(); };
    const activated = (info: { tabId: number; windowId: number }) => {
      if (!targetRef.current || info.windowId === targetRef.current.windowId) void loadCurrent();
    };
    const updated = (id: number, change: chrome.tabs.OnUpdatedInfo) => {
      if (id !== targetRef.current?.id) return;
      if (change.status === 'loading') {
        ++revision.current; controller.current?.abort(); controller.current = null;
        pendingAccessTab.current = null; setNeedsPageAccess(false); setAccessHelp(''); setRequestingAccess(false);
        commitArticle(null); commitMessages([]); setBusy(false); setReading(true); setError(''); setReadError(''); setNotices([]); setQuestion('');
      } else if (change.url || change.status === 'complete') void loadCurrent(true);
    };
    const granted = (message: { type?: string }, sender: chrome.runtime.MessageSender) => {
      if (sender.id === chrome.runtime.id && message.type === 'PAGE_ACCESS_GRANTED') void loadCurrent();
    };
    const hostGranted = () => {
      if (pendingAccessTab.current === targetRef.current?.id) void loadCurrent(true);
    };
    chrome.tabs.onActivated.addListener(activated);
    chrome.tabs.onUpdated.addListener(updated);
    chrome.runtime.onMessage.addListener(granted);
    chrome.permissions.onAdded.addListener(hostGranted);
    return () => {
      alive = false; ++revision.current; controller.current?.abort();
      const tabId = targetRef.current?.id;
      if (tabId && articleRef.current) persist(tabId, articleRef.current, messagesRef.current.map(m => m.status === 'streaming' ? { ...m, status: 'stopped' } : m));
      chrome.tabs.onActivated.removeListener(activated); chrome.tabs.onUpdated.removeListener(updated); chrome.runtime.onMessage.removeListener(granted);
      chrome.permissions.onAdded.removeListener(hostGranted);
    };
  }, [loadCurrent]);

  useEffect(() => {
    if (!messages.length && scrollRef.current) scrollRef.current.scrollTop = 0;
    else if (stickToBottom.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, error, notices]);

  async function openSettings() {
    const version = revision.current;
    try {
      const latest = await loadSettings();
      if (version !== revision.current) return;
      setSettings(latest); settingsRef.current = latest; setSettingsOpen(true);
    } catch (cause) { if (version === revision.current) setError(cause instanceof Error ? cause.message : t('Settings could not be loaded. Check extension storage access.')); }
  }

  async function updateSettings(next: Settings, password?: VaultPasswordChange) {
    const normalized = password?.kind === 'create' ? await credentials.create(password.next, next)
      : password?.kind === 'change' ? await credentials.changePassword(password.current, password.next, next)
      : await saveSettings(next, true);
    setSettings(normalized); settingsRef.current = normalized;
    setThemePreview(null); setLanguagePreview(null); setSettingsOpen(false); setError('');
  }

  function updatePreferences(patch: Partial<Pick<Settings, 'length' | 'language'>>) {
    const next = { ...settingsRef.current, ...patch };
    setSettings(next); settingsRef.current = next;
    void saveSettings(next).catch(() => setStorageNotice(t("Your preferences could not be saved. They still apply to this panel.")));
  }

  async function run(requestQuestion?: string, retry = false) {
    const source = articleRef.current;
    const tabId = targetRef.current?.id;
    if (!source || !tabId || controller.current) return;
    const selectedSettings = structuredClone(settingsRef.current);
    try { validateProvider(selectedSettings.provider, selectedSettings.providers[selectedSettings.provider]); }
    catch (cause) { setError((cause as Error).message); return; }
    const abort = new AbortController(); controller.current = abort;
    const version = ++revision.current;
    setBusy(true); setError('');
    const history = retry ? messagesRef.current.slice(0, -2) : messagesRef.current;
    let nextMessages = history;
    const assistantId = crypto.randomUUID();
    try {
      await requestProviderAccess(selectedSettings);
      if (version !== revision.current) return;
      abort.signal.throwIfAborted();
      // Read current credentials immediately before generation, including any
      // key edits made in another panel. UI preferences stay with this request.
      const latest = await loadSettings();
      if (version !== revision.current) return;
      selectedSettings.providers[selectedSettings.provider].apiKey = latest.providers[selectedSettings.provider].apiKey;
      validateProvider(selectedSettings.provider, selectedSettings.providers[selectedSettings.provider]);
      abort.signal.throwIfAborted();
      const input = prepareInput(source, history, selectedSettings, requestQuestion);
      setNotices(input.notices); setQuestion(''); stickToBottom.current = true;
      nextMessages = [...history,
        { id: crypto.randomUUID(), role: 'user', content: requestQuestion || summaryInstruction(selectedSettings), label: requestQuestion ? undefined : summaryLabel(selectedSettings), kind: requestQuestion ? 'question' : 'summary', status: 'complete' },
        { id: assistantId, role: 'assistant', content: '', kind: requestQuestion ? 'question' : 'summary', status: 'streaming', provider: selectedSettings.provider },
      ];
      commitMessages(nextMessages); persist(tabId, source, nextMessages);
      const onDelta = (delta: string) => {
        if (version !== revision.current) return;
        nextMessages = nextMessages.map(m => m.id === assistantId ? { ...m, content: m.content + delta } : m);
        commitMessages(nextMessages);
      };
      if (import.meta.env.DEV && isPreview) await (await import('./preview')).previewGenerate(input, abort.signal, onDelta);
      else await generate(selectedSettings, input, abort.signal, onDelta);
      if (version !== revision.current) return;
      nextMessages = nextMessages.map(m => m.id === assistantId ? { ...m, status: 'complete' } : m);
      commitMessages(nextMessages);
    } catch (cause) {
      if (version !== revision.current) return;
      const stopped = abort.signal.aborted;
      nextMessages = nextMessages.map(m => m.id === assistantId ? { ...m, status: stopped ? 'stopped' : 'error' } : m);
      commitMessages(nextMessages);
      if (!stopped) setError(cause instanceof Error ? cause.message : t("The response could not be completed."));
    } finally {
      if (version === revision.current) {
        persist(tabId, source, nextMessages);
        controller.current = null; setBusy(false);
      }
    }
  }

  function clearChat() {
    if (busy) return;
    commitMessages([]); setError(''); setNotices([]); setQuestion('');
    if (targetRef.current?.id && articleRef.current) persist(targetRef.current.id, articleRef.current, []);
  }

  function retryLast() {
    const user = messagesRef.current.at(-2);
    if (user?.role === 'user') void run(user.kind === 'summary' ? undefined : user.content, true);
  }

  function scrollDown() {
    stickToBottom.current = true;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    setShowScrollButton(false);
  }

  const selectedProvider = PROVIDERS[settings.provider];
  const local = isLocalProvider(settings.provider, settings.providers[settings.provider]);
  const hasConversation = messages.length > 0;
  const lastMessage = messages.at(-1);
  const canRetry = lastMessage?.role === 'assistant' && ['error', 'stopped'].includes(lastMessage.status);
  const hasAnswer = messages.some(m => m.role === 'assistant' && m.status === 'complete');

  if (settingsOpen) return <SettingsPanel settings={settings} onSave={updateSettings} onThemePreview={setThemePreview} onLanguagePreview={setLanguagePreview} onBack={() => { setThemePreview(null); setLanguagePreview(null); setSettingsOpen(false); }} />;

  return <div className="app-shell">
    {isPreview && <div className="preview-banner">{t("UI PREVIEW")}{' '}<span>{t("Sample article & responses · no API calls")}</span></div>}
    <header className="app-header">
      <div className="brand"><span className="brand-mark"><Feather size={21} strokeWidth={1.7} /></span><span>save my time<span className="brand-dot">.</span></span></div>
      <div className="header-actions">{credentials.isUnlocked() && <button className="icon-button" title={t('Lock vault')} aria-label={t('Lock vault')} onClick={() => lockVault()}><LockKeyhole size={17} /></button>}<button className="icon-button" title={t("New chat")} aria-label={t("New chat")} onClick={clearChat} disabled={busy || !hasConversation}><Plus size={20} /></button><button className="icon-button" title={t("Settings")} aria-label={t("Settings")} onClick={() => void openSettings()} disabled={busy || !ready}><Settings2 size={18} /></button></div>
    </header>

    <div className="reader-scroll" ref={scrollRef} onScroll={() => {
      const el = scrollRef.current;
      if (el) { stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90; setShowScrollButton(!stickToBottom.current && hasConversation); }
    }}>
      <main>
        {!hasConversation && <section className="welcome">
          <div className="eyebrow"><span className="tiny-line" />{' '}{t("LESS SCROLLING, MORE LIVING")}</div>
          <h1>{t("The big picture.")}<br /><em>{t("In a little time.")}</em></h1>
          <p>{t("A thoughtful little shortcut to")}<br />{t("what’s worth knowing.")}</p>
          <div className="welcome-art" aria-hidden="true"><div className="art-page back" /><div className="art-page front"><span /><span /><span /><span /></div><div className="art-spark">✳</div><div className="art-dot" /></div>
        </section>}

        <section className={`article-card ${hasConversation ? 'compact' : ''}`} aria-label={t("Current article")}>
          <div className="article-meta"><span><BookOpen size={13} />{article ? article.siteName : t("CURRENT PAGE")}</span><button className="icon-button small" aria-label={t("Read page again")} title={t("Read page again")} onClick={() => void loadCurrent(true)} disabled={busy || reading}><RefreshCw size={13} /></button></div>
          {reading ? <div className="reading-state" role="status"><LoaderCircle size={17} className="spin" />{t("Finding the article…")}</div> : article ? <>
            <h2 dir="auto">{article.title}</h2>
            <div className="article-info"><span><Clock3 size={12} />{Math.max(1, Math.round(article.wordCount / 220))}{' '}{t("min read")}</span><span>{article.wordCount.toLocaleString()}{' '}{t("words")}</span><span className="article-ready"><span className="status-dot ready" />{t("Ready")}</span></div>
            {hasConversation && <button className="text-button source-toggle" onClick={() => setSourceOpen(!sourceOpen)} aria-expanded={sourceOpen}><BookOpen size={12} />{t("View source")}<ChevronDown size={13} className={sourceOpen ? 'rotate' : ''} /></button>}
          </> : <><h2>{t("A good read starts here.")}</h2><p className="help-text">{readError || t('Open an article and click the Save My Time extension icon.')}</p><button className="text-button" onClick={() => void loadCurrent(true)}><RefreshCw size={13} />{t("Try reading again")}</button></>}
        </section>

        {accessHelp && <div className="notice" role="status">{accessHelp}</div>}

        {sourceOpen && article && <section className="source-panel"><div className="section-heading"><h2>{t("What the model can read")}</h2><button className="icon-button small" onClick={() => setSourceOpen(false)} aria-label={t("Close source")}><X size={15} /></button></div><p className="help-text">{t("Extracted article text. Long articles may be shortened further for the selected model.")}</p><pre dir="auto">{article.text}</pre><a className="text-link" href={article.url} target="_blank" rel="noreferrer">{t("Open original article")}{' '}<ExternalLink size={12} /></a></section>}

        <section className="summary-controls" aria-label={t("Summary preferences")}>
          <div className="control-label"><label id="length-label">{t("A LITTLE OR A LOT?")}</label><span>{settings.provider === 'chrome' ? t("3, 5, or 7 key points") : t('~{count} words', { count: { short: 60, medium: 150, long: 300 }[settings.length] })}</span></div>
          <div className="segmented-control" role="group" aria-labelledby="length-label">{LENGTHS.map(length => <button key={length.id} aria-pressed={settings.length === length.id} onClick={() => updatePreferences({ length: length.id })} disabled={busy} className={settings.length === length.id ? 'active' : ''}>{t(length.label)}</button>)}</div>
          <div className="language-control"><Globe2 size={15} /><label htmlFor="language">{t("Read in")}</label><div className="select-wrap"><select id="language" value={settings.language} onChange={e => updatePreferences({ language: e.target.value })} disabled={busy}>{LANGUAGES.map(([id, label]) => <option key={id} value={id}>{id === 'auto' ? t('Same as article') : label}</option>)}</select><ChevronDown size={13} /></div></div>
          <button className={`primary-button full-width summarize-button ${hasConversation ? 'subtle' : ''}`} disabled={(!article && !needsPageAccess) || reading || busy || !ready || requestingAccess} onClick={() => needsPageAccess ? void allowPageAccess() : void run()}>{busy || requestingAccess ? <LoaderCircle className="spin" size={16} /> : <Feather size={17} />}<span>{requestingAccess ? t("Requesting page access…") : needsPageAccess ? t("Allow access to this page") : busy ? t("Putting it into words…") : hasConversation ? t("Make a new summary") : t("Give me the short version")}</span>{!busy && <ArrowRight size={17} />}</button>
          {!hasConversation && <div className="send-disclosure"><ShieldCheck size={12} /><span>{local ? t("Processed on your device") : t('Article sent directly to {provider}', { provider: selectedProvider.name })}</span></div>}
        </section>

        {notices.map(notice => <div className="notice" key={notice}>{notice}</div>)}
        {storageNotice && <div className="notice" role="status">{storageNotice}</div>}
        {hasConversation && <div className="conversation" aria-label={t("Conversation")} aria-busy={busy}>{messages.map(message => <Message message={message} key={message.id} />)}</div>}
        <div className="sr-only" role="status" aria-live="polite">{busy ? t("Generating an answer.") : lastMessage?.status === 'complete' ? t("Answer complete.") : lastMessage?.status === 'stopped' ? t("Generation stopped.") : ''}</div>
        {error && <div className="notice error" role="alert"><p>{error}</p><div className="notice-actions">{canRetry && <button className="text-button" onClick={retryLast} disabled={busy}><RefreshCw size={13} />{t("Try again")}</button>}<button className="text-button" onClick={() => void openSettings()} disabled={busy}><Settings2 size={13} />{t("Open settings")}</button></div></div>}
        {canRetry && !error && <button className="text-button retry-stopped" onClick={retryLast}><RefreshCw size={13} />{t("Try this response again")}</button>}
        {hasAnswer && !busy && !error && <div className="suggestions" aria-label={t("Suggested questions")}>{[t('What’s the main takeaway?'), t('Explain it simply'), t('What are the caveats?')].map(suggestion => <button key={suggestion} onClick={() => void run(suggestion)}>{suggestion}<ArrowUp size={12} /></button>)}</div>}
        {!hasConversation && <div className="empty-chat-note"><MessageCircle size={17} /><div><strong>{t("Curiosity is welcome.")}</strong><p>{t("Ask a follow-up. Connect the dots.")}<br />{t("Go a little deeper, right here.")}</p></div></div>}
      </main>
      <div className="scroll-bottom-space" />
    </div>

    {showScrollButton && <button className="scroll-down" aria-label={t("Scroll to latest answer")} onClick={scrollDown}><ArrowDown size={17} /></button>}
    <footer className="composer-area">
      <form className={`composer ${busy ? 'generating' : ''}`} onSubmit={e => { e.preventDefault(); if (question.trim() && !busy) void run(question.trim()); }}>
        <label className="sr-only" htmlFor="question">{t("Ask about this article")}</label>
        <textarea id="question" ref={textareaRef} rows={2} maxLength={2_000} placeholder={article ? t("Ask about this article…") : t("Open an article to start…")} value={question} disabled={!article || busy} onChange={e => setQuestion(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (question.trim() && !busy) void run(question.trim()); } }} />
        <div className="composer-bottom"><button className="model-switcher" type="button" onClick={() => void openSettings()} disabled={busy}><span className={`status-dot ${local ? 'ready' : 'cloud'}`} />{selectedProvider.name}<ChevronDown size={11} /></button>{busy ? <button className="send-button stop" type="button" onClick={() => controller.current?.abort()} aria-label={t("Stop generation")}><Square size={13} fill="currentColor" /></button> : <button className="send-button" type="submit" disabled={!question.trim() || !article} aria-label={t("Send question")}><ArrowUp size={18} /></button>}</div>
      </form>
      <div className="footer-note">{hasConversation ? <>{t("AI can miss details. Keep the original close.")}</> : <><Check size={11} />{' '}{t("Your time is well spent.")}</>}</div>
    </footer>
  </div>;
}
