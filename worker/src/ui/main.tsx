import './layers.css';
import './styles.css';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Theme } from '@astryxdesign/core/theme';
import { stoneTheme } from '@astryxdesign/theme-stone/built';
import { App } from './App';
import { ThemeModeContext, type ThemeMode } from './components/ui/primitives';
import { I18nProvider } from './i18n';

const THEME_STORAGE_KEY = 'wortlaut_theme_mode';

function loadInitialThemeMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') {
      return raw;
    }
  } catch {
    // ignore storage errors
  }
  return 'dark';
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000,
      refetchOnWindowFocus: false,
    },
  },
});

function Root() {
  const [mode, setModeState] = useState<ThemeMode>(loadInitialThemeMode);

  const setMode = (next: ThemeMode) => {
    setModeState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
  };

  return (
    <ThemeModeContext.Provider value={{ mode, setMode }}>
      <I18nProvider>
        <Theme theme={stoneTheme} mode={mode}>
          <QueryClientProvider client={queryClient}>
            <App />
          </QueryClientProvider>
        </Theme>
      </I18nProvider>
    </ThemeModeContext.Provider>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>
  );
}
