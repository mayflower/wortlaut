// Exact webclient origins only; Microsoft login pages are never capture targets.
export const teamsOrigins = [
  'https://teams.microsoft.com', 'https://teams.live.com', 'https://teams.cloud.microsoft',
];
export function isTeamsOrigin(url: URL) { return teamsOrigins.includes(url.origin); }
export function isTeamsMeeting(url: URL) {
  return isTeamsOrigin(url) && !url.username && !url.password &&
    /^\/(?:meet\/[0-9]+|l\/meetup-join\/[A-Za-z0-9_%.-]+\/[0-9]+)\/?$/.test(url.pathname);
}
