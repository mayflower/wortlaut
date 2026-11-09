// Exact Zoom webclient and invite origins; third-party SSO login pages are never capture targets.
export function isZoomOrigin(url: URL) {
  return url.protocol === 'https:' && !url.port &&
    (url.hostname === 'zoom.us' || url.hostname.endsWith('.zoom.us'));
}

export function isZoomMeeting(url: URL) {
  return isZoomOrigin(url) && !url.username && !url.password &&
    /^\/(?:wc\/[0-9]{9,11}\/join|j\/[0-9]{9,11}|s\/[0-9]{9,11})\/?$/.test(url.pathname);
}
