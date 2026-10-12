/* Entrople, pure Wordle feedback + information-theory math. No DOM access.
   Credit: Antwaun Tune */

const MAX_PATTERNS = 243; // 3^5 possible feedback patterns
const MAX_BITS_PER_GUESS = Math.log2(MAX_PATTERNS);
const VOWELS = "AEIOU";
const WIN_CODE = 242; // base-3 code for GGGGG (all-correct), see feedbackCode

function vowelsIn(word) {
  return [...new Set(word.split("").filter((ch) => VOWELS.includes(ch)))];
}

// Array-based feedback for rendering: correct = green, present = yellow, absent = gray.
function feedback(guess, answer) {
  const result = Array(5).fill("absent");
  const remainingLetters = {};

  for (let index = 0; index < 5; index++) {
    if (guess[index] === answer[index]) {
      result[index] = "correct";
    } else {
      const letter = answer[index];
      remainingLetters[letter] = (remainingLetters[letter] || 0) + 1;
    }
  }

  for (let index = 0; index < 5; index++) {
    if (result[index] === "correct") continue;
    const letter = guess[index];
    if (remainingLetters[letter] > 0) {
      result[index] = "present";
      remainingLetters[letter]--;
    }
  }

  return result;
}

// Same comparison packed into a base-3 int (0..242), allocation-free for hot loops.
const _letterCounts = new Int8Array(26);

function feedbackCode(guess, answer) {
  let c0 = 0, c1 = 0, c2 = 0, c3 = 0, c4 = 0;

  const g0 = guess.charCodeAt(0) - 65, g1 = guess.charCodeAt(1) - 65, g2 = guess.charCodeAt(2) - 65,
    g3 = guess.charCodeAt(3) - 65, g4 = guess.charCodeAt(4) - 65;
  const a0 = answer.charCodeAt(0) - 65, a1 = answer.charCodeAt(1) - 65, a2 = answer.charCodeAt(2) - 65,
    a3 = answer.charCodeAt(3) - 65, a4 = answer.charCodeAt(4) - 65;

  if (g0 === a0) c0 = 2; else _letterCounts[a0]++;
  if (g1 === a1) c1 = 2; else _letterCounts[a1]++;
  if (g2 === a2) c2 = 2; else _letterCounts[a2]++;
  if (g3 === a3) c3 = 2; else _letterCounts[a3]++;
  if (g4 === a4) c4 = 2; else _letterCounts[a4]++;

  if (c0 !== 2 && _letterCounts[g0] > 0) { c0 = 1; _letterCounts[g0]--; }
  if (c1 !== 2 && _letterCounts[g1] > 0) { c1 = 1; _letterCounts[g1]--; }
  if (c2 !== 2 && _letterCounts[g2] > 0) { c2 = 1; _letterCounts[g2]--; }
  if (c3 !== 2 && _letterCounts[g3] > 0) { c3 = 1; _letterCounts[g3]--; }
  if (c4 !== 2 && _letterCounts[g4] > 0) { c4 = 1; _letterCounts[g4]--; }

  _letterCounts[a0] = 0; _letterCounts[a1] = 0; _letterCounts[a2] = 0; _letterCounts[a3] = 0; _letterCounts[a4] = 0;

  return (((c0 * 3 + c1) * 3 + c2) * 3 + c3) * 3 + c4;
}

// Wordle Hard Mode requires every revealed green to stay fixed, every yellow
// letter to be reused away from its known-wrong position, and every revealed
// letter multiplicity to be preserved. It does *not* require a guess to
// reproduce the whole previous feedback pattern: gray letters may be reused
// and a legal probe can be outside the current answer candidate set.
function buildHardModeConstraints(history) {
  const fixedLetters = Array(5).fill("");
  const forbiddenLetters = new Int32Array(5);
  const minimumLetterCounts = new Int8Array(26);

  for (const { guess, code } of history) {
    const revealedThisGuess = new Int8Array(26);
    let remainingCode = code;
    const marks = new Int8Array(5);
    for (let index = 4; index >= 0; index--) {
      marks[index] = remainingCode % 3;
      remainingCode = Math.floor(remainingCode / 3);
    }

    for (let index = 0; index < 5; index++) {
      const letter = guess[index];
      const letterIndex = letter.charCodeAt(0) - 65;

      if (marks[index] === 2) {
        fixedLetters[index] = letter;
        revealedThisGuess[letterIndex]++;
      } else if (marks[index] === 1) {
        forbiddenLetters[index] |= 1 << letterIndex;
        revealedThisGuess[letterIndex]++;
      }
    }

    for (let letterIndex = 0; letterIndex < 26; letterIndex++) {
      minimumLetterCounts[letterIndex] = Math.max(
        minimumLetterCounts[letterIndex],
        revealedThisGuess[letterIndex]
      );
    }
  }

  return { fixedLetters, forbiddenLetters, minimumLetterCounts };
}

function isHardModeLegal(word, constraints) {
  if (!constraints) return true;

  const { fixedLetters, forbiddenLetters, minimumLetterCounts } = constraints;

  for (let index = 0; index < 5; index++) {
    const letter = word[index];
    const letterIndex = letter.charCodeAt(0) - 65;
    if (fixedLetters[index] && fixedLetters[index] !== letter) return false;
    if (forbiddenLetters[index] & (1 << letterIndex)) return false;
  }

  for (let letterIndex = 0; letterIndex < 26; letterIndex++) {
    const requiredCount = minimumLetterCounts[letterIndex];
    if (!requiredCount) continue;
    let count = 0;
    for (let index = 0; index < 5; index++) {
      if (word.charCodeAt(index) - 65 === letterIndex) count++;
    }
    if (count < requiredCount) return false;
  }

  return true;
}

// Shannon entropy plus a candidate-reduction measure for `guess` against the
// current pool. `candidateReductionBits` is collision entropy: it is the
// information equivalent of the expected number of candidates left after the
// feedback. The ranking gives equal weight to that direct reduction measure and
// win-bonus-adjusted Shannon entropy.
const _patternCounts = new Int32Array(243);

function guessEntropy(guess, candidates) {
  const total = candidates.length;
  // Empty pool (e.g. the tracked answer list doesn't contain the real answer,
  // so narrowing against true feedback stranded it at zero) has no
  // patterns to score. Return a neutral zero profile instead of falling
  // through to 0/0 divisions further down.
  if (total === 0) {
    return { bits: 0, pWin: 0, adjustedBits: 0, expectedRemaining: 0, candidateReductionBits: 0, rankingScore: 0 };
  }

  _patternCounts.fill(0);

  for (let i = 0; i < candidates.length; i++) {
    _patternCounts[feedbackCode(guess, candidates[i])]++;
  }

  let bits = 0;
  let sumSquares = 0;

  for (let i = 0; i < 243; i++) {
    const count = _patternCounts[i];
    if (count === 0) continue;
    const p = count / total;
    bits -= p * Math.log2(p);
    sumSquares += count * count;
  }

  // p_win: probability the guess IS the answer, i.e. the (at most one) candidate
  // that produces the all-green GGGGG pattern (code 242).
  const pWin = _patternCounts[WIN_CODE] / total;

  const expectedRemaining = sumSquares / total;
  const candidateReductionBits = Math.log2(total / expectedRemaining);
  const adjustedBits = bits + pWin;

  return {
    bits,
    pWin,
    adjustedBits,
    expectedRemaining,
    candidateReductionBits,
    rankingScore: (adjustedBits + candidateReductionBits) / 2,
  };
}

// Full partition profile (entropy, bucket stats, KL divergence, win-bonus-adjusted
// score) for a guess.
//
// Win-bonus correction (Healy, 2022, "On Optimal Strategies for Wordle"):
// Plain Shannon entropy treats the GGGGG ("you win") bucket like any other bucket,
// scored only by how much it shrinks the candidate set. But a guess that wins
// outright is strictly better than one that merely narrows the field to the same
// size without winning -- e.g. with only {PICKY, PIGGY} left, guessing CIGAR
// distinguishes them perfectly (entropy = 1 bit) but guessing PICKY directly is
// better, since it wins immediately with 50% probability instead of guaranteeing
// a 3rd guess. Healy's fix: in the expected-remaining-entropy calculation, assign
// the GGGGG bucket a value of log2(|S|) = -1 instead of the 0 it would otherwise
// get for a singleton bucket. Carried through algebraically (see derivation below),
// this is equivalent to simply adding p_win -- the probability the guess itself is
// the answer -- on top of the ordinary entropy score:
//
//   adjustedBits = H(guess) + p_win,   p_win = Pr(guess is the hidden answer)
//
// Derivation: expected remaining entropy is ER(guess) = sum_i p_i * log2(n_i).
// Substituting log2(1) = -1 for the win bucket instead of the natural 0 changes
// ER by exactly -p_win. Since entropy H(guess) = log2(N) - ER(guess), a decrease
// of p_win in ER is an increase of p_win in H. This is why the correction is just
// "+p_win" and not some free parameter: it falls straight out of the substitution.
function guessPartitionProfile(guess, candidates) {
  const N = candidates.length;

  // Same empty-pool guard as guessEntropy above. Without this, `mean = N / k`,
  // `variance = .../k`, and `pWin = counts/N` all divide 0 by 0 and produce
  // NaN, which then poisons every downstream score (grade, luck factor,
  // guess-quality percentage) that reads this profile.
  if (N === 0) {
    return {
      bits: 0,
      pWin: 0,
      adjustedBits: 0,
      candidateReductionBits: 0,
      rankingScore: 0,
      bucketsUsed: 0,
      expectedRemaining: 0,
      maxBucket: 0,
      mean: 0,
      variance: 0,
      stdDev: 0,
      klDivergence: 0,
      buckets: [],
    };
  }

  _patternCounts.fill(0);
  for (let i = 0; i < candidates.length; i++) {
    _patternCounts[feedbackCode(guess, candidates[i])]++;
  }

  const buckets = [];
  let bits = 0;
  let sumSquares = 0;
  let maxBucket = 0;
  let klDivergence = 0;
  const uniform = 1 / MAX_PATTERNS;

  for (let i = 0; i < 243; i++) {
    const n = _patternCounts[i];
    if (n === 0) continue;
    buckets.push(n);
    const p = n / N;
    bits -= p * Math.log2(p);
    sumSquares += n * n;
    klDivergence += p * Math.log2(p / uniform);
    if (n > maxBucket) maxBucket = n;
  }

  buckets.sort((a, b) => b - a);

  const k = buckets.length;
  const mean = N / k;
  const variance =
    buckets.reduce((sum, n) => sum + (n - mean) * (n - mean), 0) / k;

  const pWin = _patternCounts[WIN_CODE] / N;

  const expectedRemaining = sumSquares / N;
  const adjustedBits = bits + pWin;

  return {
    bits,
    pWin,
    adjustedBits,
    candidateReductionBits: Math.log2(N / expectedRemaining),
    rankingScore: (adjustedBits + Math.log2(N / expectedRemaining)) / 2,
    bucketsUsed: k,
    expectedRemaining,
    maxBucket,
    mean,
    variance,
    stdDev: Math.sqrt(variance),
    klDivergence,
    buckets,
  };
}

// ---------------------------------------------------------------------------
// Exact endgame search + opening book
//
// Why: one-step entropy is a *proxy* for the real objective, which is to
// minimise the expected number of guesses (and, first of all, to never fail
// inside six). Bertsimas & Paskov (2025, "An Exact Solution to Wordle",
// Operations Research) solve the game exactly by dynamic programming and find
// the proxy loses most of its ground in two places: the very first guess, and
// small late-game pools where several look-alike words (BATCH/CATCH/HATCH...)
// survive. Those are precisely the spots where lookahead is cheap, so:
//
//   1. Opening book. SALET is the provably optimal opener for the original
//      answer list (Bertsimas & Paskov 2025; Cunanan & Thielscher, IJCAI 2023).
//   2. Exact endgame. When few candidates remain, recursively search the
//      feedback tree over {candidates} + {top-K information probes}, ranking by
//      (a) probability of winning inside the guesses left, then
//      (b) expected number of guesses. This is what lets Entrople choose a
//      non-candidate "probe" word to split a swap family instead of guessing
//      its members one by one.
//
// The search is bounded: it spends at most ENDGAME_OP_BUDGET feedback
// evaluations and silently falls back to the entropy ranking if it runs out.
// ---------------------------------------------------------------------------
const OPENING_BOOK_WORD = "SALET";
const OPENING_BOOK_MIN_POOL = 1000; // only "fresh board" pools, never a narrowed one
const ENDGAME_MAX_CANDIDATES = 100;
const ENDGAME_PROBE_COUNT = 40;
const ENDGAME_OP_BUDGET = 2e6;
const FAIL_COST = 10; // stand-in cost for a branch that cannot win inside the limit

function betterExact(a, b) {
  if (!b) return true;
  if (a.pWin > b.pWin + 1e-12) return true;
  if (a.pWin < b.pWin - 1e-12) return false;
  return a.expected < b.expected - 1e-12;
}

function exactSolveNode(S, left, ctx, history) {
  const n = S.length;
  if (left <= 0) return { pWin: 0, expected: FAIL_COST };
  if (n === 1) return { pWin: 1, expected: 1 };
  if (n === 2) {
    return left >= 2
      ? { pWin: 1, expected: 1.5 }
      : { pWin: 0.5, expected: 0.5 + 0.5 * FAIL_COST };
  }
  if (left === 1) {
    return { pWin: 1 / n, expected: 1 / n + (1 - 1 / n) * FAIL_COST };
  }

  const key = left + "|" + S.join(",") + (ctx.hard ? "|" + history.map((h) => h.guess + h.code).join(";") : "");
  const hit = ctx.memo.get(key);
  if (hit) return hit;

  let guesses = S;
  if (ctx.probes.length) {
    const constraints = ctx.hard && history.length ? buildHardModeConstraints(history) : null;
    const inS = new Set(S);
    const extra = [];
    for (const probe of ctx.probes) {
      if (inS.has(probe)) continue;
      if (constraints && !isHardModeLegal(probe, constraints)) continue;
      extra.push(probe);
    }
    guesses = S.concat(extra);
  }

  let best = null;
  for (const g of guesses) {
    const r = exactEvalGuess(g, S, left, ctx, history);
    if (ctx.aborted) return { pWin: 0, expected: Infinity };
    if (betterExact(r, best)) best = r;
  }

  ctx.memo.set(key, best);
  return best;
}

function exactEvalGuess(guess, S, left, ctx, history) {
  const n = S.length;
  const buckets = new Map();
  for (let i = 0; i < n; i++) {
    const code = feedbackCode(guess, S[i]);
    const list = buckets.get(code);
    if (list) list.push(S[i]);
    else buckets.set(code, [S[i]]);
  }

  ctx.ops += n;
  if (ctx.ops > ctx.budget) {
    ctx.aborted = true;
    return { pWin: 0, expected: Infinity };
  }

  let pWin = 0;
  let expected = 0;
  for (const [code, bucket] of buckets) {
    const p = bucket.length / n;
    if (code === WIN_CODE) {
      pWin += p;
      expected += p;
      continue;
    }
    if (bucket.length === n) return { pWin: 0, expected: Infinity }; // learns nothing
    const nextHistory = ctx.hard ? history.concat([{ guess, code }]) : history;
    const sub = exactSolveNode(bucket, left - 1, ctx, nextHistory);
    if (ctx.aborted) return { pWin: 0, expected: Infinity };
    pWin += p * sub.pWin;
    expected += p * (1 + sub.expected);
  }
  return { pWin, expected };
}

// Ranks `rootGuesses` by exact (pWin, expected guesses) against `candidates`.
// Returns null if the op budget is exhausted so the caller can fall back.
function exactEndgameRank(candidates, rootGuesses, probes, guessesLeft, hardHistory) {
  const ctx = {
    memo: new Map(),
    probes,
    candidateSet: new Set(candidates),
    hard: Array.isArray(hardHistory),
    ops: 0,
    budget: ENDGAME_OP_BUDGET,
    aborted: false,
  };
  const history = Array.isArray(hardHistory) ? hardHistory : [];
  const out = new Map();
  for (const g of rootGuesses) {
    const r = exactEvalGuess(g, candidates, guessesLeft, ctx, history);
    if (ctx.aborted) return null;
    out.set(g, r);
  }
  return out;
}

function compareRanked(a, b) {
  return (
    b.rankingScore - a.rankingScore ||
    b.adjustedBits - a.adjustedBits ||
    a.expectedRemaining - b.expectedRemaining
  );
}

// Keeps `list` sorted by compareRanked and at most `cap` long. Ties keep their
// insertion order (same stable behaviour as the old sort-after-every-push).
function insertRanked(list, item, cap) {
  if (list.length >= cap && compareRanked(item, list[list.length - 1]) >= 0) return;
  let i = list.length;
  while (i > 0 && compareRanked(item, list[i - 1]) < 0) i--;
  list.splice(i, 0, item);
  if (list.length > cap) list.pop();
}

// Top-N guesses. Stage 1 ranks the legal pool by the balanced information score
// (win-bonus-adjusted Shannon entropy averaged with collision entropy). Stage 2
// then refines it:
//   - fresh board          -> opening book (SALET) is placed first
//   - small candidate pool -> exact expected-guesses search over the
//                             candidates + the best information probes
// options: { guessesLeft = 6 }  guesses remaining *including* this one.
// hardModeHistory restricts to Wordle Hard Mode (array, possibly empty).
function findBestGuesses(candidates, topN = 5, hardModeHistory = null, fullDictionary = null, options = {}) {
  const guessesLeft = options.guessesLeft === undefined ? 6 : options.guessesLeft;
  const useFullDictionary = candidates.length <= 500 && fullDictionary && fullDictionary.size > 0;
  const basePool = useFullDictionary
    ? new Set([...candidates, ...fullDictionary])
    : new Set(candidates);

  let pool = basePool;
  let hardModeApplied = false;

  if (hardModeHistory && hardModeHistory.length) {
    const constraints = buildHardModeConstraints(hardModeHistory);
    const filtered = [...basePool].filter((word) => isHardModeLegal(word, constraints));
    if (filtered.length > 0) {
      pool = new Set(filtered);
      hardModeApplied = true;
    }
  }

  // On the very last guess only a live candidate can win, so a "probe" is
  // worthless there no matter how much entropy it carries.
  if (guessesLeft <= 1 && candidates.length > 0) {
    const finalPool = new Set(candidates);
    if (hardModeHistory && hardModeHistory.length) {
      const constraints = buildHardModeConstraints(hardModeHistory);
      for (const word of [...finalPool]) if (!isHardModeLegal(word, constraints)) finalPool.delete(word);
    }
    if (finalPool.size > 0) pool = finalPool;
  }

  const wantsBook =
    options.openingBook !== false &&
    candidates.length >= OPENING_BOOK_MIN_POOL &&
    (!hardModeHistory || hardModeHistory.length === 0) &&
    fullDictionary && fullDictionary.has(OPENING_BOOK_WORD);

  const wantsExact =
    options.exactEndgame !== false &&
    candidates.length > 1 &&
    candidates.length <= ENDGAME_MAX_CANDIDATES &&
    guessesLeft >= 2;

  // The opening book makes a single-result request free: no scan of the pool.
  if (wantsBook && topN === 1) {
    const profile = guessEntropy(OPENING_BOOK_WORD, candidates);
    return {
      searched: "opening book",
      top: [{ word: OPENING_BOOK_WORD, ...profile, method: "book" }],
      hardModeApplied,
      poolSize: pool.size,
    };
  }

  const keep = wantsExact ? Math.max(topN, ENDGAME_PROBE_COUNT) : topN;
  const best = [];
  for (const guess of pool) {
    insertRanked(best, { word: guess, ...guessEntropy(guess, candidates) }, keep);
  }

  let top = best.slice(0, topN).map((e) => ({ ...e, method: "entropy" }));
  let searched = useFullDictionary ? "full dictionary" : "candidate pool";

  if (wantsBook) {
    const profile = guessEntropy(OPENING_BOOK_WORD, candidates);
    top = [
      { word: OPENING_BOOK_WORD, ...profile, method: "book" },
      ...top.filter((e) => e.word !== OPENING_BOOK_WORD),
    ].slice(0, topN);
    searched = "opening book";
  }

  if (wantsExact) {
    const candidateSet = new Set(candidates);
    const probes = best.map((e) => e.word).filter((w) => !candidateSet.has(w));
    const rootGuesses = [
      ...candidates.filter((c) => pool.has(c)),
      ...probes.filter((w) => pool.has(w)),
    ];
    const exact = exactEndgameRank(candidates, rootGuesses, probes, guessesLeft, hardModeHistory);

    if (exact) {
      const profiles = new Map(best.map((e) => [e.word, e]));
      const ranked = rootGuesses
        .map((word) => {
          const r = exact.get(word);
          const profile = profiles.get(word) || { word, ...guessEntropy(word, candidates) };
          return {
            ...profile,
            method: "exact",
            exactPWin: r.pWin > 1 - 1e-9 ? 1 : r.pWin, // snap float noise
            exactExpected: r.expected,
          };
        })
        .filter((e) => Number.isFinite(e.exactExpected))
        .sort((a, b) => {
          // Epsilon compare: sums of fractions leave ~1e-16 noise on pWin, which
          // must never outrank a real difference in expected guesses.
          if (Math.abs(a.exactPWin - b.exactPWin) > 1e-9) return b.exactPWin - a.exactPWin;
          if (Math.abs(a.exactExpected - b.exactExpected) > 1e-9) return a.exactExpected - b.exactExpected;
          return compareRanked(a, b);
        });
      if (ranked.length) {
        top = ranked.slice(0, topN);
        searched = "exact endgame search";
      }
    }
  }

  return { searched, top, hardModeApplied, poolSize: pool.size };
}

// Keeps only candidates consistent with the feedback a guess actually produced.
function narrowCandidates(candidates, guess, actualCode) {
  return candidates.filter((c) => feedbackCode(guess, c) === actualCode);
}
