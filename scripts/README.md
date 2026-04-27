# Local release helper

Grabs the latest decrypted YouTube IPA from `decrypt.day` using **your** logged-in browser session, stages it on a hidden pre-release of this fork, and triggers `buildapp.yml` to build + publish the uYouPlus IPA.

## Why local?

`decrypt.day` is protected by Cloudflare Turnstile (invisible CAPTCHA), which blocks headless browsers on datacenter IPs (i.e., GitHub Actions runners). Running on **your** machine — real browser, residential IP, real cookies — sails through.

## One-time setup

```bash
cd scripts
npm install      # also runs `playwright install chromium`
gh auth status   # confirm gh CLI is authenticated to your account
```

## Usage

From the repo root:

```bash
node scripts/local-release.mjs
```

### First run

A Chromium window opens. Log in to decrypt.day manually (the Turnstile challenge will pass since you're a real user). When you land back on the YouTube app page, return to the terminal and press Enter. Cookies are saved to `~/.cache/uyou-scraper/profile/`.

### Subsequent runs

Cookies persist, so the script runs unattended:

1. Opens decrypt.day's YouTube page (already logged in)
2. Clicks Download, captures the IPA (~355 MB)
3. Uploads to a `_youtube-source` pre-release on the fork (overwrites previous)
4. Triggers `buildapp.yml` with the asset URL

The workflow then builds + publishes the actual uYouPlus IPA as a normal release.

## What gets stored where

- `~/.cache/uyou-scraper/profile/` — Chromium profile (cookies, session). Delete to log out.
- `~/.cache/uyou-scraper/downloads/` — last downloaded IPA, kept for one-off debugging.
- GitHub release `_youtube-source` — public pre-release (not "Latest"); transient.

## When it breaks

- **"Not logged in" loop**: cookies expired. Delete `~/.cache/uyou-scraper/profile/` and rerun.
- **"No download link or button found"**: decrypt.day changed their UI. The script keeps the browser open for 5 min so you can inspect the page; copy the download element's selector and update `local-release.mjs`.
- **Upload fails**: `gh auth status` — ensure CLI has `repo` scope on your account.
