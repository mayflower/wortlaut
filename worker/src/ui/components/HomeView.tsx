import React from 'react';
import type { CalendarEvent, RecordingSummary } from '../types';
import { RecordingSidebar, type QuickStatusFilter } from './RecordingSidebar';

export interface HomeViewProps {
  token: string;
  recordings: RecordingSummary[];
  calendarEvents: CalendarEvent[];
  onOpenRecording: (id: string) => void;
  onNavigateMeetings: () => void;
  onNavigateCalendar: () => void;
  onOpenIcsImport: () => void;
  onCreatedRecording: (id: string) => void;
}

export function HomeView({
  token,
  recordings,
  onOpenRecording,
  onOpenIcsImport,
  onCreatedRecording,
}: HomeViewProps) {
  const [providerFilter, setProviderFilter] = React.useState('');
  const [quickFilter, setQuickFilter] =
    React.useState<QuickStatusFilter>('all');
  const [titleSearch, setTitleSearch] = React.useState('');

  return (
    <RecordingSidebar
      token={token}
      recordings={recordings}
      selectedId={null}
      onSelectRecording={onOpenRecording}
      providerFilter={providerFilter}
      onProviderFilterChange={setProviderFilter}
      quickFilter={quickFilter}
      onQuickFilterChange={setQuickFilter}
      titleSearch={titleSearch}
      onTitleSearchChange={setTitleSearch}
      onOpenNewRecording={onOpenIcsImport}
      onOpenIcsImport={onOpenIcsImport}
      onCreatedRecording={onCreatedRecording}
      isLoading={false}
    />
  );
}
