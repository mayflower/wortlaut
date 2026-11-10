import React, { createContext, useContext, useEffect, useState } from 'react';

export type UiLang = 'de' | 'en';

const LANG_STORAGE_KEY = 'wortlaut_lang';

let currentModuleLang: UiLang = 'de';

export function loadInitialLang(): UiLang {
  if (typeof window !== 'undefined') {
    try {
      const params = new URLSearchParams(window.location.search);
      const qLang = params.get('lang')?.trim().toLowerCase();
      if (qLang === 'en' || qLang === 'de') {
        currentModuleLang = qLang;
        return qLang;
      }
    } catch {
      // ignore URL parse errors
    }
    try {
      const stored = localStorage.getItem(LANG_STORAGE_KEY);
      if (stored === 'en' || stored === 'de') {
        currentModuleLang = stored;
        return stored;
      }
    } catch {
      // ignore storage errors
    }
    const instDefault = window.__WORTLAUT_BOOT__?.instance?.defaultLocale;
    if (instDefault === 'en' || instDefault === 'de') {
      currentModuleLang = instDefault;
      return instDefault;
    }
    if (typeof navigator !== 'undefined' && navigator.language) {
      const nav = navigator.language.toLowerCase();
      currentModuleLang = nav.startsWith('de') ? 'de' : 'en';
      return currentModuleLang;
    }
  }
  return 'de';
}

export function getCurrentLang(): UiLang {
  return currentModuleLang;
}

export interface I18nContextValue {
  lang: UiLang;
  localeTag: 'de-DE' | 'en-US';
  setLang: (next: UiLang) => void;
  tr: (de: string, en: string) => string;
}

const I18nContext = createContext<I18nContextValue>({
  lang: 'de',
  localeTag: 'de-DE',
  setLang: () => {},
  tr: (de) => de,
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<UiLang>(loadInitialLang);

  useEffect(() => {
    currentModuleLang = lang;
    if (typeof document !== 'undefined') {
      document.documentElement.lang = lang;
    }
  }, [lang]);

  const setLang = (next: UiLang) => {
    currentModuleLang = next;
    setLangState(next);
    try {
      localStorage.setItem(LANG_STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
  };

  const localeTag: 'de-DE' | 'en-US' = lang === 'en' ? 'en-US' : 'de-DE';
  const tr = (de: string, en: string): string => (lang === 'en' ? en : de);

  return (
    <I18nContext.Provider value={{ lang, localeTag, setLang, tr }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

const PARTICIPATION_EN: Record<string, string> = {
  scheduled: 'Scheduled',
  starting: 'Worker starting',
  preparing: 'Worker starting',
  joining: 'Joining meeting…',
  waiting_admission: 'Waiting in lobby',
  capturing: 'Recording live',
  ended: 'Ended',
  unknown: 'Unknown',
};

const SOURCE_COVERAGE_EN: Record<string, string> = {
  complete: 'Fully bound to participants',
  partial: 'Partially bound',
  unknown: 'Isolated track capture active',
  none: 'No audio tracks yet',
};

const DELIVERY_STATUS_EN: Record<string, string> = {
  pending: 'Pending',
  sending: 'Sending…',
  sent: 'Delivered',
  skipped: 'Skipped (no recipient)',
  failed: 'Delivery failed',
  delivery_unknown: 'Status unknown (SMTP timeout)',
};

const ATTRIBUTION_STATUS_EN: Record<string, string> = {
  bound: 'Verified participant session',
  unbound: 'Unverified session ID',
  ambiguous: 'Ambiguous track binding',
  unknown: 'Attribution pending',
};

export function localizeParticipation(
  state: string,
  lang: UiLang,
  fallbackDe: Record<string, string>
): string {
  if (lang === 'en') {
    return PARTICIPATION_EN[state] || state;
  }
  return fallbackDe[state] || state;
}

export function localizeSourceCoverage(
  coverage: string,
  lang: UiLang,
  fallbackDe: Record<string, string>
): string {
  if (lang === 'en') {
    return SOURCE_COVERAGE_EN[coverage] || coverage;
  }
  return fallbackDe[coverage] || coverage;
}

export function localizeDeliveryStatus(
  status: string,
  lang: UiLang,
  fallbackDe: Record<string, string>
): string {
  if (lang === 'en') {
    return DELIVERY_STATUS_EN[status] || status;
  }
  return fallbackDe[status] || status;
}

export function localizeAttributionStatus(
  status: string,
  lang: UiLang,
  fallbackDe: Record<string, string>
): string {
  if (lang === 'en') {
    return ATTRIBUTION_STATUS_EN[status] || status;
  }
  return fallbackDe[status] || status;
}
