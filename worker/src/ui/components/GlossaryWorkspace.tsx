import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Check,
  Copy,
  Edit3,
  ListPlus,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
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
import { IconButton } from '@astryxdesign/core/IconButton';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Token } from '@astryxdesign/core/Token';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Banner } from '@astryxdesign/core/Banner';
import { deleteGlossaryEntry, upsertGlossaryEntries } from '../api';
import { useI18n } from '../i18n';
import type {
  GlossaryEntryItem,
  GlossaryOverview,
  GlossaryScope,
} from '../types';

export interface GlossaryWorkspaceProps {
  token: string;
  glossary: GlossaryOverview | null;
  isLoading?: boolean;
  loadError?: string | null;
  onRefresh: () => void;
}

interface DeletedGlossaryUndo {
  term: string;
  aliases: string[];
  scope: GlossaryScope;
}

function findInvalidShortAlias(raw: string): string | null {
  const parts = raw
    .split(/[,;|\n]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  for (const part of parts) {
    if (part.length < 2 || !/[\p{L}\p{N}]/u.test(part)) {
      return part;
    }
  }
  return null;
}

function countBulkCandidates(raw: string): number {
  let count = 0;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/->|=>|→/.test(line)) {
      count += line.split(';').filter((s) => s.trim()).length;
    } else {
      count += line.split(/[,;]+/).filter((s) => s.trim()).length;
    }
  }
  return count;
}

export function GlossaryWorkspace({
  token,
  glossary,
  loadError = null,
  onRefresh,
}: GlossaryWorkspaceProps) {
  const { tr } = useI18n();
  const canEditGlobal = Boolean(glossary?.can_edit_global);
  const hasPersonalScope = Boolean(glossary?.has_personal_scope);
  const defaultScope: GlossaryScope =
    glossary?.default_scope || (canEditGlobal ? 'global' : 'personal');

  const [activeScope, setActiveScope] = useState<GlossaryScope>(defaultScope);
  const scopeInitializedRef = useRef(false);

  useEffect(() => {
    if (!glossary) return;
    if (!scopeInitializedRef.current) {
      scopeInitializedRef.current = true;
      setActiveScope(glossary.default_scope);
      return;
    }
    if (activeScope === 'personal' && !glossary.has_personal_scope) {
      setActiveScope('global');
    }
  }, [glossary, activeScope]);

  const [termInput, setTermInput] = useState('');
  const [aliasInput, setAliasInput] = useState('');
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedList, setCopiedList] = useState(false);

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editTermDraft, setEditTermDraft] = useState('');
  const [editAliasesDraft, setEditAliasesDraft] = useState('');

  const [savingAdd, setSavingAdd] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [restoringTerm, setRestoringTerm] = useState<string | null>(null);
  const [restoringUndo, setRestoringUndo] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [undoDeleted, setUndoDeleted] = useState<DeletedGlossaryUndo | null>(
    null
  );

  const addLockRef = useRef(false);
  const editLockRef = useRef(false);
  const deleteLockRef = useRef(false);

  const isCurrentScopeEditable =
    activeScope === 'global' ? canEditGlobal : hasPersonalScope;

  const entries: GlossaryEntryItem[] = useMemo(() => {
    if (!glossary) return [];
    return activeScope === 'global'
      ? glossary.global_entries
      : glossary.personal_entries;
  }, [glossary, activeScope]);

  const suppressedEnvTerms = useMemo(() => {
    if (!glossary || activeScope !== 'global') return [];
    return glossary.suppressed_env_terms || [];
  }, [glossary, activeScope]);

  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (item) =>
        item.term.toLowerCase().includes(q) ||
        item.aliases.some((al) => al.toLowerCase().includes(q))
    );
  }, [entries, searchQuery]);

  const looksLikeMultipleTerms =
    termInput.includes(',') ||
    termInput.includes(';') ||
    termInput.includes('->') ||
    termInput.includes('=>') ||
    termInput.includes('→');

  const multiTermAliasConflict =
    !bulkMode && looksLikeMultipleTerms && aliasInput.trim().length > 0;
  const invalidAddAlias = !bulkMode ? findInvalidShortAlias(aliasInput) : null;
  const invalidEditAlias = editingKey
    ? findInvalidShortAlias(editAliasesDraft)
    : null;

  const inlineAddValidationHint = multiTermAliasConflict
    ? tr(
        'Separate Hörfehler gelten jeweils für genau einen Fachbegriff — nutzen Sie „Hörfehler -> Fachbegriff“ oder „Liste einfügen“.',
        'Separate mishearings apply to a single canonical term — use “Misheard -> Term” syntax or “Bulk paste”.'
      )
    : invalidAddAlias
      ? tr(
          `„${invalidAddAlias}“ ist zu kurz — Hörfehler-Varianten müssen mindestens 2 Zeichen lang sein.`,
          `“${invalidAddAlias}” is too short — misheard variants must be at least 2 characters.`
        )
      : null;

  const handleToggleBulkMode = () => {
    if (!bulkMode) {
      const cleanTerm = termInput.trim();
      const cleanAlias = aliasInput.trim();
      if (cleanTerm && !bulkText.trim()) {
        setBulkText(cleanAlias ? `${cleanAlias} -> ${cleanTerm}` : cleanTerm);
      }
      setBulkMode(true);
    } else {
      setBulkMode(false);
    }
  };

  const handleCopyGlossaryList = () => {
    if (entries.length === 0 || !navigator.clipboard) return;
    const formatted = entries
      .map((item) =>
        item.aliases.length > 0
          ? `${item.aliases.join(' | ')} -> ${item.term}`
          : item.term
      )
      .join('\n');
    navigator.clipboard.writeText(formatted).then(() => {
      setCopiedList(true);
      window.setTimeout(() => setCopiedList(false), 1800);
    });
  };

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      !isCurrentScopeEditable ||
      addLockRef.current ||
      multiTermAliasConflict ||
      Boolean(invalidAddAlias)
    ) {
      return;
    }
    const raw = bulkMode ? bulkText.trim() : termInput.trim();
    if (!raw) return;

    addLockRef.current = true;
    setSavingAdd(true);
    setErrorMsg(null);
    setUndoDeleted(null);
    try {
      if (bulkMode || looksLikeMultipleTerms) {
        const approxCount = countBulkCandidates(raw);
        await upsertGlossaryEntries(token, {
          scope: activeScope,
          raw_text: raw,
        });
        setStatusMsg(
          approxCount === 1
            ? tr('1 Begriff im Glossar gespeichert.', 'Saved 1 term to glossary.')
            : tr(
                `${approxCount} Einträge im Glossar übernommen.`,
                `Imported ${approxCount} entries into glossary.`
              )
        );
      } else {
        await upsertGlossaryEntries(token, {
          scope: activeScope,
          term: raw,
          aliases: aliasInput.trim() || undefined,
        });
        setStatusMsg(
          tr(`„${raw}“ im Glossar gespeichert.`, `Saved “${raw}” to glossary.`)
        );
      }
      setTermInput('');
      setAliasInput('');
      setBulkText('');
      if (bulkMode) setBulkMode(false);
      onRefresh();
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : tr('Speichern fehlgeschlagen.', 'Failed to save glossary entry.')
      );
    } finally {
      addLockRef.current = false;
      setSavingAdd(false);
    }
  };

  const handleStartEdit = (item: GlossaryEntryItem) => {
    setEditingKey(item.term_key);
    setEditTermDraft(item.term);
    setEditAliasesDraft(item.aliases.join(', '));
    setErrorMsg(null);
  };

  const handleSaveEdit = async (originalKey: string) => {
    if (
      !isCurrentScopeEditable ||
      editLockRef.current ||
      Boolean(invalidEditAlias)
    ) {
      return;
    }
    const cleanTerm = editTermDraft.trim();
    if (!cleanTerm) return;

    editLockRef.current = true;
    setSavingEdit(true);
    setErrorMsg(null);
    try {
      await upsertGlossaryEntries(token, {
        scope: activeScope,
        term: cleanTerm,
        aliases: editAliasesDraft,
        replace_aliases: true,
        previous_term_key: originalKey,
      });
      setEditingKey(null);
      setStatusMsg(
        tr(`„${cleanTerm}“ aktualisiert.`, `Updated “${cleanTerm}”.`)
      );
      onRefresh();
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : tr('Änderung fehlgeschlagen.', 'Failed to update entry.')
      );
    } finally {
      editLockRef.current = false;
      setSavingEdit(false);
    }
  };

  const handleDelete = async (item: GlossaryEntryItem) => {
    if (!isCurrentScopeEditable || deleteLockRef.current) return;
    deleteLockRef.current = true;
    setDeletingKey(item.term_key);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      await deleteGlossaryEntry(token, item.term_key, activeScope);
      if (editingKey === item.term_key) {
        setEditingKey(null);
      }
      setUndoDeleted({
        term: item.term,
        aliases: item.aliases,
        scope: activeScope,
      });
      onRefresh();
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : tr('Löschen fehlgeschlagen.', 'Failed to delete entry.')
      );
    } finally {
      deleteLockRef.current = false;
      setDeletingKey(null);
    }
  };

  const handleUndoDelete = async () => {
    if (!undoDeleted || addLockRef.current) return;
    addLockRef.current = true;
    setRestoringUndo(true);
    setErrorMsg(null);
    try {
      await upsertGlossaryEntries(token, {
        scope: undoDeleted.scope,
        term: undoDeleted.term,
        aliases: undoDeleted.aliases,
        replace_aliases: true,
      });
      const restoredName = undoDeleted.term;
      setUndoDeleted(null);
      setStatusMsg(
        tr(`„${restoredName}“ wiederhergestellt.`, `Restored “${restoredName}”.`)
      );
      onRefresh();
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : tr('Wiederherstellen fehlgeschlagen.', 'Failed to restore entry.')
      );
    } finally {
      addLockRef.current = false;
      setRestoringUndo(false);
    }
  };

  const handleRestoreEnvTerm = async (envTerm: string) => {
    if (!canEditGlobal || addLockRef.current) return;
    addLockRef.current = true;
    setRestoringTerm(envTerm);
    setErrorMsg(null);
    try {
      await upsertGlossaryEntries(token, {
        scope: 'global',
        term: envTerm,
      });
      setStatusMsg(
        tr(
          `Standardbegriff „${envTerm}“ wieder aktiviert.`,
          `Re-enabled default term “${envTerm}”.`
        )
      );
      onRefresh();
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : tr('Wiederherstellen fehlgeschlagen.', 'Failed to restore term.')
      );
    } finally {
      addLockRef.current = false;
      setRestoringTerm(null);
    }
  };

  const showScopeToggle =
    hasPersonalScope &&
    (canEditGlobal || (glossary?.global_entries.length || 0) > 0);

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <div className="wl-page-container">
            <HStack justify="between" vAlign="center" wrap="wrap" gap={3}>
              <VStack gap={0.5} className="max-w-[70ch]">
                <Heading level={1}>{tr('Glossar', 'Glossary')}</Heading>
                <Text type="supporting" color="secondary">
                  {tr(
                    'Eigennamen, Produkte und Fachbegriffe für Spracherkennung und KI-Zusammenfassung — hinterlegte Hörfehler werden auch in bestehenden Protokollen korrigiert.',
                    'Proper nouns, products, and domain terms for speech recognition and AI summaries — saved mishearings also normalize existing transcripts.'
                  )}
                </Text>
              </VStack>

              <HStack gap={2} vAlign="center" wrap="wrap">
                {showScopeToggle && (
                  <SegmentedControl
                    size="sm"
                    label={tr('Glossar-Bereich', 'Glossary scope')}
                    value={activeScope}
                    onChange={(val) => {
                      setEditingKey(null);
                      setErrorMsg(null);
                      setActiveScope(val as GlossaryScope);
                    }}
                  >
                    {hasPersonalScope && (
                      <SegmentedControlItem
                        value="personal"
                        label={`${tr('Persönlich', 'Personal')} (${glossary?.personal_entries.length || 0})`}
                      />
                    )}
                    <SegmentedControlItem
                      value="global"
                      label={`${tr('Team-Glossar', 'Team Glossary')} (${glossary?.global_entries.length || 0})`}
                    />
                  </SegmentedControl>
                )}
                {entries.length > 0 && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={
                      copiedList ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )
                    }
                    label={
                      copiedList
                        ? tr('Kopiert', 'Copied')
                        : tr('Liste kopieren', 'Copy list')
                    }
                    onClick={handleCopyGlossaryList}
                  />
                )}
              </HStack>
            </HStack>
          </div>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          <div className="wl-page-container">
            <VStack gap={4}>
              {(loadError || errorMsg) && (
                <Banner
                  status="error"
                  container="card"
                  title={errorMsg || loadError || ''}
                  isDismissable={Boolean(errorMsg)}
                  onDismiss={errorMsg ? () => setErrorMsg(null) : undefined}
                />
              )}

              {undoDeleted && (
                <Banner
                  status="info"
                  container="card"
                  isDismissable
                  onDismiss={() => setUndoDeleted(null)}
                  title={tr(
                    `„${undoDeleted.term}“ wurde aus dem Glossar entfernt.`,
                    `Removed “${undoDeleted.term}” from the glossary.`
                  )}
                  endContent={
                    <Button
                      variant="secondary"
                      size="sm"
                      isLoading={restoringUndo}
                      icon={<RotateCcw className="h-3.5 w-3.5" />}
                      label={tr('Rückgängig', 'Undo')}
                      onClick={handleUndoDelete}
                    />
                  }
                />
              )}

              {statusMsg && !undoDeleted && (
                <Banner
                  status="success"
                  container="card"
                  title={statusMsg}
                  isDismissable
                  onDismiss={() => setStatusMsg(null)}
                />
              )}

              {!isCurrentScopeEditable ? (
                <Banner
                  status="info"
                  container="card"
                  title={tr(
                    'Instanzweites Team-Glossar (Schreibgeschützt)',
                    'Instance-wide Team Glossary (Read-only)'
                  )}
                  description={tr(
                    'Diese Begriffe gelten automatisch für alle Aufnahmen dieser Instanz. Eigene Kunden-, Projekt- oder Fachbegriffe können Sie im Tab „Persönlich“ pflegen.',
                    'These baseline terms apply automatically to all recordings on this instance. Switch to “Personal” to manage custom vocabulary for your own meetings.'
                  )}
                />
              ) : (
                <form onSubmit={handleAddSubmit} className="wl-dispatch-bar">
                  {bulkMode ? (
                    <VStack gap={2}>
                      <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
                        <Text type="supporting" weight="semibold" color="primary">
                          {tr(
                            'Mehrere Begriffe oder Zuordnungen einfügen (Komma oder Zeilenumbruch)',
                            'Paste multiple terms or mappings (comma or newline separated)'
                          )}
                        </Text>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          label={tr('Einzeleingabe', 'Single input')}
                          onClick={handleToggleBulkMode}
                        />
                      </HStack>
                      <textarea
                        rows={4}
                        dir="auto"
                        value={bulkText}
                        onChange={(e) => setBulkText(e.target.value)}
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                            void handleAddSubmit(e);
                          } else if (e.key === 'Escape') {
                            setBulkMode(false);
                          }
                        }}
                        placeholder={tr(
                          'mAIstack, Mainova, Hertener Stadtwerke, Europa-Park, s.Oliver\nMistack | Maystack -> mAIstack',
                          'mAIstack, Mainova, Hertener Stadtwerke, Europa-Park, s.Oliver\nMistack | Maystack -> mAIstack'
                        )}
                        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-background-surface)] px-3 py-2 text-[16px] md:text-[14px] leading-relaxed text-[var(--color-text-primary)] wl-focus-accent"
                      />
                      <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
                        <Text type="supporting" color="secondary">
                          {tr(
                            'Tipp: „Falsch | Variante -> Korrekt“ ersetzt Hörfehler auch rückwirkend im Protokoll.',
                            'Tip: “Misheard | Variant -> Canonical” also normalizes existing transcripts.'
                          )}
                        </Text>
                        <HStack gap={2} vAlign="center">
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            label={tr('Abbrechen', 'Cancel')}
                            onClick={() => {
                              setBulkMode(false);
                              setBulkText('');
                            }}
                          />
                          <Button
                            type="submit"
                            variant="primary"
                            size="sm"
                            isLoading={savingAdd}
                            isDisabled={!bulkText.trim()}
                            icon={<Plus className="h-3.5 w-3.5" />}
                            label={tr('Liste übernehmen', 'Import terms')}
                          />
                        </HStack>
                      </HStack>
                    </VStack>
                  ) : (
                    <VStack gap={2}>
                      <div className="flex flex-col gap-2.5 lg:flex-row lg:items-end">
                        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 flex-1 min-w-0">
                          <TextInput
                            size="sm"
                            label={tr(
                              'Fachbegriff (korrekte Schreibweise)',
                              'Domain term (canonical spelling)'
                            )}
                            value={termInput}
                            onChange={setTermInput}
                            placeholder={tr(
                              'z. B. mAIstack, Hertener Stadtwerke…',
                              'e.g. mAIstack, Hertener Stadtwerke…'
                            )}
                          />
                          <TextInput
                            size="sm"
                            label={tr(
                              'Ersetzte Hörfehler (optional)',
                              'Replaced mishearings (optional)'
                            )}
                            value={aliasInput}
                            onChange={setAliasInput}
                            placeholder={tr(
                              'z. B. Mistack, Maystack',
                              'e.g. Mistack, Maystack'
                            )}
                          />
                        </div>
                        <div className="flex items-center justify-end gap-1.5 shrink-0">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            icon={<ListPlus className="h-3.5 w-3.5" />}
                            label={tr('Liste einfügen', 'Bulk paste')}
                            onClick={handleToggleBulkMode}
                          />
                          <Button
                            type="submit"
                            variant="primary"
                            size="sm"
                            isLoading={savingAdd}
                            isDisabled={
                              !termInput.trim() ||
                              multiTermAliasConflict ||
                              Boolean(invalidAddAlias)
                            }
                            icon={<Plus className="h-3.5 w-3.5" />}
                            label={tr('Hinzufügen', 'Add')}
                          />
                        </div>
                      </div>
                      {inlineAddValidationHint && (
                        <p
                          role="alert"
                          className="m-0 text-[13px] text-[var(--wl-warn-text)]"
                        >
                          {inlineAddValidationHint}
                        </p>
                      )}
                    </VStack>
                  )}
                </form>
              )}

              <VStack gap={2}>
                <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
                  <HStack gap={2} vAlign="center">
                    <Heading level={2}>
                      {activeScope === 'global'
                        ? tr('Team-Glossar', 'Team Glossary')
                        : tr('Persönliches Glossar', 'Personal Glossary')}
                    </Heading>
                    <Token size="sm" label={String(entries.length)} />
                  </HStack>

                  {entries.length > 0 && (
                    <div className="w-60 max-w-full">
                      <TextInput
                        type="search"
                        size="sm"
                        label={tr('Glossar filtern', 'Filter glossary')}
                        isLabelHidden
                        hasClear
                        value={searchQuery}
                        onChange={setSearchQuery}
                        placeholder={tr('Begriff suchen…', 'Filter terms…')}
                        startIcon={<Search className="h-3.5 w-3.5" />}
                      />
                    </div>
                  )}
                </HStack>

                {entries.length === 0 ? (
                  <EmptyState
                    headingLevel={3}
                    icon={<BookOpen className="h-8 w-8" />}
                    title={tr(
                      'Noch keine Glossarbegriffe hinterlegt',
                      'No glossary terms configured yet'
                    )}
                    description={tr(
                      'Hinterlegte Eigennamen, Kunden- und Produktbegriffe verbessern die Spracherkennung sowie die Schreibweise in KI-Zusammenfassungen sofort für neue Aufnahmen.',
                      'Saved proper nouns, customer names, and product terms immediately improve speech recognition accuracy and AI summary spelling on upcoming recordings.'
                    )}
                  />
                ) : filteredEntries.length === 0 ? (
                  <EmptyState
                    headingLevel={3}
                    icon={<Search className="h-7 w-7" />}
                    title={tr(
                      'Kein Eintrag für diesen Suchbegriff',
                      'No matching glossary entry'
                    )}
                    actions={
                      <Button
                        variant="secondary"
                        size="sm"
                        label={tr('Suche zurücksetzen', 'Clear filter')}
                        onClick={() => setSearchQuery('')}
                      />
                    }
                  />
                ) : (
                  <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background-surface)] divide-y divide-[var(--color-border)]">
                    {filteredEntries.map((item) => {
                      const isEditing = editingKey === item.term_key;
                      return (
                        <div key={item.term_key} className="px-4 py-2.5">
                          {isEditing ? (
                            <VStack gap={1}>
                              <form
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  void handleSaveEdit(item.term_key);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') {
                                    setEditingKey(null);
                                  }
                                }}
                                className="flex flex-col gap-2.5 lg:flex-row lg:items-end"
                              >
                                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 flex-1 min-w-0">
                                  <TextInput
                                    size="sm"
                                    label={tr(
                                      'Korrekte Schreibweise',
                                      'Canonical term'
                                    )}
                                    value={editTermDraft}
                                    onChange={setEditTermDraft}
                                  />
                                  <TextInput
                                    size="sm"
                                    label={tr(
                                      'Ersetzte Hörfehler (kommagetrennt)',
                                      'Replaced mishearings (comma-separated)'
                                    )}
                                    value={editAliasesDraft}
                                    onChange={setEditAliasesDraft}
                                    placeholder={tr(
                                      'z. B. Mistack, Maystack',
                                      'e.g. Mistack, Maystack'
                                    )}
                                  />
                                </div>
                                <div className="flex items-center justify-end gap-2 shrink-0">
                                  <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    icon={<X className="h-3.5 w-3.5" />}
                                    label={tr('Abbrechen', 'Cancel')}
                                    onClick={() => setEditingKey(null)}
                                  />
                                  <Button
                                    type="submit"
                                    variant="primary"
                                    size="sm"
                                    isLoading={savingEdit}
                                    isDisabled={
                                      !editTermDraft.trim() ||
                                      Boolean(invalidEditAlias)
                                    }
                                    icon={<Check className="h-3.5 w-3.5" />}
                                    label={tr('Speichern', 'Save')}
                                  />
                                </div>
                              </form>
                              {invalidEditAlias && (
                                <p
                                  role="alert"
                                  className="m-0 text-[13px] text-[var(--wl-warn-text)]"
                                >
                                  {tr(
                                    `„${invalidEditAlias}“ ist zu kurz — mindestens 2 Zeichen erforderlich.`,
                                    `“${invalidEditAlias}” is too short — at least 2 characters required.`
                                  )}
                                </p>
                              )}
                            </VStack>
                          ) : (
                            <HStack
                              justify="between"
                              vAlign="center"
                              wrap="wrap"
                              gap={2}
                            >
                              <HStack
                                gap={2}
                                vAlign="center"
                                wrap="wrap"
                                className="min-w-0 flex-1"
                              >
                                <span
                                  dir="auto"
                                  className="wl-break-anywhere font-semibold text-[14px] text-[var(--color-text-primary)]"
                                >
                                  {item.term}
                                </span>
                                {item.source === 'env' && (
                                  <Token
                                    size="sm"
                                    label={tr('Standard', 'Default')}
                                  />
                                )}
                                {item.aliases.length > 0 && (
                                  <HStack gap={1} vAlign="center" wrap="wrap">
                                    <span className="text-[12px] text-[var(--color-text-secondary)]">
                                      {tr('ersetzt:', 'replaces:')}
                                    </span>
                                    {item.aliases.map((al) => (
                                      <span
                                        key={al}
                                        dir="auto"
                                        className="wl-break-anywhere inline-flex items-center rounded-full border border-[var(--color-border)] bg-[var(--color-background-muted)] px-2 py-0.5 text-[12px] line-through text-[var(--color-text-secondary)]"
                                      >
                                        {al}
                                      </span>
                                    ))}
                                  </HStack>
                                )}
                              </HStack>

                              {isCurrentScopeEditable && (
                                <HStack gap={2} vAlign="center">
                                  <IconButton
                                    variant="ghost"
                                    size="sm"
                                    label={tr(
                                      `${item.term} bearbeiten`,
                                      `Edit ${item.term}`
                                    )}
                                    icon={<Edit3 className="h-3.5 w-3.5" />}
                                    onClick={() => handleStartEdit(item)}
                                  />
                                  <IconButton
                                    variant="ghost"
                                    size="sm"
                                    isLoading={deletingKey === item.term_key}
                                    label={tr(
                                      `${item.term} entfernen`,
                                      `Remove ${item.term}`
                                    )}
                                    icon={<Trash2 className="h-3.5 w-3.5" />}
                                    onClick={() => handleDelete(item)}
                                  />
                                </HStack>
                              )}
                            </HStack>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {isCurrentScopeEditable && suppressedEnvTerms.length > 0 && (
                  <HStack
                    gap={1.5}
                    vAlign="center"
                    wrap="wrap"
                    className="pt-1"
                  >
                    <Text type="supporting" color="secondary">
                      {tr(
                        'Ausgeblendete Standardbegriffe:',
                        'Muted default terms:'
                      )}
                    </Text>
                    {suppressedEnvTerms.map((envTerm) => (
                      <button
                        key={envTerm}
                        type="button"
                        disabled={restoringTerm === envTerm}
                        onClick={() => handleRestoreEnvTerm(envTerm)}
                        className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--color-border)] bg-[var(--color-background-surface)] px-2.5 py-0.5 text-[12px] text-[var(--color-text-secondary)] hover:border-[var(--wl-accent)] hover:text-[var(--color-text-primary)] transition-colors cursor-pointer"
                        title={tr(
                          `${envTerm} wieder aktivieren`,
                          `Re-enable ${envTerm}`
                        )}
                      >
                        <Plus className="h-3 w-3" />
                        <span dir="auto">{envTerm}</span>
                      </button>
                    ))}
                  </HStack>
                )}
              </VStack>
            </VStack>
          </div>
        </LayoutContent>
      }
    />
  );
}
