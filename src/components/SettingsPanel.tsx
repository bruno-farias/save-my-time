import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, CircleHelp, Cpu, Download, Eye, EyeOff, KeyRound, LoaderCircle, Monitor, Moon, RefreshCw, ShieldCheck, Sun } from 'lucide-react';
import { hasProviderAccess, inExtension, isPreview, requestProviderAccess } from '../lib/browser';
import { normalizeOllamaUrl, PROVIDERS } from '../lib/settings';
import { chromeAIStatus, prepareChromeAI } from '../providers/chrome-ai';
import { listModels, type ModelOption } from '../providers/models';
import type { ProviderId, Settings, Theme } from '../lib/types';
import { credentials, lockVault, settingsHaveKeys } from '../lib/vault';
import { checkPasswordConfirmation, passwordConfirmationError, PasswordFields } from './VaultBoundary';
import { interfaceLanguages } from '../locales/catalog';
import { t, mark, useTranslation } from '../lib/i18n';

export type VaultPasswordChange = { kind: 'create'; next: string } | { kind: 'change'; current: string; next: string };
interface Props { settings: Settings; onSave: (settings: Settings, password?: VaultPasswordChange) => Promise<void>; onBack: () => void; onThemePreview: (theme: Theme) => void; onLanguagePreview: (language: string) => void }
interface Catalog { models: ModelOption[]; loading: boolean; status: string; error: string; needsAccess: boolean }
const emptyCatalog: Catalog = { models: [], loading: false, status: '', error: '', needsAccess: false };

export function SettingsPanel({ settings, onSave, onBack, onThemePreview, onLanguagePreview }: Props) {
  useTranslation();
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<Catalog>(emptyCatalog);
  const [refresh, setRefresh] = useState(0);
  const [manualModel, setManualModel] = useState(false);
  const [availability, setAvailability] = useState('checking');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const hasVault = credentials.isUnlocked();
  const needsPassword = changingPassword || (!hasVault && (settingsHaveKeys(draft) || Boolean(newPassword || confirmPassword)));
  const passwordInvalid = needsPassword && Boolean(passwordConfirmationError(newPassword, confirmPassword));
  const controller = useRef<AbortController | null>(null);
  const catalogController = useRef<AbortController | null>(null);
  const catalogEpoch = useRef(0);
  const provider = draft.provider;
  const config = draft.providers[provider];
  const origin = inExtension ? `chrome-extension://${chrome.runtime.id}` : 'chrome-extension://YOUR_EXTENSION_ID';

  useEffect(() => {
    let alive = true;
    void chromeAIStatus().then(value => { if (alive) setAvailability(value); });
    return () => { alive = false; controller.current?.abort(); };
  }, []);

  useEffect(() => {
    ++catalogEpoch.current;
    setCatalog(emptyCatalog);
    if (provider === 'chrome' || (provider !== 'ollama' && !config.apiKey.trim())) return;
    const abort = new AbortController(); catalogController.current = abort;
    let alive = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          if (!await hasProviderAccess(draft)) {
            if (alive && !abort.signal.aborted) setCatalog({ ...emptyCatalog, needsAccess: true, status: t('Connect once to allow this provider’s model list to load.') });
            return;
          }
          if (!alive || abort.signal.aborted) return;
          setCatalog({ ...emptyCatalog, loading: true, status: t('Loading available models…') });
          timeout = setTimeout(() => abort.abort(new DOMException('Model listing timed out.', 'TimeoutError')), 15_000);
          const models = import.meta.env.DEV && isPreview
            ? (await import('../preview')).previewModels(provider)
            : await listModels(provider, config, abort.signal);
          if (!alive || abort.signal.aborted) return;
          setCatalog({ ...emptyCatalog, models, status: models.length ? provider === 'ollama' ? (models.length === 1 ? t('1 installed model found.') : t('{count} installed models found.', { count: models.length })) : (models.length === 1 ? t('1 available model found.') : t('{count} available models found.', { count: models.length })) : provider === 'ollama' ? t("No installed models found. Install a chat model in Ollama, then refresh.") : t("No text models were returned. You can enter a model manually.") });
        } catch (cause) {
          if (!alive || (abort.signal.aborted && abort.signal.reason?.name !== 'TimeoutError')) return;
          setCatalog({ ...emptyCatalog, error: abort.signal.reason?.name === 'TimeoutError' ? t("Loading models took too long. Check the connection and refresh.") : cause instanceof Error ? cause.message : t("Models could not be loaded.") });
        } finally { clearTimeout(timeout); }
      })();
    }, 650);
    return () => { alive = false; ++catalogEpoch.current; clearTimeout(timer); clearTimeout(timeout); abort.abort(); };
    // Model selection and appearance changes must not refetch the catalog.
  }, [provider, config.apiKey, config.baseUrl, refresh]);

  function updateConfig(field: 'model' | 'apiKey' | 'baseUrl', value: string) {
    if (field !== 'model') { ++catalogEpoch.current; catalogController.current?.abort(); }
    setError(''); setStatus('');
    setDraft(current => ({ ...current, providers: { ...current.providers, [provider]: { ...current.providers[provider], [field]: value } } }));
  }

  function selectProvider(id: ProviderId) {
    if (id === provider) return;
    ++catalogEpoch.current; catalogController.current?.abort();
    setDraft(current => ({ ...current, provider: id }));
    setManualModel(false); setShowKey(false); setError(''); setStatus('');
  }

  async function save(event: React.FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const next = structuredClone(draft);
      let password: VaultPasswordChange | undefined;
      if (!hasVault && (settingsHaveKeys(next) || newPassword || confirmPassword)) {
        checkPasswordConfirmation(newPassword, confirmPassword);
        password = { kind: 'create', next: newPassword };
      } else if (changingPassword) {
        checkPasswordConfirmation(newPassword, confirmPassword);
        if (!currentPassword) throw new Error(t('Enter your current master password.'));
        password = { kind: 'change', current: currentPassword, next: newPassword };
      }
      if (provider !== 'chrome' && !config.model.trim()) throw new Error(t("Enter a model name."));
      if (provider === 'ollama') next.providers.ollama.baseUrl = normalizeOllamaUrl(config.baseUrl);
      if (provider === 'ollama' || config.apiKey.trim()) await requestProviderAccess(next);
      await onSave(next, password);
      setNewPassword(''); setConfirmPassword(''); setCurrentPassword('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("Settings could not be saved.")); }
    finally { setBusy(false); }
  }

  async function findModels() {
    const epoch = catalogEpoch.current;
    setCatalog(current => ({ ...current, loading: true, error: '', status: t('Connecting…') }));
    try {
      await requestProviderAccess(draft);
      if (epoch === catalogEpoch.current) setRefresh(value => value + 1);
    } catch (cause) {
      if (epoch === catalogEpoch.current) setCatalog({ ...emptyCatalog, needsAccess: true, error: cause instanceof Error ? cause.message : t("Provider access could not be requested.") });
    }
  }

  function downloadChromeModels() {
    setError(''); setStatus(t("Preparing Chrome AI…")); setBusy(true);
    const abort = new AbortController(); controller.current = abort;
    // Start synchronously during the click to retain Chrome's user activation.
    void prepareChromeAI(abort.signal, setStatus)
      .then(() => setAvailability('available'))
      .catch(cause => setError(cause instanceof Error ? cause.message : t("Chrome AI could not be prepared.")))
      .finally(() => { controller.current = null; setBusy(false); });
  }

  return <div className="settings-screen">
    <header className="settings-heading">
      <button className="icon-button" onClick={onBack} aria-label={t("Back to article")}><ArrowLeft size={19} /></button>
      <div><h1>{t("Make it yours")}</h1><p>{t("Your model. Your way of reading.")}</p></div>
    </header>
    <form onSubmit={save} className="settings-form">
      <fieldset className="appearance-fieldset" disabled={busy}>
        <legend className="eyebrow">{t("APPEARANCE")}</legend>
        <div className="segmented-control" role="group" aria-label={t("Appearance")}>
          {([{ id: 'system', name: mark('System'), icon: Monitor }, { id: 'light', name: mark('Light'), icon: Sun }, { id: 'dark', name: mark('Dark'), icon: Moon }] as const).map(({ id, name, icon: Icon }) => <button key={id} type="button" aria-pressed={draft.theme === id} className={draft.theme === id ? 'active' : ''} onClick={() => { setDraft(current => ({ ...current, theme: id })); onThemePreview(id); }}><Icon size={13} />{t(name)}</button>)}
        </div>
      </fieldset>
      <section className="provider-config interface-language">
        <label htmlFor="interface-language">{t('Interface language')}</label>
        <select id="interface-language" value={draft.uiLanguage} disabled={busy} onChange={e => { const uiLanguage = e.target.value; setDraft(current => ({ ...current, uiLanguage })); onLanguagePreview(uiLanguage); }}>
          <option value="auto">{t('Follow browser language')}</option>
          {interfaceLanguages.map(language => <option key={language.code} value={language.code}>{language.nativeName}</option>)}
        </select>
        <p className="help-text">{t('The interface language and the summary language can be different. Missing translations use English.')}</p>
      </section>
      <fieldset disabled={busy} className="provider-fieldset">
        <legend className="eyebrow">{t("CHOOSE YOUR AI")}</legend>
        <div className="provider-list">
          {(Object.keys(PROVIDERS) as ProviderId[]).map(id => <button type="button" key={id} className={`provider-option ${provider === id ? 'selected' : ''}`} aria-pressed={provider === id} onClick={() => selectProvider(id)}>
            <span className={`provider-symbol ${id}`}>{id === 'ollama' ? <Cpu size={20} /> : id === 'chrome' ? <Download size={19} /> : id === 'anthropic' ? '✳' : id === 'gemini' ? '✦' : '◉'}</span>
            <span className="provider-description"><strong>{PROVIDERS[id].name}</strong><small>{t(PROVIDERS[id].detail)}</small></span>
            {PROVIDERS[id].local && <span className="local-pill">{t("LOCAL")}</span>}
            <span className={`radio-indicator ${provider === id ? 'checked' : ''}`}>{provider === id && <Check size={10} strokeWidth={3} />}</span>
          </button>)}
        </div>
      </fieldset>

      <section className="provider-config">
        <div className="section-heading"><h2>{t('{provider} settings', { provider: PROVIDERS[provider].name })}</h2>{provider !== 'chrome' && <KeyRound size={15} />}</div>
        {provider === 'chrome' ? <>
          <p className="help-text">{t("Summaries and follow-up chat run on your device. Chrome manages the models; the first setup may require a large download.")}</p>
          <div className="connection-status"><span className={`status-dot ${availability === 'available' ? 'ready' : ''}`} />{availability === 'available' ? t("Models ready") : availability === 'unavailable' ? t("Not available in this browser or device") : availability === 'checking' ? t("Checking availability…") : t("Model download needed")}</div>
          <button type="button" className="secondary-button full-width" onClick={downloadChromeModels} disabled={busy || availability === 'unavailable' || isPreview}>{busy ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}{availability === 'available' ? t("Check Chrome AI setup") : t("Prepare Chrome AI")}</button>
          {busy && <button type="button" className="text-button" onClick={() => controller.current?.abort()}>{t("Cancel download")}</button>}
          <p className="help-text">{t("Requires a supported desktop Chrome and compatible hardware. Language support varies; English, Spanish, French, German, and Japanese are documented. Brave availability is detected at runtime.")}</p>
          <a className="text-link" href="https://developer.chrome.com/docs/ai/built-in-apis" target="_blank" rel="noreferrer">{t("Chrome AI requirements")}{' '}<ChevronRight size={13} /></a>
        </> : <>
          {provider === 'ollama' ? <>
            <label htmlFor="ollama-url">{t("Server address")}</label>
            <input id="ollama-url" type="url" required value={config.baseUrl} onChange={e => updateConfig('baseUrl', e.target.value)} disabled={busy} spellCheck={false} placeholder="http://localhost:11434" />
            <p className="help-text">{t("Use your local Ollama server, or an HTTPS server you trust.")}</p>
          </> : <>
            <label htmlFor="api-key">{t("API key")}</label>
            <div className="password-field"><input id="api-key" type={showKey ? 'text' : 'password'} value={config.apiKey} onChange={e => updateConfig('apiKey', e.target.value)} disabled={busy} spellCheck={false} autoComplete="off" placeholder={t('Your {provider} API key', { provider: PROVIDERS[provider].name })} /><button className="icon-button" type="button" onClick={() => setShowKey(!showKey)} aria-label={showKey ? t("Hide API key") : t("Show API key")}>{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
            <p className="help-text">{t('Saved keys are encrypted on this device with your master password, never synced. Clear this field and save to remove a key. Provider API usage is billed separately from chat subscriptions.')}</p>
          </>}
          <label htmlFor="model">{t("Model")}</label>
          <select id="model" value={manualModel ? '__custom__' : config.model} onChange={e => { setManualModel(e.target.value === '__custom__'); if (e.target.value !== '__custom__') updateConfig('model', e.target.value); }} disabled={busy} aria-describedby="model-help">
            {!catalog.models.some(model => model.id === config.model) && <option value={config.model}>{config.model || t('Choose a model')}{config.model ? t(" (current)") : ''}</option>}
            {catalog.models.map(model => <option value={model.id} key={model.id}>{model.name === model.id ? model.id : `${model.name} · ${model.id}`}</option>)}
            <option value="__custom__">{t("Enter model manually…")}</option>
          </select>
          {manualModel && <div className="manual-model"><label htmlFor="model-id">{t("Model ID")}</label><input id="model-id" required value={config.model} onChange={e => updateConfig('model', e.target.value)} disabled={busy} spellCheck={false} autoComplete="off" /></div>}
          <p className="help-text" id="model-help">{provider === 'ollama' ? t("Choose an installed chat model, or enter its name manually.") : t("Models load automatically once connected. You can also enter a model ID manually.")}{provider === 'openai' && t(' The catalog does not report chat compatibility for every model.')}</p>
          <button className="secondary-button full-width" type="button" onClick={findModels} disabled={busy || catalog.loading || (provider !== 'ollama' && !config.apiKey.trim())}>{catalog.loading ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={15} />}{catalog.loading ? t("Loading models…") : catalog.needsAccess ? t("Connect and load models") : catalog.models.length ? t("Refresh models") : t("Load models")}</button>
          {catalog.status && <p className="help-text catalog-status" role="status">{catalog.status}</p>}
          {catalog.error && <div className="notice error" role="alert">{catalog.error}</div>}
        </>}
      </section>
      <section className="provider-config vault-settings" aria-label={t('API key protection')}>
        <div className="section-heading"><h2>{t('API key protection')}</h2><ShieldCheck size={16} /></div>
        {hasVault ? <>
          <p className="help-text">{t('Your vault is unlocked. Keys are encrypted when saved. It locks when this panel closes or after 15 minutes without activity.')}</p>
          <div className="vault-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => lockVault()}>{t('Lock vault')}</button><button type="button" className="text-button" disabled={busy} onClick={() => { setChangingPassword(!changingPassword); setNewPassword(''); setConfirmPassword(''); setCurrentPassword(''); }}>{changingPassword ? t('Cancel password change') : t('Change master password')}</button></div>
        </> : <p className="help-text">{t('Create a master password before saving API keys. Ollama and Chrome AI do not need one.')}</p>}
        {changingPassword && <><label htmlFor="master-current">{t('Current master password')}</label><input id="master-current" type="password" autoComplete="current-password" maxLength={1024} value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} disabled={busy} /></>}
        {(!hasVault || changingPassword) && <PasswordFields password={newPassword} confirm={confirmPassword} onPassword={setNewPassword} onConfirm={setConfirmPassword} busy={busy} />}
      </section>
      {provider === 'ollama' && <details className="setup-guide"><summary><CircleHelp size={16} />{' '}{t("First time using Ollama?")}</summary><div>
        <p><a href="https://ollama.com/download" target="_blank" rel="noreferrer">{t('Install Ollama')}</a>{' '}{t('Then download a model:')}</p><code>ollama pull llama3.2</code>
        <p>{t("Allow this extension’s origin and start the server (macOS / Linux terminal):")}</p><code>OLLAMA_ORIGINS='{origin}' ollama serve</code>
        <p>{t("For the macOS Ollama app, set the origin, quit the app, and open it again:")}</p><code>launchctl setenv OLLAMA_ORIGINS '{origin}'</code>
        <p>{t('On Windows, set the OLLAMA_ORIGINS user environment variable to {origin} and restart Ollama. Keep the server bound to localhost.', { origin })}</p>
      </div></details>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {status && <div className="notice" role="status">{status}</div>}
      <div className="privacy-note"><ShieldCheck size={18} /><p>{t("Only the article you choose is sent to your selected provider. No account, tracking, or middleman.")}</p></div>
      <button className="primary-button full-width save-settings" type="submit" disabled={busy || passwordInvalid || (changingPassword && !currentPassword)}><Check size={17} />{t("Save settings")}</button>
    </form>
  </div>;
}
