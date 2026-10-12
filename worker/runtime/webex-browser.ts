import type {Frame, Locator, Page} from 'playwright';
import {AudioTransport} from '../src/transport.js';
import {installMeetCapture, MeetError} from './meet.js';

export type WebexBrowserBootstrap = {provider: 'webex'; meeting_id: string; attempt_id: string;
  meeting_url: string; deadline: string; lobby_timeout_seconds: number;
  webex_browser: {display_name: string}};

// Webex's join-service page embeds the web meeting client at this exact origin.
// Do not interact with arbitrary login, help or advertisement frames.
export class WebexBrowser {
  private readonly transport: AudioTransport;
  private initialize?: () => Promise<void>;
  private stopping?: Promise<void>;
  private reason = '';
  private joined = false;
  private drained: boolean | null = null;

  constructor(private readonly page: Page, private readonly bootstrap: WebexBrowserBootstrap,
    api: string, credential: string, workerId: string, private readonly assets?: URL) {
    const url = new URL(`/v1/attempts/${bootstrap.attempt_id}/audio`, api);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.transport = new AudioTransport(url.href, credential, workerId, reason => { this.reason = reason; });
  }

  private frame(): Frame | undefined {
    return this.page.frames().find(frame =>
      /^https:\/\/web\.webex\.com\/meeting(?:[?#]|$)/.test(frame.url()));
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
      end: metadata => this.transport.control(metadata as Record<string, unknown> & {id: string}),
      gap: metadata => this.transport.control(metadata as Record<string, unknown> & {id: string}),
      chunk: (metadata, pcm) => this.transport.chunk(metadata, pcm),
      error: reason => { this.reason = reason; },
    }, this.assets, 'webex');
    this.transport.connect();
  }

  async join() {
    const until = Date.now() + 60000;
    while (!this.frame() && Date.now() < until && !this.stopping) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (this.stopping) return;
    const frame = this.frame();
    if (!frame) throw new MeetError('webex_frame_missing');
    const name = frame.getByRole('textbox', {name: /^(Name|Your name|Ihr Name)$/i});
    await name.waitFor({state: 'visible', timeout: 60000});
    await this.initialize?.();
    for (const label of [/^(Reject|Ablehnen)$/i,
      /^(Continue without microphone and camera|Ohne Mikrofon und Kamera fortfahren)$/i]) {
      const button = frame.getByRole('button', {name: label});
      if (await button.isVisible()) {
        await this.click(button);
        await button.waitFor({state: 'hidden', timeout: 5000});
      }
    }
    await name.fill(this.bootstrap.webex_browser.display_name);
    // Both send controls must visibly be off before requesting admission.
    await frame.getByRole('button', {name: /^Microphone is currently muted|^Mikrofon.*stummgeschaltet/i})
      .waitFor({state: 'visible', timeout: 10000});
    await frame.getByRole('button', {name: /^Sending video is currently disabled|^Video.*deaktiviert/i})
      .waitFor({state: 'visible', timeout: 10000});
    if (this.stopping) return;
    const join = frame.getByRole('button', {name: /^(Join meeting|Meeting beitreten)(?:\s|$)/i});
    await this.click(join);
    this.joined = true;
  }

  async inspect() {
    const frame = this.frame();
    const state = await frame?.evaluate(() => window.wortlautMeet?.inspect()).catch(() => undefined);
    if (state?.reason) this.reason = state.reason;
    const text = await frame?.locator('body').ariaSnapshot().catch(() => '') ?? '';
    let participation = 'joining';
    if (/waiting for (?:the )?host|host.*(?:let you in|admit)|wait.*lobby|Warten.*Gastgeber/i.test(text)) {
      participation = 'waiting_admission';
    } else if (this.joined && frame && await frame.getByRole('button', {
      name: /^(Leave meeting|Leave|Meeting verlassen|Verlassen)(?:\s|$)/i,
    }).first().isVisible()) participation = 'capturing';
    if (/meeting (?:has )?ended|Meeting.*beendet/i.test(text)) this.reason = 'meeting_ended';
    if (/host.*denied|not allowed to join|Beitritt.*abgelehnt/i.test(text)) this.reason = 'admission_denied';
    return {...state, capability: 'unverified', participation: this.stopping ? 'ended' : participation,
      reason: this.reason, stopped: Boolean(this.stopping || this.reason), drained: this.drained,
      streams: state?.streams ?? 0, audio_samples: state?.audio_samples ?? 0,
      receiver_sources: state?.receiver_sources ?? [], configured_speaker_slots: null,
      configured_share_slots: null, participant_sources: {available: false, total: 0, truncated: false, sources: []}};
  }

  stop(reason: string) {
    return this.stopping ??= (async () => {
      this.reason ||= reason === 'normal' ? '' : reason;
      const frame = this.frame();
      const ended = await frame?.evaluate(() => window.wortlautMeet?.stop()).catch(() => false);
      this.drained = await this.transport.drain() && ended === true;
      const leave = frame?.getByRole('button', {name: /^(Leave meeting|Leave|Meeting verlassen|Verlassen)(?:\s|$)/i}).first();
      if (leave && await leave.isVisible()) await this.click(leave).catch(() => {});
    })();
  }
}
