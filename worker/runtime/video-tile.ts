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
  optedOut?: string[];
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
      reportOptOutActivity?: (level: number) => void;
      stop: () => void;
      getSnapshot: () => {
        frameCount: number;
        participation: string;
        paused: boolean;
        optOutActive: boolean;
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
    const FONT_SANS = 'system-ui, -apple-system, "Liberation Sans", "DejaVu Sans", sans-serif';
    const FONT_MONO = '"Liberation Mono", "DejaVu Sans Mono", ui-monospace, monospace';

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
    let lastOptOutVoiceAt = -Infinity;
    let activeSpeaker: string | null = null;
    let activeSpeakerUntil = -Infinity;
    const optedOutNorm = new Set<string>();
    const liveTracks = new Set<MediaStreamTrack>();

    const isSpeakerOptedOut = (name?: string | null): boolean => {
      if (!optedOutNorm.size || !name) return false;
      const clean = name.trim().toLowerCase();
      return Boolean(clean && optedOutNorm.has(clean));
    };

    const sampleRtpAudioLevel = (): {
      level: number;
      speaker: string | null;
      optedOutSpeaking: boolean;
    } => {
      let maxLevel = 0;
      let optedOutSpeaking = false;
      const nowPerf = performance.now();
      const meetReceivers = (
        window as unknown as {
          wortlautMeetReceivers?: {
            connections?: Set<RTCPeerConnection>;
            isReceiverOptedOut?: (recv: RTCRtpReceiver) => boolean;
          };
        }
      ).wortlautMeetReceivers;
      const conns = meetReceivers?.connections;
      const isRecvOptedOut = meetReceivers?.isReceiverOptedOut;
      if (conns) {
        for (const pc of conns) {
          if (pc.connectionState === 'closed') continue;
          for (const recv of pc.getReceivers()) {
            if (recv.track?.kind !== 'audio' || recv.track.readyState !== 'live' || recv.track.muted) {
              continue;
            }
            const recvOptedOut = Boolean(isRecvOptedOut?.(recv));
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
                if (recvOptedOut) {
                  if (boosted >= 0.02) optedOutSpeaking = true;
                } else if (boosted > maxLevel) {
                  maxLevel = boosted;
                }
              }
            }
          }
        }
      }
      return {level: maxLevel, speaker: null, optedOutSpeaking};
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

    const speakerInitials = (name: string): string => {
      const cleaned = name.replace(/\(.*?\)/g, '').trim();
      const parts = cleaned.split(/[\s._-]+/).filter(Boolean);
      if (parts.length === 0) return 'T';
      if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
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

      // Astryx Stone dark ground (#111113 -> #151518)
      const bgGrad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
      bgGrad.addColorStop(0, '#111113');
      bgGrad.addColorStop(1, '#151518');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);

      // Safe-area horizontal bounds (clears 4:3 crop edges & bottom-left conference nameplate)
      const padX = 84;
      const contentW = WIDTH - padX * 2; // 1112px (x: 84..1196)
      const contentRight = padX + contentW;

      const nowPerf = performance.now();
      const isJoining = participation === 'joining' || participation === 'preparing';
      const inLobby = participation === 'waiting_admission';
      const isPendingEntry = isJoining || inLobby;
      const isPausedActive = paused && !isPendingEntry;
      const voiceActive =
        !isPausedActive &&
        !isPendingEntry &&
        (liveAudioLevel >= 0.02 || nowPerf - lastVoiceAt <= 650);
      const isOptOutSpeakingActive =
        !isPausedActive &&
        !isPendingEntry &&
        !voiceActive &&
        nowPerf - lastOptOutVoiceAt <= 1200;
      const shownLevel = voiceActive ? Math.max(0.22, liveAudioLevel) : 0;
      const currentSpeaker =
        voiceActive && nowPerf <= activeSpeakerUntil && activeSpeaker ? activeSpeaker : null;

      // 1. Top Header (y: 42..106) — Brand + Meeting Context on left, Distance-Legible Status Pill on right
      const logoX = padX;
      const logoY = 44;
      const logoSize = 48;
      const isAmberState = isPendingEntry || isPausedActive || isOptOutSpeakingActive;
      roundRect(ctx, logoX, logoY, logoSize, logoSize, 12);
      ctx.fillStyle = isAmberState ? 'rgba(245, 158, 11, 0.15)' : 'rgba(16, 185, 129, 0.15)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = isAmberState ? 'rgba(251, 191, 36, 0.42)' : 'rgba(52, 211, 153, 0.42)';
      ctx.stroke();

      const baseBarHeights = [12, 22, 28, 18];
      ctx.strokeStyle = isAmberState ? '#fbbf24' : '#34d399';
      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      for (let i = 0; i < baseBarHeights.length; i++) {
        const bx = logoX + 13.5 + i * 7;
        const dynScale = voiceActive
          ? 0.58 + 0.62 * shownLevel * (0.65 + 0.35 * Math.sin(frameCount * 1.3 + i * 1.1))
          : 0.72;
        const bh = Math.max(7, Math.min(30, baseBarHeights[i] * dynScale));
        const by = logoY + logoSize / 2;
        ctx.beginPath();
        ctx.moveTo(bx, by - bh / 2);
        ctx.lineTo(bx, by + bh / 2);
        ctx.stroke();
      }

      const statusText = inLobby
        ? (isEn ? 'Waiting in lobby' : 'Wartet im Warteraum')
        : isJoining
          ? (isEn ? 'Joining meeting…' : 'Tritt Konferenz bei…')
          : isPausedActive
            ? 'Off the Record'
            : isOptOutSpeakingActive
              ? 'Opt-out'
              : (isEn ? 'Recording active' : 'Aufzeichnung aktiv');
      ctx.font = `700 21px ${FONT_SANS}`;
      const statusTextW = ctx.measureText(statusText).width;
      const pillW = statusTextW + 52;
      const pillH = 44;
      const pillX = contentRight - pillW;
      const pillY = 46;

      roundRect(ctx, pillX, pillY, pillW, pillH, 22);
      ctx.fillStyle = isAmberState ? 'rgba(245, 158, 11, 0.16)' : 'rgba(16, 185, 129, 0.14)';
      ctx.fill();
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = isAmberState ? 'rgba(251, 191, 36, 0.46)' : 'rgba(52, 211, 153, 0.42)';
      ctx.stroke();

      const dotX = pillX + 22;
      const dotY = pillY + pillH / 2;
      if (voiceActive || isAmberState) {
        ctx.beginPath();
        ctx.arc(dotX, dotY, 8.5, 0, Math.PI * 2);
        ctx.fillStyle = isAmberState
          ? `rgba(251, 191, 36, ${(0.28 * pulse).toFixed(2)})`
          : `rgba(52, 211, 153, ${(0.30 * pulse).toFixed(2)})`;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(dotX, dotY, 5, 0, Math.PI * 2);
      ctx.fillStyle = isAmberState ? '#fbbf24' : '#34d399';
      ctx.fill();

      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = isAmberState ? '#fef3c7' : '#d1fae5';
      ctx.fillText(statusText, pillX + 36, pillY + 29);

      const titleX = logoX + logoSize + 16;
      const headerTextMaxW = Math.max(240, pillX - titleX - 24);
      ctx.fillStyle = '#fafaf9';
      ctx.font = `700 27px ${FONT_SANS}`;
      ctx.fillText('Wortlaut.cloud', titleX, 68);

      const metaParts: string[] = [];
      if (cfg.meetingTitle) {
        metaParts.push(cfg.meetingTitle);
      }
      if (cfg.invitedBy) {
        metaParts.push(isEn ? `Invited by ${cfg.invitedBy}` : `Eingeladen von ${cfg.invitedBy}`);
      }
      if (asrLanguage && asrLanguage !== 'auto' && asrLanguage !== '*') {
        metaParts.push(asrLanguage.replace(/,/g, ' + '));
      }
      if (metaParts.length === 0) {
        metaParts.push(
          isEn ? 'Speaker-isolated meeting transcript' : 'Sprechergetrenntes Wortprotokoll',
        );
      }
      ctx.font = `400 17px ${FONT_SANS}`;
      ctx.fillStyle = '#a8a29e';
      ctx.fillText(truncateText(ctx, metaParts.join('  ·  '), headerTextMaxW), titleX, 92);

      // 2. Prominent 3×3-Legible Chat Command Band (y: 120..188)
      const stripY = 120;
      const stripH = 68;
      if (isPausedActive) {
        ctx.fillStyle = 'rgba(245, 158, 11, 0.08)';
        ctx.fillRect(padX, stripY, contentW, stripH);
      }
      ctx.strokeStyle = isPausedActive ? 'rgba(251, 191, 36, 0.34)' : 'rgba(255, 255, 255, 0.09)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padX, stripY);
      ctx.lineTo(contentRight, stripY);
      ctx.moveTo(padX, stripY + stripH);
      ctx.lineTo(contentRight, stripY + stripH);
      ctx.stroke();

      const drawKeycap = (x: number, centerY: number, label: string, highlightAmber = false): number => {
        ctx.font = `700 21.5px ${FONT_MONO}`;
        const kw = ctx.measureText(label).width + 24;
        const kh = 34;
        roundRect(ctx, x, centerY - kh / 2, kw, kh, 7);
        ctx.fillStyle = highlightAmber ? 'rgba(245, 158, 11, 0.20)' : 'rgba(255, 255, 255, 0.07)';
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = highlightAmber ? 'rgba(251, 191, 36, 0.48)' : 'rgba(255, 255, 255, 0.18)';
        ctx.stroke();
        ctx.fillStyle = highlightAmber ? '#fde68a' : '#fafaf9';
        ctx.fillText(label, x + 12, centerY + 7.5);
        return kw;
      };

      const cmdCenterY = stripY + stripH / 2;
      // Left group: [no] [opt out] Eigene Stimme ausnehmen
      let lx = padX;
      lx += drawKeycap(lx, cmdCenterY, 'no') + 8;
      lx += drawKeycap(lx, cmdCenterY, 'opt out') + 14;
      ctx.font = `500 18.5px ${FONT_SANS}`;
      ctx.fillStyle = '#d6d3d1';
      ctx.fillText(
        isEn ? 'Exclude your voice' : 'Eigene Stimme ausnehmen',
        lx,
        cmdCenterY + 6.5,
      );

      // Right group (right-aligned): [#pause] [#resume] Off-the-Record-Pause (or Fortsetzen when paused)
      const rightDesc = isPausedActive
        ? (isEn ? 'Resume in chat' : 'Im Chat fortsetzen')
        : (isEn ? 'Off-the-Record in chat' : 'Off-the-Record im Chat');
      ctx.font = `500 18.5px ${FONT_SANS}`;
      const rightDescW = ctx.measureText(rightDesc).width;
      ctx.font = `700 21.5px ${FONT_MONO}`;
      const k1Label = isPausedActive ? '#resume' : '#pause';
      const k2Label = isPausedActive ? (isEn ? '#continue' : '#weiter') : '#resume';
      const k1W = ctx.measureText(k1Label).width + 24;
      const k2W = isPausedActive && isEn ? 0 : ctx.measureText(k2Label).width + 24;
      const totalRightW = k1W + (k2W ? 8 + k2W : 0) + 14 + rightDescW;
      let rx = Math.max(lx + 240, contentRight - totalRightW);
      rx += drawKeycap(rx, cmdCenterY, k1Label, isPausedActive) + 8;
      if (k2W > 0) {
        rx += drawKeycap(rx, cmdCenterY, k2Label, isPausedActive) + 14;
      } else {
        rx += 6;
      }
      ctx.font = `500 18.5px ${FONT_SANS}`;
      ctx.fillStyle = isPausedActive ? '#fde68a' : '#d6d3d1';
      ctx.fillText(rightDesc, rx, cmdCenterY + 6.5);

      // 3. Central Stage — Ruhiger Sprach-Horizont (y: 215..472) & Subordinate Proof Line (y: 496..588)
      const entries = segments.slice(-8);
      const latest = entries.length > 0 ? entries[entries.length - 1] : null;
      const centerX = WIDTH / 2;

      if (isPausedActive) {
        const boxW = 860;
        const boxH = 316;
        const boxX = (WIDTH - boxW) / 2;
        const boxY = 232;
        roundRect(ctx, boxX, boxY, boxW, boxH, 16);
        ctx.fillStyle = 'rgba(245, 158, 11, 0.08)';
        ctx.fill();
        ctx.lineWidth = 1.25;
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.38)';
        ctx.stroke();

        const badgeSize = 56;
        const badgeX = centerX - badgeSize / 2;
        const badgeY = boxY + 32;
        roundRect(ctx, badgeX, badgeY, badgeSize, badgeSize, 14);
        ctx.fillStyle = 'rgba(245, 158, 11, 0.18)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.52)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#fbbf24';
        roundRect(ctx, centerX - 10, badgeY + 16, 7, 24, 3);
        ctx.fill();
        roundRect(ctx, centerX + 3, badgeY + 16, 7, 24, 3);
        ctx.fill();

        ctx.textAlign = 'center';
        ctx.font = `700 28px ${FONT_SANS}`;
        ctx.fillStyle = '#fef3c7';
        const pausedHeadline = isEn
          ? 'OFF THE RECORD · Recording Paused'
          : 'OFF THE RECORD · Aufnahme pausiert';
        ctx.fillText(pausedHeadline, centerX, badgeY + badgeSize + 44);

        ctx.font = `400 18.5px ${FONT_SANS}`;
        ctx.fillStyle = '#d6d3d1';
        const pausedBody = isEn
          ? 'Spoken audio and shared screens are discarded in memory and never stored.'
          : 'Gesprochenes Audio und geteilte Bildschirme werden sofort verworfen und nicht gespeichert.';
        ctx.fillText(pausedBody, centerX, badgeY + badgeSize + 78);

        // Muted broken amber horizon line inside paused stage
        const pHorizY = boxY + boxH - 64;
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.34)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([8, 8]);
        ctx.beginPath();
        ctx.moveTo(boxX + 64, pHorizY);
        ctx.lineTo(boxX + boxW - 64, pHorizY);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.font = `600 16.5px ${FONT_SANS}`;
        ctx.fillStyle = '#fde68a';
        ctx.fillText(
          isEn
            ? 'Send "#resume" in meeting chat to resume'
            : 'Mit „#resume“ oder „#weiter“ im Chat fortsetzen',
          centerX,
          pHorizY + 32,
        );
        ctx.textAlign = 'left';
        lastRenderedText = pausedHeadline;
      } else {
        // Active / Listening / Lobby Acoustic Horizon Stage (no eyebrow/kicker above heading!)
        const prominentSpeaker =
          currentSpeaker || (latest?.speaker ? latest.speaker : null);
        const headlineY = 308;
        const sublineY = 344;
        const horizonY = 408;

        ctx.textAlign = 'center';
        if (isPendingEntry) {
          ctx.font = `700 38px ${FONT_SANS}`;
          ctx.fillStyle = '#fef3c7';
          const lobbyTitle = inLobby
            ? (isEn ? 'Waiting for host admission…' : 'Wartet auf Einlass…')
            : (isEn ? 'Connecting to meeting…' : 'Verbindet mit der Konferenz…');
          ctx.fillText(lobbyTitle, centerX, headlineY);

          ctx.font = `400 18.5px ${FONT_SANS}`;
          ctx.fillStyle = '#a8a29e';
          ctx.fillText(
            isEn
              ? 'Audio capture remains inactive until admitted to the room'
              : 'Tonaufzeichnung startet erst nach Zulassung zum Meeting',
            centerX,
            sublineY,
          );
          lastRenderedText = lobbyTitle;
        } else if (isOptOutSpeakingActive) {
          const optOutTitle = 'Opt-out';
          ctx.font = `700 48px ${FONT_SANS}`;
          ctx.fillStyle = '#fef3c7';
          ctx.fillText(optOutTitle, centerX, headlineY);

          ctx.font = `500 18.5px ${FONT_SANS}`;
          ctx.fillStyle = '#fbbf24';
          ctx.fillText(
            isEn
              ? 'Voice excluded · Not recorded or transcribed'
              : 'Stimme ausgenommen · Wird nicht aufgezeichnet oder transkribiert',
            centerX,
            sublineY,
          );
          lastRenderedText = optOutTitle;
        } else if (voiceActive) {
          const spkHeadline =
            prominentSpeaker ||
            (isEn ? 'Recording audio' : 'Ton wird aufgezeichnet');
          ctx.font = `700 48px ${FONT_SANS}`;
          ctx.fillStyle = '#fafaf9';
          ctx.fillText(truncateText(ctx, spkHeadline, contentW - 80), centerX, headlineY);

          ctx.font = `500 18.5px ${FONT_SANS}`;
          ctx.fillStyle = '#34d399';
          ctx.fillText(
            prominentSpeaker
              ? (isEn
                  ? 'Speaking now · Isolated WebRTC audio track'
                  : 'Spricht gerade · Getrennte WebRTC-Audiospur')
              : (isEn
                  ? 'Isolated WebRTC audio track · Transcribing live'
                  : 'Getrennte WebRTC-Audiospur · Live-Erkennung läuft'),
            centerX,
            sublineY,
          );
          if (!latest) {
            lastRenderedText = prominentSpeaker
              ? (isEn ? `Recording audio · ${prominentSpeaker}` : `Ton wird aufgezeichnet · ${prominentSpeaker}`)
              : spkHeadline;
          }
        } else if (latest) {
          const spkHeadline = latest.speaker || (isEn ? 'Participant' : 'Teilnehmer');
          ctx.font = `700 42px ${FONT_SANS}`;
          ctx.fillStyle = '#e7e5e4';
          ctx.fillText(truncateText(ctx, spkHeadline, contentW - 80), centerX, headlineY);

          ctx.font = `400 18px ${FONT_SANS}`;
          ctx.fillStyle = '#a8a29e';
          ctx.fillText(
            isEn
              ? `Last speaker (${formatTimestamp(latest.start)}) · Listening for next statement`
              : `Zuletzt gesprochen (${formatTimestamp(latest.start)}) · Hört weiter zu`,
            centerX,
            sublineY,
          );
        } else {
          const readyTitle = isEn
            ? 'Listening · Ready for the call'
            : 'Hört zu · Bereit für das Gespräch';
          ctx.font = `600 36px ${FONT_SANS}`;
          ctx.fillStyle = '#f5f5f4';
          ctx.fillText(readyTitle, centerX, headlineY);

          ctx.font = `400 18.5px ${FONT_SANS}`;
          ctx.fillStyle = '#a8a29e';
          ctx.fillText(
            isEn
              ? 'Isolated per-speaker tracks · Outbound microphone muted'
              : 'Getrennte Sprecherspuren · Eigenes Mikrofon dauerhaft stumm',
            centerX,
            sublineY,
          );
          lastRenderedText = readyTitle;
        }
        ctx.textAlign = 'left';

        // Full-width Acoustic Horizon Line + Symmetrical Center Wave Bars (horizonY = 408)
        const waveHeights = [12, 20, 32, 46, 56, 62, 56, 46, 32, 20, 12];
        const barSpacing = 13;
        const clusterHalfW = ((waveHeights.length - 1) * barSpacing) / 2 + 24;
        const ruleColor =
          isPendingEntry || isOptOutSpeakingActive
            ? 'rgba(251, 191, 36, 0.28)'
            : voiceActive
              ? 'rgba(52, 211, 153, 0.40)'
              : 'rgba(52, 211, 153, 0.20)';

        ctx.strokeStyle = ruleColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padX, horizonY);
        ctx.lineTo(centerX - clusterHalfW, horizonY);
        ctx.moveTo(centerX + clusterHalfW, horizonY);
        ctx.lineTo(contentRight, horizonY);
        ctx.stroke();

        ctx.lineWidth = 4.2;
        ctx.lineCap = 'round';
        for (let i = 0; i < waveHeights.length; i++) {
          const bx = centerX - ((waveHeights.length - 1) * barSpacing) / 2 + i * barSpacing;
          let bh = 6;
          if (voiceActive) {
            const harmonic = 0.62 + 0.38 * Math.sin(frameCount * 1.45 + i * 0.75);
            bh = Math.max(8, Math.min(62, waveHeights[i] * shownLevel * harmonic));
            ctx.strokeStyle = '#34d399';
          } else if (isOptOutSpeakingActive) {
            bh = 6;
            ctx.strokeStyle = 'rgba(251, 191, 36, 0.42)';
          } else if (isPendingEntry) {
            bh = Math.max(6, waveHeights[i] * 0.26 * (0.7 + 0.3 * Math.sin(frameCount * 0.6 + i * 0.8)));
            ctx.strokeStyle = 'rgba(251, 191, 36, 0.52)';
          } else {
            bh = i % 2 === 0 ? 6 : 10;
            ctx.strokeStyle = 'rgba(52, 211, 153, 0.32)';
          }
          ctx.beginPath();
          ctx.moveTo(bx, horizonY - bh / 2);
          ctx.lineTo(bx, horizonY + bh / 2);
          ctx.stroke();
        }

        // Subordinate Latest-Statement Proof Strip (y: 494..584 — rendered ONLY when speech segments exist and not in Opt-out state!)
        if (latest && !isOptOutSpeakingActive) {
          const quoteRuleY = 486;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(padX, quoteRuleY);
          ctx.lineTo(contentRight, quoteRuleY);
          ctx.stroke();

          const spkRaw = latest.speaker || (isEn ? 'Participant' : 'Teilnehmer');
          const avR = 15;
          const avCx = padX + avR;
          const avCy = 524;
          ctx.beginPath();
          ctx.arc(avCx, avCy, avR, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(16, 185, 129, 0.14)';
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(52, 211, 153, 0.44)';
          ctx.stroke();

          ctx.textAlign = 'center';
          ctx.font = `600 12px ${FONT_SANS}`;
          ctx.fillStyle = '#a7f3d0';
          ctx.fillText(speakerInitials(spkRaw), avCx, avCy + 4.5);
          ctx.textAlign = 'left';

          const textX = padX + avR * 2 + 14; // x = 128 (squarely inside x: 96..880 probe window)
          const quoteMaxW = contentRight - textX;
          ctx.font = `500 15.5px ${FONT_MONO}`;
          ctx.fillStyle = '#78716c';
          const prefixMeta = `${formatTimestamp(latest.start)} · ${truncateText(ctx, spkRaw, 320)}`;
          ctx.fillText(prefixMeta, textX, 514);

          ctx.font = `400 20.5px ${FONT_SANS}`;
          ctx.fillStyle = '#d6d3d1';
          const quoteLines = wrapLines(ctx, `„${latest.text}“`, quoteMaxW, 2);
          for (let l = 0; l < quoteLines.length; l++) {
            ctx.fillText(quoteLines[l], textX, 544 + l * 28);
          }

          lastRenderedText = `${latest.speaker}: ${latest.text}`;
        }
      }
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
    let wasOptOutActiveOnTile = false;
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
      } else if (rtp.optedOutSpeaking && !paused) {
        lastOptOutVoiceAt = nowPerf;
      }
      const voiceNow =
        !paused &&
        participation !== 'joining' &&
        participation !== 'preparing' &&
        participation !== 'waiting_admission' &&
        (liveAudioLevel >= 0.02 || nowPerf - lastVoiceAt <= 650);
      const optOutNow =
        !paused &&
        !voiceNow &&
        participation !== 'joining' &&
        participation !== 'preparing' &&
        participation !== 'waiting_admission' &&
        nowPerf - lastOptOutVoiceAt <= 1200;
      if (
        voiceNow ||
        wasVoiceActiveOnTile ||
        optOutNow ||
        wasOptOutActiveOnTile ||
        nowPerf - lastIdleEmitAt >= 1000
      ) {
        wasVoiceActiveOnTile = voiceNow;
        wasOptOutActiveOnTile = optOutNow;
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
        let scrubbedSpeaker = false;
        if (Array.isArray(patch.optedOut)) {
          let addedOptOut = false;
          for (const raw of patch.optedOut) {
            if (typeof raw !== 'string') continue;
            const norm = raw.trim().toLowerCase();
            if (norm && !optedOutNorm.has(norm) && optedOutNorm.size < 256) {
              optedOutNorm.add(norm);
              addedOptOut = true;
            }
          }
          if (addedOptOut) {
            lastOptOutVoiceAt = performance.now();
            scrubbedSpeaker = true;
            const meetApi = (
              window as unknown as {
                wortlautMeet?: {syncOptedOut?: (items: string[]) => boolean};
              }
            ).wortlautMeet;
            meetApi?.syncOptedOut?.(patch.optedOut);
          }
          if (optedOutNorm.size > 0) {
            const beforeLen = segments.length;
            segments = segments.filter((s) => !isSpeakerOptedOut(s.speaker));
            if (segments.length !== beforeLen) scrubbedSpeaker = true;
            if (isSpeakerOptedOut(activeSpeaker)) {
              activeSpeaker = null;
              activeSpeakerUntil = -Infinity;
              liveAudioLevel = 0;
              lastVoiceAt = -Infinity;
              wasVoiceActiveOnTile = false;
              scrubbedSpeaker = true;
            }
          }
        }
        if (Array.isArray(patch.segments)) {
          segments = patch.segments
            .slice(-8)
            .map((s) => ({
              speaker: String(s?.speaker ?? '').slice(0, 80),
              text: String(s?.text ?? '').slice(0, 420),
              start: typeof s?.start === 'number' && Number.isFinite(s.start) ? s.start : 0,
            }))
            .filter((s) => !isSpeakerOptedOut(s.speaker));
        }
        const sig = `${participation}::${paused ? '1' : '0'}::${asrLanguage}::${JSON.stringify(segments)}`;
        if (sig !== lastSignature || scrubbedSpeaker) {
          lastSignature = sig;
          flushFrameBurst();
        }
      },
      reportAudioActivity(level: number, speakerName?: string | null) {
        if (typeof level !== 'number' || !Number.isFinite(level) || paused) {
          return;
        }
        const clamped = Math.max(0, Math.min(1, level));
        const nowPerf = performance.now();
        if (isSpeakerOptedOut(speakerName)) {
          if (clamped >= 0.02) {
            lastOptOutVoiceAt = nowPerf;
            const voiceNow = liveAudioLevel >= 0.02 || nowPerf - lastVoiceAt <= 650;
            if (!voiceNow && !wasOptOutActiveOnTile) {
              wasOptOutActiveOnTile = true;
              lastIdleEmitAt = nowPerf;
              emitFrame();
            }
          }
          return;
        }
        if (clamped > liveAudioLevel) {
          liveAudioLevel = clamped;
        }
        if (clamped >= 0.02) {
          lastVoiceAt = nowPerf;
          lastOptOutVoiceAt = -Infinity;
          if (speakerName && speakerName.trim()) {
            activeSpeaker = speakerName.trim().slice(0, 80);
            activeSpeakerUntil = nowPerf + 1400;
          }
          if (!wasVoiceActiveOnTile || wasOptOutActiveOnTile) {
            wasVoiceActiveOnTile = true;
            wasOptOutActiveOnTile = false;
            lastIdleEmitAt = nowPerf;
            emitFrame();
          }
        }
      },
      reportOptOutActivity(level: number) {
        if (typeof level !== 'number' || !Number.isFinite(level) || paused) return;
        const clamped = Math.max(0, Math.min(1, level));
        if (clamped < 0.02) return;
        const nowPerf = performance.now();
        lastOptOutVoiceAt = nowPerf;
        const voiceNow = liveAudioLevel >= 0.02 || nowPerf - lastVoiceAt <= 650;
        if (!voiceNow && !wasOptOutActiveOnTile) {
          wasOptOutActiveOnTile = true;
          lastIdleEmitAt = nowPerf;
          emitFrame();
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
        const optOutActive =
          !paused &&
          !audioActive &&
          participation !== 'joining' &&
          participation !== 'preparing' &&
          participation !== 'waiting_admission' &&
          nowPerf - lastOptOutVoiceAt <= 1200;
        return {
          frameCount,
          participation,
          paused,
          optOutActive,
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
