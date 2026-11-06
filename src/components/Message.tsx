import { t, useTranslation } from '../lib/i18n';
import { useState } from 'react';
import Markdown from 'react-markdown';
import { Check, Copy, Feather, LoaderCircle } from 'lucide-react';
import type { ChatMessage } from '../lib/types';
import { PROVIDERS } from '../lib/settings';

export function Message({ message }: { message: ChatMessage }) {
  useTranslation();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  if (message.role === 'user') return <div className={`user-message ${message.kind === 'summary' ? 'summary-request' : ''}`}><span>{message.kind === 'summary' ? message.label || t('Summarize this article') : message.content}</span></div>;
  async function copy() {
    try { await navigator.clipboard.writeText(message.content); setCopied(true); setCopyError(false); setTimeout(() => setCopied(false), 1_800); }
    catch { setCopyError(true); }
  }
  return <article className={`assistant-message ${message.status}`}>
    <div className="message-heading"><span className="assistant-avatar"><Feather size={14} /></span><span className="message-name">{message.kind === 'summary' ? t("The short version") : t("A closer look")}</span><small>{message.provider ? PROVIDERS[message.provider].name : ''}</small></div>
    <div className="markdown" dir="auto">
      <Markdown skipHtml components={{
        img: () => null,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
      }}>{message.content}</Markdown>
      {message.status === 'streaming' && (!message.content ? <span className="thinking"><LoaderCircle className="spin" size={15} />{t("Reading between the lines…")}</span> : <span className="stream-cursor" />)}
    </div>
    {message.status !== 'streaming' && <div className="message-actions">
      <span>{message.status === 'stopped' ? t("Stopped · incomplete") : message.status === 'error' ? t("Incomplete response") : t("Based on this article")}</span>
      {message.content && <button className="text-button" onClick={() => void copy()} aria-label={t("Copy answer")}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? t("Copied") : t("Copy")}</button>}
    </div>}
    {copyError && <p className="help-text" role="status">{t("Copy was unavailable. Select the text to copy it manually.")}</p>}
  </article>;
}
