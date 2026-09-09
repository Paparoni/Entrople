// Runs server-side (in GitHub Actions), so it isn't subject to the browser
// CORS restrictions that block the NYT Wordle API from a page loaded on
// GitHub Pages. Fetches today's puzzle (in America/New_York, matching NYT's
// own rollover) and merges it into data/wordle-answers.json, which is served
// same-origin alongside the rest of the site.
import fs from "node:fs/promises";

const ARCHIVE_PATH = new URL("../data/wordle-answers.json", import.meta.url);

// A handful of retries with backoff absorbs the kind of one-off blip
// (transient 429/5xx, a dropped connection) that would otherwise silently
// leave a day missing from the archive until the *next* scheduled run
// happens to succeed.
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 2000;
const FETCH_TIMEOUT_MS = 15000;

function todaysEasternDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

async function loadArchive() {
  try {
    const raw = await fs.readFile(ARCHIVE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Fetches one date, retrying transient failures (network errors, timeouts,
// 429s, 5xx) with exponential backoff. A 404 (puzzle genuinely doesn't exist
// yet, e.g. asking for tomorrow) is NOT retried -- it's returned as null so
// the caller can decide what to do.
async function fetchWordleFor(dateStr) {
  const url = `https://www.nytimes.com/svc/wordle/v2/${dateStr}.json`;
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetchWithTimeout(
        url,
        { headers: { "User-Agent": "Entrople-wordle-archiver (+https://github.com/paparoni/Entrople)" } },
        FETCH_TIMEOUT_MS
      );

      if (res.status === 404) return null;

      if (!res.ok) {
        throw new Error(`NYT Wordle API responded ${res.status} for ${dateStr}`);
      }

      const data = await res.json();
      if (!data || typeof data.solution !== "string") {
        throw new Error("Unexpected response shape from NYT Wordle API");
      }
      return data;
    } catch (err) {
      lastErr = err;
      const isLastAttempt = attempt === MAX_ATTEMPTS;
      console.warn(
        `Attempt ${attempt}/${MAX_ATTEMPTS} for ${dateStr} failed: ${err.message}${
          isLastAttempt ? "" : " -- retrying"
        }`
      );
      if (!isLastAttempt) {
        await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }

  throw lastErr;
}

function storeEntry(archive, dateStr, data) {
  archive[dateStr] = {
    id: data.id,
    solution: data.solution,
    print_date: data.print_date,
    days_since_launch: data.days_since_launch,
  };
}

async function main() {
  const archive = await loadArchive();
  let changed = false;
  const failures = [];

  // Primary target is today's puzzle. Also opportunistically backfill
  // yesterday if it's somehow still missing (e.g. a prior run failed
  // outright and nothing retried it since) -- one extra request a day is
  // cheap insurance against a permanent gap in the archive.
  const targets = [todaysEasternDate(0), todaysEasternDate(-1)];

  for (const dateStr of targets) {
    if (archive[dateStr]) {
      console.log(`Already have ${dateStr} (${archive[dateStr].solution}), nothing to do.`);
      continue;
    }

    try {
      const data = await fetchWordleFor(dateStr);
      if (data === null) {
        console.log(`No puzzle published yet for ${dateStr} (404), skipping.`);
        continue;
      }
      storeEntry(archive, dateStr, data);
      changed = true;
      console.log(`Saved ${dateStr}: ${data.solution}`);
    } catch (err) {
      console.error(`Giving up on ${dateStr} after ${MAX_ATTEMPTS} attempts: ${err.message}`);
      failures.push(dateStr);
    }
  }

  if (changed) {
    await fs.writeFile(ARCHIVE_PATH, JSON.stringify(archive, null, 2) + "\n");
  }

  // Fail the job (non-zero exit) only if today's date specifically never got
  // an entry -- that's the case that actually matters for the site. A
  // failure on the backfill target alone still exits 0 so it doesn't spam
  // the Actions tab with red Xs for a day that already has other chances
  // (including tomorrow's backfill attempt) to fill in.
  if (failures.includes(targets[0])) {
    console.error(`Today's puzzle (${targets[0]}) could not be fetched. Failing the job.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
