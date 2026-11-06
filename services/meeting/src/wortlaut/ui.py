"""Self-contained operator and transcript web UI served directly by the meeting service."""

from wortlaut.mail import FAILURE_REASONS

UI_HTML = """<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>wortlaut – Meeting-Transkription</title>
  <style>
    :root {
      --bg: #0f172a;
      --panel: #1e293b;
      --panel-alt: #273549;
      --border: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --accent-hover: #0284c7;
      --success: #22c55e;
      --warn: #f59e0b;
      --danger: #ef4444;
      --radius: 8px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.45;
    }
    header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 20px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 1.2rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--muted);
      display: inline-block;
    }
    .dot.ok { background: var(--success); }
    .dot.err { background: var(--danger); }
    .auth-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    input, select, button {
      font: inherit;
      color: var(--text);
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 7px 11px;
    }
    input:focus, select:focus {
      outline: 2px solid var(--accent);
      border-color: transparent;
    }
    button {
      cursor: pointer;
      background: var(--panel-alt);
      font-weight: 500;
      transition: background 0.15s;
    }
    button:hover { background: var(--border); }
    button.primary {
      background: var(--accent-hover);
      border-color: var(--accent);
      color: #fff;
    }
    button.primary:hover { background: #0369a1; }
    button.danger {
      background: #7f1d1d;
      border-color: var(--danger);
      color: #fecaca;
    }
    .container {
      max-width: 1440px;
      margin: 0 auto;
      padding: 16px 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px;
    }
    .card h2, .card h3 {
      margin: 0 0 12px 0;
      font-size: 1.02rem;
    }
    .dispatch-form {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: flex-end;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .field.grow { flex: 1 1 320px; }
    .field label {
      font-size: 0.78rem;
      color: var(--muted);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .grid {
      display: grid;
      grid-template-columns: 430px 1fr;
      gap: 16px;
      align-items: start;
    }
    @media (max-width: 980px) {
      .grid { grid-template-columns: 1fr; }
    }
    .list-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      gap: 8px;
    }
    .recording-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 74vh;
      overflow-y: auto;
    }
    .rec-item {
      padding: 12px;
      border-radius: 6px;
      background: var(--bg);
      border: 1px solid var(--border);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .rec-item:hover, .rec-item.active {
      border-color: var(--accent);
      background: #162238;
    }
    .rec-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      font-size: 0.84rem;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 600;
      background: var(--panel-alt);
      color: var(--text);
    }
    .badge.provider-google_meet { background: #14532d; color: #bbf7d0; }
    .badge.provider-teams { background: #312e81; color: #c7d2fe; }
    .badge.provider-webex { background: #0c4a6e; color: #bae6fd; }
    .badge.state-capturing { background: #166534; color: #dcfce7; }
    .badge.state-waiting_admission { background: #92400e; color: #fef3c7; }
    .badge.state-joining, .badge.state-preparing { background: #075985; color: #e0f2fe; }
    .badge.state-failed, .badge.state-unknown { background: #7f1d1d; color: #fecaca; }
    .muted { color: var(--muted); font-size: 0.83rem; }
    .alert {
      padding: 9px 12px;
      border-radius: 6px;
      font-size: 0.86rem;
      margin-top: 6px;
    }
    .alert.warn { background: #451a03; border: 1px solid var(--warn); color: #fde68a; }
    .alert.err { background: #450a0a; border: 1px solid var(--danger); color: #fecaca; }
    .alert.ok { background: #052e16; border: 1px solid var(--success); color: #bbf7d0; }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 12px;
    }
    .source-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin-bottom: 8px;
      padding: 8px;
      background: var(--bg);
      border-radius: 6px;
      border: 1px solid var(--border);
    }
    .source-row code {
      font-size: 0.8rem;
      color: var(--accent);
      flex: 1 1 220px;
      word-break: break-all;
    }
    .segments {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 55vh;
      overflow-y: auto;
      margin-top: 10px;
    }
    .segment {
      padding: 10px 12px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    .segment-meta {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-size: 0.79rem;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .speaker-tag {
      color: var(--accent);
      font-weight: 600;
    }
    details {
      margin-top: 12px;
      border-top: 1px solid var(--border);
      padding-top: 10px;
    }
    summary {
      cursor: pointer;
      font-weight: 600;
      font-size: 0.9rem;
      color: var(--muted);
    }
    pre {
      background: var(--bg);
      padding: 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      overflow-x: auto;
      font-size: 0.78rem;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span id="health-dot" class="dot" title="Systemstatus"></span>
      <span>wortlaut</span>
      <span class="muted">Google Meet · Microsoft Teams · Webex</span>
    </div>
    <div class="auth-bar">
      <input id="api-token" type="password" placeholder="API Bearer Token" style="width: 230px">
      <button id="save-token" class="primary">Verbinden</button>
      <label class="muted" style="display:flex;align-items:center;gap:4px">
        <input id="auto-refresh" type="checkbox" checked> Live (3s)
      </label>
      <button id="refresh-btn">Aktualisieren</button>
    </div>
  </header>

  <div class="container">
    <section class="card">
      <h2>Bot in ein Meeting schicken (Ad-hoc oder Geplant)</h2>
      <form id="dispatch-form" class="dispatch-form">
        <div class="field grow">
          <label for="meeting-url">Meeting-Link (Google Meet, Teams oder Webex)</label>
          <input id="meeting-url" type="url" required
            placeholder="https://meet.google.com/... oder https://teams.microsoft.com/meet/...">
        </div>
        <div class="field">
          <label for="join-mode">Modus</label>
          <select id="join-mode">
            <option value="live">Sofort beitreten (Live)</option>
            <option value="scheduled">Termin planen</option>
          </select>
        </div>
        <div class="field" id="duration-field">
          <label for="duration-min">Dauer</label>
          <select id="duration-min">
            <option value="30">30 Minuten</option>
            <option value="60" selected>60 Minuten</option>
            <option value="90">90 Minuten</option>
            <option value="120">120 Minuten</option>
          </select>
        </div>
        <div class="field" id="start-field" style="display:none">
          <label for="starts-at">Startzeit</label>
          <input id="starts-at" type="datetime-local">
        </div>
        <div class="field" id="end-field" style="display:none">
          <label for="ends-at">Endzeit</label>
          <input id="ends-at" type="datetime-local">
        </div>
        <button type="submit" class="primary">Bot starten</button>
      </form>
      <div id="dispatch-feedback"></div>
    </section>

    <div class="grid">
      <section class="card">
        <div class="list-header">
          <h2 style="margin:0">Aufnahmen</h2>
          <select id="provider-filter">
            <option value="">Alle Provider</option>
            <option value="google_meet">Google Meet</option>
            <option value="teams">Microsoft Teams</option>
            <option value="webex">Webex</option>
          </select>
        </div>
        <div id="recordings-list" class="recording-list">
          <div class="muted">Bitte API-Token eingeben und verbinden.</div>
        </div>
      </section>

      <section class="card" id="detail-panel">
        <div class="muted">
          Aufnahme links auswählen, um Live-Status, Sprecher-Zuordnung und Transkript zu öffnen.
        </div>
      </section>
    </div>
  </div>

  <script>
    const FAILURE_REASONS = __FAILURE_REASONS_JSON__;
    const PARTICIPATION_LABELS = {
      scheduled: "Geplant",
      preparing: "Worker startet",
      joining: "Tritt Meeting bei…",
      waiting_admission: "Im Warteraum – bitte im Meeting einlassen!",
      capturing: "Nimmt auf",
      ended: "Beendet",
      unknown: "Unbekannt"
    };

    let selectedId = null;
    let token = localStorage.getItem("wortlaut_api_token") || "";
    const tokenInput = document.getElementById("api-token");
    tokenInput.value = token;

    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      }[c]));
    }

    function fmtTime(sec) {
      const ms = Math.max(0, Math.round((Number(sec) || 0) * 1000));
      const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
      const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
      const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
      return `${h}:${m}:${s}`;
    }

    async function api(path, options = {}) {
      const headers = new Headers(options.headers || {});
      if (token) headers.set("Authorization", "Bearer " + token);
      if (options.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      const res = await fetch(path, { ...options, headers });
      if (!res.ok) {
        let detail = res.statusText;
        try {
          const err = await res.json();
          if (err.detail) {
            detail = typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail);
          }
        } catch {}
        throw new Error(`${res.status}: ${detail}`);
      }
      return res;
    }

    async function checkHealth() {
      const dot = document.getElementById("health-dot");
      try {
        const res = await fetch("/health/ready");
        dot.className = res.ok ? "dot ok" : "dot err";
      } catch {
        dot.className = "dot err";
      }
    }

    document.getElementById("join-mode").addEventListener("change", (e) => {
      const scheduled = e.target.value === "scheduled";
      document.getElementById("duration-field").style.display = scheduled ? "none" : "";
      document.getElementById("start-field").style.display = scheduled ? "" : "none";
      document.getElementById("end-field").style.display = scheduled ? "" : "none";
    });

    document.getElementById("save-token").addEventListener("click", () => {
      token = tokenInput.value.trim();
      localStorage.setItem("wortlaut_api_token", token);
      refreshAll();
    });

    document.getElementById("refresh-btn").addEventListener("click", () => refreshAll());
    document.getElementById("provider-filter").addEventListener("change", () => loadList());

    document.getElementById("dispatch-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const feedback = document.getElementById("dispatch-feedback");
      feedback.innerHTML = "";
      try {
        const url = document.getElementById("meeting-url").value.trim();
        const mode = document.getElementById("join-mode").value;
        let startsAt, endsAt;
        if (mode === "live") {
          const mins = Number(document.getElementById("duration-min").value) || 60;
          const now = new Date();
          startsAt = now.toISOString();
          endsAt = new Date(now.getTime() + mins * 60000).toISOString();
        } else {
          const s = document.getElementById("starts-at").value;
          const end = document.getElementById("ends-at").value;
          if (!s || !end) throw new Error("Bitte Start- und Endzeit angeben.");
          startsAt = new Date(s).toISOString();
          endsAt = new Date(end).toISOString();
        }
        const key = "ui-" + (crypto.randomUUID ? crypto.randomUUID() : Date.now());
        const res = await api("/v1/recordings", {
          method: "POST",
          headers: { "Idempotency-Key": key },
          body: JSON.stringify({ meeting_url: url, starts_at: startsAt, ends_at: endsAt })
        });
        const created = await res.json();
        document.getElementById("meeting-url").value = "";
        selectedId = created.id;
        feedback.innerHTML = `<div class="alert ok">Aufnahme <code>${esc(created.id)}</code> `
          + `(${esc(created.provider)}) angelegt.</div>`;
        await refreshAll();
      } catch (err) {
        feedback.innerHTML = `<div class="alert err">${esc(err.message)}</div>`;
      }
    });

    async function loadList() {
      const container = document.getElementById("recordings-list");
      if (!token) {
        container.innerHTML = `<div class="muted">Bitte oben den API Bearer Token eintragen.</div>`;
        return;
      }
      try {
        const provider = document.getElementById("provider-filter").value;
        const query = new URLSearchParams({ limit: "50" });
        if (provider) query.set("provider", provider);
        const res = await api("/v1/recordings?" + query.toString());
        const data = await res.json();
        const items = (data.items || []).slice().reverse();
        if (!items.length) {
          container.innerHTML = `<div class="muted">Noch keine Aufnahmen vorhanden.</div>`;
          return;
        }
        if (!selectedId) selectedId = items[0].id;
        container.innerHTML = items.map((item) => {
          const active = item.id === selectedId ? "active" : "";
          const partLabel = PARTICIPATION_LABELS[item.participation] || item.participation;
          const reason = item.participation_reason;
          const reasonHint = reason && FAILURE_REASONS[reason] ? FAILURE_REASONS[reason] : reason;
          const samples = item.quality?.durable_sample_count || 0;
          const seconds = Math.round(samples / 16000);
          return `
            <div class="rec-item ${active}" data-id="${esc(item.id)}">
              <div class="rec-top">
                <span class="badge provider-${esc(item.provider)}">${esc(item.provider)}</span>
                <span class="badge state-${esc(item.participation)}">${esc(partLabel)}</span>
              </div>
              <div style="font-size:0.84rem;font-weight:600">
                ${esc(new Date(item.starts_at).toLocaleString("de-DE"))}
              </div>
              <div class="muted">
                ID: ${esc(item.id.slice(0, 8))}… · ASR: ${esc(item.processing)} · Audio: ${seconds}s
              </div>
              ${reasonHint
                ? `<div class="muted" style="color:#fca5a5">Grund: ${esc(reasonHint)}</div>`
                : ""}
            </div>
          `;
        }).join("");
        container.querySelectorAll(".rec-item").forEach((el) => {
          el.addEventListener("click", () => {
            selectedId = el.getAttribute("data-id");
            refreshAll();
          });
        });
      } catch (err) {
        container.innerHTML = `<div class="alert err">${esc(err.message)}</div>`;
      }
    }

    async function downloadExport(recordingId, format) {
      try {
        const res = await api(`/v1/recordings/${recordingId}/exports/${format}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `wortlaut-${recordingId}.${format}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        alert("Export noch nicht verfügbar: " + err.message);
      }
    }

    async function loadDetail() {
      const panel = document.getElementById("detail-panel");
      if (!token || !selectedId) return;
      const searchInput = document.getElementById("segment-search");
      const currentSearch = searchInput ? searchInput.value : "";
      const activeInput = document.activeElement;
      if (activeInput?.classList?.contains("source-label-input")) {
        return; // Eingabe in den Sprecherfeldern nicht durch Auto-Refresh überschreiben
      }
      try {
        const [recRes, transRes] = await Promise.all([
          api(`/v1/recordings/${selectedId}`),
          api(`/v1/recordings/${selectedId}/transcript`)
        ]);
        const rec = await recRes.json();
        const trans = await transRes.json();
        const lastAttempt = (rec.attempts || [])[rec.attempts.length - 1];
        const reason = rec.participation_reason || lastAttempt?.end_reason || "";
        const explanation = FAILURE_REASONS[reason] || "";
        const canCancel = rec.participation !== "ended" && !rec.cancelled_at;
        const canRetryMail = rec.delivery
          && ["failed", "delivery_unknown"].includes(rec.delivery.status);

        const sourceIds = new Set();
        (trans.quality?.streams || []).forEach((s) => {
          if (s.provider_source_id) sourceIds.add(s.provider_source_id);
        });
        (trans.segments || []).forEach((s) => {
          if (s.provider_source_id) sourceIds.add(s.provider_source_id);
        });
        (lastAttempt?.diagnostics?.receiver_sources || []).forEach((r) => {
          if (r.provider_source_id) sourceIds.add(r.provider_source_id);
        });
        const sourceLabels = trans.source_labels || {};

        const segments = (trans.segments || []).filter((s) => {
          if (!currentSearch.trim()) return true;
          const q = currentSearch.toLowerCase();
          return (s.text || "").toLowerCase().includes(q)
            || (s.speaker_label || "").toLowerCase().includes(q);
        });

        const startStr = new Date(rec.starts_at).toLocaleString("de-DE");
        const endStr = new Date(rec.ends_at).toLocaleString("de-DE");
        const partText = PARTICIPATION_LABELS[rec.participation] || rec.participation;
        const sampleCount = rec.ingest?.durable_sample_count ?? 0;
        const sampleSec = Math.round(sampleCount / 16000);
        const asrCounts = `${rec.asr?.pending ?? 0} / ${rec.asr?.completed ?? 0} / `
          + `${rec.asr?.failed ?? 0}`;

        panel.innerHTML = `
          <div class="toolbar">
            <div>
              <span class="badge provider-${esc(rec.provider)}">${esc(rec.provider)}</span>
              <strong style="margin-left:6px">${esc(rec.id)}</strong>
              <div class="muted" style="margin-top:4px">
                Zeitraum: ${esc(startStr)} – ${esc(endStr)}
              </div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button data-export="txt">TXT Export</button>
              <button data-export="vtt">WebVTT Export</button>
              <button data-export="json">JSON Export</button>
              ${canRetryMail ? `<button id="retry-mail-btn">Mail erneut senden</button>` : ""}
              ${canCancel
                ? `<button id="cancel-rec-btn" class="danger">Aufnahme beenden</button>`
                : ""}
            </div>
          </div>

          ${rec.participation === "waiting_admission" ? `
            <div class="alert warn">
              <strong>Warteraum aktiv:</strong>
              Der Bot wartet im Meeting-Warteraum auf Einlass durch den Host.
            </div>
          ` : ""}
          ${explanation ? `
            <div class="alert err">
              <strong>${esc(reason)}:</strong> ${esc(explanation)}
            </div>
          ` : ""}

          <div style="display:flex;gap:16px;flex-wrap:wrap;margin:10px 0" class="muted">
            <span>Teilnahme: <strong>${esc(partText)}</strong></span>
            <span>Verarbeitung: <strong>${esc(rec.processing)}</strong></span>
            <span>Samples: <strong>${esc(sampleCount)}</strong> (${sampleSec}s)</span>
            <span>ASR-Jobs (offen / fertig / fehler): <strong>${esc(asrCounts)}</strong></span>
            <span>Mail-Versand: <strong>${esc(rec.delivery?.status ?? "pending")}</strong></span>
          </div>

          ${sourceIds.size ? `
            <div style="margin-top:14px">
              <h3>Audio-Quellen &amp; Sprecher-Zuordnung</h3>
              ${[...sourceIds].map((sid) => `
                <div class="source-row">
                  <code>${esc(sid)}</code>
                  <input class="source-label-input" data-source-id="${esc(sid)}"
                    type="text" placeholder="Sprechername zuordnen (z. B. Max Mustermann)"
                    value="${esc(sourceLabels[sid] || "")}" style="flex:1 1 220px">
                </div>
              `).join("")}
              <button id="save-sources-btn" class="primary">Sprechernamen speichern</button>
            </div>
          ` : ""}

          <div style="margin-top:16px">
            <div class="list-header">
              <h3 style="margin:0">Transkript (${ (trans.segments || []).length } Segmente)</h3>
              <input id="segment-search" type="search"
                placeholder="Transkript durchsuchen…" value="${esc(currentSearch)}"
                style="width:240px">
            </div>
            <div class="segments">
              ${segments.length ? segments.map((seg) => `
                <div class="segment">
                  <div class="segment-meta">
                    <span class="speaker-tag">${esc(seg.speaker_label)}</span>
                    <span>${fmtTime(seg.start)} – ${fmtTime(seg.end)}</span>
                  </div>
                  <div>${esc(seg.text)}</div>
                </div>
              `).join("") : `<div class="muted">Noch keine Transkript-Segmente vorhanden.</div>`}
            </div>
          </div>

          <details>
            <summary>WebRTC-Receiver &amp; Worker-Diagnose anzeigen</summary>
            <pre>${esc(JSON.stringify({
              attempts: rec.attempts,
              audio_streams: rec.audio,
              quality: trans.quality
            }, null, 2))}</pre>
          </details>
        `;

        panel.querySelectorAll("[data-export]").forEach((btn) => {
          btn.addEventListener("click", () => {
            downloadExport(rec.id, btn.getAttribute("data-export"));
          });
        });

        const cancelBtn = document.getElementById("cancel-rec-btn");
        if (cancelBtn) {
          cancelBtn.addEventListener("click", async () => {
            await api(`/v1/recordings/${rec.id}/cancel`, { method: "POST" });
            refreshAll();
          });
        }

        const retryBtn = document.getElementById("retry-mail-btn");
        if (retryBtn) {
          retryBtn.addEventListener("click", async () => {
            await api(`/v1/recordings/${rec.id}/delivery/retry`, { method: "POST" });
            refreshAll();
          });
        }

        const saveSourcesBtn = document.getElementById("save-sources-btn");
        if (saveSourcesBtn) {
          saveSourcesBtn.addEventListener("click", async () => {
            const labels = {};
            panel.querySelectorAll(".source-label-input").forEach((inp) => {
              labels[inp.getAttribute("data-source-id")] = inp.value.trim();
            });
            await api(`/v1/recordings/${rec.id}/sources`, {
              method: "PATCH",
              body: JSON.stringify({ labels })
            });
            refreshAll();
          });
        }

        const newSearch = document.getElementById("segment-search");
        if (newSearch) {
          newSearch.addEventListener("input", () => loadDetail());
        }
      } catch (err) {
        panel.innerHTML = `<div class="alert err">${esc(err.message)}</div>`;
      }
    }

    async function refreshAll() {
      await checkHealth();
      await loadList();
      await loadDetail();
    }

    setInterval(() => {
      if (document.getElementById("auto-refresh").checked) {
        refreshAll();
      }
    }, 3000);

    refreshAll();
  </script>
</body>
</html>
"""


def render_ui() -> str:
    import json

    return UI_HTML.replace(
        "__FAILURE_REASONS_JSON__", json.dumps(FAILURE_REASONS, ensure_ascii=False)
    )
