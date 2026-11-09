import React, { createContext, useContext } from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { Token } from '@astryxdesign/core/Token';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { HStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import type { ParticipationState, Provider } from '../../types';
import { PARTICIPATION_LABELS, PROVIDER_LABELS } from '../../api';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export type ThemeMode = 'light' | 'dark' | 'system';

export interface ThemeModeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

export const ThemeModeContext = createContext<ThemeModeContextValue>({
  mode: 'dark',
  setMode: () => {},
});

export function useThemeMode(): ThemeModeContextValue {
  return useContext(ThemeModeContext);
}

export function LiveWaveform({ className }: { className?: string }) {
  return (
    <span
      className={cn('wl-waveform text-emerald-500', className)}
      aria-hidden="true"
    >
      <span className="wl-wave-bar" />
      <span className="wl-wave-bar" />
      <span className="wl-wave-bar" />
      <span className="wl-wave-bar" />
    </span>
  );
}

export function ProviderIcon({
  provider,
  size = 14,
}: {
  provider: Provider;
  size?: number;
}) {
  if (provider === 'google_meet') {
    return (
      <svg
        width={Math.round(size * 1.18)}
        height={size}
        viewBox="0 0 87.5 72"
        aria-hidden="true"
        className="shrink-0"
      >
        <path
          fill="#00832d"
          d="M49.5 36l8.53 9.75 11.47 7.33 2-17.02-2-16.64-11.69 6.44z"
        />
        <path
          fill="#0066da"
          d="M0 51.5V66c0 3.315 2.685 6 6 6h14.5l3-10.96-3-9.54-9.95-3z"
        />
        <path
          fill="#e94235"
          d="M20.5 0L0 20.5l10.55 3 9.95-3 2.95-9.41z"
        />
        <path fill="#2684fc" d="M20.5 20.5H0v31h20.5z" />
        <path
          fill="#00ac47"
          d="M82.6 8.68L69.5 19.42v33.66l13.16 10.79c1.97 1.54 4.85.135 4.85-2.37V11c0-2.535-2.945-3.925-4.91-2.32zM49.5 36v15.5h-29V72h43c3.315 0 6-2.685 6-6V53.08z"
        />
        <path
          fill="#ffba00"
          d="M63.5 0h-43v20.5h29V36l20-16.57V6c0-3.315-2.685-6-6-6z"
        />
      </svg>
    );
  }
  if (provider === 'teams') {
    return (
      <svg
        width={size + 1}
        height={size + 1}
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="shrink-0"
      >
        <circle cx="19.5" cy="6.2" r="2.3" fill="#5059C9" />
        <path
          d="M16.5 10h5a1.5 1.5 0 0 1 1.5 1.5v4.2a2.8 2.8 0 0 1-2.8 2.8h-2.2v-7A1.5 1.5 0 0 0 16.5 10z"
          fill="#5059C9"
        />
        <circle cx="14.2" cy="4.8" r="2.8" fill="#7B83EB" />
        <path
          d="M9.5 9.5h9a2 2 0 0 1 2 2v6a4.5 4.5 0 0 1-4.5 4.5h-4A4.5 4.5 0 0 1 7.5 17.5v-6a2 2 0 0 1 2-2z"
          fill="#7B83EB"
        />
        <rect x="1" y="5.5" width="12" height="12" rx="2.2" fill="#4B53BC" />
        <path
          d="M4.2 8.7h5.6v1.5H7.8v5.1H6.2v-5.1H4.2V8.7z"
          fill="#ffffff"
        />
      </svg>
    );
  }
  if (provider === 'webex') {
    return (
      <svg
        width={Math.round(size * 1.25)}
        height={size}
        viewBox="0 0 36 28"
        aria-hidden="true"
        className="shrink-0"
      >
        <path
          d="M2 6.5a3 3 0 0 1 5.5-1.6l4.8 9.2 4.3-8.2a3 3 0 0 1 5.3 0l4.3 8.2 4.8-9.2a3 3 0 1 1 5.3 2.8l-7.4 14.2a3.1 3.1 0 0 1-5.5 0l-4.2-8-4.2 8a3.1 3.1 0 0 1-5.5 0L2.1 7.7A3 3 0 0 1 2 6.5z"
          fill="#00BCEB"
        />
        <path
          d="M13.6 15.9l3-5.8a3 3 0 0 1 5.3 0l4.3 8.2 4.8-9.2a3 3 0 1 1 5.3 2.8l-7.4 14.2a3.1 3.1 0 0 1-5.5 0l-4.5-8.6z"
          fill="#07C160"
          opacity="0.9"
        />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect x="0" y="0" width="28" height="28" rx="7.5" fill="#0B5CFF" />
      <rect x="4.8" y="8.5" width="11.5" height="11" rx="2.4" fill="#ffffff" />
      <path
        d="M17.5 11.6l4.5-2.7a.8.8 0 0 1 1.2.7v8.8a.8.8 0 0 1-1.2.7l-4.5-2.7v-4.8z"
        fill="#ffffff"
      />
    </svg>
  );
}

export function ProviderBadge({
  provider,
  size = 'sm',
}: {
  provider: Provider;
  size?: 'sm' | 'md' | 'lg';
}) {
  const colorMap: Record<Provider, 'green' | 'purple' | 'blue' | 'cyan'> = {
    google_meet: 'green',
    teams: 'purple',
    webex: 'blue',
    zoom: 'cyan',
  };
  return (
    <Token
      size={size}
      color={colorMap[provider] || 'gray'}
      icon={<ProviderIcon provider={provider} size={size === 'lg' ? 16 : 13} />}
      label={PROVIDER_LABELS[provider] || provider}
    />
  );
}

export function StatusIndicator({
  variant = 'neutral',
  isPulsing = false,
  showWaveform = false,
  label,
  weight = 'normal',
}: {
  variant?: 'success' | 'warning' | 'error' | 'accent' | 'neutral';
  isPulsing?: boolean;
  showWaveform?: boolean;
  label: string;
  weight?: 'normal' | 'medium' | 'semibold' | 'bold';
}) {
  return (
    <HStack gap={1.5} vAlign="center" wrap="nowrap">
      {showWaveform ? (
        <LiveWaveform />
      ) : (
        <StatusDot variant={variant} isPulsing={isPulsing} label={label} />
      )}
      <Text type="supporting" weight={weight} maxLines={1}>
        {label}
      </Text>
    </HStack>
  );
}

export function StatusBadge({
  participation,
  processing,
  hasError,
}: {
  participation: ParticipationState;
  processing?: string;
  hasError?: boolean;
}) {
  let variant: 'success' | 'warning' | 'error' | 'accent' | 'neutral' = 'neutral';
  let isPulsing = false;
  let showWaveform = false;
  let label = PARTICIPATION_LABELS[participation] || participation;

  if (participation === 'capturing') {
    variant = 'success';
    isPulsing = true;
    showWaveform = true;
    label = 'Zeichnet live auf';
  } else if (participation === 'waiting_admission') {
    variant = 'warning';
    isPulsing = true;
    label = 'Im Warteraum';
  } else if (
    participation === 'joining' ||
    participation === 'preparing' ||
    participation === 'starting'
  ) {
    variant = 'accent';
    isPulsing = true;
    label = PARTICIPATION_LABELS[participation] || 'Tritt Meeting bei…';
  } else if (participation === 'scheduled') {
    variant = 'neutral';
    label = 'Geplant';
  } else if (participation === 'ended') {
    if (hasError || processing === 'failed') {
      variant = 'error';
      label = processing === 'failed' ? 'Verarbeitungsfehler' : 'Mit Hinweis beendet';
    } else if (processing === 'completed') {
      variant = 'success';
      label = 'Protokoll fertig';
    } else {
      variant = 'accent';
      isPulsing = true;
      label = 'Erstellt Protokoll…';
    }
  }

  return (
    <StatusIndicator
      variant={variant}
      isPulsing={isPulsing}
      showWaveform={showWaveform}
      label={label}
      weight="semibold"
    />
  );
}
