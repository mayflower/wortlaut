import type {Frame, Locator, Page} from 'playwright';
import {AudioTransport} from '../src/transport.js';
import {installMeetCapture, MeetError} from './meet.js';

export type WebexBrowserBootstrap = {provider: 'webex'; meeting_id: string; attempt_id: string;
  meeting_url: string; deadline: string; lobby_timeout_seconds: number;
  empty_room_timeout_seconds?: number; chat_intro?: string | null;
  webex_browser: {display_name: string}};

// Webex's join-service page embeds the web meeting client at this exact origin.
// Do not interact with arbitrary login, help or advertisement frames.
export class WebexBrowser {
  private readonly transport: AudioTransport;
  private initialize?: () => Promise<void>;
  private stopping?: Promise<void>;
  private reason = '';
  private joined = false;
  private chatSent = false;
  private chatAttempts = 0;
  private rosterOpened = false;
  private drained: boolean | null = null;

  constructor(private readonly page: Page, private readonly bootstrap: WebexBrowserBootstrap,
    api: string, credential: string, workerId: string, private readonly assets?: URL) {
    const url = new URL(`/v1/attempts/${bootstrap.attempt_id}/audio`, api);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.transport = new AudioTransport(url.href, credential, workerId, reason => { this.reason = reason; });
  }

  private frame(): Frame | undefined {
    const frames = this.page.frames().filter(frame =>
      /^https:\/\/web\.webex\.com\/(?:meeting|guest-join-meeting)(?:[?#]|$)/.test(frame.url()) &&
      !frame.url().includes('preload=true'));
    return frames[frames.length - 1];
  }

  private async click(button: Locator) {
    await button.waitFor({state: 'visible', timeout: 10000});
    if (!await button.isEnabled()) throw new MeetError('webex_action_disabled');
    // Webex custom elements in the cross-origin client accept DOM activation.
    // Each join step below also verifies its resulting visible state.
    await button.evaluate(element => (element as HTMLElement).click());
  }

  async prepare() {
    this.initialize = await installMeetCapture(this.page, this.bootstrap, {
      begin: metadata => this.transport.control(metadata as Record<string, unknown> & {id: string}),
      bind: metadata => this.transport.control(metadata as Record<string, unknown> & {id: string}),
      end: metadata => this.transport.control(metadata as Record<string, unknown> & {id: string}),
      gap: metadata => this.transport.control(metadata as Record<string, unknown> & {id: string}),
      chunk: (metadata, pcm) => this.transport.chunk(metadata, pcm),
      error: reason => { this.reason = reason; },
    }, this.assets, 'webex');
    this.transport.connect();
  }

  async join() {
    const until = Date.now() + 60000;
    while (Date.now() < until && !this.stopping) {
      const candidate = this.frame();
      if (candidate && await candidate.getByRole('textbox', {name: /^(Name|Your name|Ihr Name)$/i}).isVisible().catch(() => false)) {
        break;
      }
      const joinBrowser = this.page.locator('#broadcom-center-right, #push_download_join_by_browser')
        .or(this.page.getByRole('button', {
          name: /^(Join from (?:this|your) browser|Join from browser|Über diesen Browser beitreten|Im Browser beitreten)$/i,
        }));
      if (await joinBrowser.first().isVisible().catch(() => false)) {
        await joinBrowser.first().evaluate(el => (el as HTMLElement).click()).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (this.stopping) return;
    const frame = this.frame();
    if (!frame) throw new MeetError('webex_frame_missing');
    const name = frame.getByRole('textbox', {name: /^(Name|Your name|Ihr Name)$/i});
    await name.waitFor({state: 'visible', timeout: 60000});
    await this.initialize?.();
    for (const label of [/^(Reject|Ablehnen)$/i,
      /^(Continue without microphone and camera|Ohne Mikrofon und Kamera fortfahren)$/i,
      /^(Continue without microphone|Ohne Mikrofon fortfahren)$/i]) {
      const button = frame.getByRole('button', {name: label});
      if (await button.isVisible()) {
        await this.click(button);
        await button.waitFor({state: 'hidden', timeout: 5000});
      }
    }
    await name.fill(this.bootstrap.webex_browser.display_name);
    // Both send controls must visibly be off before requesting admission.
    await frame.getByRole('button', {name: /^(?:Your )?microphone is currently muted|^(?:Ihr )?Mikrofon.*stummgeschaltet/i})
      .waitFor({state: 'visible', timeout: 10000});
    await frame.getByRole('button', {name: /^Sending video is currently disabled|^(?:Senden von )?Video.*deaktiviert/i})
      .waitFor({state: 'visible', timeout: 10000});
    if (this.stopping) return;
    const join = frame.getByRole('button', {name: /^(?:Join meeting(?:\s|$)|Meeting\b.*beitreten)/i});
    await this.click(join);
    this.joined = true;
  }

  private async sendChatIntro(frame: Frame) {
    const text = this.bootstrap.chat_intro?.trim();
    if (!text) {
      this.chatSent = true;
      return;
    }
    try {
      const chatBox = frame.getByRole('textbox', {
        name: /write a message|send a message|enter message|nachricht.*eingeben|nachricht.*schreiben|chat/i,
      }).or(frame.locator('textarea[placeholder*="message" i], textarea[placeholder*="Nachricht" i]'));
      if (!await chatBox.first().isVisible().catch(() => false)) {
        const chatToggle = frame.getByRole('button', {
          name: /^(?:Chat|Open chat|Show chat|Chat öffnen|Chatbereich öffnen|Chat anzeigen)(?:\b|\s|$)/i,
        }).and(frame.locator(':not([aria-expanded="true"]):not([aria-pressed="true"])')).first();
        if (!await chatToggle.isVisible().catch(() => false)) return;
        await this.click(chatToggle).catch(() => {});
        await chatBox.first().waitFor({state: 'visible', timeout: 2500}).catch(() => {});
      }
      if (!await chatBox.first().isVisible().catch(() => false)) return;
      await chatBox.first().fill(text, {timeout: 2500});
      await chatBox.first().press('Enter', {timeout: 2000}).catch(() => {});
      this.chatSent = true;
    } catch { /* chat intro is non-critical */ }
  }

  async inspect() {
    const frame = this.frame();
    const state = await frame?.evaluate(() => window.wortlautMeet?.inspect()).catch(() => undefined);
    if (state?.reason) this.reason = state.reason;
    const text = await frame?.locator('body').ariaSnapshot().catch(() => '') ?? '';
    let participation = 'joining';
    if (/waiting for (?:the )?host|host.*(?:let you in|admit)|wait.*lobby|in the lobby|Lobby des Meetings|bis der Host Sie einlässt|Warten.*(?:Gastgeber|Host)/i.test(text)) {
      participation = 'waiting_admission';
    } else if (!/Verbindung wird hergestellt|Connecting/i.test(text) && this.joined && frame && await frame.getByRole('button', {
      name: /^(Leave meeting|Leave|Meeting verlassen|Meeting verlassen oder Meeting für alle beenden|Verlassen)(?:\s|$)/i,
    }).first().isVisible()) {
      participation = 'capturing';
      if (!this.chatSent && this.chatAttempts < 8) {
        this.chatAttempts += 1;
        await this.sendChatIntro(frame);
      }
      if (!this.rosterOpened && (this.chatSent || !this.bootstrap.chat_intro?.trim() || this.chatAttempts >= 3)) {
        this.rosterOpened = true;
        const toggle = frame.getByRole('button', {
          name: /^(?:Participants|Show participants|Open participants|People|Teilnehmer|Teilnehmer anzeigen|Teilnehmerbereich öffnen|Personen)(?:\b|\s|$)/i,
        }).and(frame.locator(':not([aria-expanded="true"]):not([aria-pressed="true"])')).first();
        if (await toggle.isVisible().catch(() => false)) {
          await this.click(toggle).catch(() => {});
        }
      }
    }
    if (/meeting (?:has )?ended|Meeting.*beendet/i.test(text)) this.reason = 'meeting_ended';
    if (/host.*denied|not allowed to join|Beitritt.*abgelehnt/i.test(text)) this.reason = 'admission_denied';
    return {...state, capability: 'unverified', participation: this.stopping ? 'ended' : participation,
      reason: this.reason, stopped: Boolean(this.stopping || this.reason), drained: this.drained,
      streams: state?.streams ?? 0, audio_samples: state?.audio_samples ?? 0,
      active_audio_samples: state?.active_audio_samples ?? 0,
      receiver_sources: state?.receiver_sources ?? [], configured_speaker_slots: null,
      configured_share_slots: null,
      participant_sources: state?.participant_sources ?? {available: false, total: 0, truncated: false, sources: []},
      data_channels: state?.data_channels ?? [],
      sdp: state?.sdp ?? {descriptions: 0, audio_sections: 0, video_sections: 0, ssrc_count: 0, cname_count: 0, msid_count: 0}};
  }

  stop(reason: string) {
    return this.stopping ??= (async () => {
      this.reason ||= reason === 'normal' ? '' : reason;
      const frame = this.frame();
      const ended = await frame?.evaluate(() => window.wortlautMeet?.stop()).catch(() => false);
      this.drained = await this.transport.drain() && ended === true;
      const leave = frame?.getByRole('button', {
        name: /^(Leave meeting|Leave|Meeting verlassen|Meeting verlassen oder Meeting für alle beenden|Verlassen)(?:\s|$)/i,
      }).first();
      if (leave && await leave.isVisible()) {
        await this.click(leave).catch(() => {});
        const confirmLeave = frame?.getByRole('button', {name: /^(Leave meeting|Meeting verlassen)$/i}).first();
        if (confirmLeave && await confirmLeave.isVisible().catch(() => false)) {
          await this.click(confirmLeave).catch(() => {});
        }
      }
    })();
  }
}
