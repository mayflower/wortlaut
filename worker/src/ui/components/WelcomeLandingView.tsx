import React, { useState } from 'react';
import { Check, Copy, KeyRound, LogIn } from 'lucide-react';
import { Center } from '@astryxdesign/core/Center';
import { Card } from '@astryxdesign/core/Card';
import { Section } from '@astryxdesign/core/Section';
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
    share: '46 % Redeanteil',
    text: 'Lass uns kurz die offenen Punkte für das Release am Donnerstag durchgehen.',
  },
  {
    time: '00:00:23',
    speaker: 'Markus Berg',
    share: '34 % Redeanteil',
    text: 'Die Migration auf dem Datenbank-Cluster ist abgeschlossen, es fehlt nur noch der gemeinsame Abnahmetest.',
  },
  {
    time: '00:00:35',
    speaker: 'Julia Vogt',
    share: '20 % Redeanteil',
    text: 'Perfekt, dann planen wir den Testlauf für morgen um zehn Uhr ein und teilen danach direkt das Protokoll.',
  },
];

const EXAMPLE_LINES_EN = [
  {
    time: '00:00:14',
    speaker: 'Anna Lindner',
    share: '46% speaking share',
    text: 'Let us walk through the open items for Thursday’s release.',
  },
  {
    time: '00:00:23',
    speaker: 'Markus Berg',
    share: '34% speaking share',
    text: 'The database cluster migration is complete—we only need the joint acceptance test.',
  },
  {
    time: '00:00:35',
    speaker: 'Julia Vogt',
    share: '20% speaking share',
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
    <Center axis="horizontal" paddingBlock={8} paddingInline={4}>
      <div className="w-full max-w-5xl grid grid-cols-1 gap-8 lg:grid-cols-12 lg:items-start">
        {/* Left column: Value proposition + Sign-in Card */}
        <VStack gap={5} className="lg:col-span-6">
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
                'Automatische Wortprotokolle für Ihre Meetings',
                'Self-Hosted Meeting Transcripts & Protocols'
              )}
            </Heading>
            <Text type="body" color="secondary">
              {lang === 'en' ? (
                <>
                  <strong>{instance.assistantName}</strong> joins meetings in
                  Google Meet, Microsoft Teams, Cisco Webex, and Zoom as a silent
                  participant, attributes every statement to the verified
                  speaker track, and runs 100% on your own infrastructure.
                </>
              ) : (
                <>
                  <strong>{instance.assistantName}</strong> nimmt als stiller
                  Zuhörer an Besprechungen in Google Meet, Microsoft Teams,
                  Cisco Webex und Zoom teil, ordnet jeden Redebeitrag
                  zuverlässig der sprechenden Person zu und erstellt Ihr
                  Protokoll komplett auf eigener Infrastruktur.
                </>
              )}
            </Text>
          </VStack>

          <Card>
            <VStack gap={3}>
              <VStack gap={0.5}>
                <Heading level={3}>{tr('Anmelden', 'Sign in')}</Heading>
                <Text type="supporting" color="secondary">
                  {oidcEnabled
                    ? tr(
                        'Melden Sie sich per Single Sign-On (OIDC) an, um eigene Aufnahmen und Kalender-Synchronisationen zu verwalten.',
                        'Sign in via Single Sign-On (OIDC) to manage your recordings and calendar integrations.'
                      )
                    : tr(
                        'Geben Sie Ihren Zugangsschlüssel oder einen Lese-Token für ein freigegebenes Protokoll ein.',
                        'Enter your API key or a read-only share token to open a meeting transcript.'
                      )}
                </Text>
              </VStack>

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
                    'Lese-Token (wortlaut-read-…) oder API-Schlüssel verwenden',
                    'Use read-only token (wortlaut-read-…) or API key'
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
                          'Lese-Token (wortlaut-read-…) oder API-Schlüssel',
                          'Read-only token (wortlaut-read-…) or API key'
                        )}
                        value={tokenInput}
                        onChange={setTokenInput}
                        placeholder={tr(
                          'Token oder Freigabe-Link einfügen…',
                          'Paste token or share URL…'
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

          <VStack gap={2}>
            <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
              <Heading level={4}>
                {tr('Ablauf in 3 Schritten', 'How it works in 3 steps')}
              </Heading>
              {instance.botEmail && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={
                    copiedMail ? (
                      <Check className="h-3 w-3" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )
                  }
                  label={
                    copiedMail
                      ? tr('Kopiert', 'Copied')
                      : `${tr('Bot-E-Mail', 'Bot email')}: ${instance.botEmail}`
                  }
                  onClick={handleCopyBotMail}
                />
              )}
            </HStack>
            <div className="divide-y divide-[var(--color-border)]">
              <div className="py-2.5">
                <VStack gap={0.5}>
                  <Text type="body" weight="semibold">
                    {tr(
                      '1. Kalender verbinden oder Meeting-Link starten',
                      '1. Connect calendar or paste a meeting link'
                    )}
                  </Text>
                  <Text type="supporting" color="secondary">
                    {tr(
                      'Google Calendar oder Microsoft 365 per OAuth2 verknüpfen, Meeting-URL direkt einfügen oder den Bot per E-Mail einladen.',
                      'Connect Google Calendar or Microsoft 365 via OAuth2, paste a meeting URL directly, or invite the bot via email.'
                    )}
                  </Text>
                </VStack>
              </div>
              <div className="py-2.5">
                <VStack gap={0.5}>
                  <Text type="body" weight="semibold">
                    {tr('2. Im Warteraum zulassen', '2. Admit from the lobby')}
                  </Text>
                  <Text type="supporting" color="secondary">
                    {tr(
                      `Der Bot tritt stummgeschaltet als „${instance.assistantName}“ bei und erfasst jede Teilnehmer-Audiospur vor dem Konferenz-Mix einzeln.`,
                      `The bot joins muted as “${instance.assistantName}” and captures each participant’s audio track individually before mixing.`
                    )}
                  </Text>
                </VStack>
              </div>
              <div className="py-2.5">
                <VStack gap={0.5}>
                  <Text type="body" weight="semibold">
                    {tr(
                      '3. Protokoll lesen, teilen oder exportieren',
                      '3. Read, share, or export your protocol'
                    )}
                  </Text>
                  <Text type="supporting" color="secondary">
                    {tr(
                      'Fertige Transkripte lassen sich nach Sprechern filtern, als .md, .txt, .vtt oder .json herunterladen und per Lese-Link teilen.',
                      'Filter transcripts by speaker, download as .md, .txt, .vtt, or .json, and share read-only protocol links.'
                    )}
                  </Text>
                </VStack>
              </div>
            </div>
          </VStack>
        </VStack>

        {/* Right column: Editorial transcript specimen */}
        <div className="lg:col-span-6 wl-fade-in">
          <Section variant="section">
            <VStack gap={3}>
              <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
                <HStack gap={2} vAlign="center">
                  <LiveWaveform />
                  <Heading level={4}>
                    {tr('Beispiel-Protokoll', 'Sample Transcript')}
                  </Heading>
                </HStack>
                <ProviderBadge provider="teams" size="sm" />
              </HStack>

              <Divider variant="subtle" />

              <div className="divide-y divide-[var(--color-border)]">
                {exampleLines.map((line) => (
                  <div key={line.time} className="py-3 wl-turn-row">
                    <HStack gap={2} vAlign="start">
                      <Avatar size="sm" shape="circle" name={line.speaker} />
                      <VStack gap={0.5} className="flex-1">
                        <HStack justify="between" vAlign="center" gap={2}>
                          <Text type="body" weight="semibold" color="primary">
                            {line.speaker}
                          </Text>
                          <Text type="supporting" color="secondary" hasTabularNumbers>
                            {line.share} · {line.time}
                          </Text>
                        </HStack>
                        <Text type="body" color="primary">
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
                    'Lokale Spracherkennung (Qwen3-ASR, GPU) · Keine Cloud-Weitergabe',
                    'Local speech recognition (Qwen3-ASR, GPU) · Zero cloud sharing'
                  )}
                </Text>
                <Text type="supporting" color="secondary">
                  {tr(
                    `Roh-Audio nach ${instance.retention.audioHours}h gelöscht`,
                    `Raw audio deleted after ${instance.retention.audioHours}h`
                  )}{' '}
                  ·{' '}
                  <a
                    href={`/privacy?lang=${lang}`}
                    className="text-[var(--color-text-accent)] underline"
                  >
                    {tr('Datenschutz-Info', 'Privacy notice')}
                  </a>
                </Text>
              </HStack>
            </VStack>
          </Section>
        </div>
      </div>
    </Center>
  );
}
