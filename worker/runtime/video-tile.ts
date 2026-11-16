import type {Frame, Page} from 'playwright';
import {teamsOrigins} from '../src/teams-url.js';

export type VideoTileSegment = {
  speaker: string;
  text: string;
  start: number;
};

export type VideoTilePatch = {
  participation?: string;
  paused?: boolean;
  asrLanguage?: string;
  segments?: VideoTileSegment[];
};

export type VideoTileMetadata = {
  locale: string;
  invitedBy: string | null;
  meetingTitle: string | null;
  asrLanguage?: string | null;
};

type InitTileConfig = {
  provider: 'google_meet' | 'webex' | 'teams' | 'zoom';
  meetingUrl: string;
  teamsOrigins: string[];
  locale: string;
  invitedBy: string | null;
  meetingTitle: string | null;
  asrLanguage: string | null;
};

declare global {
  interface Window {
    wortlautVideoTile?: {
      update: (patch: VideoTilePatch) => void;
      reportAudioActivity: (level: number, speakerName?: string | null) => void;
      stop: () => void;
      getSnapshot: () => {
        frameCount: number;
        participation: string;
        paused: boolean;
        asrLanguage: string;
        audioActive: boolean;
        audioLevel: number;
        activeSpeaker: string | null;
        segmentCount: number;
        lastRenderedText: string;
        activeTracks: number;
      };
      canvas: HTMLCanvasElement;
    };
  }
}

export async function installVideoTile(
  page: Page,
  provider: 'google_meet' | 'webex' | 'teams' | 'zoom',
  meetingUrl: string,
  meta: VideoTileMetadata,
  resolveFrame?: () => Frame | undefined,
) {
  const initCfg: InitTileConfig = {
    provider,
    meetingUrl,
    teamsOrigins,
    locale: meta.locale,
    invitedBy: meta.invitedBy?.trim() || null,
    meetingTitle: meta.meetingTitle?.trim() || null,
    asrLanguage: meta.asrLanguage?.trim() || null,
  };

  await page.addInitScript((cfg: InitTileConfig) => {
    (globalThis as Record<string, unknown>).__name ??= (fn: unknown) => fn;
    const isZoomHost =
      location.protocol === 'https:' &&
      !location.port &&
      (location.hostname === 'zoom.us' || location.hostname.endsWith('.zoom.us'));
    const trusted =
      cfg.provider === 'webex'
        ? location.origin === 'https://web.webex.com' &&
          /^\/(?:meeting|guest-join-meeting)$/.test(location.pathname) &&
          !location.search.includes('preload=true')
        : cfg.provider === 'teams'
          ? window === window.top && cfg.teamsOrigins.includes(location.origin)
          : cfg.provider === 'zoom'
            ? window === window.top && isZoomHost
            : window === window.top &&
              location.origin === 'https://meet.google.com' &&
              location.pathname.replace(/^\/meet\//, '/') ===
                new URL(cfg.meetingUrl).pathname.replace(/^\/meet\//, '/');
    if (!trusted) return;

    const isEn = /^en\b/i.test(cfg.locale);
    const WIDTH = 1280;
    const HEIGHT = 720;
    const FONT_SANS = 'Inter, "Liberation Sans", "DejaVu Sans", system-ui, -apple-system, sans-serif';
    const FONT_MONO = '"Liberation Mono", "DejaVu Sans Mono", ui-monospace, monospace';
    const SPEAKER_COLORS = ['#60a5fa', '#34d399', '#f472b6', '#fbbf24', '#a78bfa', '#38bdf8'];

    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d');

    let participation = 'joining';
    let paused = false;
    let asrLanguage = cfg.asrLanguage || 'auto';
    let segments: VideoTileSegment[] = [];
    let frameCount = 0;
    let lastRenderedText = '';
    let liveAudioLevel = 0;
    let lastVoiceAt = -Infinity;
    let activeSpeaker: string | null = null;
    let activeSpeakerUntil = -Infinity;
    const liveTracks = new Set<MediaStreamTrack>();

    const sampleRtpAudioLevel = (): {level: number; speaker: string | null} => {
      let maxLevel = 0;
      const nowPerf = performance.now();
      const conns = (
        window as unknown as {
          wortlautMeetReceivers?: {connections?: Set<RTCPeerConnection>};
        }
      ).wortlautMeetReceivers?.connections;
      if (conns) {
        for (const pc of conns) {
          if (pc.connectionState === 'closed') continue;
          for (const recv of pc.getReceivers()) {
            if (recv.track?.kind !== 'audio' || recv.track.readyState !== 'live' || recv.track.muted) {
              continue;
            }
            for (const src of [
              ...recv.getSynchronizationSources(),
              ...recv.getContributingSources(),
            ]) {
              if (
                typeof src.timestamp === 'number' &&
                nowPerf - src.timestamp <= 500 &&
                typeof src.audioLevel === 'number' &&
                Number.isFinite(src.audioLevel)
              ) {
                const boosted = Math.min(1, src.audioLevel * 3.2);
                if (boosted > maxLevel) maxLevel = boosted;
              }
            }
          }
        }
      }
      return {level: maxLevel, speaker: null};
    };

    const roundRect = (
      c: CanvasRenderingContext2D,
      x: number,
      y: number,
      w: number,
      h: number,
      r: number,
    ) => {
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r);
      c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    };

    const speakerColor = (name: string): string => {
      let hash = 0;
      for (let i = 0; i < name.length; i++) {
        hash = (hash * 31 + name.charCodeAt(i)) | 0;
      }
      return SPEAKER_COLORS[Math.abs(hash) % SPEAKER_COLORS.length];
    };

    const formatTimestamp = (sec: number): string => {
      const total = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
      const mins = Math.floor(total / 60);
      const rem = total % 60;
      const hrs = Math.floor(mins / 60);
      if (hrs > 0) {
        return `${String(hrs).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
      }
      return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
    };

    const truncateText = (c: CanvasRenderingContext2D, text: string, maxW: number): string => {
      if (c.measureText(text).width <= maxW) return text;
      let out = text;
      while (out.length > 1 && c.measureText(out + '…').width > maxW) {
        out = out.slice(0, -1);
      }
      return out.trimEnd() + '…';
    };

    const wrapLines = (
      c: CanvasRenderingContext2D,
      text: string,
      maxW: number,
      maxLines: number,
    ): string[] => {
      const words = text.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) return [];
      const lines: string[] = [];
      let current = '';
      for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (c.measureText(candidate).width <= maxW) {
          current = candidate;
        } else {
          if (current) lines.push(current);
          if (c.measureText(word).width > maxW) {
            current = truncateText(c, word, maxW);
          } else {
            current = word;
          }
        }
      }
      if (current) lines.push(current);
      if (lines.length <= maxLines) return lines;
      const tail = lines.slice(lines.length - maxLines);
      tail[0] = '… ' + tail[0];
      if (c.measureText(tail[0]).width > maxW) {
        tail[0] = truncateText(c, tail[0], maxW);
      }
      return tail;
    };

    const renderFrame = () => {
      if (!ctx) return;
      frameCount += 1;
      const pulse = 0.55 + 0.45 * Math.sin(frameCount * 0.65);

      // Outer backdrop
      const bgGrad = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
      bgGrad.addColorStop(0, '#0c0e14');
      bgGrad.addColorStop(1, '#131824');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);

      // Safe-area card container (avoids bottom-left conference name overlays & 4:3 crop edges)
      const cardX = 68;
      const cardY = 32;
      const cardW = 1144;
      const cardH = 636;
      roundRect(ctx, cardX, cardY, cardW, cardH, 22);
      ctx.fillStyle = '#161b26';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.stroke();

      // Header background subtle highlight
      ctx.save();
      roundRect(ctx, cardX, cardY, cardW, cardH, 22);
      ctx.clip();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
      ctx.fillRect(cardX, cardY, cardW, 92);

      const nowPerf = performance.now();
      const isJoining = participation === 'joining' || participation === 'preparing';
      const inLobby = participation === 'waiting_admission';
      const isPendingEntry = isJoining || inLobby;
      const isPausedActive = paused && !isPendingEntry;
      const voiceActive =
        !isPausedActive &&
        !isPendingEntry &&
        (liveAudioLevel >= 0.02 || nowPerf - lastVoiceAt <= 650);
      const shownLevel = voiceActive ? Math.max(0.14, liveAudioLevel) : 0;
      const currentSpeaker =
        voiceActive && nowPerf <= activeSpeakerUntil && activeSpeaker ? activeSpeaker : null;

      // Brand icon badge (AudioLines mark)
      const logoX = 96;
      const logoY = 50;
      const logoSize = 54;
      roundRect(ctx, logoX, logoY, logoSize, logoSize, 14);
      ctx.fillStyle = voiceActive ? 'rgba(16, 185, 129, 0.22)' : 'rgba(37, 99, 235, 0.20)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = voiceActive ? 'rgba(52, 211, 153, 0.65)' : 'rgba(96, 165, 250, 0.50)';
      ctx.stroke();

      const baseBarHeights = [12, 24, 32, 20, 14];
      ctx.strokeStyle = voiceActive ? '#34d399' : '#60a5fa';
      ctx.lineWidth = 3.6;
      ctx.lineCap = 'round';
      for (let i = 0; i < baseBarHeights.length; i++) {
        const bx = logoX + 13 + i * 7;
        const dynScale = voiceActive
          ? 0.55 + 0.65 * shownLevel * (0.65 + 0.35 * Math.sin(frameCount * 1.3 + i * 1.1))
          : 0.72;
        const bh = Math.max(8, Math.min(36, baseBarHeights[i] * dynScale));
        const by = logoY + logoSize / 2;
        ctx.beginPath();
        ctx.moveTo(bx, by - bh / 2);
        ctx.lineTo(bx, by + bh / 2);
        ctx.stroke();
      }

      // Brand title & "Eingeladen von ..." subtitle
      const titleX = logoX + logoSize + 18;
      ctx.fillStyle = '#f8fafc';
      ctx.font = `700 30px ${FONT_SANS}`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('wortlaut', titleX, 74);

      const langLabel =
        !asrLanguage || asrLanguage === 'auto' || asrLanguage === '*'
          ? (isEn ? 'Auto (30 langs)' : 'Auto (30 Sprachen)')
          : asrLanguage.replace(/,/g, ' + ');
      let subtitle = '';
      if (cfg.invitedBy) {
        subtitle = isEn
          ? `Invited by ${cfg.invitedBy} · ASR: ${langLabel}`
          : `Eingeladen von ${cfg.invitedBy} · ASR: ${langLabel}`;
      } else if (cfg.meetingTitle) {
        subtitle = `${cfg.meetingTitle} · ASR: ${langLabel}`;
      } else {
        subtitle = isEn
          ? `Automated Meeting Transcript · ASR: ${langLabel}`
          : `Automatisches Konferenz-Protokoll · ASR: ${langLabel}`;
      }
      ctx.font = `500 18px ${FONT_SANS}`;
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(truncateText(ctx, subtitle, 590), titleX, 100);

      // Status pill (top right)
      const isAmberPill = isPendingEntry || isPausedActive;
      const statusText = inLobby
        ? (isEn ? 'Waiting in lobby' : 'Wartet im Warteraum')
        : isJoining
          ? (isEn ? 'Joining meeting…' : 'Tritt Konferenz bei…')
          : isPausedActive
            ? (isEn ? 'Paused · Off the Record' : 'Pausiert · Off the Record')
            : voiceActive
              ? (isEn ? 'Recording Audio' : 'Ton wird aufgezeichnet')
              : (isEn ? 'Live Transcript Active' : 'Wortprotokoll aktiv');
      ctx.font = `600 19px ${FONT_SANS}`;
      const statusTextW = ctx.measureText(statusText).width;
      const pillW = statusTextW + 48;
      const pillH = 42;
      const pillX = cardX + cardW - 28 - pillW;
      const pillY = 56;

      roundRect(ctx, pillX, pillY, pillW, pillH, 21);
      ctx.fillStyle = isAmberPill ? 'rgba(245, 158, 11, 0.18)' : 'rgba(16, 185, 129, 0.16)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = isAmberPill ? 'rgba(251, 191, 36, 0.55)' : 'rgba(52, 211, 153, 0.48)';
      ctx.stroke();

      const dotX = pillX + 21;
      const dotY = pillY + pillH / 2;
      ctx.beginPath();
      ctx.arc(dotX, dotY, 7.5, 0, Math.PI * 2);
      ctx.fillStyle = isAmberPill
        ? `rgba(251, 191, 36, ${(0.28 * pulse).toFixed(2)})`
        : `rgba(52, 211, 153, ${(0.28 * pulse).toFixed(2)})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(dotX, dotY, 4.8, 0, Math.PI * 2);
      ctx.fillStyle = isAmberPill ? '#fbbf24' : '#34d399';
      ctx.fill();

      ctx.fillStyle = isAmberPill ? '#fef3c7' : '#d1fae5';
      ctx.fillText(statusText, pillX + 35, pillY + 27);

      // Single compact on-screen chat instruction strip ("no"/"opt out" & #pause/#resume)
      const stripY = 124;
      const stripH = 44;
      ctx.fillStyle = isPausedActive ? 'rgba(245, 158, 11, 0.13)' : '#1c2333';
      ctx.fillRect(cardX, stripY, cardW, stripH);
      ctx.strokeStyle = isPausedActive ? 'rgba(251, 191, 36, 0.42)' : 'rgba(255, 255, 255, 0.09)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cardX, stripY);
      ctx.lineTo(cardX + cardW, stripY);
      ctx.moveTo(cardX, stripY + stripH);
      ctx.lineTo(cardX + cardW, stripY + stripH);
      ctx.stroke();

      const CHIP_STYLES = {
        amber: {fill: 'rgba(245, 158, 11, 0.20)', stroke: 'rgba(251, 191, 36, 0.45)', fg: '#fde68a'},
        emerald: {fill: 'rgba(16, 185, 129, 0.18)', stroke: 'rgba(52, 211, 153, 0.42)', fg: '#a7f3d0'},
        blue: {fill: 'rgba(59, 130, 246, 0.18)', stroke: 'rgba(96, 165, 250, 0.42)', fg: '#bfdbfe'},
      } as const;

      const drawInstructionRow = (rowY: number, dotColor: string, items: string[]) => {
        ctx.beginPath();
        ctx.arc(104, rowY - 5.5, 4, 0, Math.PI * 2);
        ctx.fillStyle = dotColor;
        ctx.fill();

        let curX = 118;
        const maxRight = cardX + cardW - 24;
        for (const raw of items) {
          if (curX >= maxRight) break;
          const chipMatch = /^\[(amber|emerald|blue):(.+)\]$/.exec(raw);
          if (chipMatch) {
            const palette = CHIP_STYLES[chipMatch[1] as keyof typeof CHIP_STYLES];
            const label = chipMatch[2];
            ctx.font = `600 15px ${FONT_MONO}`;
            const chipW = ctx.measureText(label).width + 14;
            if (curX + chipW > maxRight) break;
            roundRect(ctx, curX, rowY - 17, chipW, 22, 6);
            ctx.fillStyle = palette.fill;
            ctx.fill();
            ctx.strokeStyle = palette.stroke;
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.fillStyle = palette.fg;
            ctx.fillText(label, curX + 7, rowY - 1);
            curX += chipW + 6;
          } else {
            const bold = raw.startsWith('*') && raw.endsWith('*') && raw.length > 2;
            const text = bold ? raw.slice(1, -1) : raw;
            ctx.font = `${bold ? 600 : 500} 16px ${FONT_SANS}`;
            ctx.fillStyle = bold ? '#f8fafc' : '#cbd5e1';
            const clipped = truncateText(ctx, text, maxRight - curX);
            ctx.fillText(clipped, curX, rowY);
            curX += ctx.measureText(clipped).width + 6;
          }
        }
      };

      if (isPausedActive) {
        drawInstructionRow(
          stripY + 28,
          '#fbbf24',
          isEn
            ? ['*OFF THE RECORD — Paused.*', 'Type', '[amber:#resume]', 'to continue  ·', '[blue:no]', '/', '[blue:opt out]', 'exclude yourself']
            : ['*OFF THE RECORD — Pausiert.*', 'Im Chat', '[amber:#resume]', 'zum Fortsetzen  ·', '[blue:no]', '/', '[blue:opt out]', 'Widerspruch'],
        );
      } else {
        drawInstructionRow(
          stripY + 28,
          '#60a5fa',
          isEn
            ? ['*Chat:*', '[blue:no]', '/', '[blue:opt out]', 'exclude your own voice  ·', '[amber:#pause]', '/', '[amber:#resume]', 'off-the-record']
            : ['*Chat:*', '[blue:no]', '/', '[blue:opt out]', 'eigene Stimme ausnehmen  ·', '[amber:#pause]', '/', '[amber:#resume]', 'Off-the-Record-Pause'],
        );
      }

      // Transcript viewport (leaves dedicated footer bar at y=612..668 for live audio activity)
      const bodyTop = 180;
      const bodyBottom = 602;
      const bodyLeft = 96;
      const bodyWidth = cardW - 56;

      const entries = segments.slice(-8);

      if (isPausedActive) {
        const boxX = cardX + 64;
        const boxY = 232;
        const boxW = cardW - 128;
        const boxH = 348;
        roundRect(ctx, boxX, boxY, boxW, boxH, 20);
        ctx.fillStyle = 'rgba(245, 158, 11, 0.08)';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.38)';
        ctx.stroke();

        const centerX = WIDTH / 2;
        const badgeSize = 64;
        const badgeX = centerX - badgeSize / 2;
        const badgeY = boxY + 34;
        roundRect(ctx, badgeX, badgeY, badgeSize, badgeSize, 18);
        ctx.fillStyle = 'rgba(245, 158, 11, 0.20)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.55)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Pause icon bars (||)
        ctx.fillStyle = '#fbbf24';
        roundRect(ctx, centerX - 12, badgeY + 18, 8, 28, 3);
        ctx.fill();
        roundRect(ctx, centerX + 4, badgeY + 18, 8, 28, 3);
        ctx.fill();

        ctx.textAlign = 'center';
        ctx.font = `700 27px ${FONT_SANS}`;
        ctx.fillStyle = '#fef3c7';
        const pausedHeadline = isEn
          ? 'OFF THE RECORD — Recording Paused'
          : 'OFF THE RECORD — Aufnahme pausiert';
        ctx.fillText(pausedHeadline, centerX, badgeY + badgeSize + 44);

        ctx.font = `400 19px ${FONT_SANS}`;
        ctx.fillStyle = '#cbd5e1';
        const pausedBody = isEn
          ? 'Spoken audio and shared screens are discarded in memory and never stored.'
          : 'Gesprochenes Audio und geteilte Bildschirme werden sofort verworfen und nicht gespeichert.';
        ctx.fillText(pausedBody, centerX, badgeY + badgeSize + 80);

        const resumeHint = isEn
          ? 'Type "#resume" in meeting chat to resume transcription'
          : 'Im Konferenz-Chat „#resume“ oder „#weiter“ schreiben, um fortzufahren';
        ctx.font = `600 18px ${FONT_SANS}`;
        const hintW = ctx.measureText(resumeHint).width + 44;
        const hintH = 42;
        const hintX = centerX - hintW / 2;
        const hintY = boxY + boxH - 68;
        roundRect(ctx, hintX, hintY, hintW, hintH, 21);
        ctx.fillStyle = 'rgba(245, 158, 11, 0.18)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.48)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.fillStyle = '#fde68a';
        ctx.fillText(resumeHint, centerX, hintY + 27);

        ctx.textAlign = 'left';
        lastRenderedText = pausedHeadline;
      } else if (entries.length === 0) {
        const centerX = WIDTH / 2;
        const centerY = (bodyTop + bodyBottom) / 2 - 6;
        // Audio-reactive listening waveform: flat calm baseline when silent, dynamic bars when speaking
        const eqBars = [12, 22, 34, 24, 36, 20, 12];
        ctx.strokeStyle = isPendingEntry
          ? 'rgba(251, 191, 36, 0.55)'
          : voiceActive
            ? '#34d399'
            : 'rgba(148, 163, 184, 0.45)';
        ctx.lineWidth = 4.2;
        ctx.lineCap = 'round';
        for (let i = 0; i < eqBars.length; i++) {
          const h = voiceActive
            ? Math.max(8, eqBars[i] * shownLevel * (0.65 + 0.35 * Math.sin(frameCount * 1.4 + i * 1.1)))
            : isPendingEntry
              ? Math.max(6, eqBars[i] * 0.35 * (0.7 + 0.3 * Math.sin(frameCount * 0.6 + i * 0.9)))
              : 6;
          const bx = centerX - ((eqBars.length - 1) * 12) / 2 + i * 12;
          ctx.beginPath();
          ctx.moveTo(bx, centerY - 38 - h / 2);
          ctx.lineTo(bx, centerY - 38 + h / 2);
          ctx.stroke();
        }

        ctx.textAlign = 'center';
        ctx.font = `600 23px ${FONT_SANS}`;
        ctx.fillStyle = voiceActive ? '#d1fae5' : '#e2e8f0';
        const emptyPrimary = inLobby
          ? (isEn ? 'Waiting for host admission…' : 'Wartet auf Einlass durch den Organisator…')
          : isJoining
            ? (isEn ? 'Connecting to meeting…' : 'Verbindet mit der Konferenz…')
            : voiceActive
              ? (isEn
                  ? (currentSpeaker ? `Recording speech · ${currentSpeaker}` : 'Recording speech — transcribing segment…')
                  : (currentSpeaker ? `Ton wird aufgezeichnet · ${currentSpeaker}` : 'Ton wird aufgezeichnet – Segment wird transkribiert…'))
              : (isEn
                  ? 'Listening — spoken statements appear here live'
                  : 'Bereit – gesprochene Beiträge erscheinen hier live');
        ctx.fillText(emptyPrimary, centerX, centerY + 14);

        ctx.font = `400 18px ${FONT_SANS}`;
        ctx.fillStyle = '#94a3b8';
        const emptySecondary = isPendingEntry
          ? (isEn
              ? 'Audio capture starts only after admission to the meeting.'
              : 'Die Audioerfassung startet erst nach Zulassung zum Meeting.')
          : (isEn
              ? 'Per-speaker transcription active · Outbound microphone disabled'
              : 'Getrennte Sprechererkennung aktiv · Eigenes Mikrofon deaktiviert');
        ctx.fillText(emptySecondary, centerX, centerY + 46);
        ctx.textAlign = 'left';
        lastRenderedText = emptyPrimary;
      } else {
        ctx.save();
        ctx.beginPath();
        ctx.rect(cardX + 4, bodyTop, cardW - 8, bodyBottom - bodyTop);
        ctx.clip();

        let cursorY = bodyBottom - 6;
        let overflowedTop = false;
        const lineHeight = 30;
        const headerHeight = 26;
        const turnGap = 15;
        const textMaxW = bodyWidth - 32;

        for (let idx = entries.length - 1; idx >= 0; idx--) {
          const seg = entries[idx];
          ctx.font = `400 22px ${FONT_SANS}`;
          const lines = wrapLines(ctx, seg.text, textMaxW, 4);
          if (lines.length === 0) continue;

          const blockH = headerHeight + lines.length * lineHeight;
          const blockTop = cursorY - blockH;

          if (blockTop < bodyTop - lineHeight * 2) {
            overflowedTop = true;
            break;
          }
          if (blockTop < bodyTop) {
            overflowedTop = true;
          }

          const accent = speakerColor(seg.speaker || 'Teilnehmer');
          roundRect(ctx, bodyLeft, blockTop + 4, 4, blockH - 6, 2);
          ctx.fillStyle = accent;
          ctx.fill();

          const ts = formatTimestamp(seg.start);
          ctx.font = `500 16px ${FONT_MONO}`;
          ctx.fillStyle = '#64748b';
          ctx.fillText(ts, bodyLeft + 16, blockTop + 19);
          const tsW = ctx.measureText(ts).width;

          ctx.font = `700 19.5px ${FONT_SANS}`;
          ctx.fillStyle = accent;
          const spkLabel = truncateText(ctx, seg.speaker || 'Teilnehmer', 480);
          ctx.fillText(spkLabel, bodyLeft + 16 + tsW + 12, blockTop + 19);

          ctx.font = `400 22px ${FONT_SANS}`;
          ctx.fillStyle = '#f1f5f9';
          for (let l = 0; l < lines.length; l++) {
            ctx.fillText(lines[l], bodyLeft + 16, blockTop + headerHeight + 22 + l * lineHeight);
          }

          cursorY = blockTop - turnGap;
        }

        if (overflowedTop) {
          const fade = ctx.createLinearGradient(0, bodyTop, 0, bodyTop + 34);
          fade.addColorStop(0, '#161b26');
          fade.addColorStop(1, 'rgba(22, 27, 38, 0)');
          ctx.fillStyle = fade;
          ctx.fillRect(cardX + 4, bodyTop, cardW - 8, 34);
        }
        ctx.restore();
        const latest = entries[entries.length - 1];
        lastRenderedText = `${latest.speaker}: ${latest.text}`;
      }

      // Dedicated persistent Live Audio Activity footer bar (always visible at bottom of card)
      const footerY = 612;
      const footerH = 56;
      ctx.fillStyle = isPausedActive
        ? 'rgba(245, 158, 11, 0.12)'
        : voiceActive
          ? 'rgba(16, 185, 129, 0.13)'
          : 'rgba(15, 23, 42, 0.65)';
      ctx.fillRect(cardX, footerY, cardW, footerH);
      ctx.strokeStyle = isPausedActive
        ? 'rgba(251, 191, 36, 0.35)'
        : voiceActive
          ? 'rgba(52, 211, 153, 0.42)'
          : 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cardX, footerY);
      ctx.lineTo(cardX + cardW, footerY);
      ctx.stroke();

      // 14-bar real-time VU / waveform meter
      const meterStartX = 196;
      const meterMidY = footerY + footerH / 2;
      const meterProfile = [0.45, 0.7, 0.95, 0.65, 1.0, 0.8, 0.55, 0.9, 1.0, 0.72, 0.88, 0.6, 0.78, 0.5];
      ctx.lineWidth = 3.5;
      ctx.lineCap = 'round';
      for (let i = 0; i < meterProfile.length; i++) {
        const bx = meterStartX + i * 8;
        let bh = 4;
        if (voiceActive) {
          const wave = 0.62 + 0.38 * Math.sin(frameCount * 1.55 + i * 0.85);
          bh = Math.max(5, Math.min(30, 30 * meterProfile[i] * shownLevel * wave));
          ctx.strokeStyle = i % 3 === 0 ? '#38bdf8' : '#34d399';
        } else if (isPausedActive) {
          ctx.strokeStyle = 'rgba(251, 191, 36, 0.40)';
        } else {
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.38)';
        }
        ctx.beginPath();
        ctx.moveTo(bx, meterMidY - bh / 2);
        ctx.lineTo(bx, meterMidY + bh / 2);
        ctx.stroke();
      }

      const meterTextX = meterStartX + meterProfile.length * 8 + 14;
      ctx.font = `600 17px ${FONT_SANS}`;
      if (isPausedActive) {
        ctx.fillStyle = '#fde68a';
        ctx.fillText(
          isEn
            ? 'Paused — incoming audio is muted & discarded'
            : 'Pausiert — eingehender Ton wird verworfen',
          meterTextX,
          meterMidY + 6,
        );
      } else if (isPendingEntry) {
        ctx.fillStyle = '#fcd34d';
        ctx.fillText(
          isEn
            ? 'Audio capture inactive until admitted to the call'
            : 'Noch keine Tonaufzeichnung bis zum Einlass',
          meterTextX,
          meterMidY + 6,
        );
      } else if (voiceActive) {
        ctx.fillStyle = '#a7f3d0';
        const activeLabel = currentSpeaker
          ? (isEn ? `Recording audio · ${currentSpeaker}` : `Ton wird aufgezeichnet · ${currentSpeaker}`)
          : (isEn ? 'Recording audio — voice activity detected' : 'Ton wird aufgezeichnet — Sprachaktivität erkannt');
        ctx.fillText(truncateText(ctx, activeLabel, cardX + cardW - meterTextX - 36), meterTextX, meterMidY + 6);
      } else {
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(
          isEn
            ? 'Audio ready — waiting for speech'
            : 'Tonempfang bereit — warte auf Sprache',
          meterTextX,
          meterMidY + 6,
        );
      }

      ctx.restore();
    };

    let lastSignature = '';
    let masterStream: MediaStream | null = null;
    let baseTrack: CanvasCaptureMediaStreamTrack | null = null;
    const burstTimers = new Set<number>();

    const emitFrame = () => {
      renderFrame();
      baseTrack?.requestFrame?.();
    };

    const clearBurstTimers = () => {
      for (const timer of burstTimers) {
        window.clearTimeout(timer);
      }
      burstTimers.clear();
    };

    const flushFrameBurst = () => {
      clearBurstTimers();
      emitFrame();
      for (const delay of [80, 180, 340]) {
        const timer = window.setTimeout(() => {
          burstTimers.delete(timer);
          emitFrame();
        }, delay);
        burstTimers.add(timer);
      }
    };

    renderFrame();
    let lastIdleEmitAt = performance.now();
    let wasVoiceActiveOnTile = false;
    const intervalId = window.setInterval(() => {
      const nowPerf = performance.now();
      const rtp = sampleRtpAudioLevel();
      if (rtp.level > liveAudioLevel) {
        liveAudioLevel = rtp.level;
      } else {
        liveAudioLevel = liveAudioLevel * 0.58;
        if (liveAudioLevel < 0.008) liveAudioLevel = 0;
      }
      if (liveAudioLevel >= 0.02) {
        lastVoiceAt = nowPerf;
      }
      const voiceNow =
        !paused &&
        participation !== 'joining' &&
        participation !== 'preparing' &&
        participation !== 'waiting_admission' &&
        (liveAudioLevel >= 0.02 || nowPerf - lastVoiceAt <= 650);
      if (voiceNow || wasVoiceActiveOnTile || nowPerf - lastIdleEmitAt >= 1000) {
        wasVoiceActiveOnTile = voiceNow;
        lastIdleEmitAt = nowPerf;
        emitFrame();
      }
    }, 250);

    const decorateVirtualVideoTrack = (track: MediaStreamTrack): MediaStreamTrack => {
      const tagged = track as MediaStreamTrack & {__wortlautVirtualVideo?: boolean};
      tagged.__wortlautVirtualVideo = true;
      track.contentHint = 'detail';
      Object.defineProperty(track, 'label', {
        configurable: true,
        get: () => 'wortlaut Live-Protokoll (16:9)',
      });
      const origGetSettings = track.getSettings.bind(track);
      track.getSettings = () => ({
        ...origGetSettings(),
        deviceId: 'wortlaut-virtual-camera',
        groupId: 'wortlaut-virtual-group',
        width: WIDTH,
        height: HEIGHT,
        aspectRatio: WIDTH / HEIGHT,
        frameRate: 8,
        resizeMode: 'none',
      } as MediaTrackSettings);
      track.getCapabilities = () =>
        ({
          aspectRatio: {min: WIDTH / HEIGHT, max: WIDTH / HEIGHT},
          deviceId: 'wortlaut-virtual-camera',
          frameRate: {min: 1, max: 30},
          groupId: 'wortlaut-virtual-group',
          height: {min: HEIGHT, max: HEIGHT},
          width: {min: WIDTH, max: WIDTH},
          resizeMode: ['none'],
        }) as unknown as MediaTrackCapabilities;
      track.applyConstraints = async (constraints?: MediaTrackConstraints) => {
        if (constraints && typeof constraints === 'object') {
          const ar = constraints.aspectRatio;
          const exactAr =
            typeof ar === 'number'
              ? null
              : ar && typeof ar === 'object' && typeof ar.exact === 'number'
                ? ar.exact
                : null;
          const wObj = constraints.width;
          const hObj = constraints.height;
          const exactW =
            wObj && typeof wObj === 'object' && typeof wObj.exact === 'number' ? wObj.exact : null;
          const exactH =
            hObj && typeof hObj === 'object' && typeof hObj.exact === 'number' ? hObj.exact : null;
          if ((exactAr !== null && exactAr < 1) || (exactW !== null && exactH !== null && exactW < exactH)) {
            throw new DOMException('16:9 widescreen required', 'OverconstrainedError');
          }
        }
      };
      const origClone = track.clone.bind(track);
      track.clone = () => decorateVirtualVideoTrack(origClone());
      const origStop = track.stop.bind(track);
      track.stop = () => {
        liveTracks.delete(track);
        origStop();
      };
      liveTracks.add(track);
      return track;
    };

    const virtualCamDevice = {
      deviceId: 'wortlaut-virtual-camera',
      kind: 'videoinput' as MediaDeviceKind,
      label: 'wortlaut Live-Protokoll',
      groupId: 'wortlaut-virtual-group',
      toJSON() {
        return {
          deviceId: this.deviceId,
          kind: this.kind,
          label: this.label,
          groupId: this.groupId,
        };
      },
    } as MediaDeviceInfo;

    navigator.mediaDevices.enumerateDevices = async () => [virtualCamDevice];

    navigator.mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      if (!constraints || constraints.audio || !constraints.video) {
        throw new DOMException('Requested device not found', 'NotFoundError');
      }
      if (!baseTrack || baseTrack.readyState !== 'live') {
        masterStream = canvas.captureStream(8);
        baseTrack = masterStream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
      }
      const cloned = decorateVirtualVideoTrack(baseTrack.clone());
      const stream = new MediaStream([cloned]);
      flushFrameBurst();
      return stream;
    };

    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = async (descriptor: PermissionDescriptor) => {
      if ((descriptor as {name?: string})?.name === 'camera') {
        return {
          state: 'granted',
          name: 'camera',
          onchange: null,
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent: () => true,
        } as unknown as PermissionStatus;
      }
      return origQuery(descriptor);
    };

    window.wortlautVideoTile = {
      canvas,
      update(patch: VideoTilePatch) {
        if (typeof patch.participation === 'string' && patch.participation) {
          participation = patch.participation;
        }
        if (typeof patch.paused === 'boolean') {
          paused = patch.paused;
        }
        if (typeof patch.asrLanguage === 'string' && patch.asrLanguage.trim()) {
          asrLanguage = patch.asrLanguage.trim().slice(0, 120);
        }
        if (Array.isArray(patch.segments)) {
          segments = patch.segments.slice(-8).map((s) => ({
            speaker: String(s?.speaker ?? '').slice(0, 80),
            text: String(s?.text ?? '').slice(0, 420),
            start: typeof s?.start === 'number' && Number.isFinite(s.start) ? s.start : 0,
          }));
        }
        const sig = `${participation}::${paused ? '1' : '0'}::${asrLanguage}::${JSON.stringify(segments)}`;
        if (sig !== lastSignature) {
          lastSignature = sig;
          flushFrameBurst();
        }
      },
      reportAudioActivity(level: number, speakerName?: string | null) {
        if (typeof level !== 'number' || !Number.isFinite(level) || paused) return;
        const clamped = Math.max(0, Math.min(1, level));
        const nowPerf = performance.now();
        if (clamped > liveAudioLevel) {
          liveAudioLevel = clamped;
        }
        if (clamped >= 0.02) {
          lastVoiceAt = nowPerf;
          if (speakerName && speakerName.trim()) {
            activeSpeaker = speakerName.trim().slice(0, 80);
            activeSpeakerUntil = nowPerf + 1400;
          }
          if (!wasVoiceActiveOnTile) {
            wasVoiceActiveOnTile = true;
            lastIdleEmitAt = nowPerf;
            emitFrame();
          }
        }
      },
      stop() {
        window.clearInterval(intervalId);
        clearBurstTimers();
        for (const t of [...liveTracks]) {
          t.stop();
        }
        liveTracks.clear();
        if (baseTrack) {
          baseTrack.stop();
          baseTrack = null;
        }
        masterStream = null;
      },
      getSnapshot() {
        const nowPerf = performance.now();
        const audioActive =
          !paused &&
          participation !== 'joining' &&
          participation !== 'preparing' &&
          participation !== 'waiting_admission' &&
          (liveAudioLevel >= 0.02 || nowPerf - lastVoiceAt <= 650);
        return {
          frameCount,
          participation,
          paused,
          asrLanguage,
          audioActive,
          audioLevel: Math.round(liveAudioLevel * 1000) / 1000,
          activeSpeaker: audioActive && nowPerf <= activeSpeakerUntil ? activeSpeaker : null,
          segmentCount: segments.length,
          lastRenderedText,
          activeTracks: [...liveTracks].filter((t) => t.readyState === 'live').length,
        };
      },
    };
  }, initCfg);

  return async (patch: VideoTilePatch) => {
    const targetFrame = resolveFrame ? resolveFrame() : page.mainFrame();
    if (!targetFrame) return;
    await targetFrame
      .evaluate((rawPatch: VideoTilePatch) => {
        window.wortlautVideoTile?.update(rawPatch);
      }, patch)
      .catch(() => {});
  };
}
