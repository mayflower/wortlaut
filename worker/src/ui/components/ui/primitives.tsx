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

export function ProviderBadge({
  provider,
  size = 'sm',
}: {
  provider: Provider;
  size?: 'sm' | 'md' | 'lg';
}) {
  const colorMap: Record<Provider, 'green' | 'purple' | 'blue'> = {
    google_meet: 'green',
    teams: 'purple',
    webex: 'blue',
  };
  return (
    <Token
      size={size}
      color={colorMap[provider] || 'gray'}
      label={PROVIDER_LABELS[provider] || provider}
    />
  );
}

export function StatusIndicator({
  variant = 'neutral',
  isPulsing = false,
  label,
  weight = 'normal',
}: {
  variant?: 'success' | 'warning' | 'error' | 'accent' | 'neutral';
  isPulsing?: boolean;
  label: string;
  weight?: 'normal' | 'medium' | 'semibold' | 'bold';
}) {
  return (
    <HStack gap={1.5} vAlign="center" wrap="nowrap">
      <StatusDot variant={variant} isPulsing={isPulsing} label={label} />
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
  let label = PARTICIPATION_LABELS[participation] || participation;

  if (participation === 'capturing') {
    variant = 'success';
    isPulsing = true;
    label = 'Zeichnet auf';
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
      label = 'Transkript fertig';
    } else {
      variant = 'accent';
      isPulsing = true;
      label = 'Verarbeitet Audio…';
    }
  }

  return <StatusIndicator variant={variant} isPulsing={isPulsing} label={label} weight="medium" />;
}
