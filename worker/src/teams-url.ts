// Exact webclient origins only; Microsoft login pages are never capture targets.
export const teamsOrigins = [
  'https://teams.microsoft.com', 'https://teams.live.com', 'https://teams.cloud.microsoft',
];
export function isTeamsOrigin(url: URL) { return teamsOrigins.includes(url.origin); }
export function isTeamsMeeting(url: URL) {
  return isTeamsOrigin(url) && !url.username && !url.password &&
    /^\/(?:meet\/[0-9]+|l\/meetup-join\/[A-Za-z0-9_%.:@+=~-]+\/[0-9]+)\/?$/.test(url.pathname);
}

/**
 * Microsoft Teams pre-join rejects parentheses and most punctuation in guest
 * display names ("only letters, numbers, spaces, and - ' . _ @"), leaving the
 * Join button permanently disabled. Normalize `Base (Inviter)` -> `Base - Inviter`.
 */
export function sanitizeTeamsDisplayName(raw: string): string {
  const cleaned = (raw || '')
    .replace(/\s*\(\s*/g, ' - ')
    .replace(/\)/g, ' ')
    .replace(/[^\p{L}\p{N}\s'._@-]/gu, ' ')
    .replace(/\s*-\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s-]+|[\s-]+$/g, '');
  return cleaned.slice(0, 60).replace(/[\s-]+$/g, '') || 'wortlaut';
}
