#!/usr/bin/env node

/**
 * ============================================================================
 * Wurmpedia Full HTML Page Downloader v1.0
 * ============================================================================
 *
 * Downloads complete HTML pages from Wurmpedia for offline scraping.
 *
 * Features:
 * - Downloads full rendered HTML pages (not just API content)
 * - Very conservative rate limiting (3-5 seconds between requests)
 * - Checkpoint/resume system for interruptions
 * - Exponential backoff on errors
 * - Stores pages locally for offline processing
 *
 * Usage:
 *   node download-pages.js [command] [options]
 *
 * Commands:
 *   download       Start/resume downloading pages
 *   status         Show download progress
 *   clear          Clear checkpoint and start fresh
 *   list           List downloaded pages
 *
 * Options:
 *   --delay=N      Set delay between requests in ms (default: 3000)
 *   --limit=N      Only download N pages (for testing)
 *
 * ============================================================================
 */

const fs = require("fs");
const path = require("path");

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Base URLs
  WIKI_BASE: "https://wurmpedia.com/index.php",
  API_BASE: "https://wurmpedia.com/api.php",

  // Directories
  DATA_DIR: path.join(__dirname, "data"),
  HTML_DIR: path.join(__dirname, "data", "html-pages"),
  INDEX_FILE: path.join(__dirname, "data", "index.json"),
  CHECKPOINT_FILE: path.join(__dirname, "data", "download-checkpoint.json"),

  // Rate limiting - VERY CONSERVATIVE to be respectful to the wiki
  DELAY_MS: 3000,              // 3 seconds between requests (default)
  MIN_DELAY_MS: 2000,          // Minimum 2 seconds
  MAX_DELAY_MS: 10000,         // Maximum 10 seconds

  // Retry settings
  MAX_RETRIES: 5,
  RETRY_BASE_DELAY_MS: 5000,   // Start with 5 seconds on error
  RETRY_MAX_DELAY_MS: 60000,   // Max 1 minute between retries

  // User agent - identify ourselves
  USER_AGENT: "WurmpediaHarvester/1.0 (Community Project; Offline Scraping; Contact: github.com/Yarpii)",

  // Save checkpoint every N pages
  CHECKPOINT_INTERVAL: 10
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatTime(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function sanitizeFilename(title) {
  // Replace characters that are problematic in filenames
  return title
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/__+/g, "_")
    .substring(0, 200); // Limit length
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// PAGE INDEX MANAGER
// ============================================================================

class PageIndex {
  constructor() {
    this.indexFile = CONFIG.INDEX_FILE;
    this.pages = {};
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.indexFile)) {
        const data = JSON.parse(fs.readFileSync(this.indexFile, "utf-8"));
        this.pages = data.pages || {};
        console.log(`  Loaded index with ${Object.keys(this.pages).length} pages`);
      }
    } catch (e) {
      console.error(`  Warning: Could not load index: ${e.message}`);
    }
  }

  getPageList() {
    // Return array of {pageid, title} sorted by title
    return Object.entries(this.pages)
      .map(([pageid, info]) => ({
        pageid: Number(pageid),
        title: info.title,
        ns: info.ns
      }))
      .filter(p => p.ns === 0 || p.ns === undefined) // Main namespace only
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  isEmpty() {
    return Object.keys(this.pages).length === 0;
  }
}

// ============================================================================
// CHECKPOINT MANAGER
// ============================================================================

class Checkpoint {
  constructor() {
    this.file = CONFIG.CHECKPOINT_FILE;
    this.data = this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        return JSON.parse(fs.readFileSync(this.file, "utf-8"));
      }
    } catch (e) {
      console.error(`  Warning: Could not load checkpoint: ${e.message}`);
    }
    return {
      downloaded: [],        // Array of pageids already downloaded
      failed: [],           // Array of {pageid, error, attempts}
      lastPageId: null,
      startedAt: null,
      lastUpdate: null,
      stats: {
        total: 0,
        downloaded: 0,
        failed: 0,
        bytes: 0
      }
    };
  }

  save() {
    this.data.lastUpdate = new Date().toISOString();
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  isDownloaded(pageid) {
    return this.data.downloaded.includes(pageid);
  }

  markDownloaded(pageid, bytes) {
    if (!this.data.downloaded.includes(pageid)) {
      this.data.downloaded.push(pageid);
      this.data.stats.downloaded++;
      this.data.stats.bytes += bytes;
    }
    this.data.lastPageId = pageid;
  }

  markFailed(pageid, error) {
    const existing = this.data.failed.find(f => f.pageid === pageid);
    if (existing) {
      existing.attempts++;
      existing.lastError = error;
      existing.lastAttempt = new Date().toISOString();
    } else {
      this.data.failed.push({
        pageid,
        error,
        attempts: 1,
        firstAttempt: new Date().toISOString(),
        lastAttempt: new Date().toISOString()
      });
      this.data.stats.failed++;
    }
  }

  setTotal(total) {
    this.data.stats.total = total;
  }

  start() {
    if (!this.data.startedAt) {
      this.data.startedAt = new Date().toISOString();
    }
    this.save();
  }

  clear() {
    this.data = {
      downloaded: [],
      failed: [],
      lastPageId: null,
      startedAt: null,
      lastUpdate: null,
      stats: { total: 0, downloaded: 0, failed: 0, bytes: 0 }
    };
    this.save();
  }

  getProgress() {
    return this.data.stats;
  }
}

// ============================================================================
// HTML DOWNLOADER
// ============================================================================

class HtmlDownloader {
  constructor(delayMs = CONFIG.DELAY_MS) {
    this.delayMs = Math.max(CONFIG.MIN_DELAY_MS, Math.min(CONFIG.MAX_DELAY_MS, delayMs));
    this.lastRequest = 0;
    this.requestCount = 0;
  }

  async rateLimit() {
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    if (elapsed < this.delayMs) {
      await sleep(this.delayMs - elapsed);
    }
    this.lastRequest = Date.now();
  }

  buildPageUrl(title) {
    // Wurmpedia uses index.php/Page_Title format
    const encodedTitle = encodeURIComponent(title.replace(/ /g, "_"));
    return `${CONFIG.WIKI_BASE}/${encodedTitle}`;
  }

  async downloadPage(title, retries = CONFIG.MAX_RETRIES) {
    await this.rateLimit();

    const url = this.buildPageUrl(title);

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": CONFIG.USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Accept-Encoding": "gzip, deflate",
            "Connection": "keep-alive"
          }
        });

        // Handle rate limiting
        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          const delay = retryAfter
            ? parseInt(retryAfter) * 1000
            : Math.min(CONFIG.RETRY_BASE_DELAY_MS * Math.pow(2, attempt), CONFIG.RETRY_MAX_DELAY_MS);

          console.log(`    Rate limited! Waiting ${delay/1000}s...`);
          await sleep(delay);
          continue;
        }

        // Handle server errors
        if (response.status >= 500) {
          throw new Error(`Server error: ${response.status}`);
        }

        // Handle not found
        if (response.status === 404) {
          return { success: false, error: "Page not found", status: 404 };
        }

        // Handle other errors
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const html = await response.text();
        this.requestCount++;

        return {
          success: true,
          html,
          url,
          bytes: Buffer.byteLength(html, "utf-8"),
          status: response.status
        };

      } catch (error) {
        const isLast = attempt === retries;
        const delay = Math.min(
          CONFIG.RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1),
          CONFIG.RETRY_MAX_DELAY_MS
        );

        console.log(`    Attempt ${attempt}/${retries} failed: ${error.message}`);

        if (!isLast) {
          console.log(`    Retrying in ${delay/1000}s...`);
          await sleep(delay);
        } else {
          return {
            success: false,
            error: error.message,
            url
          };
        }
      }
    }
  }
}

// ============================================================================
// PROGRESS DISPLAY
// ============================================================================

class Progress {
  constructor(total, label = "Progress") {
    this.total = total;
    this.current = 0;
    this.label = label;
    this.startTime = Date.now();
    this.lastUpdate = 0;
  }

  update(current, extra = "") {
    this.current = current;
    const now = Date.now();

    // Only update display every 500ms to avoid console spam
    if (now - this.lastUpdate < 500 && current < this.total) return;
    this.lastUpdate = now;

    const percent = ((current / this.total) * 100).toFixed(1);
    const elapsed = (now - this.startTime) / 1000;
    const rate = current / elapsed;
    const remaining = rate > 0 ? (this.total - current) / rate : 0;
    const eta = remaining > 0 ? formatTime(remaining) : "Done";

    process.stdout.write(`\r${this.label}: ${current}/${this.total} (${percent}%) | ETA: ${eta} ${extra}    `);
  }

  done() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    console.log(`\r${this.label}: ${this.total}/${this.total} (100%) | Completed in ${formatTime(elapsed)}      `);
  }
}

// ============================================================================
// MAIN DOWNLOADER
// ============================================================================

class WurmpediaDownloader {
  constructor(options = {}) {
    this.options = {
      delay: CONFIG.DELAY_MS,
      limit: 0,
      ...options
    };

    this.pageIndex = new PageIndex();
    this.checkpoint = new Checkpoint();
    this.downloader = new HtmlDownloader(this.options.delay);

    ensureDir(CONFIG.HTML_DIR);
  }

  async fetchPageList() {
    console.log("\n  Fetching page list from API...\n");

    const pages = [];
    let continueToken = null;

    while (true) {
      const url = new URL(CONFIG.API_BASE);
      url.searchParams.set("action", "query");
      url.searchParams.set("list", "allpages");
      url.searchParams.set("aplimit", "500");
      url.searchParams.set("apnamespace", "0");
      url.searchParams.set("format", "json");

      if (continueToken) {
        url.searchParams.set("apcontinue", continueToken);
      }

      try {
        const response = await fetch(url.toString(), {
          headers: { "User-Agent": CONFIG.USER_AGENT }
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const batch = data.query?.allpages || [];

        for (const page of batch) {
          pages.push({
            pageid: page.pageid,
            title: page.title,
            ns: page.ns
          });
        }

        console.log(`    Fetched ${pages.length} pages...`);

        if (data.continue?.apcontinue) {
          continueToken = data.continue.apcontinue;
          await sleep(1000); // Be nice to the API
        } else {
          break;
        }
      } catch (error) {
        console.error(`    Error fetching pages: ${error.message}`);
        await sleep(5000);
      }
    }

    console.log(`\n    Total pages found: ${pages.length}\n`);
    return pages;
  }

  async download() {
    console.log("\n===========================================");
    console.log(" Wurmpedia HTML Page Downloader v1.0");
    console.log("===========================================\n");
    console.log(`  Delay between requests: ${this.options.delay}ms`);
    console.log(`  Output directory: ${CONFIG.HTML_DIR}`);

    // Get page list
    let pages = this.pageIndex.getPageList();

    if (pages.length === 0) {
      console.log("\n  No pages in index. Fetching from API...");
      pages = await this.fetchPageList();

      if (pages.length === 0) {
        console.log("  No pages found. Exiting.");
        return;
      }
    }

    console.log(`\n  Total pages available: ${pages.length}`);

    // Apply limit if set
    if (this.options.limit > 0) {
      pages = pages.slice(0, this.options.limit);
      console.log(`  Limited to: ${pages.length} pages`);
    }

    // Filter out already downloaded
    const toDownload = pages.filter(p => !this.checkpoint.isDownloaded(p.pageid));
    console.log(`  Already downloaded: ${pages.length - toDownload.length}`);
    console.log(`  Remaining to download: ${toDownload.length}`);

    if (toDownload.length === 0) {
      console.log("\n  All pages already downloaded!");
      return;
    }

    // Calculate estimated time
    const estimatedSeconds = (toDownload.length * this.options.delay) / 1000;
    console.log(`\n  Estimated time: ${formatTime(estimatedSeconds)}`);
    console.log("  (Press Ctrl+C to pause - progress will be saved)\n");

    // Start download
    this.checkpoint.setTotal(pages.length);
    this.checkpoint.start();

    const progress = new Progress(toDownload.length, "  Downloading");
    let downloaded = 0;
    let failed = 0;
    let totalBytes = 0;

    // Handle graceful shutdown
    let shuttingDown = false;
    process.on("SIGINT", () => {
      if (shuttingDown) {
        console.log("\n\n  Force quit!");
        process.exit(1);
      }
      shuttingDown = true;
      console.log("\n\n  Graceful shutdown... (press Ctrl+C again to force quit)");
      console.log("  Saving checkpoint...");
      this.checkpoint.save();
      console.log(`  Progress saved! Downloaded ${downloaded} pages.`);
      console.log("  Run 'node download-pages.js download' to resume.\n");
      process.exit(0);
    });

    for (const page of toDownload) {
      if (shuttingDown) break;

      const result = await this.downloader.downloadPage(page.title);

      if (result.success) {
        // Save HTML file
        const filename = `${page.pageid}_${sanitizeFilename(page.title)}.html`;
        const filepath = path.join(CONFIG.HTML_DIR, filename);

        // Add metadata comment at the top
        const htmlWithMeta = `<!--
  Wurmpedia Page Archive
  Page ID: ${page.pageid}
  Title: ${page.title}
  URL: ${result.url}
  Downloaded: ${new Date().toISOString()}
-->
${result.html}`;

        fs.writeFileSync(filepath, htmlWithMeta, "utf-8");

        this.checkpoint.markDownloaded(page.pageid, result.bytes);
        downloaded++;
        totalBytes += result.bytes;
      } else {
        this.checkpoint.markFailed(page.pageid, result.error);
        failed++;
        console.log(`\n    Failed: ${page.title} - ${result.error}`);
      }

      progress.update(downloaded + failed, `| ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);

      // Save checkpoint periodically
      if ((downloaded + failed) % CONFIG.CHECKPOINT_INTERVAL === 0) {
        this.checkpoint.save();
      }
    }

    progress.done();
    this.checkpoint.save();

    // Summary
    console.log("\n===========================================");
    console.log(" Download Complete!");
    console.log("===========================================");
    console.log(`  Downloaded: ${downloaded} pages`);
    console.log(`  Failed: ${failed} pages`);
    console.log(`  Total size: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
    console.log(`  Saved to: ${CONFIG.HTML_DIR}`);

    if (failed > 0) {
      console.log(`\n  Failed pages are saved in checkpoint.`);
      console.log("  Run 'node download-pages.js retry' to retry failed pages.");
    }
  }

  async retryFailed() {
    const failed = this.checkpoint.data.failed;

    if (failed.length === 0) {
      console.log("\n  No failed pages to retry.");
      return;
    }

    console.log(`\n  Retrying ${failed.length} failed pages...\n`);

    // Get page info for failed pages
    const pages = this.pageIndex.getPageList();
    const failedPages = failed.map(f => {
      const page = pages.find(p => p.pageid === f.pageid);
      return page || { pageid: f.pageid, title: `Unknown (${f.pageid})` };
    });

    // Reset failed list
    this.checkpoint.data.failed = [];
    this.checkpoint.data.stats.failed = 0;
    this.checkpoint.save();

    // Download
    const progress = new Progress(failedPages.length, "  Retrying");
    let success = 0;
    let stillFailed = 0;

    for (const page of failedPages) {
      const result = await this.downloader.downloadPage(page.title);

      if (result.success) {
        const filename = `${page.pageid}_${sanitizeFilename(page.title)}.html`;
        const filepath = path.join(CONFIG.HTML_DIR, filename);

        const htmlWithMeta = `<!--
  Wurmpedia Page Archive
  Page ID: ${page.pageid}
  Title: ${page.title}
  URL: ${result.url}
  Downloaded: ${new Date().toISOString()}
-->
${result.html}`;

        fs.writeFileSync(filepath, htmlWithMeta, "utf-8");
        this.checkpoint.markDownloaded(page.pageid, result.bytes);
        success++;
      } else {
        this.checkpoint.markFailed(page.pageid, result.error);
        stillFailed++;
      }

      progress.update(success + stillFailed);
    }

    progress.done();
    this.checkpoint.save();

    console.log(`\n  Success: ${success}, Still failed: ${stillFailed}`);
  }

  showStatus() {
    console.log("\n===========================================");
    console.log(" Download Status");
    console.log("===========================================\n");

    const stats = this.checkpoint.getProgress();
    const pages = this.pageIndex.getPageList();

    console.log(`  Total pages in index: ${pages.length}`);
    console.log(`  Downloaded: ${stats.downloaded}`);
    console.log(`  Failed: ${stats.failed}`);
    console.log(`  Remaining: ${pages.length - stats.downloaded}`);
    console.log(`  Total size: ${(stats.bytes / 1024 / 1024).toFixed(1)} MB`);

    if (this.checkpoint.data.startedAt) {
      console.log(`\n  Started: ${this.checkpoint.data.startedAt}`);
      console.log(`  Last update: ${this.checkpoint.data.lastUpdate}`);
    }

    if (stats.failed > 0) {
      console.log(`\n  Failed pages (${this.checkpoint.data.failed.length}):`);
      for (const f of this.checkpoint.data.failed.slice(0, 10)) {
        console.log(`    - ${f.pageid}: ${f.error} (${f.attempts} attempts)`);
      }
      if (this.checkpoint.data.failed.length > 10) {
        console.log(`    ... and ${this.checkpoint.data.failed.length - 10} more`);
      }
    }

    // Check HTML directory
    if (fs.existsSync(CONFIG.HTML_DIR)) {
      const files = fs.readdirSync(CONFIG.HTML_DIR).filter(f => f.endsWith(".html"));
      console.log(`\n  HTML files on disk: ${files.length}`);
    }
  }

  listDownloaded() {
    if (!fs.existsSync(CONFIG.HTML_DIR)) {
      console.log("\n  No HTML directory found.");
      return;
    }

    const files = fs.readdirSync(CONFIG.HTML_DIR)
      .filter(f => f.endsWith(".html"))
      .sort();

    console.log(`\n  Downloaded pages (${files.length}):\n`);

    for (const file of files.slice(0, 50)) {
      console.log(`    ${file}`);
    }

    if (files.length > 50) {
      console.log(`\n    ... and ${files.length - 50} more`);
    }
  }

  clear() {
    this.checkpoint.clear();
    console.log("\n  Checkpoint cleared. Next download will start fresh.");
    console.log("  Note: HTML files are NOT deleted. Delete them manually if needed.");
    console.log(`  HTML directory: ${CONFIG.HTML_DIR}`);
  }
}

// ============================================================================
// CLI
// ============================================================================

function parseArgs(args) {
  const options = {
    delay: CONFIG.DELAY_MS,
    limit: 0
  };

  for (const arg of args) {
    if (arg.startsWith("--delay=")) {
      options.delay = parseInt(arg.split("=")[1]) || CONFIG.DELAY_MS;
    } else if (arg.startsWith("--limit=")) {
      options.limit = parseInt(arg.split("=")[1]) || 0;
    }
  }

  return options;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.find(a => !a.startsWith("--")) || "download";
  const options = parseArgs(args);

  const downloader = new WurmpediaDownloader(options);

  switch (command) {
    case "download":
    case "start":
      await downloader.download();
      break;

    case "retry":
      await downloader.retryFailed();
      break;

    case "status":
      downloader.showStatus();
      break;

    case "list":
      downloader.listDownloaded();
      break;

    case "clear":
      downloader.clear();
      break;

    case "help":
    default:
      console.log(`
Wurmpedia HTML Page Downloader v1.0

Downloads complete HTML pages from Wurmpedia for offline scraping.
Very conservative rate limiting to respect the wiki servers.

Usage: node download-pages.js [command] [options]

Commands:
  download       Start or resume downloading pages (default)
  retry          Retry previously failed pages
  status         Show download progress and statistics
  list           List downloaded pages
  clear          Clear checkpoint (does not delete HTML files)
  help           Show this help

Options:
  --delay=N      Delay between requests in milliseconds (default: 3000)
                 Minimum: 2000ms, Maximum: 10000ms
  --limit=N      Only download N pages (useful for testing)

Examples:
  node download-pages.js download              # Start/resume downloading
  node download-pages.js download --delay=5000 # Slower (5 second delay)
  node download-pages.js download --limit=10   # Download only 10 pages
  node download-pages.js status                # Check progress
  node download-pages.js retry                 # Retry failed pages

Tips:
  - Press Ctrl+C to gracefully stop - progress is saved
  - HTML files are saved to: data/html-pages/
  - Each file includes metadata (page ID, title, URL, download date)
  - Run 'harvest-wurmpedia.js pages' first to build the page index
      `);
  }
}

main().catch(error => {
  console.error(`\nFatal error: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});
