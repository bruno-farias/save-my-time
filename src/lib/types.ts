export type ProviderId = 'ollama' | 'chrome' | 'openai' | 'anthropic' | 'gemini';
export type SummaryLength = 'short' | 'medium' | 'long';
export type Theme = 'system' | 'light' | 'dark';
export type MessageStatus = 'complete' | 'streaming' | 'stopped' | 'error';

export interface ProviderConfig {
  model: string;
  apiKey: string;
  baseUrl: string;
}

export interface Settings {
  version: 1;
  provider: ProviderId;
  length: SummaryLength;
  language: string;
  theme: Theme;
  uiLanguage: string;
  /** In-memory conflict token. Never persisted outside the encrypted envelope. */
  vaultRevision?: string;
  providers: Record<ProviderId, ProviderConfig>;
}

export interface Article {
  title: string;
  url: string;
  siteName: string;
  byline: string;
  language: string;
  text: string;
  wordCount: number;
  extractedAt: number;
  truncated: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: MessageStatus;
  kind: 'summary' | 'question';
  label?: string;
  provider?: ProviderId;
}

export interface ArticleSession {
  article: Article;
  messages: ChatMessage[];
  updatedAt: number;
}

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

export interface GenerationInput {
  system: string;
  turns: Turn[];
  sourceText: string;
  inputLanguage: string;
  outputLanguage: string;
  kind: 'summary' | 'question';
  length: SummaryLength;
  notices: string[];
}

export type ExtractionResult = { ok: true; article: Article } | { ok: false; error: string };
