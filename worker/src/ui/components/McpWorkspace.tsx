import React, { useState } from 'react';
import { Check, Copy, RefreshCw, Terminal, Trash2 } from 'lucide-react';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import { Button } from '@astryxdesign/core/Button';
import { Token } from '@astryxdesign/core/Token';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Banner } from '@astryxdesign/core/Banner';
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
  loadError?: string | null;
  onRefresh: () => void;
}

type GrantRow = McpGrantItem & Record<string, unknown>;
type SnippetMode = 'claude' | 'json' | 'url';

export function McpWorkspace({
  token,
  endpoint,
  grants,
  isLoading = false,
  loadError = null,
  onRefresh,
}: McpWorkspaceProps) {
  const { localeTag, tr } = useI18n();
  const [snippetMode, setSnippetMode] = useState<SnippetMode>('claude');
  const [copied, setCopied] = useState(false);
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

  const activeSnippet =
    snippetMode === 'claude'
      ? claudeCmd
      : snippetMode === 'json'
        ? mcpJsonSnippet
        : mcpUrl;

  const handleCopy = () => {
    navigator.clipboard?.writeText(activeSnippet).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
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

  const formatDate = (iso: string | null | undefined) => {
    if (!iso) return '—';
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return iso;
    return dt.toLocaleString(localeTag, {
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
      header: tr('Client', 'Client'),
      width: proportional(1.6, { minWidth: 180 }),
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
      header: tr('Berechtigung', 'Scopes'),
      width: pixel(190),
      renderCell: (row) => (
        <HStack gap={1} wrap="wrap">
          {(row.scopes || []).map((sc) => (
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
      width: pixel(160),
      renderCell: (row) => (
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {formatDate(row.last_used_at || row.created_at)}
        </Text>
      ),
    },
    {
      key: 'refresh_expires_at',
      header: tr('Gültig bis', 'Expires'),
      width: pixel(160),
      renderCell: (row) => (
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {formatDate(row.refresh_expires_at)}
        </Text>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: pixel(160),
      align: 'end',
      renderCell: (row) => (
        <Button
          variant="ghost"
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
            <HStack justify="between" vAlign="center" wrap="wrap" gap={3}>
              <VStack gap={0.5}>
                <Heading level={1}>MCP</Heading>
                <Text type="supporting" color="secondary">
                  {tr(
                    'KI-Clients per OAuth 2.1 mit Ihren eigenen Protokollen verbinden.',
                    'Connect AI clients via OAuth 2.1 to your own protocols.'
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
          </div>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          <div className="wl-page-container">
            <VStack gap={6}>
              <VStack gap={2}>
                <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
                  <SegmentedControl
                    size="sm"
                    label={tr('Konfigurationsformat', 'Snippet format')}
                    value={snippetMode}
                    onChange={(v) => setSnippetMode(v as SnippetMode)}
                  >
                    <SegmentedControlItem value="claude" label="Claude Code" />
                    <SegmentedControlItem
                      value="json"
                      label="mcp.json"
                    />
                    <SegmentedControlItem
                      value="url"
                      label={tr('Endpunkt', 'Endpoint')}
                    />
                  </SegmentedControl>

                  <Button
                    variant="secondary"
                    size="sm"
                    icon={
                      copied ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )
                    }
                    label={
                      copied
                        ? tr('Kopiert', 'Copied')
                        : tr('Kopieren', 'Copy')
                    }
                    onClick={handleCopy}
                  />
                </HStack>

                <pre className="m-0 overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-background-surface)] px-3.5 py-2.5 text-[13px] leading-relaxed font-mono">
                  {activeSnippet}
                </pre>
              </VStack>

              <VStack gap={2}>
                <HStack gap={2} vAlign="center">
                  <Heading level={2}>
                    {tr('Autorisierte Clients', 'Authorized Clients')}
                  </Heading>
                  <Token size="sm" color="gray" label={String(grants.length)} />
                </HStack>

                {(errorMsg || loadError) && (
                  <Banner
                    status="error"
                    container="card"
                    title={errorMsg || loadError || ''}
                    isDismissable={Boolean(errorMsg)}
                    onDismiss={errorMsg ? () => setErrorMsg(null) : undefined}
                    endContent={
                      loadError ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<RefreshCw className="h-3.5 w-3.5" />}
                          label={tr('Erneut laden', 'Retry')}
                          onClick={onRefresh}
                        />
                      ) : undefined
                    }
                  />
                )}

                {grants.length === 0 ? (
                  loadError ? null : (
                  <EmptyState
                    isCompact
                    icon={<Terminal className="h-6 w-6" />}
                    title={
                      isLoading
                        ? tr('Lade Verbindungen…', 'Loading connections…')
                        : tr(
                            'Noch keine MCP-Clients verbunden',
                            'No MCP clients connected yet'
                          )
                    }
                    description={tr(
                      'Nach der Anmeldung per Browser-OAuth erscheinen verbundene Clients hier.',
                      'Connected clients appear here after browser OAuth sign-in.'
                    )}
                  />
                  )
                ) : (
                  <>
                    <div className="hidden md:block">
                      <Table<GrantRow>
                        idKey="id"
                        density="balanced"
                        dividers="rows"
                        hasHover
                        data={grants as GrantRow[]}
                        columns={grantColumns}
                      />
                    </div>
                    <div className="md:hidden rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
                      {grants.map((row) => (
                        <div key={row.id} className="p-3.5">
                          <VStack gap={1.5}>
                            <HStack
                              justify="between"
                              vAlign="start"
                              gap={2}
                            >
                              <VStack gap={0.5}>
                                <Text
                                  type="body"
                                  weight="semibold"
                                  color="primary"
                                >
                                  {row.client_name}
                                </Text>
                                <Text type="supporting" color="secondary">
                                  {row.owner_email ||
                                    (row.is_operator
                                      ? 'Operator'
                                      : row.client_id)}
                                </Text>
                              </VStack>
                              <Button
                                variant="ghost"
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
                            </HStack>
                            {(row.scopes || []).length > 0 && (
                              <HStack gap={1} wrap="wrap">
                                {(row.scopes || []).map((sc) => (
                                  <Token
                                    key={sc}
                                    size="sm"
                                    color={sc === 'mcp:write' ? 'blue' : 'green'}
                                    label={sc}
                                  />
                                ))}
                              </HStack>
                            )}
                            <Text
                              type="supporting"
                              color="secondary"
                              hasTabularNumbers
                            >
                              {tr('Zuletzt genutzt', 'Last used')}:{' '}
                              {formatDate(row.last_used_at || row.created_at)}
                            </Text>
                          </VStack>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </VStack>
            </VStack>
          </div>
        </LayoutContent>
      }
    />
  );
}
