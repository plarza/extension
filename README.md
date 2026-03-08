# Plarza Extension

A browser userscript that passively scans web pages for URLs and submits them in batches to the Plarza worker API for content ingestion.

## How It Works

The script runs on every page (excluding Plarza itself and localhost), extracts URLs from links, images, srcsets, meta tags, inline scripts, data attributes, and visible text, then periodically submits new URLs to `worker.aza.network/submit`.

- URLs are deduplicated against a local master list (capped at 10,000 entries)
- Submissions happen every 10 seconds via `GM_xmlhttpRequest`
- A MutationObserver triggers re-scans when the page changes
- Pending URLs persist across sessions using `GM_setValue`/`GM_getValue`

## Prerequisites
- a userscript manager ([Tampermonkey](https://www.tampermonkey.net/), [Violentmonkey](https://violentmonkey.github.io/), etc.)

## Installation
2. Install the userscript from the URL [https://raw.githubusercontent.com/plarza/extension/refs/heads/main/userscript.js](https://raw.githubusercontent.com/plarza/extension/refs/heads/main/userscript.js)
3. On first page load, you'll be prompted for your Plarza API key