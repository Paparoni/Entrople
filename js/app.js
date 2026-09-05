/* Entrople, solve analyzer + entropy engine. Load js/core/entropy-math.js first.
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
                    ? ` It's itself a live candidate, so it also carries a ${(cand.pWin * 100).toFixed(1)}% chance of winning outright this turn — worth +${cand.pWin.toFixed(3)} bits on top of its raw entropy of ${fmtBits(cand.bits)}.`
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
          <p class="next-best-mode-note">The ranking is Shannon entropy plus a win-bonus correction (Healy, 2022): a guess that could itself be the answer gets +p<sub>win</sub> bits added on top of its raw entropy, since winning outright beats merely narrowing the field to the same size without winning. This is what breaks the old tie between two guesses carrying identical bits — the one that's a live candidate now outranks the one that isn't. It still doesn't weight a word by anything beyond that specific correction, so among words that are equally live candidates (or equally not), the ranking is unchanged. The commonness badge and vowel note per word above are tidbits, not separate scoring terms: the badge reflects how often the word is used in everyday English globally (Google Books Ngram data), not Wordle-answer likelihood. Vowel coverage is already fully priced into the entropy number itself (see the citations in the formula reference above), so an explicit vowel bonus on top would just double-count it.</p>
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

    renderGrade(steps, solvedAt, guessesUsed, avgBits, infoEfficiency);
    renderTraps(steps, solvedAt);
  }, 20);
}

// Composite 0-100 score: info efficiency (20%), solve efficiency (50%), luck (20%), evenness (10%).
function renderGrade(steps, solvedAt, guessesUsed, avgBits, infoEfficiency) {
  const card = document.querySelector("#gradeCard");
  card.classList.remove("disabled");

  const luckValues = steps.map((s) =>
    s.expected > 0 ? Math.min(100, (s.actualBits / s.expected) * 100) : 100
  );
  const luckScore = luckValues.reduce((a, b) => a + b, 0) / luckValues.length;

  const klValues = steps.map((s) => s.profile.klDivergence);
  const avgKL = klValues.reduce((a, b) => a + b, 0) / klValues.length;
  const evennessScore = Math.max(0, 100 - avgKL * 12);

  const solveEfficiencyScore = solvedAt ? Math.max(0, 100 - (solvedAt - 1) * 12) : 0;

  const WEIGHTS = { info: 0.2, solve: 0.5, luck: 0.2, even: 0.1 };
  const rawScore =
    WEIGHTS.info * infoEfficiency +
    WEIGHTS.solve * solveEfficiencyScore +
    WEIGHTS.luck * luckScore +
    WEIGHTS.even * evennessScore;
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
    S: "Near-optimal. Your average bits-per-guess tracked the theoretical ceiling closely, every guess split its candidate pool close to evenly, and you solved with guesses to spare.",
    A: "Excellent extraction of information. Small losses somewhere in efficiency, evenness, or guesses used kept this just short of optimal.",
    B: "A solid, above-average solve. The entropy math shows real information gained each guess, with room to trim either the guess count or the partition evenness.",
    C: "A workable solve, but a meaningful gap opened between what your guesses were expected to yield and what they actually returned, or you used more guesses than the info gained justified.",
    D: solvedAt
      ? "You solved it, but inefficiently. Low information efficiency, uneven partitions, or both, relative to what the candidate pool allowed."
      : "The puzzle wasn't solved within the guesses evaluated, which caps the grade regardless of how any individual guess scored.",
    F: solvedAt
      ? "Solved, but the underlying information metrics were weak across the board."
      : "Not solved, and the information metrics on the guesses played were weak as well.",
  };

  document.querySelector("#gradeLetter").className = `grade-letter grade-${letter[0].toLowerCase()}`;
  document.querySelector("#gradeLetter").textContent = letter;
  document.querySelector("#gradeScore").textContent = score.toFixed(1);
  document.querySelector("#gradeVerdict").textContent = verdicts[letter[0]];

  const rows = [
    {
      label: "INFO EFFICIENCY",
      detail: `avg ${fmtBits(avgBits)} / ${fmtBits(MAX_BITS_PER_GUESS)} ceiling`,
      value: infoEfficiency,
      weight: WEIGHTS.info,
    },
    {
      label: "SOLVE EFFICIENCY",
      detail: solvedAt ? `solved on guess ${solvedAt} of 6` : "not solved",
      value: solveEfficiencyScore,
      weight: WEIGHTS.solve,
    },
    {
      label: "PER-STEP LUCK FACTOR",
      detail: `mean actual ÷ expected bits across ${luckValues.length} guess${
        luckValues.length === 1 ? "" : "es"
      }`,
      value: luckScore,
      weight: WEIGHTS.luck,
    },
    {
      label: "PARTITION EVENNESS",
      detail: `mean D_KL(P‖U) = ${avgKL.toFixed(3)} bits`,
      value: evennessScore,
      weight: WEIGHTS.even,
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
    `\\text{Score} = 0.30(${infoEfficiency.toFixed(0)}) + 0.40(${solveEfficiencyScore.toFixed(
      0
    )}) + 0.20(${luckScore.toFixed(0)}) + 0.10(${evennessScore.toFixed(
      0
    )}) = ${score.toFixed(1)} \\Rightarrow \\text{${letter}}`,
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

<<<<<<< HEAD
// Win-bonus-adjusted entropy solve, unconstrained by Hard Mode, independent of the user's guesses.
=======
// Pure Shannon-entropy solve, independent of the user's guesses. Honors Hard Mode when active,
// so suggested guesses stay legal (must reuse all previously revealed green/yellow letters).
>>>>>>> 146864196cf12c524a5d80fc4cb34f3c86981453
function simulateOptimalSolve(answer) {
  let candidates = words.answers.slice();
  const steps = [];
  let hardHistory = [];

  for (let guessNum = 1; guessNum <= 6; guessNum++) {
    const before = candidates.length;
    let guess, bits = 0, searched = "candidate pool";

    if (candidates.length === 1) {
      guess = candidates[0];
    } else {
      const best = findBestGuesses(
        candidates,
        1,
        solveMode === "hard" ? hardHistory : null,
        words.guesses
      );
      guess = best.top[0].word;
      bits = best.top[0].bits;
      searched = best.searched;
    }

    const code = feedbackCode(guess, answer);
    const marks = feedback(guess, answer);
    hardHistory = [...hardHistory, { guess, code }];
    candidates = narrowCandidates(candidates, guess, code);

    const solved = guess === answer;
    steps.push({ guess, marks, before, after: candidates.length, bits, searched, solved });
    if (solved) break;
  }

  return steps;
}

let cachedSolve = null; // { answer, steps }, avoids re-running the search on replay
let solveObserver = null; // fires the reveal the first time #solveCard scrolls into view

function renderEntropleSolve(answer, context) {
  const card = document.querySelector("#solveCard");
  const boardEl = document.querySelector("#solveBoard");
  const stepsEl = document.querySelector("#solveSteps");
  const summaryEl = document.querySelector("#solveSummary");
  const replayBtn = document.querySelector("#solveReplay");

  if (solveObserver) {
    solveObserver.disconnect();
    solveObserver = null;
  }

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
  stepsEl.innerHTML = `<p class="solve-empty">Solving with pure entropy search…</p>`;
  summaryEl.textContent = "";
  replayBtn.classList.add("hidden");

  setTimeout(() => {
    const steps = simulateOptimalSolve(answer);
    cachedSolve = { answer, steps };

    buildSolveBoard(steps);

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
          ` Your solve actually beat pure-entropy search by ${beat} ${beat === 1 ? "guess" : "guesses"}, a` +
          ` well-timed non-greedy pick can still win faster than always taking the highest` +
          ` expected information.`;
      }
    } else if (context && !context.solvedAt) {
      compareLine = ` Your board didn't reach the answer within the guesses evaluated.`;
    }

    summaryEl.innerHTML =
      `Playing pure Shannon-entropy search (always the single highest expected-information ` +
      `legal guess), Entrople solves <b>${answer}</b> in <b>${solvedAt} ${
        solvedAt === 1 ? "guess" : "guesses"
      }</b> against the live ${words.answers.length.toLocaleString()}-word pool.${compareLine}`;

    replayBtn.classList.remove("hidden");
    armSolveReveal();
  }, 20);
}

// Waits until #solveCard first scrolls into view before playing the reveal animation.
// Falls back to a timer so the tiles never get stuck invisible if the observer
// never fires (e.g. the card is taller than the viewport, or already mid-layout).
function armSolveReveal() {
  const card = document.querySelector("#solveCard");
  if (!card) return;

  if (!("IntersectionObserver" in window)) {
    triggerSolveAnimation();
    return;
  }

  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    triggerSolveAnimation();
    if (solveObserver) {
      solveObserver.disconnect();
      solveObserver = null;
    }
    clearTimeout(fallbackTimer);
  };

  solveObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting || entry.intersectionRatio > 0) fire();
      });
    },
    { threshold: 0 }
  );

  solveObserver.observe(card);

  // Defensive fallback: guarantees the reveal plays even if the observer
  // never reports an intersection (zero-height element at observe time, etc).
  const fallbackTimer = setTimeout(fire, 600);
}

function buildSolveBoard(steps) {
  const boardEl = document.querySelector("#solveBoard");
  const stepsEl = document.querySelector("#solveSteps");

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

function triggerSolveAnimation() {
  const boardEl = document.querySelector("#solveBoard");
  const stepsEl = document.querySelector("#solveSteps");
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
  if (solveObserver) {
    solveObserver.disconnect();
    solveObserver = null;
  }
  triggerSolveAnimation();
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

renderInputs();
renderDataStatus();
loadWordData().then(() => analyze());
analyze();
