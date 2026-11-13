import type {Frame, Page} from 'playwright';
import {teamsOrigins} from '../src/teams-url.js';

export type VideoTileSegment = {
  speaker: string;
  text: string;
  start: number;
};

export type VideoTilePatch = {
  participation?: string;
  segments?: VideoTileSegment[];
};

export type VideoTileMetadata = {
  locale: string;
  invitedBy: string | null;
  meetingTitle: string | null;
};

type InitTileConfig = {
  provider: 'google_meet' | 'webex' | 'teams' | 'zoom';
  meetingUrl: string;
  teamsOrigins: string[];
  locale: string;
  invitedBy: string | null;
  meetingTitle: string | null;
};

declare global {
  interface Window {
    wortlautVideoTile?: {
      update: (patch: VideoTilePatch) => void;
      stop: () => void;
      getSnapshot: () => {
        frameCount: number;
        participation: string;
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
          /^\/(?:meeting|guest-join-meeting)$/.test(location.pathname)
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
    let segments: VideoTileSegment[] = [];
    let frameCount = 0;
    let lastRenderedText = '';
    const liveTracks = new Set<MediaStreamTrack>();

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
      ctx.fillRect(cardX, cardY, cardW, 100);

      // Brand icon badge (AudioLines mark)
      const logoX = 96;
      const logoY = 54;
      const logoSize = 54;
      roundRect(ctx, logoX, logoY, logoSize, logoSize, 14);
      ctx.fillStyle = 'rgba(37, 99, 235, 0.20)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(96, 165, 250, 0.50)';
      ctx.stroke();

      const barHeights = [12, 24, 32, 20, 14];
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 3.6;
      ctx.lineCap = 'round';
      for (let i = 0; i < barHeights.length; i++) {
        const bx = logoX + 13 + i * 7;
        const bh = barHeights[i];
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
      ctx.fillText('wortlaut', titleX, 78);

      let subtitle = '';
      if (cfg.invitedBy) {
        subtitle = isEn ? `Invited by ${cfg.invitedBy}` : `Eingeladen von ${cfg.invitedBy}`;
      } else if (cfg.meetingTitle) {
        subtitle = cfg.meetingTitle;
      } else {
        subtitle = isEn ? 'Automated Meeting Transcript' : 'Automatisches Konferenz-Protokoll';
      }
      ctx.font = `500 18px ${FONT_SANS}`;
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(truncateText(ctx, subtitle, 610), titleX, 104);

      // Status pill (top right)
      const inLobby = participation === 'waiting_admission';
      const statusText = inLobby
        ? (isEn ? 'Waiting in lobby' : 'Wartet im Warteraum')
        : (isEn ? 'Live Transcript Active' : 'Wortprotokoll aktiv');
      ctx.font = `600 19px ${FONT_SANS}`;
      const statusTextW = ctx.measureText(statusText).width;
      const pillW = statusTextW + 48;
      const pillH = 42;
      const pillX = cardX + cardW - 28 - pillW;
      const pillY = 60;

      roundRect(ctx, pillX, pillY, pillW, pillH, 21);
      ctx.fillStyle = inLobby ? 'rgba(245, 158, 11, 0.16)' : 'rgba(16, 185, 129, 0.16)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = inLobby ? 'rgba(251, 191, 36, 0.48)' : 'rgba(52, 211, 153, 0.48)';
      ctx.stroke();

      const dotX = pillX + 21;
      const dotY = pillY + pillH / 2;
      ctx.beginPath();
      ctx.arc(dotX, dotY, 7.5, 0, Math.PI * 2);
      ctx.fillStyle = inLobby
        ? `rgba(251, 191, 36, ${(0.28 * pulse).toFixed(2)})`
        : `rgba(52, 211, 153, ${(0.28 * pulse).toFixed(2)})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(dotX, dotY, 4.8, 0, Math.PI * 2);
      ctx.fillStyle = inLobby ? '#fbbf24' : '#34d399';
      ctx.fill();

      ctx.fillStyle = inLobby ? '#fde68a' : '#d1fae5';
      ctx.fillText(statusText, pillX + 35, pillY + 27);

      // Opt-out info strip
      const stripY = 132;
      const stripH = 46;
      ctx.fillStyle = '#1e2536';
      ctx.fillRect(cardX, stripY, cardW, stripH);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.09)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cardX, stripY);
      ctx.lineTo(cardX + cardW, stripY);
      ctx.moveTo(cardX, stripY + stripH);
      ctx.lineTo(cardX + cardW, stripY + stripH);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(104, stripY + stripH / 2, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#60a5fa';
      ctx.fill();

      const optOutText = isEn
        ? 'Opt out anytime in meeting chat: type "opt out" — your statements will not be recorded'
        : 'Widerspruch jederzeit im Konferenz-Chat: „nein“ oder „opt out“ schreiben (keine Speicherung Ihrer Beiträge)';
      ctx.font = `500 17.5px ${FONT_SANS}`;
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(truncateText(ctx, optOutText, cardW - 64), 118, stripY + 29);

      // Transcript viewport
      const bodyTop = 192;
      const bodyBottom = 648;
      const bodyLeft = 96;
      const bodyWidth = cardW - 56;

      if (segments.length === 0) {
        const centerX = WIDTH / 2;
        const centerY = (bodyTop + bodyBottom) / 2 - 14;
        // Subtle animated listening waveform
        const eqBars = [10, 18, 26, 16, 28, 14, 10];
        ctx.strokeStyle = inLobby ? 'rgba(251, 191, 36, 0.55)' : 'rgba(96, 165, 250, 0.65)';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        for (let i = 0; i < eqBars.length; i++) {
          const anim = 0.65 + 0.35 * Math.sin(frameCount * 0.7 + i * 0.9);
          const h = Math.max(6, eqBars[i] * anim);
          const bx = centerX - ((eqBars.length - 1) * 11) / 2 + i * 11;
          ctx.beginPath();
          ctx.moveTo(bx, centerY - 38 - h / 2);
          ctx.lineTo(bx, centerY - 38 + h / 2);
          ctx.stroke();
        }

        ctx.textAlign = 'center';
        ctx.font = `600 23px ${FONT_SANS}`;
        ctx.fillStyle = '#e2e8f0';
        const emptyPrimary = inLobby
          ? (isEn ? 'Waiting for host admission…' : 'Wartet auf Einlass durch den Organisator…')
          : (isEn
              ? 'Listening — spoken statements appear here live'
              : 'Hört zu – aktuelle Beiträge erscheinen hier live');
        ctx.fillText(emptyPrimary, centerX, centerY + 14);

        ctx.font = `400 18px ${FONT_SANS}`;
        ctx.fillStyle = '#94a3b8';
        const emptySecondary = inLobby
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
        const turnGap = 16;
        const textMaxW = bodyWidth - 26;

        for (let idx = segments.length - 1; idx >= 0; idx--) {
          const seg = segments[idx];
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
        const latest = segments[segments.length - 1];
        lastRenderedText = `${latest.speaker}: ${latest.text}`;
      }

      ctx.restore();
    };

    let lastSignature = '';
    renderFrame();
    const intervalId = window.setInterval(renderFrame, 2000);

    const decorateVirtualVideoTrack = (track: MediaStreamTrack): MediaStreamTrack => {
      const tagged = track as MediaStreamTrack & {__wortlautVirtualVideo?: boolean};
      tagged.__wortlautVirtualVideo = true;
      track.contentHint = 'detail';
      Object.defineProperty(track, 'label', {
        configurable: true,
        get: () => 'wortlaut Live-Protokoll',
      });
      const origGetSettings = track.getSettings.bind(track);
      track.getSettings = () => ({
        ...origGetSettings(),
        deviceId: 'wortlaut-virtual-camera',
        groupId: 'wortlaut-virtual-group',
        width: WIDTH,
        height: HEIGHT,
        aspectRatio: WIDTH / HEIGHT,
        frameRate: 2,
        facingMode: 'user',
      });
      track.getCapabilities = () =>
        ({
          aspectRatio: {min: 1, max: 2},
          deviceId: 'wortlaut-virtual-camera',
          facingMode: ['user'],
          frameRate: {min: 1, max: 30},
          groupId: 'wortlaut-virtual-group',
          height: {min: 360, max: HEIGHT},
          width: {min: 640, max: WIDTH},
        }) as MediaTrackCapabilities;
      track.applyConstraints = async () => {};
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

    let baseTrack: CanvasCaptureMediaStreamTrack | null = null;

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
        const master = canvas.captureStream(2);
        baseTrack = master.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
      }
      const cloned = decorateVirtualVideoTrack(baseTrack.clone());
      const stream = new MediaStream([cloned]);
      renderFrame();
      baseTrack.requestFrame();
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
        if (Array.isArray(patch.segments)) {
          segments = patch.segments.slice(-8).map((s) => ({
            speaker: s.speaker.slice(0, 80),
            text: s.text.slice(0, 420),
            start: s.start,
          }));
        }
        const sig = `${participation}::${JSON.stringify(segments)}`;
        if (sig !== lastSignature) {
          lastSignature = sig;
          renderFrame();
          baseTrack?.requestFrame();
        }
      },
      stop() {
        window.clearInterval(intervalId);
        for (const t of [...liveTracks]) {
          t.stop();
        }
        liveTracks.clear();
        if (baseTrack) {
          baseTrack.stop();
          baseTrack = null;
        }
      },
      getSnapshot() {
        return {
          frameCount,
          participation,
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
      .evaluate((p: VideoTilePatch) => {
        window.wortlautVideoTile?.update(p);
      }, patch)
      .catch(() => {});
  };
}
