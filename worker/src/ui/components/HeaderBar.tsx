import React from 'react';
import {
  AudioLines,
  Calendar,
  CalendarPlus,
  FileText,
  HelpCircle,
  Home,
  KeyRound,
  Moon,
  RefreshCw,
  Search,
  ShieldCheck,
  Sun,
} from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Avatar } from '@astryxdesign/core/Avatar';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import { Text } from '@astryxdesign/core/Text';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Token } from '@astryxdesign/core/Token';
import { Switch } from '@astryxdesign/core/Switch';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import {
  SideNav,
  SideNavHeading,
  SideNavItem,
  SideNavSection,
} from '@astryxdesign/core/SideNav';
import type { AuthMode } from '../types';
import { useThemeMode, type ThemeMode } from './ui/primitives';

export type NavSection = 'home' | 'meetings' | 'calendar' | 'system';

export interface HeaderBarProps {
  healthy: boolean;
  authMode: AuthMode;
  hasSavedAccount?: boolean;
  onReturnToAccount?: () => void;
  activeNav: NavSection;
  hasSelectedRecording?: boolean;
  onChangeNav: (nav: NavSection) => void;
  recordingsCount: number;
  activeLiveCount: number;
  calendarCount: number;
  calendarConnectedCount?: number;
  livePoll: boolean;
  onToggleLivePoll: (enabled: boolean) => void;
  onManualRefresh: () => void;
  onOpenNewRecording: () => void;
  onOpenAuthDialog: () => void;
  onOpenCommandPalette?: () => void;
}

export function ReaderTopBar({
  healthy,
  authMode,
  hasSavedAccount,
  onReturnToAccount,
  onOpenAuthDialog,
}: Pick<
  HeaderBarProps,
  | 'healthy'
  | 'authMode'
  | 'hasSavedAccount'
  | 'onReturnToAccount'
  | 'onOpenAuthDialog'
>) {
  const { mode, setMode } = useThemeMode();

  return (
    <HStack
      as="header"
      justify="between"
      vAlign="center"
      wrap="wrap"
      gap={3}
      paddingInline={4}
      paddingBlock={2}
      className="border-b border-[var(--color-border)] bg-[var(--color-background-surface)]"
    >
      <HStack gap={2} vAlign="center" wrap="wrap">
        <a
          id="brand-home-link"
          href="#view=home"
          onClick={(e) => {
            if (authMode.kind === 'reader' && hasSavedAccount && onReturnToAccount) {
              e.preventDefault();
              onReturnToAccount();
            }
          }}
          title="Zur wortlaut Startseite"
          className="group flex items-center gap-2.5 rounded-lg px-1.5 py-1 no-underline transition-colors hover:bg-[var(--color-background-muted)] focus:outline-none"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-background-accent-subtle,#2563eb1a)] text-[var(--color-text-accent,#3b82f6)] ring-1 ring-[var(--color-border)] transition-transform group-hover:scale-105">
            <AudioLines className="h-4 w-4" />
          </span>
          <HStack gap={1.5} vAlign="center">
            <Text type="body" weight="bold">
              wortlaut
            </Text>
            <span id="health-dot">
              <StatusDot
                variant={healthy ? 'success' : 'error'}
                label=""
                tooltip={healthy ? 'System bereit' : 'System nicht erreichbar'}
              />
            </span>
          </HStack>
        </a>
        {authMode.kind === 'reader' ? (
          <Token
            size="sm"
            color="blue"
            icon={<ShieldCheck className="h-3 w-3" />}
            label="Freigegebenes Transkript (Nur-Lese-Link)"
          />
        ) : (
          <Text type="supporting" color="secondary">
            Google Meet · Microsoft Teams · Cisco Webex · Zoom
          </Text>
        )}
      </HStack>

      <HStack gap={2} vAlign="center" wrap="wrap">
        <SegmentedControl
          size="sm"
          label="Farbschema"
          value={mode}
          onChange={(v) => setMode(v as ThemeMode)}
        >
          <SegmentedControlItem
            value="light"
            label="Hell"
            icon={<Sun className="h-3.5 w-3.5" />}
          />
          <SegmentedControlItem
            value="dark"
            label="Dunkel"
            icon={<Moon className="h-3.5 w-3.5" />}
          />
          <SegmentedControlItem value="system" label="Auto" />
        </SegmentedControl>

        {authMode.kind === 'reader' && hasSavedAccount && onReturnToAccount && (
          <span id="return-to-account-btn">
            <Button
              variant="primary"
              size="sm"
              icon={<Home className="h-3.5 w-3.5" />}
              label="Zurück zu meinem Konto"
              onClick={onReturnToAccount}
            />
          </span>
        )}
        <Button
          variant={authMode.kind === 'unauthenticated' ? 'primary' : 'secondary'}
          size="sm"
          icon={<KeyRound className="h-3.5 w-3.5" />}
          label={authMode.kind === 'reader' ? 'Zugang wechseln' : 'Anmelden'}
          onClick={onOpenAuthDialog}
        />
      </HStack>
    </HStack>
  );
}

export function HeaderBar({
  healthy,
  authMode,
  activeNav,
  hasSelectedRecording = false,
  onChangeNav,
  recordingsCount,
  activeLiveCount,
  calendarCount,
  calendarConnectedCount = 0,
  livePoll,
  onToggleLivePoll,
  onManualRefresh,
  onOpenNewRecording,
  onOpenAuthDialog,
  onOpenCommandPalette,
}: HeaderBarProps) {
  const { mode, setMode } = useThemeMode();
  const isHomeSelected = activeNav === 'home' && !hasSelectedRecording;
  const isMeetingsSelected = activeNav === 'meetings' || hasSelectedRecording;

  return (
    <SideNav
      collapsible={{ defaultIsCollapsed: false, hasButton: true }}
      header={
        <div
          id="brand-home-link"
          onClick={() => onChangeNav('home')}
        >
          <SideNavHeading
            icon={
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-background-accent-subtle,#2563eb1a)] text-[var(--color-text-accent,#3b82f6)] ring-1 ring-[var(--color-border)]">
                <AudioLines className="h-4 w-4" />
              </span>
            }
            heading="wortlaut"
            headingHref="#view=home"
            subheading="Meet · Teams · Webex · Zoom"
            headerEndContent={
              <span id="health-dot">
                <StatusDot
                  variant={healthy ? 'success' : 'error'}
                  label=""
                  tooltip={healthy ? 'System bereit' : 'System nicht erreichbar'}
                />
              </span>
            }
          />
        </div>
      }
      topContent={
        authMode.kind === 'operator' ? (
          <VStack gap={1.5} paddingInline={2} paddingBlockEnd={1}>
            <span id="open-dispatch-modal-btn" className="contents">
              <Button
                variant="primary"
                size="sm"
                width="fill"
                icon={<CalendarPlus className="h-3.5 w-3.5" />}
                label="Neue Aufnahme"
                onClick={onOpenNewRecording}
              />
            </span>
            {onOpenCommandPalette && (
              <Button
                variant="ghost"
                size="sm"
                width="fill"
                icon={<Search className="h-3.5 w-3.5" />}
                label="Schnellsuche (⌘K)"
                onClick={onOpenCommandPalette}
              />
            )}
          </VStack>
        ) : undefined
      }
      footer={
        <VStack gap={2} paddingInline={2} paddingBlock={1.5}>
          <HStack justify="between" vAlign="center" gap={1}>
            <Switch
              size="sm"
              label="Live-Update (3s)"
              value={livePoll}
              onChange={(checked) => onToggleLivePoll(checked)}
            />
            <input
              id="auto-refresh"
              type="checkbox"
              checked={livePoll}
              onChange={(e) => onToggleLivePoll(e.target.checked)}
              className="sr-only"
              aria-hidden="true"
              tabIndex={-1}
            />
            <span id="refresh-btn">
              <IconButton
                variant="ghost"
                size="sm"
                label="Daten jetzt aktualisieren"
                tooltip="Jetzt aktualisieren"
                icon={<RefreshCw className="h-3.5 w-3.5" />}
                onClick={onManualRefresh}
              />
            </span>
          </HStack>

          <SegmentedControl
            size="sm"
            layout="fill"
            label="Farbschema"
            value={mode}
            onChange={(v) => setMode(v as ThemeMode)}
          >
            <SegmentedControlItem value="light" label="Hell" />
            <SegmentedControlItem value="dark" label="Dunkel" />
            <SegmentedControlItem value="system" label="Auto" />
          </SegmentedControl>

          {authMode.kind === 'operator' && authMode.user ? (
            <button
              type="button"
              onClick={onOpenAuthDialog}
              className="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors hover:bg-[var(--color-background-muted)] cursor-pointer"
            >
              <Avatar
                size="sm"
                shape="circle"
                name={authMode.user.name || authMode.user.email}
              />
              <div className="min-w-0 flex-1">
                <Text type="supporting" weight="semibold" maxLines={1}>
                  {authMode.user.name || authMode.user.email}
                </Text>
                <Text type="supporting" color="secondary" maxLines={1}>
                  {authMode.user.email}
                </Text>
              </div>
            </button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              width="fill"
              icon={<KeyRound className="h-3.5 w-3.5" />}
              label={
                authMode.kind === 'operator'
                  ? 'API-Schlüssel aktiv'
                  : 'Anmelden'
              }
              onClick={onOpenAuthDialog}
            />
          )}
        </VStack>
      }
    >
      {authMode.kind === 'operator' && (
        <SideNavSection title="Navigation" isHeaderHidden>
          <SideNavItem
            label="Startseite"
            icon={<Home className="h-4 w-4" />}
            isSelected={isHomeSelected}
            onClick={() => onChangeNav('home')}
          />
          <SideNavItem
            label="Aufnahmen"
            icon={<FileText className="h-4 w-4" />}
            isSelected={isMeetingsSelected}
            onClick={() => onChangeNav('meetings')}
            endContent={
              <HStack gap={1} vAlign="center">
                {activeLiveCount > 0 && (
                  <StatusDot
                    variant="success"
                    isPulsing
                    label={`${activeLiveCount} live`}
                  />
                )}
                <Token size="sm" label={String(recordingsCount)} />
              </HStack>
            }
          />
          <SideNavItem
            label="Kalender"
            icon={<Calendar className="h-4 w-4" />}
            isSelected={activeNav === 'calendar'}
            onClick={() => onChangeNav('calendar')}
            endContent={
              <HStack gap={1} vAlign="center">
                {calendarConnectedCount > 0 && (
                  <StatusDot
                    variant="success"
                    label="Kalender verbunden"
                    tooltip="Kalender-Synchronisation aktiv"
                  />
                )}
                <span id="calendar-count">
                  <Token size="sm" label={String(calendarCount)} />
                </span>
              </HStack>
            }
          />
          <SideNavItem
            label="System & Hilfe"
            icon={<HelpCircle className="h-4 w-4" />}
            isSelected={activeNav === 'system'}
            onClick={() => onChangeNav('system')}
          />
        </SideNavSection>
      )}
    </SideNav>
  );
}
