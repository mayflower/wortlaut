import {chromium} from 'playwright';
import {addExtra} from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Keep Webex's SDK environment unchanged; Meet uses full Chromium with the
// plugin's browser-surface adjustments. This does not guarantee admission.
export async function launchBrowser(provider: 'google_meet' | 'webex', locale = 'en-US') {
  let launcher = chromium;
  if (provider === 'google_meet') {
    const extra = addExtra(chromium);
    // Preserve the real OS and context locale instead of claiming Windows/en-US.
    extra.plugins.setDependencyDefaults('stealth/evasions/user-agent-override', {maskLinux: false, locale});
    extra.plugins.setDependencyDefaults('stealth/evasions/navigator.languages', {
      languages: [...new Set([locale, locale.split('-')[0]])],
    });
    extra.use(StealthPlugin());
    launcher = extra;
  }
  return launcher.launch({headless: true, chromiumSandbox: true,
    ...(provider === 'google_meet' ? {channel: 'chromium'} : {}),
    args: ['--autoplay-policy=no-user-gesture-required']});
}
