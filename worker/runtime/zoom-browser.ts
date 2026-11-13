import type {Page} from 'playwright';
import {AudioTransport} from '../src/transport.js';
import {installMeetCapture, MeetError} from './meet.js';
import {isZoomOrigin} from '../src/zoom-url.js';
import {installVideoTile, type VideoTilePatch} from './video-tile.js';

export type ZoomBootstrap = {provider: 'zoom'; meeting_id: string; attempt_id: string;
  meeting_url: string; deadline: string; lobby_timeout_seconds: number;
  empty_room_timeout_seconds?: number; chat_intro?: string | null;
  invited_by: string | null; invited_by_name: string | null; meeting_title: string | null;
  default_locale: string;
  zoom: {display_name: string; locale: string; auth_mode?: 'guest' | 'account'}};

const joinLabel = /^(Join|Beitreten|Teilnehmen)$/i;
const leaveLabel = /^(Leave|Leave Meeting|Leave meeting|Verlassen|Meeting verlassen)(?: \(.*\))?$/i;
const waitingRoomPattern = /Please wait, the meeting host will let you in soon|Waiting for the host to start the meeting|Waiting for the host to start this meeting|The host has another meeting in progress|Waiting Room|Host has joined\. We've let them know you're here|Bitte warten Sie, der Host lässt Sie in Kürze ein|Warten auf den Beginn des Meetings durch den Host|Warteraum/i;
const deniedPattern = /You have been removed from this meeting|The host has removed you|unable to join this meeting|Sie wurden aus diesem Meeting entfernt|Teilnahme abgelehnt/i;
const endedPattern = /This meeting has been ended by host|The meeting has ended|Dieses Meeting wurde vom Host beendet|Das Meeting wurde beendet/i;
const passcodeErrorPattern = /Passcode is wrong|Invalid passcode|Meeting passcode is required|Kenncode ist falsch|Ungültiger Kenncode|Meeting-Kenncode erforderlich/i;
const authRequiredPattern = /Sign in to join(?: this meeting)?|Only authenticated users can join|this meeting requires authentication|automated bots aren['’]?t allowed|must use Zoom RTMS|Commercial Zoom license is required|Melden Sie sich an, um an diesem Meeting teilzunehmen/i;
const webClientDisabledPattern = /Join from browser is disabled|Browser join is not enabled/i;
const zoomJoinButtonSelector = 'button.preview-join-button, #joinBtn';

async function zoomHumanVerificationVisible(page: Page) {
  for (const frame of await page.locator('iframe[src*="/recaptcha/"]').all()) {
    if (!await frame.evaluate(element => element.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})).catch(() => false)) continue;
    const path = new URL(await frame.getAttribute('src') ?? '', page.url()).pathname;
    if (/\/recaptcha\/(?:api2|enterprise)\/bframe$/.test(path)) return true;
    if (/\/recaptcha\/(?:api2|enterprise)\/anchor$/.test(path) &&
        await frame.contentFrame().getByRole('checkbox').first().isVisible().catch(() => false)) return true;
  }
  return false;
}

// Join flow reference: Vexa core/meetings/modules/join/src/zoom/join.ts (Apache-2.0).
export class ZoomBrowser {
  private readonly transport: AudioTransport;
  private initialize?: () => Promise<void>;
  private stopping?: Promise<void>;
  private reason = '';
  private joined = false;
  private capturing = false;
  private initializedCapture = false;
  private audioJoined = false;
  private videoStarted = false;
  private videoStartAttempts = 0;
  private videoStopped = false;
  private chatSent = false;
  private rosterOpened = false;
  private drained: boolean | null = null;
  private pushVideoTile?: (patch: VideoTilePatch) => Promise<void>;

  constructor(private readonly page: Page, private readonly bootstrap: ZoomBootstrap,
    api: string, credential: string, workerId: string, private readonly assets?: URL) {
    const url = new URL(`/v1/attempts/${bootstrap.attempt_id}/audio`, api);
    if (!['https:', 'http:'].includes(url.protocol)) throw new MeetError('invalid_ingest_url');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.transport = new AudioTransport(url.href, credential, workerId, reason => { this.reason = reason; });
  }

  async prepare() {
    this.pushVideoTile = await installVideoTile(this.page, 'zoom', this.bootstrap.meeting_url, {
      locale: this.bootstrap.default_locale,
      invitedBy: this.bootstrap.invited_by_name ?? this.bootstrap.invited_by,
      meetingTitle: this.bootstrap.meeting_title,
    });
    this.initialize = await installMeetCapture(this.page, this.bootstrap, {
      begin: metadata => this.transport.control(metadata as Record<string, unknown> & {id: string}),
      bind: metadata => this.transport.control(metadata as Record<string, unknown> & {id: string}),
      end: metadata => this.transport.control(metadata as Record<string, unknown> & {id: string}),
      gap: metadata => this.transport.control(metadata as Record<string, unknown> & {id: string}),
      chunk: (metadata, pcm) => this.transport.chunk(metadata, pcm),
      error: reason => { this.reason = reason; },
    }, this.assets, 'zoom');
    this.transport.connect();
  }

  async updateVideoTile(patch: VideoTilePatch) {
    await this.pushVideoTile?.(patch);
  }

  private async dismissBannersAndPopups() {
    const withoutMedia = this.page.getByText(
      /^(?:Continue without (?:microphone(?: and camera)?|camera|audio(?: or video)?)|Ohne (?:Mikrofon(?: und Kamera)?|Kamera|Audio(?: oder Video)?) fortfahren)$/i
    );
    if (await withoutMedia.first().isVisible().catch(() => false)) {
      await withoutMedia.first().click({timeout: 2500}).catch(() => {});
    }
    const dismissButtons = this.page.locator(
      '#onetrust-accept-btn-handler, button.zm-btn--primary:has-text("Got it"), button.zm-btn--primary:has-text("OK"), button.zm-btn--primary:has-text("I Agree"), button.zm-btn--primary:has-text("Agree")'
    ).or(this.page.getByRole('button', {
      name: /^(Accept Cookies|Agree|I Agree|Got it|OK|Continue without audio or video|Continue without microphone and camera|Continue without microphone|Verstanden|Zustimmen|Akzeptieren)$/i,
    }));
    if (await dismissButtons.first().isVisible().catch(() => false)) {
      await dismissButtons.first().click({timeout: 2500}).catch(() => {});
    }
  }

  private async configurePreviewDevices() {
    await this.dismissBannersAndPopups();
    // Ensure preview microphone is muted if any mute control is active.
    const previewMute = this.page.locator(
      '#preview-audio-control-button[aria-label*="Mute" i]:not([aria-label*="Unmute" i]), ' +
      '#preview-audio-control-button[aria-label*="Stummschalten" i]:not([aria-label*="aufheben" i])'
    );
    if (await previewMute.first().isVisible().catch(() => false)) {
      await previewMute.first().click({timeout: 2500}).catch(() => {});
    }
    // Enable virtual live-transcript camera in preview (best-effort).
    const previewStartVideo = this.page.locator(
      '#preview-video-control-button[aria-label*="Start Video" i], ' +
      '#preview-video-control-button[aria-label*="Video starten" i]'
    ).or(this.page.getByRole('button', {
      name: /^(Start Video|Turn on video|Video starten|Video einschalten)$/i,
    }));
    if (await previewStartVideo.first().isVisible().catch(() => false)) {
      await previewStartVideo.first().click({timeout: 2500}).catch(() => {});
    }
    // Forbid any live outbound audio sender or any non-virtual video sender.
    if (await this.page.evaluate(() => [...(window.wortlautMeetReceivers?.connections ?? [])]
      .some(pc => pc.getSenders().some(sender => {
        const track = sender.track as (MediaStreamTrack & {__wortlautVirtualVideo?: boolean}) | null;
        if (!track || track.readyState !== 'live' || !track.enabled) return false;
        return track.kind === 'audio' || !track.__wortlautVirtualVideo;
      })))) {
      throw new MeetError('zoom_sending_device_active');
    }
  }

  private async ensureOutgoingVideoStarted() {
    if (this.videoStarted || this.videoStartAttempts >= 6) return;
    this.videoStartAttempts += 1;
    try {
      const stopVideoBtn = this.page.locator(
        'button.send-video-container__btn[aria-label*="Stop Video" i], ' +
        'button[aria-label^="Stop Video" i], button[aria-label^="Video beenden" i], button[aria-label^="Video stoppen" i]'
      ).or(this.page.getByRole('button', {
        name: /^(Stop Video|Video beenden|Video stoppen)(?: \(.*\))?$/i,
      })).first();
      if (await stopVideoBtn.isVisible().catch(() => false)) {
        this.videoStarted = true;
        return;
      }
      const startVideoBtn = this.page.locator(
        'button.send-video-container__btn[aria-label*="Start Video" i], ' +
        'button[aria-label^="Start Video" i], button[aria-label^="Video starten" i]'
      ).or(this.page.getByRole('button', {
        name: /^(Start Video|Video starten)(?: \(.*\))?$/i,
      })).first();
      if (await startVideoBtn.isVisible().catch(() => false)) {
        await startVideoBtn.click({timeout: 2500});
        this.videoStarted = true;
      }
    } catch {
      // non-critical
    }
  }

  private async ensureComputerAudioJoined() {
    if (this.audioJoined) return;
    const joinAudioBtn = this.page.locator(
      'button.join-audio-by-voip__join-btn, button[aria-label*="Join Audio by Computer" i], button[aria-label*="Per Computeraudio teilnehmen" i]'
    ).or(this.page.getByRole('button', {
      name: /^(Join Audio by Computer|Join Audio|Per Computeraudio teilnehmen|Computeraudio beitreten)$/i,
    }));
    if (await joinAudioBtn.first().isVisible().catch(() => false)) {
      await joinAudioBtn.first().click({timeout: 3000}).catch(() => {});
      this.audioJoined = true;
    }
  }

  private async stopIncomingVideoIfPossible() {
    if (this.videoStopped) return;
    try {
      const moreBtn = this.page.locator('#moreButton, button[aria-label*="More" i], button[aria-label*="Mehr" i]').first();
      if (!await moreBtn.isVisible().catch(() => false)) return;
      await moreBtn.click({timeout: 2000});
      const stopIncoming = this.page.getByRole('menuitem', {
        name: /Stop Incoming Video|Eingehendes Video stoppen/i,
      }).or(this.page.locator('a, li, button').filter({hasText: /^(Stop Incoming Video|Eingehendes Video stoppen)$/i})).first();
      if (await stopIncoming.isVisible().catch(() => false)) {
        await stopIncoming.click({timeout: 2000}).catch(() => {});
        this.videoStopped = true;
      } else {
        await this.page.keyboard.press('Escape').catch(() => {});
        this.videoStopped = true;
      }
    } catch {
      this.videoStopped = true;
    }
  }

  private async ensureRosterOpen() {
    if (this.rosterOpened) return;
    try {
      const rosterPanel = this.page.locator('.participants-section-container, #participants-list, [aria-label*="Participants" i][role="region"]');
      if (await rosterPanel.first().isVisible().catch(() => false)) {
        this.rosterOpened = true;
        return;
      }
      const rosterBtn = this.page.locator(
        'button[aria-label*="Participants" i], button[aria-label*="Teilnehmer" i], .footer-button__participants-icon'
      ).first();
      if (await rosterBtn.isVisible().catch(() => false)) {
        await rosterBtn.click({timeout: 2500}).catch(() => {});
        this.rosterOpened = true;
      }
    } catch {
      // non-critical
    }
  }

  private async sendChatIntro() {
    if (this.chatSent) return;
    const text = this.bootstrap.chat_intro?.trim();
    if (!text) {
      this.chatSent = true;
      return;
    }
    try {
      const chatInput = this.page.locator(
        'textarea.chat-box__chat-textarea, [contenteditable="true"][aria-label*="chat" i], textarea[placeholder*="Type message" i], textarea[placeholder*="Nachricht" i]'
      );
      if (!await chatInput.first().isVisible().catch(() => false)) {
        const chatBtn = this.page.locator(
          'button[aria-label*="open the chat" i], button[aria-label^="Chat" i], .footer-button__chat-icon'
        ).first();
        if (await chatBtn.isVisible().catch(() => false)) {
          await chatBtn.click({timeout: 2500}).catch(() => {});
          await chatInput.first().waitFor({state: 'visible', timeout: 2500}).catch(() => {});
        }
      }
      if (await chatInput.first().isVisible().catch(() => false)) {
        await chatInput.first().fill(text, {timeout: 2500});
        await chatInput.first().press('Enter', {timeout: 2000}).catch(() => {});
        this.chatSent = true;
      }
    } catch {
      // chat intro is non-critical
    }
  }

  async join() {
    const until = Math.min(Date.parse(this.bootstrap.deadline), Date.now() + 90000);
    while (!this.stopping && Date.now() < until) {
      const state = await this.inspect();
      if (state.reason) throw new MeetError(state.reason);
      if (state.participation === 'waiting_admission' || state.participation === 'capturing') return;
      if (!isZoomOrigin(new URL(this.page.url()))) {
        await new Promise(resolve => setTimeout(resolve, 250));
        continue;
      }
      await this.dismissBannersAndPopups();

      const launchWebBtn = this.page.locator('#wc-footer a, a[href*="/wc/"]').or(
        this.page.getByRole('link', {name: /Join from your browser|Join from browser|Mit Ihrem Browserคม|Im Browser beitreten|Über Browser teilnehmen/i})
      );
      if (!this.page.url().includes('/wc/') && await launchWebBtn.first().isVisible().catch(() => false)) {
        await launchWebBtn.first().click({timeout: 5000}).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }

      const nameInput = this.page.locator(
        '#input-for-name, #inputname, input[placeholder*="Your Name" i], input[placeholder*="Ihr Name" i], input[name="inputname"]'
      ).or(this.page.getByRole('textbox', {
        name: /^(Your Name|Name|Ihr Name|Geben Sie Ihren Namen ein)$/i,
      }));
      const joinBtn = this.page.locator(zoomJoinButtonSelector).or(
        this.page.getByRole('button', {name: joinLabel})
      );
      const nameVisible = await nameInput.first().isVisible().catch(() => false);
      const joinVisible = await joinBtn.first().isVisible().catch(() => false);
      if ((nameVisible || (this.bootstrap.zoom.auth_mode === 'account' && joinVisible)) && !this.joined) {
        if (!this.initializedCapture) {
          await this.initialize?.();
          this.initializedCapture = true;
        }
        await this.configurePreviewDevices();
        if (nameVisible) {
          const existingVal = await nameInput.first().inputValue().catch(() => '');
          if (this.bootstrap.zoom.auth_mode !== 'account' || !existingVal.trim()) {
            await nameInput.first().click({timeout: 5000}).catch(() => {});
            await nameInput.first().fill('');
            await this.page.keyboard.type(this.bootstrap.zoom.display_name, {delay: 30});
          }
        }
        if (await zoomHumanVerificationVisible(this.page)) {
          this.reason = 'human_verification_required';
          throw new MeetError('human_verification_required');
        }
        await this.page.waitForFunction(
          (sel: string) => {
            const btn = document.querySelector(sel) as HTMLButtonElement | null;
            return Boolean(btn && !btn.classList.contains('disabled') && !btn.disabled);
          },
          zoomJoinButtonSelector,
          {timeout: 8000},
        ).catch(() => {});
        await this.configurePreviewDevices();
        const clickedDom = await this.page.evaluate((sel: string) => {
          const btn = document.querySelector(sel) as HTMLButtonElement | null;
          if (!btn || btn.classList.contains('disabled') || btn.disabled) return false;
          btn.click();
          return true;
        }, zoomJoinButtonSelector).catch(() => false);
        if (!clickedDom) {
          await joinBtn.first().waitFor({state: 'visible', timeout: 10000});
          await joinBtn.first().click({force: true, timeout: 5000});
        }
        this.joined = true;
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (!this.stopping) throw new MeetError('zoom_prejoin_timeout');
  }

  async inspect() {
    await this.dismissBannersAndPopups().catch(() => {});
    const url = new URL(this.page.url());
    if (!isZoomOrigin(url) || /^\/signin\b/i.test(url.pathname)) {
      this.reason = this.bootstrap.zoom.auth_mode === 'account' ? 'auth_session_missing' : 'zoom_auth_required';
    }
    if (!this.reason && await zoomHumanVerificationVisible(this.page)) {
      this.reason = 'human_verification_required';
    }
    const text = await this.page.locator('body').innerText().catch(() => '');
    if (passcodeErrorPattern.test(text) || await this.page.locator('#input-for-pwd, #passcode, input[placeholder*="passcode" i], input[type="password"]').isVisible().catch(() => false)) {
      this.reason = 'zoom_passcode_required';
    } else if (authRequiredPattern.test(text)) {
      this.reason = this.bootstrap.zoom.auth_mode === 'account' ? 'auth_session_missing' : 'zoom_auth_required';
    } else if (webClientDisabledPattern.test(text)) {
      this.reason = 'zoom_web_client_disabled';
    } else if (deniedPattern.test(text)) {
      this.reason = 'admission_denied';
    } else if (endedPattern.test(text)) {
      this.reason = 'ended';
    }

    const leaveVisible = await this.page.locator(
      'button.footer-button-base__button[aria-label*="Leave" i], button[aria-label*="Verlassen" i], .footer__leave-btn'
    ).or(this.page.getByRole('button', {name: leaveLabel})).first().isVisible().catch(() => false);
    const hasInCallControls = await this.page.locator(
      'button[aria-label*="Participants" i], button[aria-label*="Teilnehmer" i], .footer-button__participants-icon, ' +
      'button[aria-label*="open the chat" i], .footer-button__chat-icon, ' +
      'button.join-audio-by-voip__join-btn, button[aria-label*="Join Audio by Computer" i], button[aria-label*="Per Computeraudio teilnehmen" i], ' +
      '.speaker-active-container__video-frame, .gallery-video-container__main-view'
    ).or(
      this.page.getByRole('button', {
        name: /^(?:Join Audio by Computer|Join Audio|Per Computeraudio teilnehmen|Computeraudio beitreten|Participants|Teilnehmer)(?:\b|\s|$)/i,
      })
    ).first().isVisible().catch(() => false);
    const inMeetingDom = leaveVisible && hasInCallControls;

    if ((inMeetingDom || leaveVisible) && !this.initializedCapture) {
      await this.initialize?.().catch(() => {});
      this.initializedCapture = true;
    }

    const capture = await this.page.evaluate(() => window.wortlautMeet?.inspect()).catch(() => undefined);
    if (!this.reason && capture?.reason) this.reason = capture.reason;

    const isWaiting = waitingRoomPattern.test(text);
    const hasCaptureEvidence = Boolean(
      capture && (capture.streams > 0 || capture.audio_samples > 0 || capture.participant_sources.total > 0)
    );
    const inCall = !isWaiting && (this.capturing || inMeetingDom || hasCaptureEvidence);
    if (inCall) {
      this.capturing = true;
      await this.ensureComputerAudioJoined();
      if (!this.videoStarted) await this.ensureOutgoingVideoStarted();
      if (!this.videoStopped) await this.stopIncomingVideoIfPossible();
      if (!this.rosterOpened) await this.ensureRosterOpen();
      if (!this.chatSent) await this.sendChatIntro();
    }

    const participation = this.stopping
      ? 'ended'
      : isWaiting
        ? 'waiting_admission'
        : inCall
          ? 'capturing'
          : this.joined
            ? 'waiting_admission'
            : 'joining';
    return {
      ...capture,
      participation,
      reason: this.reason === 'ended' ? '' : this.reason,
      stopped: Boolean(this.stopping || this.reason),
      ended: this.reason === 'ended',
      capability: 'unverified',
      streams: capture?.streams ?? 0,
      configured_speaker_slots: null,
      configured_share_slots: null,
      audio_samples: capture?.audio_samples ?? 0,
      active_audio_samples: capture?.active_audio_samples ?? 0,
      receiver_sources: capture?.receiver_sources ?? [],
      participant_sources: capture?.participant_sources ?? {available: false, total: 0, truncated: false, sources: []},
      data_channels: capture?.data_channels ?? [],
      sdp: capture?.sdp ?? {descriptions: 0, audio_sections: 0, video_sections: 0, ssrc_count: 0, cname_count: 0, msid_count: 0},
      audio_clock: capture?.audio_clock ?? {interrupted: false, gap_samples: 0, max_gap_samples: 0},
      drained: this.drained,
    };
  }

  async stop(reason: string) {
    return this.stopping ??= (async () => {
      this.reason ||= reason === 'normal' ? '' : reason;
      const ended = await this.page.evaluate(() => {
        window.wortlautVideoTile?.stop();
        return window.wortlautMeet?.stop();
      }).catch(() => false);
      this.drained = await this.transport.drain() && ended === true;
      if (!isZoomOrigin(new URL(this.page.url()))) return;
      const leave = this.page.locator(
        'button.footer-button-base__button[aria-label*="Leave" i], button[aria-label*="Verlassen" i], .footer__leave-btn'
      ).or(this.page.getByRole('button', {name: leaveLabel})).first();
      if (await leave.isVisible().catch(() => false)) {
        await leave.click({timeout: 3000}).catch(() => {});
        const confirmLeave = this.page.locator(
          'button.leave-meeting-options__btn--danger, button:has-text("Leave Meeting"), button:has-text("Meeting verlassen")'
        ).first();
        if (await confirmLeave.isVisible().catch(() => false)) {
          await confirmLeave.click({timeout: 2000}).catch(() => {});
        }
      }
    })();
  }
}
