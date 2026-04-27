// Local release helper: downloads the latest decrypted YouTube IPA from
// decrypt.day using YOUR logged-in browser session, stages it on a hidden
// pre-release of the fork, and triggers the build+publish workflow.
//
// Run from the repo root:    node scripts/local-release.mjs
//
// First run: a Chromium window opens. Log in to decrypt.day manually, then
// press Enter in the terminal. Cookies persist in ~/.cache/uyou-scraper/profile,
// so subsequent runs are fully unattended.

import { chromium } from "playwright";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";

const APP_URL = "https://decrypt.day/app/id544007664";
const RELEASE_TAG = "_youtube-source";
const PROFILE_DIR = path.join(homedir(), ".cache", "uyou-scraper", "profile");
const DOWNLOADS_DIR = path.join(homedir(), ".cache", "uyou-scraper", "downloads");

mkdirSync(PROFILE_DIR, { recursive: true });
mkdirSync(DOWNLOADS_DIR, { recursive: true });

const REPO = detectRepo();
console.log(`▶ Repo: ${REPO}`);

const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  acceptDownloads: true,
  viewport: { width: 1280, height: 900 },
});

let downloadedPath;
try {
  const page = browser.pages()[0] || (await browser.newPage());
  console.log(`▶ Opening ${APP_URL}`);
  await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

  if (await isLoggedOut(page)) {
    console.log("");
    console.log("  ⚠ Not logged in. Please log in via the browser window.");
    console.log("  When you're back on the YouTube app page, press Enter here.");
    console.log("");
    await waitForEnter();
    await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    if (await isLoggedOut(page)) {
      console.error("✗ Still appears logged out. Aborting.");
      process.exit(1);
    }
  }

  console.log("▶ Logged in. Looking for download trigger...");
  const directIpa = await page.$('a[href*=".ipa"]');
  let download;
  if (directIpa) {
    const href = await directIpa.getAttribute("href");
    console.log(`  Direct .ipa link: ${href}`);
    [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      directIpa.click(),
    ]);
  } else {
    const button = await page.$(
      'button:has-text("Download"), a:has-text("Download"), button:has-text("Get IPA"), a:has-text("Get IPA")'
    );
    if (!button) {
      console.error("✗ No download link or button found on page.");
      console.error("  Check the open browser window — what does the download UI look like?");
      console.error("  Press Enter to keep the window open for 5 minutes for inspection.");
      await waitForEnter();
      await new Promise((r) => setTimeout(r, 300_000));
      process.exit(2);
    }
    console.log(`  Clicking: ${await button.evaluate((el) => el.outerHTML.slice(0, 100))}`);
    [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 120_000 }),
      button.click(),
    ]);
  }

  const filename = download.suggestedFilename() || "YouTube.ipa";
  downloadedPath = path.join(DOWNLOADS_DIR, filename);
  console.log(`▶ Downloading to ${downloadedPath} (this can take a few minutes)`);
  await download.saveAs(downloadedPath);
  const sizeMb = (statSync(downloadedPath).size / 1024 / 1024).toFixed(1);
  console.log(`✓ Downloaded ${sizeMb} MB`);
} finally {
  await browser.close();
}

console.log(`▶ Ensuring pre-release tag '${RELEASE_TAG}' exists on ${REPO}`);
const view = spawnSync("gh", ["release", "view", RELEASE_TAG, "--repo", REPO], {
  stdio: ["ignore", "ignore", "pipe"],
});
if (view.status !== 0) {
  console.log(`  Creating pre-release tag '${RELEASE_TAG}'`);
  execFileSync(
    "gh",
    [
      "release",
      "create",
      RELEASE_TAG,
      "--repo",
      REPO,
      "--prerelease",
      "--title",
      "Internal: source IPA cache",
      "--notes",
      "Transient cache used by scripts/local-release.mjs to hand off the decrypted YouTube IPA to the buildapp.yml workflow. Not a real release.",
    ],
    { stdio: "inherit" }
  );
}

console.log(`▶ Uploading IPA as release asset (overwriting previous)`);
execFileSync(
  "gh",
  ["release", "upload", RELEASE_TAG, downloadedPath, "--repo", REPO, "--clobber"],
  { stdio: "inherit" }
);

const filename = path.basename(downloadedPath);
const assetUrl = `https://github.com/${REPO}/releases/download/${RELEASE_TAG}/${encodeURIComponent(filename)}`;
console.log(`✓ Asset URL: ${assetUrl}`);

console.log(`▶ Triggering buildapp.yml`);
execFileSync(
  "gh",
  [
    "workflow",
    "run",
    "buildapp.yml",
    "--repo",
    REPO,
    "--ref",
    "main",
    "-f",
    `decrypted_youtube_url=${assetUrl}`,
  ],
  { stdio: "inherit" }
);
console.log(`✓ Triggered. Watch at: https://github.com/${REPO}/actions/workflows/buildapp.yml`);

// ---------- helpers ----------

function detectRepo() {
  const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  // Handles git@github.com:owner/repo.git and https://github.com/owner/repo(.git)
  const match = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match) {
    console.error(`✗ Could not parse repo from origin URL: ${url}`);
    process.exit(3);
  }
  return match[1];
}

async function isLoggedOut(page) {
  // decrypt.day shows "Login" / "Login to your account" prominently when logged out.
  // When logged in, those disappear. Cheap heuristic: title or URL contains 'login'.
  const title = (await page.title()).toLowerCase();
  if (title.includes("login")) return true;
  if (page.url().includes("/login")) return true;
  // Also check for a visible Login link (top-nav).
  const loginLink = await page.$('a[href*="/login"]:visible, a:has-text("Login"):visible');
  return !!loginLink;
}

function waitForEnter() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("", () => {
      rl.close();
      resolve();
    });
  });
}
