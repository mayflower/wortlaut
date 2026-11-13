import type {Page} from 'playwright';
import {AudioTransport} from '../src/transport.js';
import {installMeetCapture, MeetError} from './meet.js';
import {isTeamsOrigin} from '../src/teams-url.js';
import {installVideoTile, type VideoTilePatch} from './video-tile.js';

export type TeamsBootstrap = {provider: 'teams'; meeting_id: string; attempt_id: string;
  meeting_url: string; deadline: string; lobby_timeout_seconds: number;
  empty_room_timeout_seconds?: number; chat_intro?: string | null;
  invited_by: string | null; invited_by_name: string | null; meeting_title: string | null;
  default_locale: string;
  teams: {display_name: string; locale: string}};

const browserLabel = /^(Continue on this browser|Join on the web instead|In diesem Browser fortfahren|Stattdessen im Web teilnehmen)$/i;
const joinLabel = /^(Join now|Jetzt teilnehmen)$/i;
const leaveLabel = /^(Leave|Leave meeting|Verlassen|Besprechung verlassen)(?: \(.*\))?$/i;
const waiting = /Someone will let you in shortly|You[’']re in the lobby|Waiting.*(?:admit|let you in)|Please wait until someone admits|Jemand wird Sie.*einlassen|Sie (?:befinden sich|sind) im Wartebereich|Warten.*(?:Zulassung|eingelassen)/i;

// Join flow reference: Vexa f1a62fbbdfd2c98cb162582d82c31fe8102acc89.
export class TeamsBrowser {
  private readonly transport: AudioTransport;
  private initialize?: () => Promise<void>;
  private stopping?: Promise<void>;
  private reason = '';
  private initialized = false;
  private joined = false;
  private capturing = false;
  private browserClicked = false;
  private chatSent = false;
  private chatAttempts = 0;
  private rosterOpened = false;
  private chatRestored = false;
  private videoCheckedInCall = false;
  private videoCheckAttempts = 0;
  private drained: boolean | null = null;
  private pushVideoTile?: (patch: VideoTilePatch) => Promise<void>;

  constructor(private readonly page: Page, private readonly bootstrap: TeamsBootstrap,
    api: string, credential: string, workerId: string, private readonly assets?: URL) {
    const url = new URL(`/v1/attempts/${bootstrap.attempt_id}/audio`, api);
    if (!['https:', 'http:'].includes(url.protocol)) throw new MeetError('invalid_ingest_url');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.transport = new AudioTransport(url.href, credential, workerId, reason => { this.reason = reason; });
  }

  async prepare() {
    this.pushVideoTile = await installVideoTile(this.page, 'teams', this.bootstrap.meeting_url, {
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
    }, this.assets, 'teams');
    this.transport.connect();
  }

  async updateVideoTile(patch: VideoTilePatch) {
    await this.pushVideoTile?.(patch);
  }

  private async dismissMediaPrompt() {
    const button = this.page.getByRole('button', {
      name: /^(Continue without audio(?: or video| and video)?|Continue without microphone(?: and camera| or camera)?|Ohne Audio(?: oder Video| und Video)? fortfahren|Ohne Mikrofon(?: und Kamera| oder Kamera)? fortfahren)$/i,
    }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({timeout: 5000}).catch(() => {});
      await button.waitFor({state: 'hidden', timeout: 3000}).catch(() => {});
      await this.page.locator('.fui-DialogSurface__backdrop').first()
        .waitFor({state: 'hidden', timeout: 2000}).catch(() => {});
      return true;
    }
    return false;
  }

  private async configureDevices() {
    // Microphone must stay OFF.
    const micControl = this.page.locator('#microphone-button, [data-tid="toggle-mute"]');
    const micOffAction = this.page.getByRole('button', {
      name: /^(Mute|Turn off microphone|Mikrofon ausschalten|Mikrofon stummschalten|Stummschalten)(?: \(.*\))?$/i,
    });
    if (await micOffAction.first().isVisible().catch(() => false)) {
      await micOffAction.first().click({timeout: 3000}).catch(() => {});
    } else if (await micControl.first().isVisible().catch(() => false)) {
      const checked = await micControl.first().getAttribute('aria-checked').catch(() => null);
      const pressed = await micControl.first().getAttribute('aria-pressed').catch(() => null);
      if (checked === 'true' || pressed === 'true') {
        await micControl.first().click({timeout: 3000}).catch(() => {});
      }
    }

    // Virtual live-transcript camera should be ON (best-effort).
    const camOnAction = this.page.getByRole('button', {
      name: /^(Turn on camera|Turn camera on|Turn on video|Turn video on|Kamera einschalten|Video einschalten)(?: \(.*\))?$/i,
    });
    const camControl = this.page.locator('#video-button, [data-tid="toggle-video"]').or(
      this.page.getByRole('switch', {name: /^(Camera|Video|Kamera)(?:\b|\s|$)/i}),
    );
    if (await camOnAction.first().isVisible().catch(() => false)) {
      await camOnAction.first().click({timeout: 3000}).catch(() => {});
    } else if (await camControl.first().isVisible().catch(() => false)) {
      const isOff = await camControl.first().evaluate((el) => {
        if (el instanceof HTMLInputElement && el.type === 'checkbox') return !el.checked;
        const checked = el.getAttribute('aria-checked');
        const pressed = el.getAttribute('aria-pressed');
        return checked === 'false' || pressed === 'false';
      }).catch(() => false);
      if (isOff) {
        await camControl.first().click({timeout: 3000}).catch(() => {});
      }
    }

    // Forbid any live outbound audio sender or any non-virtual video sender.
    if (await this.page.evaluate(() => [...(window.wortlautMeetReceivers?.connections ?? [])]
      .some(pc => pc.getSenders().some(sender => {
        const track = sender.track as (MediaStreamTrack & {__wortlautVirtualVideo?: boolean}) | null;
        if (!track || track.readyState !== 'live' || !track.enabled) return false;
        return track.kind === 'audio' || !track.__wortlautVirtualVideo;
      })))) {
      throw new MeetError('teams_sending_device_active');
    }
  }

  async join() {
    const until = Math.min(Date.parse(this.bootstrap.deadline), Date.now() + 90000);
    while (!this.stopping && Date.now() < until) {
      const state = await this.inspect();
      if (state.reason) throw new MeetError(state.reason);
      if (state.participation === 'waiting_admission' || state.participation === 'capturing') return;
      if (!isTeamsOrigin(new URL(this.page.url()))) {
        await new Promise(resolve => setTimeout(resolve, 250));
        continue;
      }
      const browser = this.page.getByRole('button', {
        name: browserLabel,
      }).or(this.page.getByRole('link', {
        name: browserLabel,
      }));
      if (!this.browserClicked && !this.page.url().includes('lightExperience=true') && await browser.first().isVisible().catch(() => false)) {
        this.browserClicked = true;
        await browser.first().click({timeout: 5000}).catch(() => {});
        continue;
      }
      const dismissed = await this.dismissMediaPrompt();
      const name = this.page.getByRole('textbox', {
        name: /^(Type your name|Enter name|Your name|Name|Geben Sie Ihren Namen ein|Namen eingeben|Ihr Name)$/i,
      }).or(this.page.locator('input[data-tid="prejoin-display-name-input"]'));
      const join = this.page.getByRole('button', {name: joinLabel})
        .or(this.page.locator('button[data-tid="prejoin-join-button"]')).first();
      if (await name.first().isVisible().catch(() => false) && !this.joined) {
        if (!this.initialized) {
          await this.initialize?.();
          this.initialized = true;
        }
        await this.dismissMediaPrompt();
        await name.first().fill(this.bootstrap.teams.display_name, {timeout: 4000}).catch(() => {});
        if ((await name.first().inputValue().catch(() => '')) !== this.bootstrap.teams.display_name) {
          await this.dismissMediaPrompt();
          await new Promise(resolve => setTimeout(resolve, 150));
          continue;
        }
        const computer = this.page.getByRole('radio', {name: /^(Computer audio|Computeraudio)(?:\s|$)/i});
        if (await computer.isVisible().catch(() => false) && !(await computer.isChecked().catch(() => true))) {
          await computer.check({force: true, timeout: 2000}).catch(() => {});
        }
        const speakerOn = this.page.getByRole('button', {
          name: /^(Turn speaker on|Speaker is off|Lautsprecher einschalten)(?:\s|$)/i,
        });
        if (await speakerOn.first().isVisible().catch(() => false)) {
          await speakerOn.first().click({timeout: 3000}).catch(() => {});
        }
        const noAudio = this.page.getByRole('radio', {
          name: /^(Don't use audio|Kein Audio verwenden)(?:\s|$)/i,
        });
        if (await noAudio.isVisible().catch(() => false) && await noAudio.isChecked().catch(() => false)) {
          throw new MeetError('teams_receive_audio_disabled');
        }
        await this.configureDevices();
        await this.dismissMediaPrompt();
        if (await join.isVisible().catch(() => false) && await join.isEnabled().catch(() => false)) {
          try {
            await join.click({timeout: 4000});
            this.joined = true;
          } catch {
            await this.dismissMediaPrompt();
          }
        }
      } else if (this.joined && dismissed) {
        if (await join.isVisible().catch(() => false) && await join.isEnabled().catch(() => false)) {
          await join.click({timeout: 4000}).catch(() => {});
        }
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!this.stopping) throw new MeetError('teams_prejoin_timeout');
  }

  private async sendChatIntro() {
    const text = this.bootstrap.chat_intro?.trim();
    if (!text) {
      this.chatSent = true;
      return;
    }
    try {
      const chatBox = this.page.getByRole('textbox', {
        name: /type a message|send a message|nachricht.*eingeben|nachricht.*senden|chat/i,
      }).or(this.page.locator('[data-tid="ckeditor"], div[contenteditable="true"][role="textbox"]'));
      if (!await chatBox.first().isVisible().catch(() => false)) {
        const chatToggle = this.page.getByRole('button', {
          name: /^(?:Chat|Show conversation|Unterhaltung anzeigen)(?:\b|\s|$)/i,
        }).and(this.page.locator('[aria-expanded="false"], [aria-pressed="false"], :not([aria-expanded="true"]):not([aria-pressed="true"])')).first();
        if (!await chatToggle.isVisible().catch(() => false)) return;
        await chatToggle.click({timeout: 2000}).catch(() => {});
        await chatBox.first().waitFor({state: 'visible', timeout: 2500}).catch(() => {});
      }
      if (!await chatBox.first().isVisible().catch(() => false)) return;
      await chatBox.first().fill(text, {timeout: 2500});
      const sendBtn = this.page.getByRole('button', {
        name: /^(?:Send|Send message|Senden|Nachricht senden)(?:\b|\s|$)/i,
      }).or(this.page.locator('[data-tid="newMessageCommands-send"]')).first();
      if (await sendBtn.isVisible().catch(() => false) && await sendBtn.isEnabled().catch(() => false)) {
        await sendBtn.click({timeout: 2000}).catch(() => {});
      } else {
        await chatBox.first().press('Enter', {timeout: 2000}).catch(() => {});
      }
      this.chatSent = true;
    } catch { /* chat intro is non-critical */ }
  }

  async inspect() {
    const url = new URL(this.page.url());
    if (/^(login\.microsoftonline\.com|login\.live\.com)$/.test(url.hostname)) this.reason = 'teams_auth_required';
    const trusted = isTeamsOrigin(url);
    const text = trusted ? await this.page.locator('body').innerText().catch(() => '') : '';
    if (/verify your (?:email|identity)|enter (?:the )?(?:verification|security) code|E-Mail.*bestätigen|Bestätigungscode eingeben/i.test(text)) this.reason = 'teams_verification_required';
    if (/you were denied|denied entry|Anfrage.*abgelehnt|Zutritt.*verweigert/i.test(text)) this.reason = 'admission_denied';
    if (/removed from this meeting|aus.*Besprechung.*entfernt/i.test(text)) this.reason = 'removed';
    if (/meeting (?:has )?ended|Besprechung.*beendet/i.test(text)) this.reason = 'meeting_ended';
    if (/meeting not found|Besprechung nicht gefunden/i.test(text)) this.reason = 'meeting_not_found';
    const state = trusted ? await this.page.evaluate(() => window.wortlautMeet?.inspect()).catch(() => undefined) : undefined;
    this.reason ||= state?.reason ?? '';
    const joinVisible = trusted && await this.page.getByRole('button', {name: joinLabel})
      .or(this.page.locator('button[data-tid="prejoin-join-button"]'))
      .first().isVisible().catch(() => false);
    let participation = 'joining';
    if (trusted && this.joined && !joinVisible && waiting.test(text)) {
      participation = 'waiting_admission';
    } else if (trusted && this.joined && !joinVisible) {
      const hasLeave = await this.page.getByRole('button', {name: leaveLabel}).first().isVisible();
      const hasRtpOrParticipants =
        (state?.participant_sources?.total ?? 0) > 0 ||
        (state?.participant_sources?.dom_participants ?? 0) > 0 ||
        (state?.receiver_sources ?? []).some((r: Record<string, any>) =>
          (r.ssrc?.length ?? 0) > 0 ||
          (r.csrc?.length ?? 0) > 0 ||
          (r.encoded_transform?.frame_count ?? 0) > 0);
      const hasInCallControls = hasLeave && await this.page.locator(
        '#roster-button, #chat-button, #raisehands-button, #callingButtons-showMoreBtn'
      ).or(
        this.page.getByRole('button', {
          name: /^(?:People|Participants|Show participants|Teilnehmer|Personen|Teilnehmer anzeigen|Chat|Show conversation|Unterhaltung anzeigen|Raise|Raise hand|Hand heben)(?:\b|\s|$)/i,
        })
      ).first().isVisible().catch(() => false);
      if (this.capturing || (hasLeave && (hasRtpOrParticipants || hasInCallControls))) {
        this.capturing = true;
        participation = 'capturing';
        if (!this.videoCheckedInCall && this.videoCheckAttempts < 6) {
          this.videoCheckAttempts += 1;
          const camOff = this.page.getByRole('button', {
            name: /^(Turn off camera|Turn camera off|Turn off video|Turn video off|Kamera ausschalten|Video ausschalten)(?: \(.*\))?$/i,
          }).first();
          if (await camOff.isVisible().catch(() => false)) {
            this.videoCheckedInCall = true;
          } else {
            const camOn = this.page.getByRole('button', {
              name: /^(Turn on camera|Turn camera on|Turn on video|Turn video on|Kamera einschalten|Video einschalten)(?: \(.*\))?$/i,
            }).first();
            if (await camOn.isVisible().catch(() => false)) {
              try {
                await camOn.click({timeout: 2000});
                this.videoCheckedInCall = true;
              } catch {
                // retry on next inspect tick
              }
            }
          }
        }
        if (!this.chatSent && this.chatAttempts < 8) {
          this.chatAttempts += 1;
          await this.sendChatIntro();
        }
        if (!this.rosterOpened && (this.chatSent || !this.bootstrap.chat_intro?.trim() || this.chatAttempts >= 3)) {
          this.rosterOpened = true;
          const toggle = this.page.getByRole('button', {
            name: /^(?:People|Participants|Show participants|Teilnehmer|Personen|Teilnehmer anzeigen)(?:\b|\s|$)/i,
          }).and(this.page.locator('[aria-expanded="false"], [aria-pressed="false"]')).first();
          if (await toggle.isVisible().catch(() => false)) {
            await toggle.click({timeout: 2000}).catch(() => {});
          }
        } else if (this.rosterOpened && this.chatSent && Boolean(this.bootstrap.chat_intro?.trim()) && !this.chatRestored) {
          this.chatRestored = true;
          const chatToggle = this.page.getByRole('button', {
            name: /^(?:Chat|Show conversation|Unterhaltung anzeigen)(?:\b|\s|$)/i,
          }).and(this.page.locator('[aria-expanded="false"], [aria-pressed="false"]')).first();
          if (await chatToggle.isVisible().catch(() => false)) {
            await chatToggle.click({timeout: 2000}).catch(() => {});
          }
        }
      } else {
        participation = 'waiting_admission';
      }
    }
    return {...state, participation: this.stopping ? 'ended' : participation,
      reason: this.reason, stopped: Boolean(this.stopping || this.reason), drained: this.drained,
      capability: 'unverified', streams: state?.streams ?? 0, audio_samples: state?.audio_samples ?? 0,
      active_audio_samples: state?.active_audio_samples ?? 0,
      receiver_sources: state?.receiver_sources ?? [],
      configured_speaker_slots: null, configured_share_slots: null,
      participant_sources: state?.participant_sources ?? {available: false, total: 0, truncated: false, sources: []},
      data_channels: state?.data_channels ?? [],
      sdp: state?.sdp ?? {descriptions: 0, audio_sections: 0, video_sections: 0, ssrc_count: 0, cname_count: 0, msid_count: 0}};
  }

  stop(reason: string) {
    return this.stopping ??= (async () => {
      this.reason ||= reason === 'normal' ? '' : reason;
      const ended = await this.page.evaluate(() => {
        window.wortlautVideoTile?.stop();
        return window.wortlautMeet?.stop();
      }).catch(() => false);
      this.drained = await this.transport.drain() && ended === true;
      if (!isTeamsOrigin(new URL(this.page.url()))) return;
      const leave = this.page.getByRole('button', {name: leaveLabel}).first();
      if (await leave.isVisible()) await leave.click({timeout: 5000}).catch(() => {});
    })();
  }
}
