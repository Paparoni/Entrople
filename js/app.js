/* Entrople, UI layer: rendering, event wiring, word-data loading, and the
   "today"/analyzer/simulation tabs. The actual entropy math and game-solving
   engine live in js/core/entropy-math.js and js/core/simulation.js -- load
   both of those first (see index.html).
   Word data: steve-kasica/wordle-words, tabatkins/wordle-list, dictionaryapi.dev, Wiktionary.
   Credit: Antwaun Tune */

const ANSWER_LIST_URL =
  "https://raw.githubusercontent.com/steve-kasica/wordle-words/master/wordle.csv";
const GUESS_LIST_URL =
  "https://raw.githubusercontent.com/tabatkins/wordle-list/main/words";
const DEFINE_API = (word) =>
  `https://api.dictionaryapi.dev/api/v2/entries/en/${word.toLowerCase()}`;
// Wiktionary is the fallback when Free Dictionary API 404s.
const WIKTIONARY_API = (word) =>
  `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(
    word.toLowerCase()
  )}`;

// NYT's own Wordle rolls over at midnight Eastern Time, not local time, so the
// date used to look up "today's" puzzle must be computed in America/New_York.
const WORDLE_API = (dateStr) => `https://www.nytimes.com/svc/wordle/v2/${dateStr}.json`;
// The NYT endpoint never sends an Access-Control-Allow-Origin header, so a
// browser fetch to it from a GitHub Pages origin (or any origin) is always
// blocked by CORS -- that's not flaky, it's guaranteed to fail every time.
// A GitHub Actions workflow (.github/workflows/update-wordle.yml) fetches the
// puzzle server-side once a day, where CORS doesn't apply, and commits it here
// so it's served same-origin with the rest of the site.
const LOCAL_ARCHIVE_URL = "data/wordle-answers.json";
// Only reached if today's date isn't in the local archive yet (e.g. the daily
// workflow hasn't run since rollover). Public CORS relays are unreliable
// (rate limits, outages, some now require an API key), so these are a
// last-resort fallback, not the primary path.
const CORS_PROXIES = [
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

// "en-CA" formats as YYYY-MM-DD, which is exactly what the NYT endpoint expects.
function todaysEasternDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Same-origin, so no CORS involved at all. Returns null (rather than
// throwing) if the archive doesn't have today's date yet, so the caller can
// fall through to the live-fetch attempts below.
async function fetchFromLocalArchive(dateStr) {
  try {
    const res = await fetch(LOCAL_ARCHIVE_URL, { cache: "no-store" });
    if (!res.ok) return null;
    const archive = await res.json();
    const entry = archive?.[dateStr];
    if (!entry || typeof entry.solution !== "string") return null;
    return entry;
  } catch {
    return null;
  }
}

async function fetchTodaysWordle(dateStr) {
  const fromArchive = await fetchFromLocalArchive(dateStr);
  if (fromArchive) return fromArchive;

  const url = WORDLE_API(dateStr);
  const attempts = [url, ...CORS_PROXIES.map((make) => make(url))];
  let lastErr;

  for (const attemptUrl of attempts) {
    try {
      const res = await fetch(attemptUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(`NYT Wordle API responded ${res.status}`);
      const data = await res.json();
      if (!data || typeof data.solution !== "string") {
        throw new Error("Unexpected response shape from NYT Wordle API");
      }
      return data;
    } catch (err) {
      lastErr = err;
    }
  }

  throw (
    lastErr ||
    new Error(
      "Could not reach the NYT Wordle API, and today's date isn't in the local archive yet"
    )
  );
}

function renderFormula(id, tex, displayMode = false) {
  const el = document.querySelector(`#${id}`);
  if (!el) return;

  if (typeof katex === "undefined") {
    el.textContent = tex;
    setTimeout(() => renderFormula(id, tex, displayMode), 150);
    return;
  }

  try {
    katex.render(tex, el, { throwOnError: false, displayMode });
  } catch {
    el.textContent = tex;
  }
}

const words = {
  status: "loading", // "loading" | "ready" | "error"
  answers: [],
  frequency: {}, // word -> Google Books Ngram prevalence
  frequencySorted: [], // frequency values sorted ascending, for percentile lookups
  guesses: new Set(),
};

async function loadWordData() {
  try {
    const [answerText, guessText] = await Promise.all([
      fetchText(ANSWER_LIST_URL),
      fetchText(GUESS_LIST_URL),
    ]);

    const answerSet = new Set();

    answerText
      .split("\n")
      .slice(1)
      .forEach((line) => {
        const cols = line.split(",");
        const word = (cols[0] || "").trim().toUpperCase();
        if (!/^[A-Z]{5}$/.test(word)) return;

        // "occurrence" is Google Books Ngram prevalence for every word in the file.
        const occurrence = parseFloat(cols[1]);
        if (!Number.isNaN(occurrence)) words.frequency[word] = occurrence;

        // Only rows with a "day" value are confirmed historical answers.
        const day = cols[2] !== undefined ? cols[2].trim() : "";
        if (day !== "") answerSet.add(word);
      });

    const guessSet = new Set();

    guessText.split("\n").forEach((line) => {
      const word = line.trim().toUpperCase();
      if (/^[A-Z]{5}$/.test(word)) guessSet.add(word);
    });

    answerSet.forEach((w) => guessSet.add(w));

    words.answers = [...answerSet];
    words.guesses = guessSet;
    // Sorted so commonness reads as a percentile, since raw frequency is non-linear (Zipf's law).
    words.frequencySorted = Object.values(words.frequency).sort((a, b) => a - b);
    words.status = "ready";
  } catch (err) {
    console.error("Entrople: word data failed to load", err);
    words.status = "error";
  }

  renderDataStatus();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.text();
}

function renderDataStatus() {
  const el = document.querySelector("#dataStatus");
  if (!el) return;

  if (words.status === "loading") {
    el.textContent = "Loading live word data…";
    el.className = "data-status loading";
  } else if (words.status === "ready") {
    el.textContent =
      `${words.answers.length.toLocaleString()}-word answer pool · ` +
      `${words.guesses.size.toLocaleString()}-word dictionary, loaded live`;
    el.className = "data-status ready";
  } else {
    el.textContent =
      "Live word data unavailable. Deep entropy analysis is disabled, but your solve grid still works.";
    el.className = "data-status error";
  }
}

/* UI wiring */
const answerEl = document.querySelector("#answer");
const guessList = document.querySelector("#guessList");
const form = document.querySelector("#analyzerForm");

let guesses = ["ADIEU", "SHORT", "BROTH"];

// "hard" restricts suggestions to Wordle Hard Mode rules; "easy" ignores prior clues.
let solveMode = "hard";

const clean = (value) => value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5);

function renderInputs() {
  guessList.innerHTML = "";

  guesses.forEach((guess, index) => {
    const row = document.createElement("div");
    row.className = "guess-row";

    row.innerHTML = `
      <span class="guess-num">${String(index + 1).padStart(2, "0")}</span>

      <input
        class="guess-input"
        value="${guess}"
        maxlength="5"
        aria-label="Guess ${index + 1}"
        autocomplete="off"
        spellcheck="false"
      >

      <button
        class="remove"
        type="button"
        aria-label="Remove guess ${index + 1}"
      >×</button>
    `;

    const input = row.querySelector("input");

    input.addEventListener("input", (event) => {
      event.target.value = clean(event.target.value);
      guesses[index] = event.target.value;
    });

    row.querySelector(".remove").addEventListener("click", () => {
      guesses.splice(index, 1);
      if (!guesses.length) guesses.push("");
      renderInputs();
    });

    guessList.appendChild(row);
  });

  document.querySelector("#guessCount").textContent = `${guesses.length} / 6`;
  document.querySelector("#addGuess").disabled = guesses.length >= 6;
}

function wordSet(word) {
  return new Set(word.split(""));
}

function plural(number, word) {
  return `${number} ${word}${number === 1 ? "" : "s"}`;
}

function ordinal(number) {
  if (number === 1) return "first";
  if (number === 2) return "second";
  if (number === 3) return "third";
  return `${number}th`;
}

function fmtBits(n) {
  return `${n.toFixed(2)} bits`;
}

// Percentile rank of a word's frequency (0 = least common, 1 = most).
function frequencyPercentile(freq) {
  const sorted = words.frequencySorted;
  if (!sorted || !sorted.length) return null;

  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= freq) lo = mid + 1;
    else hi = mid;
  }
  return lo / sorted.length;
}

// How commonly a word is used in everyday English, not its odds of being the answer.
function englishCommonnessTier(word) {
  const freq = words.frequency[word];
  if (freq === undefined || Number.isNaN(freq)) {
    return { tier: "na", label: "Unknown" };
  }

  const pct = frequencyPercentile(freq);
  if (pct === null) return { tier: "na", label: "Unknown" };
  if (pct >= 0.98) return { tier: "vcommon", label: "Very Common" };
  if (pct >= 0.85) return { tier: "common", label: "Common" };
  if (pct >= 0.5) return { tier: "moderate", label: "Moderate" };
  if (pct >= 0.15) return { tier: "uncommon", label: "Uncommon" };
  return { tier: "rare", label: "Rare" };
}

function analyze() {
  const answer = clean(answerEl.value);
  const validGuesses = guesses.map(clean).filter(Boolean);
  const error = document.querySelector("#error");

  answerEl.value = answer;
  error.textContent = "";

  if (answer.length !== 5 || validGuesses.some((guess) => guess.length !== 5)) {
    error.textContent = "Every word must contain exactly five letters.";
    return;
  }

  if (!validGuesses.length) {
    error.textContent = "Add at least one guess.";
    return;
  }

  guesses = validGuesses;
  renderInputs();

  const solvedAt = validGuesses.findIndex((guess) => guess === answer) + 1;
  const guessesUsed = solvedAt || validGuesses.length;
  const evaluatedGuesses = validGuesses.slice(0, guessesUsed);

  const uniqueLetters = new Set(evaluatedGuesses.join("").split(""));
  const lettersBeforeFinalGuess = new Set(
    evaluatedGuesses.slice(0, -1).join("").split("")
  );
  const answerLetters = wordSet(answer);

  const discoveredAnswerLetters = [...answerLetters].filter((letter) =>
    lettersBeforeFinalGuess.has(letter)
  ).length;

  const foundPercentage = Math.round(
    (discoveredAnswerLetters / answerLetters.size) * 100
  );

  const guessesSpared = solvedAt ? 6 - solvedAt : 0;

  let verdict;
  if (!solvedAt) verdict = "NOT SOLVED";
  else if (solvedAt <= 2) verdict = "EXCEPTIONAL";
  else if (solvedAt === 3) verdict = "STRONG SOLVE";
  else if (solvedAt === 4) verdict = "SOLID SOLVE";
  else if (solvedAt === 5) verdict = "CLOSE CALL";
  else verdict = "CLUTCH FINISH";

  document.querySelector("#verdict").textContent = verdict;
  document.querySelector("#solvedIn").textContent = solvedAt || "N/A";
  document.querySelector("#lettersTested").textContent = uniqueLetters.size;
  document.querySelector("#alphabetCoverage").textContent =
    `${((uniqueLetters.size / 26) * 100).toFixed(1)}% of alphabet`;
  document.querySelector("#answerFound").textContent = `${foundPercentage}%`;
  document.querySelector("#spared").textContent = guessesSpared;

  const board = document.querySelector("#board");
  board.innerHTML = "";

  evaluatedGuesses.forEach((guess) => {
    const row = document.createElement("div");
    row.className = "board-row";
    const marks = feedback(guess, answer);

    guess.split("").forEach((letter, index) => {
      const tile = document.createElement("span");
      tile.className = `tile ${marks[index]}`;
      tile.textContent = letter;
      row.appendChild(tile);
    });

    board.appendChild(row);
  });

  const poolSize = words.status === "ready" ? words.answers.length : 2309;
  const baseBits = Math.log2(poolSize);

  document.querySelector("#bits").textContent = `≈ ${baseBits.toFixed(2)} bits`;
  document.querySelector("#poolSizeLabel").textContent = poolSize.toLocaleString();
  document.querySelector("#mathCopy").textContent =
    words.status === "ready"
      ? `Starting from a live ${poolSize.toLocaleString()}-word answer pool, identifying ` +
        `one exact answer requires log₂(${poolSize.toLocaleString()}) = ${baseBits.toFixed(2)} bits. ` +
        `Your solve used ${guessesUsed} of 6 available guesses.`
      : `Using the classic 2,309-word answer set as a fallback, identifying one exact ` +
        `answer requires log₂(2,309) ≈ ${baseBits.toFixed(2)} bits. Live data is unavailable, ` +
        `so the deep candidate-narrowing math below is turned off for now.`;

  const route = document.querySelector("#route");
  route.innerHTML = "";

  evaluatedGuesses.forEach((guess, index) => {
    const marks = feedback(guess, answer);
    const greenCount = marks.filter((m) => m === "correct").length;
    const yellowCount = marks.filter((m) => m === "present").length;

    const previousLetters = evaluatedGuesses.slice(0, index).join("");
    const newLetterCount = new Set(
      guess.split("").filter((letter) => !previousLetters.includes(letter))
    ).size;
    const newVowels = vowelsIn(guess).filter((v) => !previousLetters.includes(v));

    const routeLine = document.createElement("div");
    routeLine.className = "route-line";

    const description =
      guess === answer
        ? "Exact match. Puzzle solved."
        : `${plural(greenCount, "green")}, ${plural(yellowCount, "yellow")} · ${plural(
            newLetterCount,
            "new letter"
          )} tested${newVowels.length ? ` (${newVowels.length} new vowel${newVowels.length > 1 ? "s" : ""}: ${newVowels.join(", ")})` : ""}`;

    const routeScore = greenCount * 2 + yellowCount;
    const inDictionary = words.status !== "ready" || words.guesses.has(guess);

    routeLine.innerHTML = `
      <span class="n">${String(index + 1).padStart(2, "0")}</span>
      <b>${guess}${
      inDictionary ? "" : '<span class="not-listed" title="Not found in the live Entrople dictionary">†</span>'
    }</b>
      <p>${description}</p>
      <span class="score">${routeScore} pts</span>
    `;

    route.appendChild(routeLine);
  });

  renderDeepMath(evaluatedGuesses, answer, solvedAt, guessesUsed);

  renderDefinition(answer);

  renderEntropleSolve(answer, { solvedAt, guessesUsed });

  const summaryTitle = solvedAt
    ? `An ${solvedAt <= 3 ? "efficient" : "eventful"} ${ordinal(solvedAt)}-guess solve.`
    : "The answer was not reached.";

  document.querySelector("#summaryTitle").textContent = summaryTitle;

  if (solvedAt) {
    document.querySelector("#summaryCopy").textContent =
      `You tested ${uniqueLetters.size} unique letters (${((uniqueLetters.size / 26) * 100).toFixed(
        1
      )}% of the alphabet) and had uncovered ${discoveredAnswerLetters} of ${answerLetters.size} ` +
      `unique answer letters before the final guess. You finished with ${guessesSpared} ` +
      `${guessesSpared === 1 ? "guess" : "guesses"} to spare.`;
  } else {
    document.querySelector("#summaryCopy").textContent =
      `Across ${guessesUsed} guesses, you tested ${uniqueLetters.size} unique letters and uncovered ` +
      `${discoveredAnswerLetters} of ${answerLetters.size} unique answer letters.`;
  }

  document.querySelector("#results").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderDeepMath(evaluatedGuesses, answer, solvedAt, guessesUsed) {
  const deepCard = document.querySelector("#deepCard");
  const deepBody = document.querySelector("#deepBody");

  if (words.status !== "ready") {
    deepCard.classList.add("disabled");
    deepBody.innerHTML =
      `<p class="deep-empty">Deep candidate-narrowing analysis needs the live word ` +
      `dictionary. Reload Entrople with a network connection to unlock it.</p>`;

    const gradeCard = document.querySelector("#gradeCard");
    gradeCard.classList.add("disabled");
    document.querySelector("#gradeBreakdown").innerHTML = "";
    document.querySelector("#gradeLetter").textContent = "-";
    document.querySelector("#gradeScore").textContent = "0";
    document.querySelector("#gradeVerdict").textContent =
      "Grading needs the live word dictionary. Reload with a network connection to unlock it.";
    return;
  }

  deepCard.classList.remove("disabled");
  deepBody.innerHTML = "<p class='deep-empty'>Crunching the candidate space…</p>";
  renderFormulaReference();

  // Defer a tick so the "crunching" state paints before the synchronous search.
  setTimeout(() => {
    let candidates = words.answers;
    const startSize = candidates.length;
    let totalBits = 0;
    const steps = [];
    let hardHistory = [];

    evaluatedGuesses.forEach((guess) => {
      const beforeCandidates = candidates;
      const before = candidates.length;
      const actualCode = feedbackCode(guess, answer);

      const profile = guessPartitionProfile(guess, candidates);
      const best = findBestGuesses(
        candidates,
        5,
        solveMode === "hard" ? hardHistory : null,
        words.guesses
      );

      // Only clues from guesses played before this one apply.
      hardHistory = [...hardHistory, { guess, code: actualCode }];

      candidates = narrowCandidates(candidates, guess, actualCode);
      const after = Math.max(candidates.length, 1);

      const actualBits = Math.log2(before) - Math.log2(after);
      totalBits += actualBits;

      steps.push({
        guess,
        beforeCandidates,
        before,
        after: candidates.length,
        actualBits,
        expected: profile.bits,
        profile,
        best,
      });
    });

    deepBody.innerHTML = "";

    steps.forEach((step, i) => {
      const row = document.createElement("div");
      row.className = "deep-row";

      const rank = step.best.top.findIndex((b) => b.word === step.guess);
      const rankLabel =
        rank === 0
          ? "This was the top-ranked guess."
          : rank > 0
          ? `Ranked #${rank + 1} of the guesses searched.`
          : `Not in the top ${step.best.top.length} searched.`;

      const bestGuess = step.best.top[0];
      const efficiency =
        step.expected > 0 ? Math.min(100, (step.actualBits / step.expected) * 100) : 100;

      const p = step.profile;
      const formulaId = `deepFormula${i}`;

      row.innerHTML = `
        <div class="deep-row-head">
          <b>${String(i + 1).padStart(2, "0")} · ${step.guess}</b>
          <span>${step.before.toLocaleString()} → ${step.after.toLocaleString()} candidates</span>
        </div>
        <div class="deep-stats">
          <div><p>ACTUAL INFO GAINED</p><strong>${fmtBits(step.actualBits)}</strong></div>
          <div><p>EXPECTED (ENTROPY)</p><strong>${fmtBits(step.expected)}</strong></div>
          <div><p>LUCK FACTOR</p><strong>${efficiency.toFixed(0)}%</strong></div>
        </div>
        <div class="deep-stats-2">
          <div><p>PATTERN BUCKETS USED</p><strong>${p.bucketsUsed} / 243</strong></div>
          <div><p>E[N'] = Σnᵢ²/N</p><strong>${p.expectedRemaining.toFixed(1)}</strong></div>
          <div><p>σ(bucket size)</p><strong>±${p.stdDev.toFixed(1)}</strong></div>
        </div>
        <div class="deep-stats-2">
          <div><p>D_KL(P‖UNIFORM)</p><strong>${p.klDivergence.toFixed(3)} bits</strong></div>
          <div><p>LARGEST BUCKET</p><strong>${p.maxBucket.toLocaleString()} (${(
        (p.maxBucket / step.before) *
        100
      ).toFixed(1)}%)</strong></div>
          <div><p>MEAN BUCKET SIZE</p><strong>${p.mean.toFixed(1)}</strong></div>
        </div>
        <div class="histogram" title="Each bar is one realized feedback pattern, sorted largest to smallest">
          ${p.buckets
            .slice(0, 60)
            .map(
              (n) =>
                `<span style="height:${Math.max(4, (n / p.maxBucket) * 100)}%" title="${n} candidates"></span>`
            )
            .join("")}
          ${p.buckets.length > 60 ? `<em>+${p.buckets.length - 60} more</em>` : ""}
        </div>
        <p class="deep-formula" id="${formulaId}"></p>
        <p class="deep-formula" id="${formulaId}-kl"></p>
        <p class="deep-formula" id="${formulaId}-win"></p>
        <p class="deep-note">
          Best guess found for this step (searched ${step.best.hardModeApplied ? `${step.best.poolSize.toLocaleString()} legal words` : step.best.searched}):
          <b>${bestGuess.word}</b> at ${fmtBits(bestGuess.bits)} raw entropy${
        bestGuess.pWin > 0
          ? `, win-bonus adjusted to ${fmtBits(bestGuess.adjustedBits)} (${(bestGuess.pWin * 100).toFixed(1)}% chance this guess IS the answer)`
          : " (not itself a possible answer, so no win-bonus applies)"
      }. ${rankLabel}
          The largest single bucket this guess could have landed in held ${p.maxBucket.toLocaleString()}
          candidates (mean bucket size across the ${p.bucketsUsed} realized patterns was
          ${p.mean.toFixed(1)}).
        </p>
        <div class="next-best">
          <p class="next-best-title">TOP ${step.best.top.length} GUESSES FOR THIS STEP</p>
          <div class="next-best-list">
            ${step.best.top
              .map((cand, ci) => {
                const isPlayed = cand.word === step.guess;
                const candProfile = guessPartitionProfile(cand.word, step.beforeCandidates);
                const topProfile = guessPartitionProfile(step.best.top[0].word, step.beforeCandidates);
                const gapFromTop =
                  ci === 0 ? 0 : step.best.top[0].adjustedBits - cand.adjustedBits;
                const commonness = englishCommonnessTier(cand.word);
                const priorLetters = evaluatedGuesses.slice(0, i).join("");
                const candVowels = vowelsIn(cand.word);
                const newCandVowels = candVowels.filter((v) => !priorLetters.includes(v));
                const vowelNote =
                  candVowels.length === 0
                    ? "tests no vowels at all"
                    : `tests ${plural(candVowels.length, "vowel")} (${candVowels.join(", ")})${
                        newCandVowels.length && newCandVowels.length !== candVowels.length
                          ? `, ${newCandVowels.length} not yet ruled in or out`
                          : ""
                      }${candVowels.length === newCandVowels.length ? ", all still open" : ""}`;
                const winNote =
                  cand.pWin > 0
                    ? ` It's itself a live candidate, so it also carries a ${(cand.pWin * 100).toFixed(1)}% chance of winning outright this turn, worth +${cand.pWin.toFixed(3)} bits on top of its raw entropy of ${fmtBits(cand.bits)}.`
                    : "";
                let why;
                if (ci === 0) {
                  why = `Highest win-bonus-adjusted score of the ${step.best.hardModeApplied ? `${step.best.poolSize.toLocaleString()} legal words` : `${step.best.searched} searched`} (raw entropy ${fmtBits(candProfile.bits)}${cand.pWin > 0 ? `, adjusted ${fmtBits(candProfile.adjustedBits)}` : ""}). Spreads the ${step.before.toLocaleString()} candidates across ${candProfile.bucketsUsed} distinct outcomes, worst case leaving ${candProfile.maxBucket.toLocaleString()} words (${((candProfile.maxBucket / step.before) * 100).toFixed(1)}%) if the unluckiest pattern lands. Vowel-wise, it ${vowelNote}; with only 5 vowels in English against 21 consonants, that coverage is part of why the entropy math likes it.${winNote}`;
                } else {
                  why = `${fmtBits(gapFromTop)} behind the top pick on win-bonus-adjusted score. Splits into ${candProfile.bucketsUsed} outcomes with a worst case of ${candProfile.maxBucket.toLocaleString()} words (${((candProfile.maxBucket / step.before) * 100).toFixed(1)}%), ${
                    candProfile.bucketsUsed >= topProfile.bucketsUsed
                      ? "about as even a split as the top pick"
                      : "a somewhat less even split than the top pick"
                  }. It ${vowelNote}.${winNote}`;
                }
                return `
                  <div class="next-best-row${isPlayed ? " played" : ""}">
                    <span class="nb-rank">#${ci + 1}</span>
                    <b class="nb-word">${cand.word}</b>
                    <span class="nb-commonness nb-commonness-${commonness.tier}" title="How commonly this word is used in everyday English, not how likely it is to be the Wordle answer">${commonness.label}</span>
                    <span class="nb-bits" title="${cand.pWin > 0 ? `raw entropy ${cand.bits.toFixed(3)} + win-bonus ${cand.pWin.toFixed(3)}` : "raw entropy (no win-bonus: not a live candidate)"}">${fmtBits(cand.adjustedBits)}</span>
                    ${isPlayed ? '<span class="nb-tag">you played this</span>' : ""}
                    <p class="nb-why">${why}</p>
                  </div>`;
              })
              .join("")}
          </div>
          <p class="next-best-mode-note">The ranking is Shannon entropy plus a win-bonus correction (Healy, 2022): a guess that could itself be the answer gets +p<sub>win</sub> bits added on top of its raw entropy, since winning outright beats merely narrowing the field to the same size without winning. This is what breaks the old tie between two guesses carrying identical bits: the one that's a live candidate now outranks the one that isn't. It still doesn't weight a word by anything beyond that specific correction, so among words that are equally live candidates (or equally not), the ranking is unchanged. The commonness badge and vowel note per word above are tidbits, not separate scoring terms: the badge reflects how often the word is used in everyday English globally (Google Books Ngram data), not Wordle-answer likelihood. Vowel coverage is already fully priced into the entropy number itself (see the citations in the formula reference above), so an explicit vowel bonus on top would just double-count it.</p>
        </div>
      `;

      deepBody.appendChild(row);

      renderFormula(
        formulaId,
        `H(\\text{${step.guess}}) = -\\sum_{i=1}^{${p.bucketsUsed}} p_i \\log_2 p_i = ${p.bits.toFixed(
          3
        )}\\ \\text{bits}, \\quad p_i = n_i / ${step.before}`
      );

      renderFormula(
        `${formulaId}-kl`,
        `D_{KL}(P\\Vert U) = \\sum_i p_i \\log_2\\!\\dfrac{p_i}{1/243} = ${p.klDivergence.toFixed(
          3
        )}\\ \\text{bits}`
      );

      renderFormula(
        `${formulaId}-win`,
        `H'(\\text{${step.guess}}) = H(\\text{${step.guess}}) + p_{\\text{win}} = ${p.bits.toFixed(
          3
        )} + ${p.pWin.toFixed(3)} = ${p.adjustedBits.toFixed(3)}\\ \\text{bits}`
      );
    });

    const summary = document.createElement("div");
    summary.className = "deep-summary";

    const avgBits = totalBits / guessesUsed;
    const infoEfficiency = Math.min(100, (avgBits / MAX_BITS_PER_GUESS) * 100);
    const theoreticalMin = Math.max(1, Math.ceil(Math.log2(startSize) / MAX_BITS_PER_GUESS));

    summary.innerHTML = `
      <div class="deep-stats">
        <div><p>TOTAL BITS EARNED</p><strong>${fmtBits(totalBits)}</strong></div>
        <div><p>AVG BITS / GUESS</p><strong>${fmtBits(avgBits)}</strong></div>
        <div><p>INFO EFFICIENCY</p><strong>${infoEfficiency.toFixed(0)}%</strong></div>
      </div>
      <p class="deep-formula" id="deepFormulaSummary"></p>
      <p class="deep-note">
        A single guess can carry at most log₂(243) ≈ ${MAX_BITS_PER_GUESS.toFixed(2)} bits, since
        Wordle feedback has only 3⁵ = 243 possible patterns. Starting from ${startSize.toLocaleString()}
        candidates, the information-theoretic floor is ⌈log₂(${startSize.toLocaleString()}) ÷
        ${MAX_BITS_PER_GUESS.toFixed(2)}⌉ = ${theoreticalMin} guess${theoreticalMin === 1 ? "" : "es"},
        the fewest a solver could need if every guess split the field perfectly evenly.
        Your run averaged ${(infoEfficiency).toFixed(0)}% of that per-guess ceiling.
        ${
          candidates.length > 1 && !solvedAt
            ? `${candidates.length.toLocaleString()} candidates still remain unresolved.`
            : ""
        }
      </p>
    `;

    deepBody.appendChild(summary);

    renderFormula(
      "deepFormulaSummary",
      `n^{*} = \\left\\lceil \\dfrac{\\log_2(${startSize.toLocaleString().replace(/,/g, "{,}")})}{\\log_2(243)} \\right\\rceil = \\left\\lceil \\dfrac{${Math.log2(
        startSize
      ).toFixed(2)}}{${MAX_BITS_PER_GUESS.toFixed(4)}} \\right\\rceil = ${theoreticalMin}`,
      true
    );

    renderGrade(steps, solvedAt, guessesUsed, avgBits, infoEfficiency, theoreticalMin);
    renderTraps(steps, solvedAt);
  }, 20);
}

// Composite 0-100 score: guess quality (45%), solve speed (35%), per-step luck (20%).
//
// Why not grade against the raw 7.92-bit (log2 243) ceiling or dock a flat
// 12 points per guess used? Both treat an unreachable ideal as the baseline.
// No real guess ever splits 243 ways evenly against a live answer list, so
// scoring "avg bits / 7.92" or penalizing every guess past guess 1 the same
// amount fails good play: it grades you against a solver that doesn't exist
// rather than against the best move actually available at each step.
// Instead:
//   - Guess quality asks "how good was the word you picked, relative to the
//     best word Entrople could find for that exact step" (win-bonus-adjusted
//     entropy ratio). That's the real skill signal.
//   - Solve speed compares your guess count to a realistic target
//     (the information-theoretic minimum, plus one extra guess of slack --
//     since no real opening word partitions perfectly), not to "1 guess."
//   - Luck factor (already computed elsewhere) captures how the dice fell
//     independent of whether the guess itself was sound.
function renderGrade(steps, solvedAt, guessesUsed, avgBits, infoEfficiency, theoreticalMin) {
  const card = document.querySelector("#gradeCard");
  card.classList.remove("disabled");

  const luckValues = steps.map((s) =>
    s.expected > 0 ? Math.min(100, (s.actualBits / s.expected) * 100) : 100
  );
  const luckScore = luckValues.reduce((a, b) => a + b, 0) / luckValues.length;

  // How good was each guess, relative to the best word available for that
  // exact step (both scored win-bonus-adjusted, so a guess that could win
  // outright is compared fairly against other guesses that could too).
  const qualityValues = steps.map((s) => {
    const bestBits = s.best?.top?.[0]?.adjustedBits ?? s.profile.adjustedBits;
    if (bestBits <= 0) return 100; // only one legal word left to try
    return Math.min(100, (s.profile.adjustedBits / bestBits) * 100);
  });
  const guessQualityScore = qualityValues.reduce((a, b) => a + b, 0) / qualityValues.length;

  // A realistic target: the information-theoretic floor, plus one guess of
  // slack, since perfectly even 243-way splits don't occur against a real
  // answer list. Full marks at or under that target; -15 per guess beyond it.
  const speedTarget = Math.max(1, theoreticalMin + 1);
  const speedEfficiencyScore = solvedAt
    ? Math.max(0, 100 - Math.max(0, solvedAt - speedTarget) * 15)
    : 0;

  const WEIGHTS = { quality: 0.45, speed: 0.35, luck: 0.2 };
  const rawScore =
    WEIGHTS.quality * guessQualityScore +
    WEIGHTS.speed * speedEfficiencyScore +
    WEIGHTS.luck * luckScore;
  const score = Math.max(0, Math.min(100, rawScore));

  // +/- is a within-band modifier: top third of the band earns a +,
  // bottom third earns a -.
  const BANDS = [
    { letter: "S", low: 93, high: 100.001 },
    { letter: "A", low: 85, high: 93 },
    { letter: "B", low: 75, high: 85 },
    { letter: "C", low: 65, high: 75 },
    { letter: "D", low: 50, high: 65 },
    { letter: "F", low: 0, high: 50 },
  ];

  function gradeFor(s) {
    const band = BANDS.find((b) => s >= b.low && s < b.high) || BANDS[BANDS.length - 1];
    const frac = (s - band.low) / (band.high - band.low);
    if (band.letter === "F") return "F";
    if (band.letter === "S") return frac >= 0.6 ? "S+" : "S";
    if (frac >= 2 / 3) return `${band.letter}+`;
    if (frac < 1 / 3) return `${band.letter}-`;
    return band.letter;
  }

  let letter = gradeFor(score);

  if (!solvedAt) letter = score >= 50 ? (score >= 57.5 ? "D+" : score >= 42.5 ? "D" : "D-") : "F";

  const verdicts = {
    S: "Near-optimal. Your guesses tracked the best word available at nearly every step, you solved at or ahead of a realistic guess-count target, and the outcomes largely matched what the entropy math expected.",
    A: "Excellent play. Your guesses were consistently close to the best word Entrople could find for each step, and you solved efficiently relative to the information-theoretic floor.",
    B: "A solid, above-average solve. Most guesses were close to optimal for their step, with some room to trim either guess quality or guess count.",
    C: "A workable solve, but a meaningful gap opened between the guesses you played and the best available guess at one or more steps, or you used more guesses than the candidate pool justified.",
    D: solvedAt
      ? "You solved it, but the guesses played were well off the best available guess for their step, the guess count ran well past a realistic target, or both."
      : "The puzzle wasn't solved within the guesses evaluated, which caps the grade regardless of how any individual guess scored.",
    F: solvedAt
      ? "Solved, but guess quality and pacing were weak across the board relative to what the candidate pool allowed."
      : "Not solved, and the guesses played were well off the best available guess as well.",
  };

  document.querySelector("#gradeLetter").className = `grade-letter grade-${letter[0].toLowerCase()}`;
  document.querySelector("#gradeLetter").textContent = letter;
  document.querySelector("#gradeScore").textContent = score.toFixed(1);
  document.querySelector("#gradeVerdict").textContent = verdicts[letter[0]];

  const rows = [
    {
      label: "GUESS QUALITY",
      detail: `avg ${guessQualityScore.toFixed(0)}% of best available guess's bits, per step`,
      value: guessQualityScore,
      weight: WEIGHTS.quality,
    },
    {
      label: "SOLVE SPEED",
      detail: solvedAt
        ? `solved on guess ${solvedAt} of 6 (target ≤${speedTarget} given a ${theoreticalMin}-guess floor)`
        : "not solved",
      value: speedEfficiencyScore,
      weight: WEIGHTS.speed,
    },
    {
      label: "PER-STEP LUCK FACTOR",
      detail: `mean actual ÷ expected bits across ${luckValues.length} guess${
        luckValues.length === 1 ? "" : "es"
      }`,
      value: luckScore,
      weight: WEIGHTS.luck,
    },
  ];

  const breakdown = document.querySelector("#gradeBreakdown");
  breakdown.innerHTML = rows
    .map(
      (row) => `
        <div>
          <p>${row.label}<br><small>${row.detail}</small></p>
          <strong>${row.value.toFixed(1)}</strong>
          <small>× ${(row.weight * 100).toFixed(0)}%</small>
          <div class="grade-bar"><i style="width:${Math.max(0, Math.min(100, row.value))}%"></i></div>
        </div>`
    )
    .join("");

  renderFormula(
    "gradeFormula",
    `\\text{Score} = 0.45(${guessQualityScore.toFixed(0)}) + 0.35(${speedEfficiencyScore.toFixed(
      0
    )}) + 0.20(${luckScore.toFixed(0)}) = ${score.toFixed(1)} \\Rightarrow \\text{${letter}}`,
    true
  );
}

// A "swap trap" (e.g. BATCH/CATCH/HATCH) is a run of guesses stuck in a small word family.
function analyzeTraps(steps) {
  const traps = [];
  let i = 0;

  while (i < steps.length) {
    const cands = steps[i].beforeCandidates;

    if (cands.length >= 3) {
      const openPositions = [];
      for (let pos = 0; pos < 5; pos++) {
        const letters = new Set(cands.map((w) => w[pos]));
        if (letters.size > 1) openPositions.push(pos);
      }

      if (openPositions.length > 0 && openPositions.length <= 2) {
        let span = 1;
        while (
          i + span < steps.length &&
          steps[i + span].beforeCandidates.length > 1 &&
          steps[i + span].beforeCandidates.every((w) => cands.includes(w))
        ) {
          span++;
        }

        traps.push({
          startStep: i,
          span,
          openPositions,
          familySize: cands.length,
          family: cands,
        });

        i += span;
        continue;
      }
    }

    i++;
  }

  return traps;
}

function renderTraps(steps, solvedAt) {
  const card = document.querySelector("#trapCard");
  const body = document.querySelector("#trapBody");

  const traps = analyzeTraps(steps);

  if (!traps.length) {
    card.classList.add("hidden");
    body.innerHTML = "";
    return;
  }

  card.classList.remove("hidden");
  body.innerHTML = "";

  traps.forEach((trap) => {
    const guessesInTrap = steps
      .slice(trap.startStep, trap.startStep + trap.span)
      .map((s) => s.guess);
    const posLabel = trap.openPositions.map((p) => p + 1).join(" & ");
    const bitsNeeded = Math.log2(trap.familySize);
    const efficient = trap.span <= Math.ceil(bitsNeeded);
    const familyPreview = trap.family.slice(0, 12);
    const overflow = trap.family.length - familyPreview.length;

    const highlightWord = (word) =>
      word
        .split("")
        .map((ch, idx) =>
          trap.openPositions.includes(idx) ? `<b>${ch}</b>` : ch
        )
        .join("");

    const flavor =
      trap.familySize >= 5
        ? "🕳️ That's a deep trap."
        : trap.familySize >= 3
        ? "🪤 That's a classic swap trap."
        : "⚠️ A small fork in the road.";

    const row = document.createElement("div");
    row.className = "trap-row";
    row.innerHTML = `
      <div class="trap-row-head">
        <b>${flavor} Guess${trap.span > 1 ? "es" : ""} ${
      String(trap.startStep + 1).padStart(2, "0")
    }${trap.span > 1 ? `–${String(trap.startStep + trap.span).padStart(2, "0")}` : ""}</b>
        <span>${trap.familySize.toLocaleString()}-word family</span>
      </div>
      <p class="trap-copy">
        Right before ${guessesInTrap.length > 1 ? "this run of guesses" : `<b>${guessesInTrap[0]}</b>`},
        <b>${trap.familySize}</b> words were still live and agreed on every letter except
        position${trap.openPositions.length > 1 ? "s" : ""} <b>${posLabel}</b>, bolded below:
      </p>
      <p class="trap-family">
        ${familyPreview.map(highlightWord).join(", ")}${overflow > 0 ? `, +${overflow} more` : ""}
      </p>
      <p class="trap-copy">
        With only ${openPositionsWord(trap.openPositions.length)} actually undetermined, a normal
        guess can't teach you much more than "yes" or "no" on one candidate at a time. The
        information-theoretic cost of telling ${trap.familySize} words apart is only
        log₂(${trap.familySize}) ≈ ${bitsNeeded.toFixed(2)} bits, but real guesses spent here:
        <b>${trap.span}</b>${
      trap.span > 1
        ? ` (${guessesInTrap.join(" → ")})`
        : ""
    }. ${
      efficient
        ? "You cleared the trap about as fast as the math allowed."
        : "That's more guesses than the family's raw information content required. The trap cost you tempo."
    }
      </p>
    `;

    body.appendChild(row);
  });

  if (!solvedAt) {
    const note = document.createElement("p");
    note.className = "trap-copy trap-unsolved-note";
    note.textContent =
      "The board ran out before a trap fully resolved. Worth a rematch to see if it breaks faster.";
    body.appendChild(note);
  }
}

function openPositionsWord(n) {
  return n === 1 ? "one letter" : `${n} letters`;
}

// Renders the static formula-reference panel; per-step formulas plug in actual numbers.
let formulaReferenceRendered = false;
function renderFormulaReference() {
  if (formulaReferenceRendered) return;
  formulaReferenceRendered = true;

  renderFormula("fPattern", `p_i = \\dfrac{n_i}{N}, \\quad \\sum_{i=1}^{243} n_i = N`);
  renderFormula(
    "fEntropy",
    `H(\\text{guess}) = -\\sum_{i=1}^{243} p_i \\log_2 p_i`
  );
  renderFormula(
    "fActual",
    `I_{\\text{actual}} = \\log_2 N_{\\text{before}} - \\log_2 N_{\\text{after}} = \\log_2\\!\\left(\\dfrac{N_{\\text{before}}}{N_{\\text{after}}}\\right)`
  );
  renderFormula(
    "fExpectedRemain",
    `\\mathbb{E}[N'] = \\sum_i p_i n_i = \\dfrac{1}{N}\\sum_i n_i^2`
  );
  renderFormula(
    "fVariance",
    `\\sigma^2 = \\dfrac{1}{k}\\sum_i (n_i - \\bar n)^2, \\quad \\bar n = \\dfrac{N}{k}`
  );
  renderFormula(
    "fKL",
    `D_{KL}(P\\Vert U) = \\sum_i p_i \\log_2\\!\\dfrac{p_i}{1/243}`
  );
  renderFormula(
    "fMinGuesses",
    `n^{*} = \\left\\lceil \\dfrac{\\log_2 N_0}{\\log_2 243} \\right\\rceil`
  );
  renderFormula(
    "fWinBonus",
    `H'(\\text{guess}) = H(\\text{guess}) + p_{\\text{win}}, \\quad p_{\\text{win}} = \\Pr(\\text{guess is the answer}) = \\dfrac{n_{\\text{GGGGG}}}{N}`
  );
}

async function lookupFreeDictionary(word) {
  const res = await fetch(DEFINE_API(word));
  if (!res.ok) return null;

  const data = await res.json();
  const meaning = data[0]?.meanings?.[0];
  const definition = meaning?.definitions?.[0]?.definition;
  if (!definition) return null;

  return { definition, partOfSpeech: meaning?.partOfSpeech, source: "Free Dictionary API" };
}

async function lookupWiktionary(word) {
  const res = await fetch(WIKTIONARY_API(word));
  if (!res.ok) return null;

  const data = await res.json();
  const posBlock = data?.en?.[0];
  const rawDefinition = posBlock?.definitions?.[0]?.definition;
  if (!rawDefinition) return null;

  // Wiktionary definitions are HTML fragments, strip tags for display.
  const definition = rawDefinition.replace(/<[^>]+>/g, "").trim();
  if (!definition) return null;

  return { definition, partOfSpeech: posBlock.partOfSpeech, source: "Wiktionary" };
}

async function renderDefinition(answer) {
  const card = document.querySelector("#defineCard");
  const body = document.querySelector("#defineBody");

  const commonness = englishCommonnessTier(answer);
  const commonnessBadge = `<span class="nb-commonness nb-commonness-${commonness.tier} define-commonness" title="How commonly ${answer} is used in everyday English globally, not how likely it is to be the Wordle answer">${commonness.label}</span>`;

  card.classList.remove("hidden");
  body.innerHTML = "Looking up a definition…";

  let result = null;

  try {
    result = await lookupFreeDictionary(answer);
  } catch {
    result = null;
  }

  if (!result) {
    try {
      result = await lookupWiktionary(answer);
    } catch {
      result = null;
    }
  }

  if (result) {
    body.innerHTML = `<b>${answer}</b>${commonnessBadge}${
      result.partOfSpeech ? ` <em>${result.partOfSpeech}</em>` : ""
    }: ${result.definition}<span class="define-source">SOURCE: ${result.source.toUpperCase()}</span>`;
  } else {
    body.innerHTML =
      `<b>${answer}</b>${commonnessBadge}: no definition found in either connected dictionary source ` +
      `for this word. It may be a proper noun, an archaic or dialect form, or both ` +
      `dictionary services may be temporarily unreachable.`;
  }
}

// simulateOptimalSolve and simulateOptimalSolveDeep now live in
// js/core/simulation.js (loaded before this file), alongside the rest of
// the game-playing engine.

// Selectors for the two places the solve-board animation can render: the
// analyzer tab's "How Entrople Would Solve" card, and the "today" tab's own
// live solve. Passed through buildSolveBoard / triggerSolveAnimation / armSolveReveal
// so both tabs share one implementation instead of duplicating the animation logic.
const SOLVE_IDS = {
  analyzer: { card: "#solveCard", board: "#solveBoard", steps: "#solveSteps" },
  today: { card: "#todaySolveCard", board: "#todaySolveBoard", steps: "#todaySolveSteps" },
};

// Tracks the in-flight IntersectionObserver (if any) per solve card, keyed by
// card selector, so re-rendering or replaying a solve cleans up the right one.
const solveObservers = {};

function disconnectSolveObserver(cardSelector) {
  const entry = solveObservers[cardSelector];
  if (!entry) return;
  entry.observer.disconnect();
  clearTimeout(entry.fallbackTimer);
  delete solveObservers[cardSelector];
}

let cachedSolve = null; // { answer, steps }, avoids re-running the search on replay

function renderEntropleSolve(answer, context) {
  const ids = SOLVE_IDS.analyzer;
  const card = document.querySelector(ids.card);
  const boardEl = document.querySelector(ids.board);
  const stepsEl = document.querySelector(ids.steps);
  const summaryEl = document.querySelector("#solveSummary");
  const replayBtn = document.querySelector("#solveReplay");

  disconnectSolveObserver(ids.card);

  if (words.status !== "ready") {
    card.classList.add("disabled");
    boardEl.innerHTML = "";
    stepsEl.innerHTML =
      `<p class="solve-empty">Entrople's own solve needs the live word dictionary. Reload with a network connection to unlock it.</p>`;
    summaryEl.textContent = "";
    replayBtn.classList.add("hidden");
    cachedSolve = null;
    return;
  }

  card.classList.remove("disabled");
  boardEl.innerHTML = "";
  boardEl.classList.remove("animate");
  stepsEl.classList.remove("animate");
  stepsEl.innerHTML = `<p class="solve-empty">Solving with win-bonus-adjusted entropy search…</p>`;
  summaryEl.textContent = "";
  replayBtn.classList.add("hidden");

  setTimeout(() => {
    const steps = simulateOptimalSolve(answer);
    cachedSolve = { answer, steps };

    buildSolveBoard(steps, ids);

    const solvedAt = steps.length;
    let compareLine = "";

    if (context && context.solvedAt) {
      const diff = context.solvedAt - solvedAt;
      if (diff > 0) {
        compareLine = ` Your solve used ${diff} more ${diff === 1 ? "guess" : "guesses"} than this optimal route.`;
      } else if (diff === 0) {
        compareLine = ` Your solve matched the optimal route's guess count exactly.`;
      } else {
        const beat = -diff;
        compareLine =
          ` Your solve actually beat the win-bonus-adjusted search by ${beat} ${beat === 1 ? "guess" : "guesses"}, a` +
          ` well-timed non-greedy pick can still win faster than always taking the highest` +
          ` adjusted-entropy legal guess.`;
      }
    } else if (context && !context.solvedAt) {
      compareLine = ` Your board didn't reach the answer within the guesses evaluated.`;
    }

    summaryEl.innerHTML =
      `Playing win-bonus-adjusted entropy search (always the single highest adjusted-information ` +
      `legal guess, honoring ${solveMode === "hard" ? "Hard Mode" : "Normal Mode"}), Entrople solves <b>${answer}</b> in <b>${solvedAt} ${
        solvedAt === 1 ? "guess" : "guesses"
      }</b> against the live ${words.answers.length.toLocaleString()}-word pool.${compareLine}`;

    replayBtn.classList.remove("hidden");
    armSolveReveal(ids);
  }, 20);
}

// Waits until a solve card first scrolls into view before playing the reveal
// animation. Falls back to a timer so the tiles never get stuck invisible if
// the observer never fires (e.g. the card is taller than the viewport, or
// already mid-layout). `ids` selects which card/board/steps to arm (see
// SOLVE_IDS above).
function armSolveReveal(ids) {
  const card = document.querySelector(ids.card);
  if (!card) return;

  disconnectSolveObserver(ids.card);

  if (!("IntersectionObserver" in window)) {
    triggerSolveAnimation(ids);
    return;
  }

  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    triggerSolveAnimation(ids);
    disconnectSolveObserver(ids.card);
  };

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting || entry.intersectionRatio > 0) fire();
      });
    },
    { threshold: 0 }
  );

  observer.observe(card);

  // Defensive fallback: guarantees the reveal plays even if the observer
  // never reports an intersection (zero-height element at observe time, etc).
  const fallbackTimer = setTimeout(fire, 600);
  solveObservers[ids.card] = { observer, fallbackTimer };
}

function buildSolveBoard(steps, ids) {
  const boardEl = document.querySelector(ids.board);
  const stepsEl = document.querySelector(ids.steps);

  boardEl.innerHTML = "";
  stepsEl.innerHTML = "";

  steps.forEach((step, i) => {
    const row = document.createElement("div");
    row.className = "board-row solve-row";

    step.marks.forEach((mark, ti) => {
      const tile = document.createElement("span");
      tile.className = `tile ${mark}`;
      tile.textContent = step.guess[ti];
      tile.style.setProperty("--tile-delay", `${i * 850 + ti * 130}ms`);
      row.appendChild(tile);
    });

    boardEl.appendChild(row);

    const line = document.createElement("div");
    line.className = "solve-step-line";
    line.style.setProperty("--row-delay", `${i * 850 + 500}ms`);
    line.innerHTML = `
      <span class="n">${String(i + 1).padStart(2, "0")}</span>
      <b>${step.guess}</b>
      <p>${
        step.solved
          ? "Exact match. Solved."
          : `${step.before.toLocaleString()} → ${step.after.toLocaleString()} candidates` +
            (step.bits ? ` · ${fmtBits(step.bits)} expected` : "")
      }</p>
      <span class="score">${step.bits ? fmtBits(step.bits) : ""}</span>
    `;
    stepsEl.appendChild(line);
  });
}

function triggerSolveAnimation(ids) {
  const boardEl = document.querySelector(ids.board);
  const stepsEl = document.querySelector(ids.steps);
  if (!boardEl || !stepsEl) return;

  boardEl.classList.remove("animate");
  stepsEl.classList.remove("animate");
  // Force a reflow so re-adding the class restarts the CSS animations.
  void boardEl.offsetWidth;
  boardEl.classList.add("animate");
  stepsEl.classList.add("animate");
}

/* Event wiring */
answerEl.addEventListener("input", (event) => {
  event.target.value = clean(event.target.value);
});

document.querySelector("#addGuess").addEventListener("click", () => {
  if (guesses.length < 6) {
    guesses.push("");
    renderInputs();
    guessList.lastElementChild.querySelector("input").focus();
  }
});

document.querySelector("#clearBtn").addEventListener("click", () => {
  answerEl.value = "";
  guesses = [""];
  renderInputs();
  answerEl.focus();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  analyze();
});

document.querySelector("#solveReplay").addEventListener("click", () => {
  if (!cachedSolve) return;
  disconnectSolveObserver(SOLVE_IDS.analyzer.card);
  triggerSolveAnimation(SOLVE_IDS.analyzer);
});

document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.mode === solveMode) return;
    solveMode = btn.dataset.mode;
    document
      .querySelectorAll(".mode-btn")
      .forEach((b) => b.classList.toggle("active", b.dataset.mode === solveMode));
    analyze();
  });
});

/* ---------------------------------------------------------------------- */
/* "Entrople Solves Today's Wordle" tab                                    */
/* ---------------------------------------------------------------------- */

let cachedTodaySolve = null; // { answer, steps, puzzle }, avoids re-solving on reveal/replay

// Renders the guess-by-guess entropy breakdown for the today's-Wordle tab.
// Mirrors renderDeepMath's per-step stat cards and KaTeX formulas, but works
// off simulateOptimalSolveDeep's steps directly instead of comparing against
// a human's guesses (there's nothing to compare against here: Entrople's
// picks ARE the top-ranked guess by construction at every step).
function renderTodayDeepMath(steps, startSize) {
  const deepBody = document.querySelector("#todayDeepBody");
  deepBody.innerHTML = "";

  let totalBits = 0;

  steps.forEach((step, i) => {
    totalBits += step.actualBits;
    const p = step.profile;
    const row = document.createElement("div");
    row.className = "deep-row";
    const formulaId = `todayDeepFormula${i}`;

    row.innerHTML = `
      <div class="deep-row-head">
        <b>${String(i + 1).padStart(2, "0")} · ${step.guess}</b>
        <span>${step.before.toLocaleString()} → ${step.after.toLocaleString()} candidates</span>
      </div>
      <div class="deep-stats">
        <div><p>ACTUAL INFO GAINED</p><strong>${fmtBits(step.actualBits)}</strong></div>
        <div><p>RAW ENTROPY</p><strong>${fmtBits(p.bits)}</strong></div>
        <div><p>WIN-BONUS ADJUSTED</p><strong>${fmtBits(p.adjustedBits)}</strong></div>
      </div>
      <div class="deep-stats-2">
        <div><p>PATTERN BUCKETS USED</p><strong>${p.bucketsUsed} / 243</strong></div>
        <div><p>E[N'] = Σnᵢ²/N</p><strong>${p.expectedRemaining.toFixed(1)}</strong></div>
        <div><p>σ(bucket size)</p><strong>±${p.stdDev.toFixed(1)}</strong></div>
      </div>
      <div class="deep-stats-2">
        <div><p>D_KL(P‖UNIFORM)</p><strong>${p.klDivergence.toFixed(3)} bits</strong></div>
        <div><p>LARGEST BUCKET</p><strong>${p.maxBucket.toLocaleString()} (${(
          (p.maxBucket / step.before) *
          100
        ).toFixed(1)}%)</strong></div>
        <div><p>MEAN BUCKET SIZE</p><strong>${p.mean.toFixed(1)}</strong></div>
      </div>
      <div class="histogram" title="Each bar is one realized feedback pattern, sorted largest to smallest">
        ${p.buckets
          .slice(0, 60)
          .map(
            (n) =>
              `<span style="height:${Math.max(4, (n / p.maxBucket) * 100)}%" title="${n} candidates"></span>`
          )
          .join("")}
        ${p.buckets.length > 60 ? `<em>+${p.buckets.length - 60} more</em>` : ""}
      </div>
      <p class="deep-formula" id="${formulaId}"></p>
      <p class="deep-formula" id="${formulaId}-win"></p>
      <p class="deep-formula" id="${formulaId}-kl"></p>
      <p class="deep-note">
        ${
          step.solved
            ? `Exact match: this word was itself the top-ranked candidate, carrying a ${(p.pWin * 100).toFixed(
                1
              )}% chance of being the answer baked directly into its score.`
            : `Chosen as the single highest win-bonus-adjusted score across the ${step.before.toLocaleString()}-word live candidate pool. The largest single bucket it could have landed in held ${p.maxBucket.toLocaleString()} of those candidates (mean bucket size across the ${
                p.bucketsUsed
              } realized patterns was ${p.mean.toFixed(1)}).`
        }
      </p>
    `;

    deepBody.appendChild(row);

    renderFormula(
      formulaId,
      `H(\\text{${step.guess}}) = -\\sum_{i=1}^{${p.bucketsUsed}} p_i \\log_2 p_i = ${p.bits.toFixed(
        3
      )}\\ \\text{bits}, \\quad p_i = n_i / ${step.before}`
    );

    renderFormula(
      `${formulaId}-win`,
      `H'(\\text{${step.guess}}) = H(\\text{${step.guess}}) + p_{\\text{win}} = ${p.bits.toFixed(
        3
      )} + ${p.pWin.toFixed(3)} = ${p.adjustedBits.toFixed(3)}\\ \\text{bits}`
    );

    renderFormula(
      `${formulaId}-kl`,
      `D_{KL}(P\\Vert U) = \\sum_i p_i \\log_2\\!\\dfrac{p_i}{1/243} = ${p.klDivergence.toFixed(
        3
      )}\\ \\text{bits}`
    );
  });

  const guessesUsed = steps.length;
  const avgBits = totalBits / guessesUsed;
  const infoEfficiency = Math.min(100, (avgBits / MAX_BITS_PER_GUESS) * 100);
  const theoreticalMin = Math.max(1, Math.ceil(Math.log2(startSize) / MAX_BITS_PER_GUESS));

  const summary = document.createElement("div");
  summary.className = "deep-summary";
  summary.innerHTML = `
    <div class="deep-stats">
      <div><p>TOTAL BITS EARNED</p><strong>${fmtBits(totalBits)}</strong></div>
      <div><p>AVG BITS / GUESS</p><strong>${fmtBits(avgBits)}</strong></div>
      <div><p>INFO EFFICIENCY</p><strong>${infoEfficiency.toFixed(0)}%</strong></div>
    </div>
    <p class="deep-formula" id="todayDeepFormulaSummary"></p>
    <p class="deep-note">
      A single guess can carry at most log₂(243) ≈ ${MAX_BITS_PER_GUESS.toFixed(2)} bits, since
      Wordle feedback has only 3⁵ = 243 possible patterns. Starting from ${startSize.toLocaleString()}
      candidates, the information-theoretic floor is ⌈log₂(${startSize.toLocaleString()}) ÷
      ${MAX_BITS_PER_GUESS.toFixed(2)}⌉ = ${theoreticalMin} guess${theoreticalMin === 1 ? "" : "es"}.
      Today's run averaged ${infoEfficiency.toFixed(0)}% of that per-guess ceiling.
    </p>
  `;
  deepBody.appendChild(summary);

  renderFormula(
    "todayDeepFormulaSummary",
    `n^{*} = \\left\\lceil \\dfrac{\\log_2(${startSize
      .toLocaleString()
      .replace(/,/g, "{,}")})}{\\log_2(243)} \\right\\rceil = \\left\\lceil \\dfrac{${Math.log2(
      startSize
    ).toFixed(2)}}{${MAX_BITS_PER_GUESS.toFixed(4)}} \\right\\rceil = ${theoreticalMin}`,
    true
  );
}

// Populates the (still spoiler-covered) board, summary, and math cards once
// today's answer is known and the live dictionary is ready. Nothing here is
// visible until the person clicks the reveal button — the spoiler cover just
// blurs the already-built DOM.
function finishTodaySolve(answer, puzzle) {
  const steps = simulateOptimalSolveDeep(answer);
  cachedTodaySolve = { answer, steps, puzzle };

  buildSolveBoard(steps, SOLVE_IDS.today);

  const solvedAt = steps.length;
  document.querySelector("#todaySolveSummary").innerHTML =
    `Playing win-bonus-adjusted entropy search (always the single highest adjusted-information ` +
    `legal guess, honoring ${solveMode === "hard" ? "Hard Mode" : "Normal Mode"}), Entrople solves today's ` +
    `answer in <b>${solvedAt} ${solvedAt === 1 ? "guess" : "guesses"}</b> against the live ` +
    `${words.answers.length.toLocaleString()}-word pool.`;

  const poolSize = words.answers.length;
  const baseBits = Math.log2(poolSize);
  document.querySelector("#todayBits").textContent = `≈ ${baseBits.toFixed(2)} bits`;
  document.querySelector("#todayPoolSizeLabel").textContent = poolSize.toLocaleString();
  document.querySelector("#todayMathCopy").textContent =
    `Starting from a live ${poolSize.toLocaleString()}-word answer pool, identifying one exact answer ` +
    `requires log₂(${poolSize.toLocaleString()}) = ${baseBits.toFixed(2)} bits. Entrople reached it in ` +
    `${solvedAt} of 6 guesses.`;

  renderTodayDeepMath(steps, poolSize);

  const revealBtn = document.querySelector("#todayRevealBtn");
  revealBtn.disabled = false;
  revealBtn.textContent = "REVEAL TODAY'S SOLVE →";
}

function setTodayFetchStatus(text, tone) {
  const el = document.querySelector("#todayFetchStatus");
  el.textContent = text;
  el.className = tone ? `method data-status ${tone}` : "method";
}

function showTodayError(message) {
  document.querySelector("#todayError").textContent = message;
  document.querySelector("#todayRetryBtn").classList.remove("hidden");
  document.querySelector("#todayManualFallback").classList.remove("hidden");
  document.querySelector("#todayRevealBtn").textContent = "UNAVAILABLE";
}

async function initTodaySolve() {
  const dateStr = todaysEasternDate();
  const dateLabel = document.querySelector("#todayDateLabel");
  const revealBtn = document.querySelector("#todayRevealBtn");

  document.querySelector("#todayError").textContent = "";
  document.querySelector("#todayRetryBtn").classList.add("hidden");
  document.querySelector("#todayManualFallback").classList.add("hidden");
  document.querySelector("#todaySpoiler").classList.remove("revealed");
  document.querySelector("#todaySolveReplay").classList.add("hidden");
  revealBtn.disabled = true;
  revealBtn.textContent = "SOLVING…";

  const prettyDate = new Date(`${dateStr}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  dateLabel.textContent = `Today's puzzle · ${prettyDate} (Eastern Time)`;

  let puzzle;
  try {
    setTodayFetchStatus("Fetching today's puzzle from the NYT Wordle API…");
    puzzle = await fetchTodaysWordle(dateStr);
  } catch (err) {
    console.error("Entrople: couldn't fetch today's Wordle", err);
    setTodayFetchStatus("Could not reach the NYT Wordle API.", "error");
    showTodayError(
      "Entrople couldn't fetch today's answer just now — it isn't in the local archive yet, the " +
        "NYT endpoint blocks direct cross-origin requests from a browser, and the public CORS " +
        "relays tried as a fallback also failed. You can retry, or enter today's answer yourself below."
    );
    return;
  }

  // Wait for the live word dictionary if it's still loading.
  while (words.status === "loading") {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  if (words.status !== "ready") {
    setTodayFetchStatus("Live word dictionary unavailable.", "error");
    showTodayError(
      "Entrople's own solve needs the live word dictionary, which failed to load. Reload with a " +
        "network connection to try again."
    );
    return;
  }

  setTodayFetchStatus(
    `Puzzle #${puzzle.id ?? "?"} fetched · solved live`,
    "ready"
  );

  finishTodaySolve(puzzle.solution.toUpperCase(), puzzle);
}

/* --- Deep Simulation tab ---
   Fixes a different opening guess per simulated game, then hands the rest of
   the game to Entrople's own win-bonus-adjusted entropy search, and reports
   how many of those games win inside six guesses. The batch loop runs in a
   Web Worker (js/core/simulation-worker.js) so a large sample doesn't freeze
   the tab; the main thread only accumulates progress and renders results. */

// A hand-picked spread of strong, average, and deliberately weak openers
// (duplicate letters, rare letters), so a small default run still shows a
// realistic mix of fast wins and the odd near-failure.
const SIM_CURATED_OPENERS = [
  "SALET", "CRANE", "TRACE", "SLATE", "CRATE", "SOARE", "ROATE", "RAISE", "ARISE", "IRATE",
  "STARE", "TEARS", "LEAST", "CARTE", "ADIEU", "AUDIO", "LATER", "ALTER", "STORE", "SNARE",
  "SHARE", "SPARE", "SHIRE", "SHONE", "STONE", "TONES", "NOTES", "SAINT", "STAIN", "RATIO",
  "RADIO", "MEDIA", "IDEAL", "OCEAN", "UNION", "ROUTE", "MOUSE", "HOUSE", "PLANE", "PLATE",
  "GRAPE", "GRACE", "BRAVE", "BRAKE", "DRIVE", "PRIDE", "PRIME", "CRIME", "CHASE", "PHASE",
  "PULSE", "EPOXY", "EXTRA", "EXCEL", "EQUAL", "EXILE", "EERIE", "LEVEL", "RADAR", "TOOTH",
  "ARENA", "GEESE", "MADAM", "QUEUE", "GAUGE",
];

const simAnswerEl = document.querySelector("#simAnswer");
const simPoolEl = document.querySelector("#simPool");
const simSampleEl = document.querySelector("#simSample");
const simSampleMaxEl = document.querySelector("#simSampleMax");
const simPoolHintEl = document.querySelector("#simPoolHint");
const simEstimateEl = document.querySelector("#simEstimate");
const simErrorEl = document.querySelector("#simError");
const simForm = document.querySelector("#simForm");
const simRunBtn = document.querySelector("#simRunBtn");
const simCancelBtn = document.querySelector("#simCancelBtn");
const simStatusEl = document.querySelector("#simStatus");
const simProgressWrap = document.querySelector("#simProgressWrap");
const simProgressFill = document.querySelector("#simProgressFill");
const simProgressLabel = document.querySelector("#simProgressLabel");
const simEmptyEl = document.querySelector("#simEmpty");
const simSummaryEl = document.querySelector("#simSummary");

let simMode = "hard"; // continuation mode after the fixed opener: "hard" | "easy"
let simWorker = null;
let simResults = [];
let simRunToken = 0; // bumped on cancel/rerun so late worker messages are ignored
let simCurrentAnswer = "";

function simPoolForSource(source) {
  if (source === "answers") return words.answers;
  if (source === "dictionary") return [...words.guesses];
  return SIM_CURATED_OPENERS;
}

function simPoolMeta(source) {
  if (source === "answers") {
    return {
      size: words.status === "ready" ? words.answers.length : 2309,
      label: "confirmed Wordle answers",
      heavy: false,
    };
  }
  if (source === "dictionary") {
    return {
      size: words.status === "ready" ? words.guesses.size : 14855,
      label: "words in the full guess dictionary",
      heavy: true,
    };
  }
  return { size: SIM_CURATED_OPENERS.length, label: "hand-picked openers", heavy: false };
}

// pickRandomSample now lives in js/core/simulation.js.

function updateSimControls() {
  const meta = simPoolMeta(simPoolEl.value);
  const defaultSample = simPoolEl.value === "curated" ? meta.size : Math.min(150, meta.size);

  simSampleEl.max = meta.size;
  simSampleEl.value = defaultSample;
  simSampleMaxEl.textContent = `of ${meta.size.toLocaleString()}`;
  simPoolHintEl.textContent =
    simPoolEl.value === "curated"
      ? "A hand-picked spread of strong, average, and weak openers, always fast."
      : simPoolEl.value === "answers"
      ? "Randomly sampled from the real answer list, without repeats."
      : "Randomly sampled from every legal guess, including obscure words. Heaviest option.";

  updateSimEstimate();
}

function updateSimEstimate() {
  const meta = simPoolMeta(simPoolEl.value);
  const sample = Math.max(1, Math.min(Number(simSampleEl.value) || 1, meta.size));

  let msg = `About to run ${plural(sample, "simulated game")} against ${meta.label} (${meta.size.toLocaleString()} available).`;
  if (sample >= 1000) msg += " That's a large batch, expect the run to take a while.";
  else if (meta.heavy) msg += " This pool includes rarer words, so a few games may be slower to converge.";
  simEstimateEl.textContent = msg;
}

simPoolEl.addEventListener("change", updateSimControls);
simSampleEl.addEventListener("input", updateSimEstimate);

document.querySelectorAll("#simForm .mode-toggle .mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!simCancelBtn.classList.contains("hidden")) return; // ignore while a run is in progress
    simMode = btn.dataset.simmode;
    document
      .querySelectorAll("#simForm .mode-toggle .mode-btn")
      .forEach((b) => b.classList.toggle("active", b === btn));
  });
});

function setSimRunning(isRunning) {
  simRunBtn.classList.toggle("hidden", isRunning);
  simCancelBtn.classList.toggle("hidden", !isRunning);
  simProgressWrap.classList.toggle("hidden", !isRunning);
  [simAnswerEl, simPoolEl, simSampleEl].forEach((el) => (el.disabled = isRunning));
}

// computeOpenerRoute now lives in js/core/simulation.js.

function renderSimOpenerDetail(container, result) {
  const steps = computeOpenerRoute(simCurrentAnswer, result.guesses);
  const board = document.createElement("div");
  board.className = "sim-mini-board";

  steps.forEach((step) => {
    const rowEl = document.createElement("div");
    rowEl.className = "sim-mini-row";
    step.guess.split("").forEach((letter, idx) => {
      const tile = document.createElement("span");
      tile.className = `tile ${step.marks[idx]}`;
      tile.textContent = letter;
      rowEl.appendChild(tile);
    });
    const meta = document.createElement("span");
    meta.className = "sim-mini-meta";
    meta.textContent = `${step.before.toLocaleString()} → ${step.after.toLocaleString()} candidates`;
    rowEl.appendChild(meta);
    board.appendChild(rowEl);
  });

  container.appendChild(board);

  if (!result.solved) {
    const last = steps[steps.length - 1];
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent =
      `After all 6 guesses, ${plural(last.after, "candidate")} still fit every clue: the ` +
      `win-bonus-adjusted entropy search ran out of guesses before it could isolate ${simCurrentAnswer}.`;
    container.appendChild(note);
  }
}

function buildSimOpenerRow(result) {
  const row = document.createElement("div");
  row.className = "sim-opener-row";

  const head = document.createElement("button");
  head.type = "button";
  head.className = "sim-opener-head";
  head.innerHTML = `
    <span class="chev">▶</span>
    <b>${result.opener}</b>
    <span class="sim-opener-note">${
      result.solved ? `solved in ${plural(result.guessCount, "guess")}` : "never converged"
    }</span>
    <span class="sim-opener-tag ${result.solved ? "won" : "failed"}">${result.solved ? "WIN" : "FAIL"}</span>
  `;

  const detail = document.createElement("div");
  detail.className = "sim-opener-detail";
  let built = false;

  head.addEventListener("click", () => {
    const isOpen = row.classList.toggle("open");
    if (isOpen && !built) {
      renderSimOpenerDetail(detail, result);
      built = true;
    }
  });

  row.appendChild(head);
  row.appendChild(detail);
  return row;
}

function finishSimulation(cancelled) {
  setSimRunning(false);
  simWorker = null;

  const total = simResults.length;
  simStatusEl.textContent = cancelled ? "CANCELLED" : "COMPLETE";

  if (total === 0) {
    simEmptyEl.textContent = cancelled
      ? "Cancelled before any simulations finished."
      : "No simulations ran.";
    simEmptyEl.classList.remove("hidden");
    simSummaryEl.classList.add("hidden");
    return;
  }

  simEmptyEl.classList.add("hidden");

  const wins = simResults.filter((r) => r.solved);
  const fails = simResults.filter((r) => !r.solved);
  const winRate = (wins.length / total) * 100;
  const avgGuesses = wins.length
    ? wins.reduce((sum, r) => sum + r.guessCount, 0) / wins.length
    : null;

  document.querySelector("#simWins").textContent = wins.length.toLocaleString();
  document.querySelector("#simWinPct").textContent = `${winRate.toFixed(1)}% win rate`;
  document.querySelector("#simTotal").textContent = total.toLocaleString();
  document.querySelector("#simPoolLabel").textContent = cancelled ? "cancelled early" : "openers tested";
  document.querySelector("#simAvg").textContent = avgGuesses ? avgGuesses.toFixed(2) : "–";
  document.querySelector("#simFails").textContent = fails.length.toLocaleString();

  const buckets = [1, 2, 3, 4, 5, 6];
  const bucketCounts = buckets.map((n) => wins.filter((r) => r.guessCount === n).length);
  const maxCount = Math.max(1, ...bucketCounts, fails.length);

  const distEl = document.querySelector("#simDist");
  distEl.innerHTML = "";

  buckets.forEach((n, i) => {
    const count = bucketCounts[i];
    const row = document.createElement("div");
    row.className = "sim-dist-row";
    row.innerHTML = `
      <span>${plural(n, "guess")}</span>
      <div class="sim-dist-bar-track"><div class="sim-dist-bar-fill" style="width:${(count / maxCount) * 100}%"></div></div>
      <span class="count">${count.toLocaleString()}</span>
    `;
    distEl.appendChild(row);
  });

  const failRow = document.createElement("div");
  failRow.className = "sim-dist-row failed";
  failRow.innerHTML = `
    <span>Never solved</span>
    <div class="sim-dist-bar-track"><div class="sim-dist-bar-fill" style="width:${(fails.length / maxCount) * 100}%"></div></div>
    <span class="count">${fails.length.toLocaleString()}</span>
  `;
  distEl.appendChild(failRow);

  const sortedWins = [...wins].sort(
    (a, b) => a.guessCount - b.guessCount || a.opener.localeCompare(b.opener)
  );
  const fastest = sortedWins.slice(0, 5);

  const standoutIntro = document.querySelector("#simStandoutIntro");
  standoutIntro.textContent = wins.length
    ? `Fastest openers reached ${simCurrentAnswer} in as few as ${plural(
        fastest[0].guessCount,
        "guess"
      )}. Tap any row for the full route.`
    : "None of the tested openers reached a win this run.";

  const bestEl = document.querySelector("#simBest");
  bestEl.innerHTML = "";
  fastest.forEach((r) => bestEl.appendChild(buildSimOpenerRow(r)));

  const failCard = document.querySelector("#simFailCard");
  const failListEl = document.querySelector("#simFailList");
  failListEl.innerHTML = "";

  if (fails.length) {
    failCard.classList.remove("hidden");
    const shown = fails.slice(0, 25);
    shown.forEach((r) => failListEl.appendChild(buildSimOpenerRow(r)));
    if (fails.length > shown.length) {
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = `+ ${(fails.length - shown.length).toLocaleString()} more opener(s) that never converged (showing the first ${shown.length}).`;
      failListEl.appendChild(note);
    }
  } else {
    failCard.classList.add("hidden");
  }

  simSummaryEl.classList.remove("hidden");

  if (cancelled) {
    const note = document.createElement("p");
    note.className = "sim-cancelled-note";
    note.textContent = `Run cancelled after ${plural(
      total,
      "simulated game"
    )}. The stats above reflect only what finished before you cancelled.`;
    simSummaryEl.prepend(note);
  }
}

// simulateGameFromOpener now lives in js/core/simulation.js and is shared
// verbatim by the worker (js/core/simulation-worker.js, via importScripts)
// and the main-thread fallback below -- there is exactly one implementation
// of "play one game with a forced opener", not two copies to keep in sync.

// Handles one worker-shaped message, whether it actually came from the
// worker or from the main-thread fallback loop below, so both paths share
// exactly one place that updates progress UI and finalizes results.
function handleSimMessage(msg, token) {
  if (token !== simRunToken) return; // stale message from a cancelled/replaced run

  if (msg.type === "progress") {
    simResults.push(...msg.batch);
    const pct = Math.round((msg.done / msg.total) * 100);
    simProgressFill.style.width = `${pct}%`;
    simProgressLabel.textContent = `Simulated ${msg.done.toLocaleString()} of ${msg.total.toLocaleString()} (${pct}%)…`;
  } else if (msg.type === "done") {
    finishSimulation(false);
  }
}

// Runs the exact same batch loop as the worker, but on the main thread,
// yielding to the browser between batches so the tab doesn't lock up. Used
// when Workers can't be constructed at all (browsers refuse to load a worker
// script for a page opened directly as a file:// URL, with no web server
// behind it) so the tab still works, just less smoothly.
async function runSimulationOnMainThread(answer, openers, answerPool, fullDictionaryArr, hardMode, token) {
  simStatusEl.textContent = "RUNNING (LOCAL)";
  simProgressLabel.textContent =
    "Background workers aren't available for a file opened directly from disk — running in this tab " +
    `instead. Simulated 0 of ${openers.length.toLocaleString()}…`;
  // Give the browser one paint before the (possibly heavy) synchronous work starts,
  // so the note above is actually visible rather than instantly overwritten.
  await new Promise((resolve) => setTimeout(resolve, 30));
  if (token !== simRunToken) return;

  const fullDictionary = new Set(fullDictionaryArr);
  const total = openers.length;
  const BATCH = 5; // smaller than the worker's batch size, so the UI can repaint more often
  let batch = [];

  for (let i = 0; i < total; i++) {
    if (token !== simRunToken) return; // cancelled mid-run

    batch.push(simulateGameFromOpener(answer, openers[i], answerPool, fullDictionary, hardMode));

    if (batch.length >= BATCH || i === total - 1) {
      handleSimMessage({ type: "progress", batch, done: i + 1, total }, token);
      batch = [];
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (token !== simRunToken) return; // cancelled during the yield
    }
  }

  handleSimMessage({ type: "done", total }, token);
}

function startSimulation(answer, pool, sample, hardMode) {
  simRunToken++;
  const token = simRunToken;
  simResults = [];
  simCurrentAnswer = answer;
  simWorker = null;

  const openers = pool.length === sample ? pool.slice() : pickRandomSample(pool, sample);
  const answerPool = words.answers;
  const fullDictionaryArr = [...words.guesses];

  simStatusEl.textContent = "RUNNING";
  simEmptyEl.classList.add("hidden");
  simSummaryEl.classList.add("hidden");
  setSimRunning(true);
  simProgressFill.style.width = "0%";
  simProgressLabel.textContent = `Simulated 0 of ${openers.length.toLocaleString()}…`;

  const fallBackToMainThread = () => {
    if (simWorker) {
      simWorker.terminate();
      simWorker = null;
    }
    simResults = [];
    runSimulationOnMainThread(answer, openers, answerPool, fullDictionaryArr, hardMode, token);
  };

  try {
    simWorker = new Worker("js/core/simulation-worker.js");
  } catch (err) {
    // Most commonly a SecurityError from opening index.html as a file:// URL,
    // where browsers refuse to load worker scripts at all.
    console.warn("Entrople: could not start a simulation worker, running on the main thread instead", err);
    simWorker = null;
  }

  if (!simWorker) {
    runSimulationOnMainThread(answer, openers, answerPool, fullDictionaryArr, hardMode, token);
    return;
  }

  simWorker.onmessage = (event) => handleSimMessage(event.data, token);

  simWorker.onerror = (err) => {
    if (token !== simRunToken) return;
    console.warn("Entrople: simulation worker failed at runtime, falling back to the main thread", err);
    fallBackToMainThread();
  };

  simWorker.postMessage({ type: "run", answer, openers, answerPool, fullDictionaryArr, hardMode });
}

function cancelSimulation() {
  simRunToken++; // invalidates any in-flight worker messages
  if (simWorker) {
    simWorker.terminate();
    simWorker = null;
  }
  finishSimulation(true);
}

simForm.addEventListener("submit", (event) => {
  event.preventDefault();
  simErrorEl.textContent = "";

  const answer = clean(simAnswerEl.value);
  if (answer.length !== 5) {
    simErrorEl.textContent = "Enter a 5-letter answer to simulate against.";
    return;
  }
  if (words.status !== "ready") {
    simErrorEl.textContent = "Deep simulation needs the live word dictionary, which isn't ready yet.";
    return;
  }

  const pool = simPoolForSource(simPoolEl.value);
  const sample = Math.max(1, Math.min(Number(simSampleEl.value) || 1, pool.length));

  startSimulation(answer, pool, sample, simMode === "hard");
});

simCancelBtn.addEventListener("click", cancelSimulation);

updateSimControls();

let todayTabInitialized = false;

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.classList.contains("active")) return;

    document.querySelectorAll(".tab-btn").forEach((b) => {
      const isActive = b === btn;
      b.classList.toggle("active", isActive);
      b.setAttribute("aria-selected", isActive ? "true" : "false");
    });

    const target = btn.dataset.tab;
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.classList.toggle("hidden", panel.id !== `panel-${target}`);
    });

    if (target === "today" && !todayTabInitialized) {
      todayTabInitialized = true;
      initTodaySolve();
    }
  });
});

document.querySelector("#todayRetryBtn").addEventListener("click", () => {
  initTodaySolve();
});

document.querySelector("#todayManualSolve").addEventListener("click", () => {
  const input = document.querySelector("#todayManualAnswer");
  const answer = clean(input.value);
  const errorEl = document.querySelector("#todayError");

  if (answer.length !== 5) {
    errorEl.textContent = "Enter a 5-letter word to solve for.";
    return;
  }
  if (words.status !== "ready") {
    errorEl.textContent = "Entrople's own solve needs the live word dictionary, which isn't ready yet.";
    return;
  }

  errorEl.textContent = "";
  setTodayFetchStatus(`Solving ${answer} manually…`, "ready");
  document.querySelector("#todayDateLabel").textContent = `Manual entry · ${answer}`;
  finishTodaySolve(answer, null);
});

document.querySelector("#todayRevealBtn").addEventListener("click", () => {
  if (!cachedTodaySolve) return;
  document.querySelector("#todaySpoiler").classList.add("revealed");
  document.querySelector("#todaySolveReplay").classList.remove("hidden");
  triggerSolveAnimation(SOLVE_IDS.today);
});

document.querySelector("#todaySolveReplay").addEventListener("click", () => {
  if (!cachedTodaySolve) return;
  triggerSolveAnimation(SOLVE_IDS.today);
});

renderInputs();
renderDataStatus();
loadWordData().then(() => {
  analyze();
  updateSimControls();
});
analyze();
