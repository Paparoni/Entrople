/* Entrople, solve-simulation engine.
   Plays out full Wordle games using the pure math in entropy-math.js
   (findBestGuesses, feedbackCode, narrowCandidates, guessPartitionProfile).
   This is the one place that turns that math into an actual multi-guess
   game, so it's shared by every caller that needs one:
     - the analyzer/"today" tabs' single-answer solves
       (simulateOptimalSolve, simulateOptimalSolveDeep)
     - the sim-opener detail view (computeOpenerRoute)
     - the Deep Simulation tab's batch runs, both the worker
       (simulation-worker.js, via importScripts) and its main-thread
       fallback in app.js (both call simulateGameFromOpener)
   Load js/core/entropy-math.js before this file.
   Credit: Antwaun Tune */

// Seeds a candidate pool for one simulated game.
//
// Only adds `answer` to the pool if it's a real, legal word (present in
// `fullDictionary`) that simply hasn't been tagged as a confirmed historical
// answer yet -- e.g. today's live puzzle before the curated answer list
// catches up. An answer that isn't even a real word must NOT be added:
// doing so would let the solver "know" an otherwise-unreachable word and
// guarantee a win instead of genuinely failing.
//
// This used to be a `candidates.push(answer)` copy-pasted into five
// different functions with no dictionary check, which meant any invalid
// test answer (e.g. "ZZZZZ") was silently guaranteed to solve. Routing
// every simulate* function below through this one function is what keeps
// that bug from creeping back in.
function seedCandidatePool(answerPool, answer, fullDictionary) {
  const candidates = answerPool.slice();
  if (!candidates.includes(answer) && fullDictionary.has(answer)) {
    candidates.push(answer);
  }
  return candidates;
}

// Win-bonus-adjusted entropy solve, independent of the user's guesses. Honors
// Hard Mode when active, so suggested guesses stay legal (must reuse all
// previously revealed green/yellow letters); ranking within that legal set
// uses adjustedBits (see entropy-math.js: guessEntropy) so a guess that
// could itself win outright is never just tied with an equally-splitting
// guess that can't be the answer.
//
// Reads the live word list (`words`) and the analyzer's Hard/Easy toggle
// (`solveMode`) from app.js's global state, same as the rest of this
// plain-script app -- see app.js for both.
function simulateOptimalSolve(answer) {
  let candidates = seedCandidatePool(words.answers, answer, words.guesses);
  const steps = [];
  let hardHistory = [];

  for (let guessNum = 1; guessNum <= 6; guessNum++) {
    if (candidates.length === 0) break; // feedback ruled out every candidate; unsolved
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

// Same search as simulateOptimalSolve, but keeps each step's full entropy-math
// profile (bucket stats, KL divergence, win-bonus breakdown) and the live
// candidate pool at that point, so the caller can render a full math breakdown
// alongside the board rather than just the summary line.
function simulateOptimalSolveDeep(answer, candidatePool) {
  let candidates = seedCandidatePool(candidatePool || words.answers, answer, words.guesses);

  const steps = [];
  let hardHistory = [];

  for (let guessNum = 1; guessNum <= 6; guessNum++) {
    if (candidates.length === 0) break; // feedback ruled out every candidate; unsolved
    const candidatesBefore = candidates;
    const before = candidates.length;
    let guess, profile;

    if (candidates.length === 1) {
      guess = candidates[0];
      profile = guessPartitionProfile(guess, candidates);
    } else {
      const best = findBestGuesses(
        candidates,
        1,
        solveMode === "hard" ? hardHistory : null,
        words.guesses
      );
      guess = best.top[0].word;
      profile = guessPartitionProfile(guess, candidates);
    }

    const code = feedbackCode(guess, answer);
    const marks = feedback(guess, answer);
    hardHistory = [...hardHistory, { guess, code }];
    candidates = narrowCandidates(candidates, guess, code);

    const solved = guess === answer;
    const after = Math.max(candidates.length, 1);
    const actualBits = Math.log2(before) - Math.log2(after);

    steps.push({
      guess,
      marks,
      before,
      after: candidates.length,
      candidatesBefore,
      profile,
      actualBits,
      bits: profile.bits,
      solved,
    });

    if (solved) break;
  }

  return steps;
}

// Recomputes pool-before/after and tile colors for one already-simulated
// opener's guess list, on demand, so batch sim results don't need to carry
// full per-step math for every simulated game (only the final word list).
// Must seed the pool the same way simulateGameFromOpener did when it
// actually produced `guessesUsed`, or the before/after counts here won't
// match what was really searched.
function computeOpenerRoute(answer, guessesUsed) {
  let candidates = seedCandidatePool(words.answers, answer, words.guesses);

  return guessesUsed.map((guess) => {
    const before = candidates.length;
    const marks = feedback(guess, answer);
    const code = feedbackCode(guess, answer);
    candidates = narrowCandidates(candidates, guess, code);
    return { guess, marks, before, after: candidates.length };
  });
}

// Plays out one game with `opener` forced as guess #1, then hands every
// remaining guess to findBestGuesses (the same win-bonus-adjusted search the
// analyzer and "today" tabs use), narrowing the real candidate pool by the
// actual feedback that guess produces against `answer`.
//
// Used for the Deep Simulation tab's batch runs. Takes every dependency as a
// parameter (no reads of the global `words`/`solveMode` state) so the exact
// same function runs unmodified in both places that need it: inside the
// Web Worker (simulation-worker.js, via importScripts) and in the
// main-thread fallback used when Workers aren't available (app.js).
function simulateGameFromOpener(answer, opener, answerPool, fullDictionary, hardMode) {
  let candidates = seedCandidatePool(answerPool, answer, fullDictionary);

  const guesses = [];
  let hardHistory = [];

  for (let guessNum = 1; guessNum <= 6; guessNum++) {
    if (candidates.length === 0) {
      // Feedback ruled out every candidate -- report unsolved rather than
      // crashing findBestGuesses on an empty pool.
      return { opener, guesses, solved: false, guessCount: null };
    }
    let guess;

    if (guessNum === 1) {
      guess = opener;
    } else if (candidates.length === 1) {
      guess = candidates[0];
    } else {
      const best = findBestGuesses(candidates, 1, hardMode ? hardHistory : null, fullDictionary);
      guess = best.top[0].word;
    }

    const code = feedbackCode(guess, answer);
    hardHistory = [...hardHistory, { guess, code }];
    candidates = narrowCandidates(candidates, guess, code);
    guesses.push(guess);

    if (guess === answer) {
      return { opener, guesses, solved: true, guessCount: guessNum };
    }
  }

  return { opener, guesses, solved: false, guessCount: null };
}

// Fisher-Yates partial shuffle: samples `n` distinct words without repeats.
// Used to pick a random batch of openers for the Deep Simulation tab.
function pickRandomSample(pool, n) {
  const arr = pool.slice();
  const count = Math.min(n, arr.length);
  for (let i = arr.length - 1; i > arr.length - 1 - count && i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(arr.length - count);
}
