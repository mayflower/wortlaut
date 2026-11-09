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
import { List, ListItem } from '@astryxdesign/core/List';
import { Avatar } from '@astryxdesign/core/Avatar';
import { getInstanceInfo } from '../api';
import { ProviderBadge } from './ui/primitives';

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

const EXAMPLE_LINES = [
  {
    time: '00:00:14',
    speaker: 'Mara Lindner',
    source: 'Teams · Stream 1',
    text: 'Lass uns kurz die offenen Punkte für das Release am Donnerstag durchgehen.',
  },
  {
    time: '00:00:23',
    speaker: 'Thomas Berg',
    source: 'Teams · Stream 2',
    text: 'Die Migration auf dem Datenbank-Cluster ist abgeschlossen, es fehlt nur noch der Abnahmetest.',
  },
  {
    time: '00:00:35',
    speaker: 'Mara Lindner',
    source: 'Teams · Stream 1',
    text: 'Gut, dann planen wir den Testlauf für morgen um zehn Uhr ein und schicken danach das Protokoll herum.',
  },
];

export function WelcomeLandingView({
  authError,
  onConnectToken,
  onStartOidcLogin,
}: WelcomeLandingViewProps) {
  const instance = getInstanceInfo();
  const oidcEnabled = Boolean(instance.oidc?.enabled);
  const [tokenInput, setTokenInput] = useState('');
  const [showTokenForm, setShowTokenForm] = useState(!oidcEnabled);
  const [copiedMail, setCopiedMail] = useState(false);

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
            </HStack>

            <Heading level={1}>Sprechergetrennte Meeting-Protokolle</Heading>
            <Text type="body" color="secondary">
              <strong>{instance.assistantName}</strong> tritt Besprechungen in
              Google Meet, Microsoft Teams und Webex als stummer Teilnehmer bei,
              zeichnet die einzelnen Tonspuren vor dem Audio-Mix getrennt auf
              und transkribiert sie lokal auf dem Cluster.
            </Text>
          </VStack>

          <Card>
            <VStack gap={3}>
              <VStack gap={0.5}>
                <Heading level={3}>Anmelden</Heading>
                <Text type="supporting" color="secondary">
                  {oidcEnabled
                    ? 'Melden Sie sich mit Ihrem Mayflower-Account an, um eigene Aufnahmen und Kalender-Synchronisationen zu verwalten.'
                    : 'Geben Sie Ihren Zugangsschlüssel oder einen Lese-Token für ein freigegebenes Protokoll ein.'}
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
                    label="Mit Mayflower-Account anmelden (SSO)"
                    onClick={onStartOidcLogin}
                  />
                </span>
              )}

              {oidcEnabled && !showTokenForm ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  label="Lese-Token (wortlaut-read-…) oder API-Schlüssel verwenden"
                  onClick={() => setShowTokenForm(true)}
                />
              ) : (
                <form onSubmit={handleSubmit}>
                  <FormLayout direction="vertical">
                    {oidcEnabled && <Divider variant="subtle" />}
                    <div id="landing-token-input">
                      <TextInput
                        type="password"
                        label="Lese-Token (wortlaut-read-…) oder API-Schlüssel"
                        value={tokenInput}
                        onChange={setTokenInput}
                        placeholder="Token oder Freigabe-Link einfügen…"
                      />
                    </div>
                    <Button
                      type="submit"
                      variant={oidcEnabled ? 'secondary' : 'primary'}
                      size="sm"
                      width="fill"
                      isDisabled={!tokenInput.trim()}
                      icon={<KeyRound className="h-3.5 w-3.5" />}
                      label="Mit Token öffnen"
                    />
                  </FormLayout>
                </form>
              )}
            </VStack>
          </Card>

          <VStack gap={2}>
            <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
              <Heading level={4}>Ablauf in 3 Schritten</Heading>
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
                  label={copiedMail ? 'Kopiert' : `Bot-E-Mail: ${instance.botEmail}`}
                  onClick={handleCopyBotMail}
                />
              )}
            </HStack>
            <div className="divide-y divide-[var(--color-border)]">
              <div className="py-2.5">
                <VStack gap={0.5}>
                  <Text type="body" weight="semibold">
                    1. Kalender verbinden oder Meeting-Link starten
                  </Text>
                  <Text type="supporting" color="secondary">
                    Google Calendar oder Microsoft 365 per Read-Only-OAuth2 verknüpfen, Meeting-URL direkt einfügen oder den Bot per E-Mail einladen.
                  </Text>
                </VStack>
              </div>
              <div className="py-2.5">
                <VStack gap={0.5}>
                  <Text type="body" weight="semibold">
                    2. Im Warteraum zulassen
                  </Text>
                  <Text type="supporting" color="secondary">
                    Der Bot tritt stummgeschaltet als „{instance.assistantName}“ bei und erfasst jede Teilnehmer-Audiospur vor dem Konferenz-Mix einzeln.
                  </Text>
                </VStack>
              </div>
              <div className="py-2.5">
                <VStack gap={0.5}>
                  <Text type="body" weight="semibold">
                    3. Protokoll lesen, teilen oder exportieren
                  </Text>
                  <Text type="supporting" color="secondary">
                    Fertige Transkripte lassen sich nach Sprechern filtern, als .md, .txt, .vtt oder .json herunterladen und per Lese-Link teilen.
                  </Text>
                </VStack>
              </div>
            </div>
          </VStack>
        </VStack>

        {/* Right column: Editorial transcript specimen */}
        <div className="lg:col-span-6">
          <Section variant="section">
            <VStack gap={3}>
              <HStack justify="between" vAlign="center">
                <Heading level={4}>Beispiel-Protokoll</Heading>
                <Text type="supporting" color="secondary">
                  MD · TXT · VTT · JSON
                </Text>
              </HStack>

              <Divider variant="subtle" />

              <div className="divide-y divide-[var(--color-border)]">
                {EXAMPLE_LINES.map((line) => (
                  <div key={line.time} className="py-3">
                    <HStack gap={2} vAlign="start">
                      <Avatar size="sm" shape="circle" name={line.speaker} />
                      <VStack gap={0.5} className="flex-1">
                        <HStack justify="between" vAlign="center" gap={2}>
                          <Text type="body" weight="semibold" color="primary">
                            {line.speaker}
                          </Text>
                          <Text type="supporting" color="secondary" hasTabularNumbers>
                            {line.source} · {line.time}
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
                  Lokale Spracherkennung (Parakeet-GPU) · Keine Cloud-Weitergabe
                </Text>
                <Text type="supporting" color="secondary">
                  Roh-Audio nach {instance.retention.audioHours}h gelöscht ·{' '}
                  <a
                    href="/privacy"
                    className="text-[var(--color-text-accent)] underline"
                  >
                    Datenschutz-Info
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
