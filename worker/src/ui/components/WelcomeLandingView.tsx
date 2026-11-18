import React, { useState } from 'react';
import { Check, Copy, KeyRound, LogIn } from 'lucide-react';
import { Center } from '@astryxdesign/core/Center';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@astryxdesign/core/Button';
import { Banner } from '@astryxdesign/core/Banner';
import { Divider } from '@astryxdesign/core/Divider';
import { Avatar } from '@astryxdesign/core/Avatar';
import { getInstanceInfo } from '../api';
import { useI18n } from '../i18n';
import { LiveWaveform, ProviderBadge } from './ui/primitives';

export interface WelcomeLandingViewProps {
  healthy: boolean;
  authError: string | null;
  onConnectToken: (token: string) => void;
  onStartOidcLogin: () => void;
  onOpenAuthDialog: () => void;
}

function extractTokenInput(raw: string): string {
  const trimmed = raw.trim();
  const hashIdx = trimmed.indexOf('#token=');
  if (hashIdx >= 0) {
    return decodeURIComponent(trimmed.slice(hashIdx + '#token='.length).trim());
  }
  return trimmed;
}

const EXAMPLE_LINES_DE = [
  {
    time: '00:00:14',
    speaker: 'Anna Lindner',
    share: '46 %',
    text: 'Lass uns kurz die offenen Punkte für das Release am Donnerstag durchgehen.',
  },
  {
    time: '00:00:23',
    speaker: 'Markus Berg',
    share: '34 %',
    text: 'Die Migration auf dem Datenbank-Cluster ist abgeschlossen, es fehlt nur noch der gemeinsame Abnahmetest.',
  },
  {
    time: '00:00:35',
    speaker: 'Julia Vogt',
    share: '20 %',
    text: 'Perfekt, dann planen wir den Testlauf für morgen um zehn Uhr ein und teilen danach direkt das Protokoll.',
  },
];

const EXAMPLE_LINES_EN = [
  {
    time: '00:00:14',
    speaker: 'Anna Lindner',
    share: '46%',
    text: 'Let us walk through the open items for Thursday’s release.',
  },
  {
    time: '00:00:23',
    speaker: 'Markus Berg',
    share: '34%',
    text: 'The database cluster migration is complete—we only need the joint acceptance test.',
  },
  {
    time: '00:00:35',
    speaker: 'Julia Vogt',
    share: '20%',
    text: 'Great, let us schedule the test run for tomorrow at 10:00 and share the meeting protocol right after.',
  },
];

export function WelcomeLandingView({
  authError,
  onConnectToken,
  onStartOidcLogin,
}: WelcomeLandingViewProps) {
  const { lang, tr } = useI18n();
  const instance = getInstanceInfo();
  const oidcEnabled = Boolean(instance.oidc?.enabled);
  const [tokenInput, setTokenInput] = useState('');
  const [showTokenForm, setShowTokenForm] = useState(!oidcEnabled);
  const [copiedMail, setCopiedMail] = useState(false);

  const exampleLines = lang === 'en' ? EXAMPLE_LINES_EN : EXAMPLE_LINES_DE;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = extractTokenInput(tokenInput);
    if (!cleaned) return;
    onConnectToken(cleaned);
  };

  const handleCopyBotMail = async () => {
    if (!instance.botEmail || !navigator.clipboard) return;
    await navigator.clipboard.writeText(instance.botEmail).catch(() => {});
    setCopiedMail(true);
    setTimeout(() => setCopiedMail(false), 1800);
  };

  return (
    <Center axis="horizontal" paddingBlock={10} paddingInline={4}>
      <div className="w-full max-w-5xl grid grid-cols-1 gap-10 lg:grid-cols-12 lg:items-center">
        {/* Left column: Focal value proposition + Sign-in */}
        <VStack gap={5} className="lg:col-span-5">
          <VStack gap={2}>
            <HStack gap={1.5} wrap="wrap">
              {instance.providers.google_meet && (
                <ProviderBadge provider="google_meet" />
              )}
              {instance.providers.teams && <ProviderBadge provider="teams" />}
              {instance.providers.webex && <ProviderBadge provider="webex" />}
              {instance.providers.zoom && <ProviderBadge provider="zoom" />}
            </HStack>

            <Heading level={1}>
              {tr(
                'Wortprotokolle auf eigener Infrastruktur',
                'Self-Hosted Meeting Protocols'
              )}
            </Heading>
            <Text type="body" color="secondary" className="max-w-[54ch]">
              {tr(
                'Stiller Konferenz-Zuhörer mit isolierter Sprecherzuordnung vor dem Audio-Mix — ohne Cloud-Weitergabe und ohne Stimmprofile.',
                'Silent meeting participant with isolated pre-mix speaker attribution — zero cloud sharing and zero voiceprints.'
              )}
            </Text>
          </VStack>

          <Card>
            <VStack gap={3}>
              <Heading level={2}>{tr('Anmelden', 'Sign in')}</Heading>

              {authError && (
                <Banner status="error" container="card" title={authError} />
              )}

              {oidcEnabled && (
                <span id="oidc-login-btn" className="contents">
                  <Button
                    type="button"
                    variant="primary"
                    size="md"
                    width="fill"
                    icon={<LogIn className="h-4 w-4" />}
                    label={tr(
                      'Mit SSO anmelden (OIDC)',
                      'Sign in with SSO (OIDC)'
                    )}
                    onClick={onStartOidcLogin}
                  />
                </span>
              )}

              {oidcEnabled && !showTokenForm ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  label={tr(
                    'Lese-Token oder API-Schlüssel verwenden',
                    'Use read-only token or API key'
                  )}
                  onClick={() => setShowTokenForm(true)}
                />
              ) : (
                <form onSubmit={handleSubmit}>
                  <FormLayout direction="vertical">
                    {oidcEnabled && <Divider variant="subtle" />}
                    <div id="landing-token-input">
                      <TextInput
                        type="password"
                        label={tr(
                          'Lese-Token oder API-Schlüssel',
                          'Read-only token or API key'
                        )}
                        value={tokenInput}
                        onChange={setTokenInput}
                        placeholder={tr(
                          'wortlaut-read-… oder API-Schlüssel',
                          'wortlaut-read-… or API key'
                        )}
                      />
                    </div>
                    <Button
                      type="submit"
                      variant={oidcEnabled ? 'secondary' : 'primary'}
                      size="sm"
                      width="fill"
                      isDisabled={!tokenInput.trim()}
                      icon={<KeyRound className="h-3.5 w-3.5" />}
                      label={tr('Mit Token öffnen', 'Open with token')}
                    />
                  </FormLayout>
                </form>
              )}
            </VStack>
          </Card>

          <HStack gap={2} wrap="wrap" vAlign="center">
            {instance.botEmail && (
              <Button
                variant="ghost"
                size="sm"
                icon={
                  copiedMail ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )
                }
                label={
                  copiedMail
                    ? tr('Kopiert', 'Copied')
                    : `${tr('Per E-Mail einladen:', 'Invite via email:')} ${instance.botEmail}`
                }
                onClick={handleCopyBotMail}
              />
            )}
            <Text type="supporting" color="secondary">
              <a
                href={`/privacy?lang=${lang}`}
                className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] underline"
              >
                {tr('Datenschutz & Löschfristen', 'Privacy & retention')}
              </a>
            </Text>
          </HStack>
        </VStack>

        {/* Right column: Clean editorial transcript specimen */}
        <div className="lg:col-span-7 rounded-xl border border-[var(--color-border)] bg-[var(--color-background-surface)] p-6">
          <VStack gap={3}>
            <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
              <HStack gap={2} vAlign="center">
                <LiveWaveform />
                <Text type="supporting" weight="semibold" color="primary">
                  {tr('Beispiel-Protokoll', 'Sample Protocol')}
                </Text>
              </HStack>
              <ProviderBadge provider="teams" size="sm" />
            </HStack>

            <Divider variant="subtle" />

            <div className="divide-y divide-[var(--color-border)]">
              {exampleLines.map((line) => (
                <div key={line.time} className="py-3">
                  <HStack gap={3} vAlign="start">
                    <Avatar size="sm" shape="circle" name={line.speaker} />
                    <VStack gap={0.5} className="flex-1 min-w-0">
                      <HStack justify="between" vAlign="center" gap={2}>
                        <Text type="supporting" weight="semibold" color="primary">
                          {line.speaker}
                        </Text>
                        <Text
                          type="supporting"
                          color="secondary"
                          hasTabularNumbers
                        >
                          {line.share} · {line.time}
                        </Text>
                      </HStack>
                      <Text type="body" color="primary" className="max-w-[65ch]">
                        {line.text}
                      </Text>
                    </VStack>
                  </HStack>
                </div>
              ))}
            </div>

            <Divider variant="subtle" />

            <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
              <Text type="supporting" color="secondary">
                {tr(
                  'Lokales Qwen3-ASR · Im Chat steuerbar („no“, „#pause“)',
                  'Local Qwen3-ASR · In-call chat controls (“no”, “#pause”)'
                )}
              </Text>
              <Text type="supporting" color="secondary" hasTabularNumbers>
                {tr(
                  `Roh-Audio nach ${instance.retention.audioHours}h gelöscht`,
                  `Raw audio deleted after ${instance.retention.audioHours}h`
                )}
              </Text>
            </HStack>
          </VStack>
        </div>
      </div>
    </Center>
  );
}
