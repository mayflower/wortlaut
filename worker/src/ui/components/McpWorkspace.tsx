import React, { useState } from 'react';
import {
  Check,
  Copy,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Trash2,
} from 'lucide-react';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { Breadcrumbs, BreadcrumbItem } from '@astryxdesign/core/Breadcrumbs';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import { Section } from '@astryxdesign/core/Section';
import {
  MetadataList,
  MetadataListItem,
} from '@astryxdesign/core/MetadataList';
import { List, ListItem } from '@astryxdesign/core/List';
import { Button } from '@astryxdesign/core/Button';
import { Token } from '@astryxdesign/core/Token';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import {
  Table,
  pixel,
  proportional,
  type TableColumn,
} from '@astryxdesign/core/Table';
import { revokeMcpGrant } from '../api';
import { useI18n } from '../i18n';
import type { McpGrantItem } from '../types';

export interface McpWorkspaceProps {
  token: string;
  endpoint?: string;
  grants: McpGrantItem[];
  isLoading?: boolean;
  onRefresh: () => void;
  onNavigateHome?: () => void;
}

type GrantRow = McpGrantItem & Record<string, unknown>;

export function McpWorkspace({
  token,
  endpoint,
  grants,
  isLoading = false,
  onRefresh,
  onNavigateHome,
}: McpWorkspaceProps) {
  const { lang, tr } = useI18n();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const mcpUrl =
    endpoint ||
    `${typeof window !== 'undefined' ? window.location.origin : ''}/mcp`;

  const claudeCmd = `claude mcp add --transport http wortlaut ${mcpUrl}`;
  const mcpJsonSnippet = JSON.stringify(
    {
      mcpServers: {
        wortlaut: {
          url: mcpUrl,
        },
      },
    },
    null,
    2
  );

  const handleCopy = (key: string, value: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((cur) => (cur === key ? null : cur));
      }, 1800);
    });
  };

  const handleRevoke = async (grantId: string) => {
    setRevokingId(grantId);
    setErrorMsg(null);
    try {
      await revokeMcpGrant(token, grantId);
      onRefresh();
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : tr('Widerruf fehlgeschlagen.', 'Revocation failed.')
      );
    } finally {
      setRevokingId(null);
    }
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return '—';
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return iso;
    return dt.toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const grantColumns: TableColumn<GrantRow>[] = [
    {
      key: 'client_name',
      header: tr('MCP-Client', 'MCP Client'),
      width: proportional(1.4, { minWidth: 180 }),
      renderCell: (row) => (
        <VStack gap={0.5}>
          <Text type="body" weight="semibold" maxLines={1}>
            {row.client_name}
          </Text>
          <Text type="supporting" color="secondary" maxLines={1}>
            {row.owner_email || (row.is_operator ? 'Operator' : row.client_id)}
          </Text>
        </VStack>
      ),
    },
    {
      key: 'scopes',
      header: tr('Berechtigungen', 'Scopes'),
      width: pixel(210),
      renderCell: (row) => (
        <HStack gap={1} wrap="wrap">
          {row.scopes.map((sc) => (
            <Token
              key={sc}
              size="sm"
              color={sc === 'mcp:write' ? 'blue' : 'green'}
              label={sc}
            />
          ))}
        </HStack>
      ),
    },
    {
      key: 'last_used_at',
      header: tr('Zuletzt genutzt', 'Last used'),
      width: pixel(165),
      renderCell: (row) => (
        <Text type="supporting" color="secondary">
          {formatDate(row.last_used_at || row.created_at)}
        </Text>
      ),
    },
    {
      key: 'refresh_expires_at',
      header: tr('Gültig bis', 'Expires'),
      width: pixel(165),
      renderCell: (row) => (
        <Text type="supporting" color="secondary">
          {formatDate(row.refresh_expires_at)}
        </Text>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: pixel(135),
      renderCell: (row) => (
        <Button
          variant="secondary"
          size="sm"
          icon={<Trash2 className="h-3.5 w-3.5" />}
          label={
            revokingId === row.id
              ? tr('Widerrufe…', 'Revoking…')
              : tr('Widerrufen', 'Revoke')
          }
          isDisabled={revokingId === row.id}
          onClick={() => handleRevoke(row.id)}
        />
      ),
    },
  ];

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <div className="wl-page-container">
            <VStack gap={2}>
              {onNavigateHome && (
                <Breadcrumbs
                  variant="supporting"
                  label={tr('Pfadnavigation', 'Breadcrumb')}
                >
                  <BreadcrumbItem onClick={onNavigateHome}>
                    {tr('Startseite', 'Home')}
                  </BreadcrumbItem>
                  <BreadcrumbItem isCurrent>
                    {tr('MCP & KI-Clients', 'MCP & AI Clients')}
                  </BreadcrumbItem>
                </Breadcrumbs>
              )}
              <HStack justify="between" vAlign="center" wrap="wrap" gap={3}>
                <VStack gap={0.5}>
                  <Heading level={1}>
                    {tr(
                      'Model Context Protocol (MCP)',
                      'Model Context Protocol (MCP)'
                    )}
                  </Heading>
                  <Text type="supporting" color="secondary">
                    {tr(
                      'Verbinden Sie Claude Code, Cursor, VS Code, Antigravity oder eigene KI-Agenten per OAuth 2.1 (mcp auth) direkt mit Ihren eigenen wortlaut-Protokollen.',
                      'Connect Claude Code, Cursor, VS Code, Antigravity, or custom AI agents via OAuth 2.1 (mcp auth) directly to your own wortlaut meeting transcripts.'
                    )}
                  </Text>
                </VStack>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<RefreshCw className="h-3.5 w-3.5" />}
                  label={tr('Aktualisieren', 'Refresh')}
                  onClick={onRefresh}
                />
              </HStack>
            </VStack>
          </div>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          <div className="wl-page-container">
            <VStack gap={4}>
              <Section variant="section">
                <VStack gap={3}>
                  <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
                    <Heading level={3}>
                      {tr(
                        'Schnelleinrichtung (Streamable HTTP + OAuth 2.1)',
                        'Quick Setup (Streamable HTTP + OAuth 2.1)'
                      )}
                    </Heading>
                    <Token
                      size="sm"
                      color="green"
                      icon={<ShieldCheck className="h-3 w-3" />}
                      label="RFC 9728 · RFC 8414 · PKCE S256"
                    />
                  </HStack>

                  <MetadataList columns={3}>
                    <MetadataListItem
                      label={tr('1. MCP-Server hinzufügen', '1. Add MCP Server')}
                    >
                      {tr(
                        'Kein statischer API-Key nötig: Moderne MCP-Clients erkennen den geschützten Endpunkt automatisch über /.well-known/oauth-protected-resource.',
                        'No static API keys needed: modern MCP clients automatically discover OAuth metadata via /.well-known/oauth-protected-resource.'
                      )}
                    </MetadataListItem>
                    <MetadataListItem
                      label={tr(
                        '2. Browser-Anmeldung (mcp auth)',
                        '2. Browser Sign-In (mcp auth)'
                      )}
                    >
                      {tr(
                        'Ihr Browser öffnet den Login (OIDC SSO oder Instanz-Token) und zeigt einen Freigabedialog für Lese- (mcp:read) und optionale Schreibrechte (mcp:write).',
                        'Your browser opens sign-in (OIDC SSO or instance token) and presents an explicit consent screen for read (mcp:read) and optional write (mcp:write) scopes.'
                      )}
                    </MetadataListItem>
                    <MetadataListItem
                      label={tr(
                        '3. Strikte Nutzer-Isolation',
                        '3. Strict User Isolation'
                      )}
                    >
                      {tr(
                        'Der KI-Client sieht ausschließlich Ihre eigenen und für Sie freigegebenen Besprechungen inklusive isolierter Teilnehmerspuren.',
                        'The AI client can only query your own and explicitly shared recordings, preserving pre-mix WebRTC speaker attribution.'
                      )}
                    </MetadataListItem>
                  </MetadataList>

                  <VStack gap={2}>
                    <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
                      <Text type="supporting" weight="semibold">
                        {tr('MCP-Endpunkt-URL', 'MCP Endpoint URL')}
                      </Text>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={
                          copiedKey === 'url' ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )
                        }
                        label={
                          copiedKey === 'url'
                            ? tr('Kopiert', 'Copied')
                            : tr('URL kopieren', 'Copy URL')
                        }
                        onClick={() => handleCopy('url', mcpUrl)}
                      />
                    </HStack>
                    <pre className="m-0 overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-background-muted)] px-3 py-2 text-xs font-mono">
                      {mcpUrl}
                    </pre>
                  </VStack>

                  <VStack gap={2}>
                    <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
                      <Text type="supporting" weight="semibold">
                        Claude Code CLI
                      </Text>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={
                          copiedKey === 'claude' ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )
                        }
                        label={
                          copiedKey === 'claude'
                            ? tr('Kopiert', 'Copied')
                            : tr('Befehl kopieren', 'Copy command')
                        }
                        onClick={() => handleCopy('claude', claudeCmd)}
                      />
                    </HStack>
                    <pre className="m-0 overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-background-muted)] px-3 py-2 text-xs font-mono">
                      {claudeCmd}
                    </pre>
                  </VStack>

                  <VStack gap={2}>
                    <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
                      <Text type="supporting" weight="semibold">
                        Cursor / VS Code / Antigravity (`mcp.json`)
                      </Text>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={
                          copiedKey === 'json' ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )
                        }
                        label={
                          copiedKey === 'json'
                            ? tr('Kopiert', 'Copied')
                            : tr('JSON kopieren', 'Copy JSON')
                        }
                        onClick={() => handleCopy('json', mcpJsonSnippet)}
                      />
                    </HStack>
                    <pre className="m-0 overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-background-muted)] px-3 py-2 text-xs font-mono">
                      {mcpJsonSnippet}
                    </pre>
                  </VStack>
                </VStack>
              </Section>

              <Section variant="section">
                <VStack gap={2}>
                  <Heading level={3}>
                    {tr(
                      `Autorisierte MCP-Clients (${grants.length})`,
                      `Authorized MCP Clients (${grants.length})`
                    )}
                  </Heading>
                  {errorMsg && (
                    <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-red-400">
                      <Text type="supporting" color="inherit">
                        {errorMsg}
                      </Text>
                    </div>
                  )}
                  {grants.length === 0 ? (
                    <EmptyState
                      isCompact
                      icon={<Terminal className="h-6 w-6" />}
                      title={
                        isLoading
                          ? tr('Lade Verbindungen…', 'Loading connections…')
                          : tr(
                              'Noch keine MCP-Clients autorisiert',
                              'No MCP clients authorized yet'
                            )
                      }
                      description={tr(
                        'Sobald Sie sich in einem MCP-Client per Browser-OAuth anmelden, erscheint die Sitzung hier und kann jederzeit mit einem Klick widerrufen werden.',
                        'Once you sign in from an MCP client via browser OAuth, the active session appears here and can be revoked with one click.'
                      )}
                    />
                  ) : (
                    <Table<GrantRow>
                      idKey="id"
                      density="compact"
                      dividers="rows"
                      hasHover
                      data={grants as GrantRow[]}
                      columns={grantColumns}
                    />
                  )}
                </VStack>
              </Section>

              <Section variant="section">
                <VStack gap={2}>
                  <Heading level={3}>
                    {tr('Verfügbare MCP-Werkzeuge', 'Available MCP Tools')}
                  </Heading>
                  <List hasDividers edge="flush">
                    <ListItem
                      label="list_recordings · get_recording · get_transcript · export_protocol · list_calendar_events"
                      description={tr(
                        'Volltextsuche über Titel, gebundene Sprecher, Wortprotokolle, Pausenfenster (#pause), Bildschirm-Folien (wortlaut://…/keyframes/…) sowie Markdown/VTT/JSON-Exporte.',
                        'Full-text search across titles, bound speakers, verbatim transcripts, pause windows (#pause), slide keyframes (wortlaut://…/keyframes/…), and Markdown/VTT/JSON exports.'
                      )}
                      endContent={
                        <Token size="sm" color="green" label="mcp:read" />
                      }
                    />
                    <ListItem
                      label="schedule_recording · cancel_recording · update_protocol · generate_summary · toggle_calendar_event_recording · publish_calendar_protocol_link"
                      description={tr(
                        'Aufnahmen für Meet, Teams, Webex & Zoom planen/stoppen, Sprechernamen & Fachglossar pflegen, lokale Ollama-Zusammenfassung auslösen und Kalender-Links aktualisieren.',
                        'Schedule/stop Meet, Teams, Webex & Zoom recordings, update speaker names & glossary terms, trigger local Ollama summaries, and sync protocol links to calendar invites.'
                      )}
                      endContent={
                        <Token size="sm" color="blue" label="mcp:write" />
                      }
                    />
                  </List>
                </VStack>
              </Section>
            </VStack>
          </div>
        </LayoutContent>
      }
    />
  );
}
