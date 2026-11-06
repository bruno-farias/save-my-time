import { useEffect, useState, type ReactNode } from 'react';
import { KeyRound, LoaderCircle, LockKeyhole, ShieldCheck } from 'lucide-react';
import { credentials, lockVault, onVaultLocked, type VaultOverview } from '../lib/vault';
import { t, useInterfaceLanguage, useTranslation } from '../lib/i18n';
import { useTheme } from '../lib/theme';
import { validateMasterPassword } from '../lib/vault-crypto';

export const AUTO_LOCK_MS = 15 * 60 * 1000;
export function PasswordFields({ password, confirm, onPassword, onConfirm, busy = false }: { password: string; confirm: string; onPassword: (value: string) => void; onConfirm: (value: string) => void; busy?: boolean }) {
  useTranslation();
  const passwordError = password ? passwordConfirmationError(password, password) : '';
  const mismatch = Boolean(confirm) && password !== confirm;
  return <div className="password-setup">
    <label htmlFor="master-new">{t('New master password')}</label><input id="master-new" type="password" autoComplete="new-password" minLength={12} maxLength={1024} value={password} onChange={e => onPassword(e.target.value)} disabled={busy} aria-invalid={Boolean(passwordError)} aria-describedby={passwordError ? 'master-new-error master-password-help' : 'master-password-help'} />
    {passwordError && <p id="master-new-error" className="help-text field-error" role="status">{passwordError}</p>}
    <label htmlFor="master-confirm">{t('Confirm master password')}</label><input id="master-confirm" type="password" autoComplete="new-password" maxLength={1024} value={confirm} onChange={e => onConfirm(e.target.value)} disabled={busy} aria-invalid={mismatch} aria-describedby={mismatch ? 'master-confirm-error master-password-help' : 'master-password-help'} />
    {mismatch && <p id="master-confirm-error" className="help-text field-error" role="status">{t('The master passwords do not match.')}</p>}
    <p id="master-password-help" className="help-text">{t('Use at least 12 characters. Keep this password somewhere safe: it cannot be recovered. A forgotten password means resetting the vault and entering your API keys again.')}</p>
  </div>;
}
export function passwordConfirmationError(password: string, confirm: string): string {
  try { validateMasterPassword(password); }
  catch (cause) { return (cause as Error).message; }
  return password === confirm ? '' : t('The master passwords do not match.');
}
export function checkPasswordConfirmation(password: string, confirm: string) {
  const error = passwordConfirmationError(password, confirm);
  if (error) throw new Error(error);
}
export function VaultBoundary({ children }: { children: ReactNode }) {
  useTranslation();
  const [overview, setOverview] = useState<VaultOverview | null>(null);
  const [loadingError, setLoadingError] = useState('');
  const [locked, setLocked] = useState(false);
  useTheme(overview?.settings.theme || 'system');
  useInterfaceLanguage(overview?.settings.uiLanguage || 'auto');
  async function refresh() {
    try { const next = await credentials.overview(); setOverview(next); setLocked(false); setLoadingError(''); }
    catch { setLoadingError(t('Settings could not be loaded. Try reopening the panel.')); }
  }
  useEffect(() => {
    let alive = true;
    void credentials.overview().then(next => { if (alive) setOverview(next); }).catch(() => { if (alive) setLoadingError(t('Settings could not be loaded. Try reopening the panel.')); });
    const unsubscribe = onVaultLocked(() => { if (alive) { setLocked(true); void refresh(); } });
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.settings && credentials.observeChange(changes.settings.newValue, changes.settings.oldValue)) lockVault(false);
    };
    if (typeof chrome !== 'undefined' && chrome.runtime?.id) chrome.storage.onChanged.addListener(changed);
    const closing = () => lockVault(false);
    window.addEventListener('pagehide', closing);
    return () => { alive = false; unsubscribe(); window.removeEventListener('pagehide', closing); if (typeof chrome !== 'undefined' && chrome.runtime?.id) chrome.storage.onChanged.removeListener(changed); };
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let lastActivity = Date.now();
    const activity = () => {
      // Timers may be suspended in a background document. An interaction after
      // expiry must lock, rather than silently extending the old session.
      const now = Date.now();
      if (now - lastActivity >= AUTO_LOCK_MS && credentials.isUnlocked()) lockVault(false);
      lastActivity = now;
      clearTimeout(timer); timer = setTimeout(() => { if (credentials.isUnlocked()) lockVault(false); }, AUTO_LOCK_MS);
    };
    activity();
    window.addEventListener('pointerdown', activity, true); window.addEventListener('keydown', activity, true); window.addEventListener('wheel', activity, { passive: true }); window.addEventListener('focus', activity);
    return () => { clearTimeout(timer); window.removeEventListener('pointerdown', activity, true); window.removeEventListener('keydown', activity, true); window.removeEventListener('wheel', activity); window.removeEventListener('focus', activity); };
  }, []);
  if (loadingError) return <main className="vault-screen"><p className="notice error" role="alert">{loadingError}</p><button className="secondary-button" onClick={() => void refresh()}>{t('Try again')}</button></main>;
  if (!overview || locked) return <div className="vault-screen" role="status"><LoaderCircle className="spin" size={20} />{t('Opening your vault…')}</div>;
  if (['locked', 'migration', 'corrupt'].includes(overview.mode)) return <VaultGate key={overview.mode} mode={overview.mode} onReady={refresh} />;
  return children;
}
function VaultGate({ mode, onReady }: { mode: VaultOverview['mode']; onReady: () => Promise<void> }) {
  useTranslation();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resetting, setResetting] = useState(false);
  const [confirmedReset, setConfirmedReset] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (mode === 'migration') { checkPasswordConfirmation(password, confirm); await credentials.create(password); }
      else await credentials.unlock(password);
      setPassword(''); setConfirm(''); await onReady();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('The vault could not be opened.')); }
    finally { setBusy(false); }
  }
  async function reset() {
    if (!confirmedReset) return;
    setBusy(true); setError('');
    try { await credentials.reset(); lockVault(); await onReady(); }
    catch { setError(t('The vault could not be reset. Your saved data has not been changed.')); }
    finally { setBusy(false); }
  }
  return <main className="vault-screen">
    <span className="vault-symbol"><LockKeyhole size={28} /></span>
    <h1>{mode === 'migration' ? t('Protect your saved keys') : mode === 'corrupt' ? t('Your vault needs attention') : t('Welcome back')}</h1>
    <p className="vault-intro">{mode === 'migration' ? t('Your existing API keys are still stored without encryption. Create a master password to encrypt them on this device. Your provider settings will be kept.') : mode === 'corrupt' ? t('The encrypted vault is damaged or uses an unsupported format. Your saved data has not been changed.') : t('Unlock your API keys with your master password. It stays on this device.')}</p>
    {!resetting && mode !== 'corrupt' && <form onSubmit={submit} className="provider-config">
      {mode === 'migration' ? <PasswordFields password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} busy={busy} /> : <><label htmlFor="master-unlock">{t('Master password')}</label><input id="master-unlock" autoFocus type="password" autoComplete="current-password" required maxLength={1024} value={password} onChange={e => setPassword(e.target.value)} disabled={busy} /></>}
      <button type="submit" className="primary-button full-width" disabled={busy || (mode === 'migration' ? Boolean(passwordConfirmationError(password, confirm)) : !password)}>{busy ? <LoaderCircle size={16} className="spin" /> : <KeyRound size={16} />}{mode === 'migration' ? t('Encrypt saved keys') : t('Unlock vault')}</button>
    </form>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {resetting ? <section className="notice error">
      <h2>{t('Reset the vault?')}</h2><p>{t('This removes all saved API keys from this extension. Your other preferences stay. You will need to enter the keys again.')}</p>
      <label className="reset-confirm"><input type="checkbox" checked={confirmedReset} onChange={e => setConfirmedReset(e.target.checked)} disabled={busy} />{t('I understand that my saved API keys will be removed.')}</label>
      <div className="notice-actions"><button type="button" className="secondary-button" onClick={() => { setResetting(false); setConfirmedReset(false); }} disabled={busy}>{t('Cancel')}</button><button type="button" className="secondary-button" onClick={() => void reset()} disabled={!confirmedReset || busy}>{t('Delete saved keys and reset')}</button></div>
    </section> : <button type="button" className="text-button vault-reset-link" onClick={() => { setPassword(''); setConfirm(''); setResetting(true); }} disabled={busy}>{mode === 'locked' ? t('Forgot your master password?') : t('Reset saved keys')}</button>}
    <div className="privacy-note"><ShieldCheck size={18} /><p>{t('Encrypted with your master password. Locks when the panel closes or after 15 minutes without activity. The password is never saved.')}</p></div>
  </main>;
}
