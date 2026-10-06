// These claim/status requests are idempotent. A controller release must leave
// the browser and its independently reconnecting audio transport running.
export async function serviceRequest(url: URL, init: RequestInit, deadline = Infinity) {
  const until = Math.min(Date.now() + 120000, deadline);
  while (Date.now() < until) {
    let response: Response | undefined;
    try {
      response = await fetch(url, {...init, redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, Math.min(30000, until - Date.now())))});
    } catch { /* A lost reply is safe to replay with the same worker identity. */ }
    if (response?.ok) return response.json();
    if (response && ![408, 429, 500, 502, 503, 504].includes(response.status)) {
      throw new Error(`Meeting service request failed: HTTP ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(2000, until - Date.now()))));
  }
  throw new Error('Meeting service remained unavailable beyond the reconnect deadline');
}
