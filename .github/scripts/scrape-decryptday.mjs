// Resolve the latest decrypted YouTube .ipa URL from decrypt.day.
//
// decrypt.day requires:
//   1. Cloudflare's JS challenge to clear (handled by running real Chromium).
//   2. A logged-in account to expose download URLs (we use email+password).
//
// Output (stdout, GITHUB_OUTPUT format):
//   url=https://...ipa
//   version=21.16.2
// Diagnostic logs and screenshots go to stderr / $RUNNER_TEMP/scraper/*.png.
// Exits non-zero on any failure (caller MUST fail loud).

import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const APP_URL = "https://decrypt.day/app/id544007664";
const LOGIN_URL = "https://decrypt.day/login";
const NAV_TIMEOUT = 60_000;
const CF_TIMEOUT = 60_000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const EMAIL = process.env.DECRYPTDAY_EMAIL;
const PASSWORD = process.env.DECRYPTDAY_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error("[scrape-decryptday] FATAL: DECRYPTDAY_EMAIL and DECRYPTDAY_PASSWORD env vars are required");
  process.exit(1);
}

const log = (...args) => console.error("[scrape-decryptday]", ...args);

// Drop a screenshot + HTML snapshot so we can debug what the headless browser saw.
async function snapshot(page, name) {
  const pngPath = `${process.env.RUNNER_TEMP || "/tmp"}/scraper/${name}.png`;
  const htmlPath = `${process.env.RUNNER_TEMP || "/tmp"}/scraper/${name}.html`;
  try {
    await page.screenshot({ path: pngPath, fullPage: true });
    writeFileSync(htmlPath, await page.content());
    log(`  snapshot saved: ${pngPath} + ${htmlPath}`);
  } catch (e) {
    log(`  snapshot failed: ${e.message}`);
  }
}

async function clearCloudflare(page, label) {
  log(`Waiting for Cloudflare challenge to clear (${label})...`);
  await page.waitForFunction(() => !/just a moment/i.test(document.title), null, { timeout: CF_TIMEOUT });
  log(`  page title: ${await page.title()}`);
}

async function login(page) {
  log(`Navigating to ${LOGIN_URL}`);
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
  await clearCloudflare(page, "login page");
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

  // Find email/password inputs defensively — try multiple common selectors.
  const emailSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
    'input[id*="email" i]',
    'input[name*="email" i]',
    'input[placeholder*="email" i]',
  ];
  const passwordSelectors = [
    'input[type="password"]',
    'input[name="password"]',
    'input[autocomplete="current-password"]',
    'input[id*="password" i]',
  ];

  let emailField, passwordField;
  for (const sel of emailSelectors) {
    const handle = await page.$(sel);
    if (handle) {
      emailField = handle;
      log(`  email field: ${sel}`);
      break;
    }
  }
  for (const sel of passwordSelectors) {
    const handle = await page.$(sel);
    if (handle) {
      passwordField = handle;
      log(`  password field: ${sel}`);
      break;
    }
  }

  if (!emailField || !passwordField) {
    log("FATAL: could not locate email/password fields on login page");
    await snapshot(page, "login-page-no-fields");
    process.exit(3);
  }

  await emailField.fill(EMAIL);
  await passwordField.fill(PASSWORD);

  // Submit. Try clicking a likely button; fall back to Enter.
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Login")',
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
    'button:has-text("Sign In")',
  ];
  let submitted = false;
  for (const sel of submitSelectors) {
    const handle = await page.$(sel);
    if (handle) {
      log(`  submitting via: ${sel}`);
      await Promise.all([
        page.waitForNavigation({ timeout: NAV_TIMEOUT, waitUntil: "domcontentloaded" }).catch(() => {}),
        handle.click(),
      ]);
      submitted = true;
      break;
    }
  }
  if (!submitted) {
    log("  no submit button found; pressing Enter on password field");
    await Promise.all([
      page.waitForNavigation({ timeout: NAV_TIMEOUT, waitUntil: "domcontentloaded" }).catch(() => {}),
      passwordField.press("Enter"),
    ]);
  }

  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  log(`  post-login URL: ${page.url()}`);
  log(`  post-login title: ${await page.title()}`);

  // Heuristic: if we're still on /login or the page contains the password field,
  // login likely failed.
  if (/\/login(\?|$|#)/.test(page.url())) {
    log("FATAL: still on /login after submit — credentials likely rejected");
    await snapshot(page, "login-failed");
    process.exit(4);
  }
  log("  login appears successful");
}

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 1600 } });
  const page = await ctx.newPage();

  await login(page);

  log(`Navigating to ${APP_URL}`);
  await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
  await clearCloudflare(page, "app page");
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

  // Look for IPA links. Cast wide net: direct .ipa anchors, anchors with download-y text,
  // and any anchors pointing to known CDN-ish patterns.
  const candidates = await page.evaluate(() => {
    const anchors = [...document.querySelectorAll("a[href]")];
    const matches = [];
    for (const a of anchors) {
      const href = a.href;
      const text = (a.textContent || "").trim();
      const isIpa = /\.ipa(\?|#|$)/i.test(href);
      const looksLikeDownload =
        /download|get.*ipa|ipa.*download|direct/i.test(text) ||
        /download|cdn|files|storage/i.test(href);
      if (isIpa || (looksLikeDownload && /^https?:/i.test(href))) {
        // Capture nearby version-looking text from ancestor row.
        let el = a;
        const ctxText = [];
        for (let i = 0; i < 4 && el; i++) {
          ctxText.push((el.textContent || "").replace(/\s+/g, " ").trim());
          el = el.parentElement;
        }
        matches.push({ href, text, isIpa, context: ctxText.join(" | ").slice(0, 600) });
      }
    }
    return matches;
  });

  log(`Found ${candidates.length} candidate link(s):`);
  for (const c of candidates) log(`  - [ipa=${c.isIpa}] "${c.text}" -> ${c.href}`);

  // Prefer direct .ipa links; fall back to other download-looking links.
  const ipaLinks = candidates.filter((c) => c.isIpa);
  const pick = ipaLinks[0] || candidates[0];

  if (!pick) {
    log("FATAL: no download link found on logged-in app page");
    log(`  body text (first 1500 chars): ${(await page.textContent("body"))?.slice(0, 1500)}`);
    await snapshot(page, "app-page-no-download");
    process.exit(2);
  }

  // Pull the version from the candidate's surrounding text.
  const versionMatch = pick.context.match(/\b(\d+\.\d+(?:\.\d+){0,2})\b/);
  const version = versionMatch ? versionMatch[1] : "unknown";

  // Final outputs to stdout for $GITHUB_OUTPUT.
  process.stdout.write(`url=${pick.href}\n`);
  process.stdout.write(`version=${version}\n`);
  log(`Selected: url=${pick.href}, version=${version}`);
} finally {
  await browser.close();
}
