// Resolve the latest decrypted YouTube .ipa URL from decrypt.day.
//
// decrypt.day sits behind Cloudflare's JS challenge, so a plain HTTP fetch
// gets a 403 "Just a moment..." page. We launch Chromium via Playwright,
// let CF's challenge run, then read the rendered DOM.
//
// Output (stdout, GITHUB_OUTPUT format):
//   url=https://...ipa
//   version=21.16.2
// Diagnostic logs go to stderr.
// Exits non-zero on any failure (caller MUST fail loud, not fall through).

import { chromium } from "playwright";

const TARGET_URL = "https://decrypt.day/app/id544007664";
const NAV_TIMEOUT_MS = 60_000;
const CF_TIMEOUT_MS = 60_000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const log = (...args) => console.error("[scrape-decryptday]", ...args);

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  log(`Navigating to ${TARGET_URL}`);
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

  // Cloudflare interstitial sets <title>Just a moment...</title> until cleared.
  log("Waiting for Cloudflare challenge to clear...");
  await page.waitForFunction(
    () => !/just a moment/i.test(document.title),
    null,
    { timeout: CF_TIMEOUT_MS },
  );
  log(`Page title: ${await page.title()}`);

  // Give the SPA a beat to render version rows.
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

  const ipaLinks = await page.evaluate(() => {
    const anchors = [...document.querySelectorAll("a[href]")];
    const ipa = anchors.filter((a) => /\.ipa(\?|#|$)/i.test(a.href));
    return ipa.map((a) => {
      // Climb up a few ancestors to capture nearby version text.
      let el = a;
      const ctx = [];
      for (let i = 0; i < 4 && el; i++) {
        ctx.push((el.textContent || "").replace(/\s+/g, " ").trim());
        el = el.parentElement;
      }
      return { url: a.href, context: ctx.join(" | ").slice(0, 600) };
    });
  });

  if (ipaLinks.length === 0) {
    log("No .ipa anchors found. Dumping diagnostics:");
    log(`  body text (first 1500 chars): ${(await page.textContent("body"))?.slice(0, 1500)}`);
    const allHrefs = await page.evaluate(() =>
      [...document.querySelectorAll("a[href]")].slice(0, 50).map((a) => a.href),
    );
    log(`  first 50 anchors: ${JSON.stringify(allHrefs, null, 2)}`);
    process.exit(2);
  }

  log(`Found ${ipaLinks.length} .ipa link(s). Listing all (newest-first assumed):`);
  for (const l of ipaLinks) log(`  - ${l.url}   [${l.context.slice(0, 120)}...]`);

  // decrypt.day lists newest first; take the topmost.
  const top = ipaLinks[0];
  const versionMatch = top.context.match(/\b(\d+\.\d+(?:\.\d+){0,2})\b/);
  const version = versionMatch ? versionMatch[1] : "unknown";

  // GITHUB_OUTPUT format on stdout:
  process.stdout.write(`url=${top.url}\n`);
  process.stdout.write(`version=${version}\n`);
  log(`Selected: url=${top.url}, version=${version}`);
} finally {
  await browser.close();
}
