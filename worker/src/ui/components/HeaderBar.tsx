import React from 'react';
import {
  ArrowLeft,
  AudioLines,
  Calendar,
  FileText,
  HelpCircle,
  KeyRound,
  Monitor,
  Moon,
  Plus,
  Search,
  ShieldCheck,
  Sun,
  Terminal,
} from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { Avatar } from '@astryxdesign/core/Avatar';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import { Text } from '@astryxdesign/core/Text';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Token } from '@astryxdesign/core/Token';
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
import { useI18n, type UiLang } from '../i18n';
import { useThemeMode, type ThemeMode } from './ui/primitives';

export type NavSection = 'meetings' | 'calendar' | 'mcp' | 'system';

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
  mcpGrantCount?: number;
  onOpenNewRecording: () => void;
  onOpenAuthDialog: () => void;
  onOpenCommandPalette?: () => void;
}

function nextThemeMode(cur: ThemeMode): ThemeMode {
  if (cur === 'dark') return 'light';
  if (cur === 'light') return 'system';
  return 'dark';
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
  const { lang, setLang, tr } = useI18n();

  const themeIcon =
    mode === 'light' ? (
      <Sun className="h-3.5 w-3.5" />
    ) : mode === 'dark' ? (
      <Moon className="h-3.5 w-3.5" />
    ) : (
      <Monitor className="h-3.5 w-3.5" />
    );
  const themeLabel =
    mode === 'light'
      ? tr('Hell', 'Light')
      : mode === 'dark'
        ? tr('Dunkel', 'Dark')
        : 'Auto';

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
          href="#view=meetings"
          onClick={(e) => {
            if (
              authMode.kind === 'reader' &&
              hasSavedAccount &&
              onReturnToAccount
            ) {
              e.preventDefault();
              onReturnToAccount();
            }
          }}
          title={tr(
            'Zur Wortlaut.cloud Übersicht',
            'Go to Wortlaut.cloud overview'
          )}
          className="group flex items-center gap-2 rounded-lg px-1.5 py-1 no-underline transition-colors hover:bg-[var(--color-background-muted)]"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-lg wl-brand-badge">
            <AudioLines className="h-4 w-4" />
          </span>
          <HStack gap={1.5} vAlign="center">
            <Text type="body" weight="bold">
              Wortlaut.cloud
            </Text>
            <span id="health-dot">
              <StatusDot
                variant={healthy ? 'success' : 'error'}
                label=""
                tooltip={
                  healthy
                    ? tr('System bereit', 'System ready')
                    : tr('System nicht erreichbar', 'System unreachable')
                }
              />
            </span>
          </HStack>
        </a>

        {authMode.kind === 'reader' && (
          <Token
            size="sm"
            color="blue"
            icon={<ShieldCheck className="h-3 w-3" />}
            label={tr('Lese-Ansicht', 'Read-only view')}
          />
        )}
      </HStack>

      <HStack gap={2} vAlign="center" wrap="wrap">
        <SegmentedControl
          size="sm"
          label={tr('Sprache', 'Language')}
          value={lang}
          onChange={(v) => setLang(v as UiLang)}
        >
          <SegmentedControlItem value="de" label="DE" />
          <SegmentedControlItem value="en" label="EN" />
        </SegmentedControl>

        <Button
          variant="ghost"
          size="sm"
          icon={themeIcon}
          label={themeLabel}
          onClick={() => setMode(nextThemeMode(mode))}
        />

        {authMode.kind === 'reader' && hasSavedAccount && onReturnToAccount && (
          <span id="return-to-account-btn">
            <Button
              variant="primary"
              size="sm"
              icon={<ArrowLeft className="h-3.5 w-3.5" />}
              label={tr('Zu meinem Konto', 'My account')}
              onClick={onReturnToAccount}
            />
          </span>
        )}
        {authMode.kind === 'reader' && (
          <Button
            variant="secondary"
            size="sm"
            icon={<KeyRound className="h-3.5 w-3.5" />}
            label={tr('Anmelden', 'Sign in')}
            onClick={onOpenAuthDialog}
          />
        )}
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
  mcpGrantCount = 0,
  onOpenNewRecording,
  onOpenAuthDialog,
  onOpenCommandPalette,
}: HeaderBarProps) {
  const { mode, setMode } = useThemeMode();
  const { lang, setLang, tr } = useI18n();
  const isMeetingsSelected = activeNav === 'meetings' || hasSelectedRecording;

  const themeIcon =
    mode === 'light' ? (
      <Sun className="h-3.5 w-3.5" />
    ) : mode === 'dark' ? (
      <Moon className="h-3.5 w-3.5" />
    ) : (
      <Monitor className="h-3.5 w-3.5" />
    );
  const themeLabel =
    mode === 'light'
      ? tr('Hell', 'Light')
      : mode === 'dark'
        ? tr('Dunkel', 'Dark')
        : 'Auto';

  return (
    <SideNav
      collapsible={{ defaultIsCollapsed: false, hasButton: true }}
      header={
        <div id="brand-home-link" onClick={() => onChangeNav('meetings')}>
          <SideNavHeading
            icon={
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg wl-brand-badge">
                <AudioLines className="h-4 w-4" />
              </span>
            }
            heading="Wortlaut.cloud"
            headingHref="#view=meetings"
            headerEndContent={
              <span id="health-dot">
                <StatusDot
                  variant={healthy ? 'success' : 'error'}
                  label=""
                  tooltip={
                    healthy
                      ? tr('System bereit', 'System ready')
                      : tr('System nicht erreichbar', 'System unreachable')
                  }
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
                icon={<Plus className="h-3.5 w-3.5" />}
                label={tr('Neue Aufnahme', 'New recording')}
                onClick={onOpenNewRecording}
              />
            </span>
            {onOpenCommandPalette && (
              <Button
                variant="ghost"
                size="sm"
                width="fill"
                icon={<Search className="h-3.5 w-3.5" />}
                label={tr('Suche (⌘K)', 'Search (⌘K)')}
                onClick={onOpenCommandPalette}
              />
            )}
          </VStack>
        ) : undefined
      }
      footer={
        <VStack gap={2} paddingInline={2} paddingBlock={1.5}>
          <HStack justify="between" vAlign="center" gap={1.5}>
            <Button
              variant="ghost"
              size="sm"
              icon={themeIcon}
              label={themeLabel}
              onClick={() => setMode(nextThemeMode(mode))}
            />
            <SegmentedControl
              size="sm"
              label={tr('Sprache', 'Language')}
              value={lang}
              onChange={(v) => setLang(v as UiLang)}
            >
              <SegmentedControlItem value="de" label="DE" />
              <SegmentedControlItem value="en" label="EN" />
            </SegmentedControl>
          </HStack>

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
                  ? tr('API-Schlüssel aktiv', 'API key active')
                  : tr('Anmelden', 'Sign in')
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
            label={tr('Aufnahmen', 'Recordings')}
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
            label={tr('Kalender', 'Calendar')}
            icon={<Calendar className="h-4 w-4" />}
            isSelected={activeNav === 'calendar'}
            onClick={() => onChangeNav('calendar')}
            endContent={
              <HStack gap={1} vAlign="center">
                {calendarConnectedCount > 0 && (
                  <StatusDot
                    variant="success"
                    label=""
                    tooltip={tr(
                      'Kalender-Synchronisation aktiv',
                      'Calendar sync active'
                    )}
                  />
                )}
                <span id="calendar-count">
                  <Token size="sm" label={String(calendarCount)} />
                </span>
              </HStack>
            }
          />
          <SideNavItem
            label="MCP"
            icon={<Terminal className="h-4 w-4" />}
            isSelected={activeNav === 'mcp'}
            onClick={() => onChangeNav('mcp')}
            endContent={
              mcpGrantCount > 0 ? (
                <Token size="sm" color="green" label={String(mcpGrantCount)} />
              ) : undefined
            }
          />
          <SideNavItem
            label="System"
            icon={<HelpCircle className="h-4 w-4" />}
            isSelected={activeNav === 'system'}
            onClick={() => onChangeNav('system')}
          />
        </SideNavSection>
      )}
    </SideNav>
  );
}
