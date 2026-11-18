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

const KEYFRAME_CAPABILITY_EN: Record<string, string> = {
  active: 'Active (screen share detected)',
  unverified: 'Ready (no verified screen share)',
  disabled: 'Disabled',
  unsupported: 'Unsupported (SDK mode)',
};

export const KEYFRAME_STRINGS = {
  de: {
    screenShareBadge: 'Bildschirmfreigabe',
    slideSnapshotAlt: 'Folie aus Bildschirmfreigabe',
    openPreview: 'Folie vergrößern',
    closePreview: 'Vorschau schließen',
    deleteSlide: 'Folie dauerhaft löschen',
    confirmDeleteSlide:
      'Diese Bildschirmfreigabe-Folie dauerhaft aus dem Protokoll und Objektspeicher löschen?',
    loadingSlide: 'Folie lädt…',
    slideUnavailable: 'Folie nicht verfügbar',
    diagHeading: 'Bildschirmfreigabe-Keyframes',
    diagCapability: 'Status',
    diagActiveShare: 'Aktive Freigabe',
    diagEvaluatedTicks: 'Geprüfte Ticks (1 Hz)',
    diagEmitted: 'Erkannte Folienwechsel',
    diagUploaded: 'Gespeicherte Keyframes',
    diagDroppedUnverified: 'Verworfen (Kamera / unbestätigt)',
    diagDroppedOptedOut: 'Verworfen (Widerspruch / Opt-Out)',
    diagDroppedQueueFull: 'Verworfen (Warteschlange voll)',
  },
  en: {
    screenShareBadge: 'Screen share',
    slideSnapshotAlt: 'Screen-share slide snapshot',
    openPreview: 'Enlarge slide',
    closePreview: 'Close preview',
    deleteSlide: 'Delete slide permanently',
    confirmDeleteSlide:
      'Permanently delete this screen-share slide from the protocol and object storage?',
    loadingSlide: 'Loading slide…',
    slideUnavailable: 'Slide unavailable',
    diagHeading: 'Screen-Share Keyframes',
    diagCapability: 'Capability',
    diagActiveShare: 'Active share',
    diagEvaluatedTicks: 'Evaluated ticks (1 Hz)',
    diagEmitted: 'Emitted slide changes',
    diagUploaded: 'Uploaded keyframes',
    diagDroppedUnverified: 'Dropped (camera / unverified)',
    diagDroppedOptedOut: 'Dropped (opted out)',
    diagDroppedQueueFull: 'Dropped (queue full)',
  },
} as const;

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

export const QWEN_ASR_LANGUAGE_META: ReadonlyArray<{
  id: string;
  de: string;
  en: string;
  native: string;
}> = [
  { id: 'German', de: 'Deutsch', en: 'German', native: 'Deutsch' },
  { id: 'English', de: 'Englisch', en: 'English', native: 'English' },
  { id: 'French', de: 'Französisch', en: 'French', native: 'Français' },
  { id: 'Spanish', de: 'Spanisch', en: 'Spanish', native: 'Español' },
  { id: 'Italian', de: 'Italienisch', en: 'Italian', native: 'Italiano' },
  { id: 'Portuguese', de: 'Portugiesisch', en: 'Portuguese', native: 'Português' },
  { id: 'Dutch', de: 'Niederländisch', en: 'Dutch', native: 'Nederlands' },
  { id: 'Polish', de: 'Polnisch', en: 'Polish', native: 'Polski' },
  { id: 'Czech', de: 'Tschechisch', en: 'Czech', native: 'Čeština' },
  { id: 'Danish', de: 'Dänisch', en: 'Danish', native: 'Dansk' },
  { id: 'Swedish', de: 'Schwedisch', en: 'Swedish', native: 'Svenska' },
  { id: 'Finnish', de: 'Finnisch', en: 'Finnish', native: 'Suomi' },
  { id: 'Hungarian', de: 'Ungarisch', en: 'Hungarian', native: 'Magyar' },
  { id: 'Romanian', de: 'Rumänisch', en: 'Romanian', native: 'Română' },
  { id: 'Greek', de: 'Griechisch', en: 'Greek', native: 'Ελληνικά' },
  { id: 'Macedonian', de: 'Mazedonisch', en: 'Macedonian', native: 'Македонски' },
  { id: 'Russian', de: 'Russisch', en: 'Russian', native: 'Русский' },
  { id: 'Turkish', de: 'Türkisch', en: 'Turkish', native: 'Türkçe' },
  { id: 'Arabic', de: 'Arabisch', en: 'Arabic', native: 'العربية' },
  { id: 'Persian', de: 'Persisch', en: 'Persian', native: 'فارسی' },
  { id: 'Hindi', de: 'Hindi', en: 'Hindi', native: 'हिन्दी' },
  { id: 'Chinese', de: 'Chinesisch', en: 'Chinese', native: '中文' },
  { id: 'Cantonese', de: 'Kantonesisch', en: 'Cantonese', native: '粵語' },
  { id: 'Japanese', de: 'Japanisch', en: 'Japanese', native: '日本語' },
  { id: 'Korean', de: 'Koreanisch', en: 'Korean', native: '한국어' },
  { id: 'Thai', de: 'Thailändisch', en: 'Thai', native: 'ไทย' },
  { id: 'Vietnamese', de: 'Vietnamesisch', en: 'Vietnamese', native: 'Tiếng Việt' },
  { id: 'Indonesian', de: 'Indonesisch', en: 'Indonesian', native: 'Bahasa Indonesia' },
  { id: 'Malay', de: 'Malaiisch', en: 'Malay', native: 'Bahasa Melayu' },
  { id: 'Filipino', de: 'Filipino', en: 'Filipino', native: 'Tagalog' },
];

const ASR_META_BY_ID = new Map(QWEN_ASR_LANGUAGE_META.map((m) => [m.id, m]));

export function buildAsrLanguageOptions(
  lang: UiLang,
  currentValue?: string | null
): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = [
    {
      value: 'auto',
      label:
        lang === 'en'
          ? 'Auto-detect (all 30 languages)'
          : 'Automatisch (alle 30 Sprachen)',
    },
    {
      value: 'German,English',
      label:
        lang === 'en'
          ? 'German + English (Bilingual)'
          : 'Deutsch + Englisch (Zweisprachig)',
    },
    ...QWEN_ASR_LANGUAGE_META.map((item) => {
      const localName = lang === 'en' ? item.en : item.de;
      const label =
        localName === item.native
          ? localName
          : `${localName} (${item.native})`;
      return { value: item.id, label };
    }),
  ];
  const cleanCur = (currentValue || '').trim();
  if (
    cleanCur &&
    cleanCur !== '*' &&
    !options.some((o) => o.value === cleanCur)
  ) {
    options.splice(2, 0, {
      value: cleanCur,
      label: formatAsrLanguageLabel(cleanCur, lang),
    });
  }
  return options;
}

export function formatAsrLanguageLabel(
  raw: string | null | undefined,
  lang: UiLang,
  compact = false
): string {
  const clean = (raw || '').trim();
  if (!clean || clean === 'auto' || clean === '*') {
    if (compact) {
      return lang === 'en' ? 'Auto (30)' : 'Auto (30)';
    }
    return lang === 'en'
      ? 'Auto (all 30 languages)'
      : 'Automatisch (alle 30 Sprachen)';
  }
  const parts = clean
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return parts
    .map((p) => {
      const meta = ASR_META_BY_ID.get(p);
      if (!meta) return p;
      return lang === 'en' ? meta.en : meta.de;
    })
    .join(' + ');
}

export function localizeKeyframeCapability(
  capability: string,
  lang: UiLang,
  fallbackDe: Record<string, string>
): string {
  if (lang === 'en') {
    return KEYFRAME_CAPABILITY_EN[capability] || capability;
  }
  return fallbackDe[capability] || capability;
}

const PROCESSING_EN: Record<string, string> = {
  pending: 'Pending',
  processing: 'Transcribing',
  completed: 'Completed',
  failed: 'Failed',
};

export function localizeProcessing(
  status: string,
  lang: UiLang,
  fallbackDe: Record<string, string>
): string {
  if (lang === 'en') {
    return PROCESSING_EN[status] || status;
  }
  return fallbackDe[status] || status;
}
