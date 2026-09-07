// Runs server-side (in GitHub Actions), so it isn't subject to the browser
// CORS restrictions that block the NYT Wordle API from a page loaded on
// GitHub Pages. Fetches today's puzzle (in America/New_York, matching NYT's
// own rollover) and merges it into data/wordle-answers.json, which is served
// same-origin alongside the rest of the site.
import fs from "node:fs/promises";

const ARCHIVE_PATH = new URL("../data/wordle-answers.json", import.meta.url);

function todaysEasternDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function loadArchive() {
  try {
    const raw = await fs.readFile(ARCHIVE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function main() {
  const dateStr = todaysEasternDate();
  const archive = await loadArchive();

  if (archive[dateStr]) {
    console.log(`Already have ${dateStr} (${archive[dateStr].solution}), nothing to do.`);
    return;
  }

  const url = `https://www.nytimes.com/svc/wordle/v2/${dateStr}.json`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Entrople-wordle-archiver (+https://github.com/paparoni/Entrople)" },
  });

  if (!res.ok) {
    throw new Error(`NYT Wordle API responded ${res.status} for ${dateStr}`);
  }

  const data = await res.json();
  if (!data || typeof data.solution !== "string") {
    throw new Error("Unexpected response shape from NYT Wordle API");
  }

  archive[dateStr] = {
    id: data.id,
    solution: data.solution,
    print_date: data.print_date,
    days_since_launch: data.days_since_launch,
  };

  await fs.writeFile(ARCHIVE_PATH, JSON.stringify(archive, null, 2) + "\n");
  console.log(`Saved ${dateStr}: ${data.solution}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
