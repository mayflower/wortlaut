import type {Page} from 'playwright';
import {AudioTransport} from '../src/transport.js';
import {installMeetCapture, MeetError} from './meet.js';
import {isTeamsOrigin} from '../src/teams-url.js';

export type TeamsBootstrap = {provider: 'teams'; meeting_id: string; attempt_id: string;
  meeting_url: string; deadline: string; lobby_timeout_seconds: number;
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
  private joined = false;
  private drained: boolean | null = null;

  constructor(private readonly page: Page, private readonly bootstrap: TeamsBootstrap,
    api: string, credential: string, workerId: string, private readonly assets?: URL) {
    const url = new URL(`/v1/attempts/${bootstrap.attempt_id}/audio`, api);
    if (!['https:', 'http:'].includes(url.protocol)) throw new MeetError('invalid_ingest_url');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.transport = new AudioTransport(url.href, credential, workerId, reason => { this.reason = reason; });
  }

  async prepare() {
    this.initialize = await installMeetCapture(this.page, this.bootstrap, {
      begin: metadata => this.transport.control(metadata as Record<string, unknown> & {id: string}),
      end: metadata => this.transport.control(metadata as Record<string, unknown> & {id: string}),
      gap: metadata => this.transport.control(metadata as Record<string, unknown> & {id: string}),
      chunk: (metadata, pcm) => this.transport.chunk(metadata, pcm),
      error: reason => { this.reason = reason; },
    }, this.assets, 'teams');
    this.transport.connect();
  }

  private async dismissMediaPrompt() {
    const button = this.page.getByRole('button', {
      name: /^(Continue without audio or video|Continue without audio and video|Ohne Audio oder Video fortfahren|Ohne Audio und Video fortfahren)$/i,
    });
    if (await button.isVisible()) {
      await button.click({timeout: 5000});
      return true;
    }
    return false;
  }

  private async disableDevices() {
    for (const kind of ['microphone', 'camera'] as const) {
      const control = this.page.locator(kind === 'microphone'
        ? '#microphone-button, [data-tid="toggle-mute"]'
        : '#video-button, [data-tid="toggle-video"]');
      const offAction = this.page.getByRole('button', {name: kind === 'microphone'
        ? /^(Mute|Turn off microphone|Mikrofon ausschalten|Stummschalten)(?: \(.*\))?$/i
        : /^(Turn off camera|Turn camera off|Turn off video|Turn video off|Kamera ausschalten)(?: \(.*\))?$/i});
      if (await offAction.first().isVisible()) await offAction.first().click();
      else if (await control.first().isVisible()) {
        const checked = await control.first().getAttribute('aria-checked');
        const pressed = await control.first().getAttribute('aria-pressed');
        if (checked === 'true' || pressed === 'true') await control.first().click();
      }
    }
    // Check the actual senders as well as the UI controls.
    if (await this.page.evaluate(() => [...(window.wortlautMeetReceivers?.connections ?? [])]
      .some(pc => pc.getSenders().some(sender => sender.track?.readyState === 'live' && sender.track.enabled)))) {
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
      if (await browser.first().isVisible()) {
        await browser.first().click();
        continue;
      }
      const dismissed = await this.dismissMediaPrompt();
      const name = this.page.getByRole('textbox', {
        name: /^(Type your name|Enter name|Your name|Name|Geben Sie Ihren Namen ein|Namen eingeben|Ihr Name)$/i,
      }).or(this.page.locator('input[data-tid="prejoin-display-name-input"]'));
      if (await name.first().isVisible() && !this.joined) {
        await this.initialize?.();
        await name.first().fill(this.bootstrap.teams.display_name);
        const computer = this.page.getByRole('radio', {name: /^(Computer audio|Computeraudio)(?:\s|$)/i});
        if (await computer.isVisible()) await computer.check();
        const speakerOn = this.page.getByRole('button', {
          name: /^(Turn speaker on|Speaker is off|Lautsprecher einschalten)(?:\s|$)/i,
        });
        if (await speakerOn.first().isVisible()) await speakerOn.first().click();
        const noAudio = this.page.getByRole('radio', {
          name: /^(Don't use audio|Kein Audio verwenden)(?:\s|$)/i,
        });
        if (await noAudio.isVisible() && await noAudio.isChecked()) {
          throw new MeetError('teams_receive_audio_disabled');
        }
        await this.disableDevices();
        const join = this.page.getByRole('button', {name: joinLabel});
        if (await join.isEnabled()) {
          await join.click();
          this.joined = true;
        }
      } else if (this.joined && dismissed) {
        const join = this.page.getByRole('button', {name: joinLabel});
        if (await join.isVisible() && await join.isEnabled()) await join.click();
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!this.stopping) throw new MeetError('teams_prejoin_timeout');
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
    let participation = 'joining';
    if (waiting.test(text)) participation = 'waiting_admission';
    else if (trusted && this.joined && !await this.page.getByRole('button', {name: joinLabel}).isVisible()
      && await this.page.getByRole('button', {name: leaveLabel}).first().isVisible()) participation = 'capturing';
    return {...state, participation: this.stopping ? 'ended' : participation,
      reason: this.reason, stopped: Boolean(this.stopping || this.reason), drained: this.drained,
      capability: 'unverified', streams: state?.streams ?? 0, audio_samples: state?.audio_samples ?? 0,
      receiver_sources: state?.receiver_sources ?? [],
      configured_speaker_slots: null, configured_share_slots: null,
      participant_sources: {available: false, total: 0, truncated: false, sources: []}};
  }

  stop(reason: string) {
    return this.stopping ??= (async () => {
      this.reason ||= reason === 'normal' ? '' : reason;
      const ended = await this.page.evaluate(() => window.wortlautMeet?.stop()).catch(() => false);
      this.drained = await this.transport.drain() && ended === true;
      if (!isTeamsOrigin(new URL(this.page.url()))) return;
      const leave = this.page.getByRole('button', {name: leaveLabel}).first();
      if (await leave.isVisible()) await leave.click({timeout: 5000}).catch(() => {});
    })();
  }
}
