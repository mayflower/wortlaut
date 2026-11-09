import React, { useState } from 'react';
import { Check, Copy, Eye, EyeOff, KeyRound, LogIn } from 'lucide-react';
import { getInstanceInfo } from '../api';
import { Button, ProviderBadge } from './ui/primitives';

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
    time: '00:14',
    speaker: 'Mara Lindner',
    source: 'Teams · Stream 1',
    text: 'Lass uns kurz die offenen Punkte für das Release am Donnerstag durchgehen.',
  },
  {
    time: '00:23',
    speaker: 'Thomas Berg',
    source: 'Teams · Stream 2',
    text: 'Die Migration auf dem Datenbank-Cluster ist abgeschlossen, es fehlt nur noch der Abnahmetest.',
  },
  {
    time: '00:35',
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
  const [showPlain, setShowPlain] = useState(false);
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
    <div className="mx-auto max-w-5xl py-6 sm:py-12">
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-12 lg:items-start">
        {/* Left column: Straightforward explanation + Sign-in */}
        <div className="space-y-8 lg:col-span-6">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {instance.providers.google_meet && (
                <ProviderBadge provider="google_meet" />
              )}
              {instance.providers.teams && <ProviderBadge provider="teams" />}
              {instance.providers.webex && <ProviderBadge provider="webex" />}
            </div>

            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-white">
              Sprechergetrennte Meeting-Protokolle
            </h1>
            <p className="text-sm leading-relaxed text-slate-400">
              <strong className="font-medium text-slate-200">
                {instance.assistantName}
              </strong>{' '}
              tritt Besprechungen in Google Meet, Microsoft Teams und Webex als
              stummer Teilnehmer bei, zeichnet die einzelnen Tonspuren vor dem
              Audio-Mix getrennt auf und transkribiert sie lokal auf dem
              Cluster.
            </p>
          </div>

          {/* Sign-in box: Dex OIDC primary + optional token/reader-link fallback */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5 space-y-4">
            <div className="space-y-1">
              <div className="text-sm font-medium text-white">Anmelden</div>
              <p className="text-xs text-slate-400">
                {oidcEnabled
                  ? 'Melden Sie sich mit Ihrem Mayflower-Account an, um eigene Aufnahmen und Kalender-Einladungen zu verwalten.'
                  : 'Geben Sie Ihren Zugangsschlüssel oder einen Lese-Token für ein freigegebenes Protokoll ein.'}
              </p>
            </div>

            {authError && (
              <div className="rounded-lg border border-red-800/80 bg-red-950/60 px-3 py-2 text-xs text-red-200">
                {authError}
              </div>
            )}

            {oidcEnabled && (
              <Button
                type="button"
                variant="primary"
                size="md"
                onClick={onStartOidcLogin}
                id="oidc-login-btn"
                className="w-full justify-center py-2.5"
              >
                <LogIn className="h-4 w-4" />
                <span>Mit Mayflower-Account anmelden (SSO)</span>
              </Button>
            )}

            {oidcEnabled && !showTokenForm ? (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setShowTokenForm(true)}
                  className="text-xs text-slate-400 hover:text-slate-200 underline underline-offset-4 cursor-pointer"
                >
                  Lese-Token (wortlaut-read-…) oder API-Schlüssel verwenden
                </button>
              </div>
            ) : (
              <form
                onSubmit={handleSubmit}
                className={
                  oidcEnabled
                    ? 'space-y-2 border-t border-slate-800/80 pt-3.5'
                    : 'space-y-2'
                }
              >
                {oidcEnabled && (
                  <label
                    htmlFor="landing-token-input"
                    className="block text-xs text-slate-400"
                  >
                    Lese-Token (<code className="text-slate-300">wortlaut-read-…</code>) oder API-Schlüssel
                  </label>
                )}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <div className="relative flex-1">
                    <input
                      id="landing-token-input"
                      type={showPlain ? 'text' : 'password'}
                      value={tokenInput}
                      onChange={(e) => setTokenInput(e.target.value)}
                      placeholder="Token oder Freigabe-Link einfügen…"
                      autoFocus={!oidcEnabled}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 pl-3.5 pr-9 py-2 text-sm text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPlain((v) => !v)}
                      title={
                        showPlain ? 'Schlüssel verbergen' : 'Schlüssel anzeigen'
                      }
                      className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-200 cursor-pointer"
                    >
                      {showPlain ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  </div>

                  <Button
                    type="submit"
                    variant={oidcEnabled ? 'outline' : 'primary'}
                    size="md"
                    className="shrink-0 justify-center px-4"
                  >
                    <KeyRound className="h-4 w-4" />
                    <span>Öffnen</span>
                  </Button>
                </div>
              </form>
            )}
          </div>

          {/* Plain, factual 3-step explanation (no cards, just clean typography) */}
          <div className="space-y-4 border-t border-slate-800/80 pt-6">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Ablauf
            </h2>

            <ol className="space-y-3 text-sm text-slate-300">
              <li className="flex gap-3">
                <span className="font-mono text-xs text-slate-500 mt-0.5">
                  01
                </span>
                <div>
                  <strong className="font-medium text-white">
                    Link einfügen oder Termin einladen.
                  </strong>{' '}
                  <span className="text-slate-400">
                    Meeting-URL direkt starten, eine <code>.ics</code>-Datei
                    hochladen
                    {instance.botEmail ? (
                      <>
                        {' '}
                        oder{' '}
                        <button
                          type="button"
                          onClick={handleCopyBotMail}
                          className="inline-flex items-center gap-1 rounded border border-slate-800 bg-slate-900 px-1.5 py-0.5 font-mono text-xs text-slate-200 hover:border-slate-700 cursor-pointer"
                        >
                          <span>{instance.botEmail}</span>
                          {copiedMail ? (
                            <Check className="h-3 w-3 text-emerald-400" />
                          ) : (
                            <Copy className="h-3 w-3 text-slate-400" />
                          )}
                        </button>{' '}
                        als Gast in den Kalender einladen.
                      </>
                    ) : (
                      '.'
                    )}
                  </span>
                </div>
              </li>

              <li className="flex gap-3">
                <span className="font-mono text-xs text-slate-500 mt-0.5">
                  02
                </span>
                <div>
                  <strong className="font-medium text-white">
                    Im Warteraum zulassen.
                  </strong>{' '}
                  <span className="text-slate-400">
                    Der Bot tritt ohne Kamera und Mikrofon als „
                    {instance.assistantName}“ bei. Sobald er im Meeting
                    zugelassen wird, läuft das Live-Transkript mit.
                  </span>
                </div>
              </li>

              <li className="flex gap-3">
                <span className="font-mono text-xs text-slate-500 mt-0.5">
                  03
                </span>
                <div>
                  <strong className="font-medium text-white">
                    Protokoll lesen, teilen oder exportieren.
                  </strong>{' '}
                  <span className="text-slate-400">
                    Fertige Transkripte lassen sich nach Sprechern filtern, als{' '}
                    <code>.txt</code>, <code>.md</code>, <code>.vtt</code> oder{' '}
                    <code>.json</code> herunterladen und per schreibgeschütztem
                    Lese-Link teilen.
                  </span>
                </div>
              </li>
            </ol>
          </div>
        </div>

        {/* Right column: Quiet, realistic transcript specimen */}
        <div className="lg:col-span-6">
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3.5 text-xs">
              <div className="flex items-center gap-2.5">
                <span className="font-medium text-slate-200">
                  Beispiel-Protokoll
                </span>
                <span className="text-slate-600">·</span>
                <span className="text-slate-400">2 erkannte Teilnehmende</span>
              </div>
              <span className="font-mono text-[11px] text-slate-500">
                TXT · MD · VTT · JSON
              </span>
            </div>

            <div className="divide-y divide-slate-800/60 px-5">
              {EXAMPLE_LINES.map((line) => (
                <div key={line.time} className="py-4 space-y-1">
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="font-medium text-slate-200">
                      {line.speaker}
                    </span>
                    <div className="flex items-center gap-2 font-mono text-[11px] text-slate-500">
                      <span>{line.source}</span>
                      <span>{line.time}</span>
                    </div>
                  </div>
                  <p className="text-sm leading-relaxed text-slate-300">
                    {line.text}
                  </p>
                </div>
              ))}
            </div>

            <div className="border-t border-slate-800 bg-slate-950/50 px-5 py-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
              <span>
                Lokale Spracherkennung (Parakeet-GPU) · Keine Cloud-Weitergabe
              </span>
              <span>
                Roh-Audio nach {instance.retention.audioHours}h gelöscht
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
