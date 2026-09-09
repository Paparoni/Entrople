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

// Shannon entropy (bits) of `guess` against the current candidate pool, plus the
// Healy win-bonus correction (see guessPartitionProfile below for the derivation).
// Returns {bits, pWin, adjustedBits} rather than a bare number, since ranking by
// raw entropy alone is exactly the case that lets two guesses with identical bits
// come out equally "good" even when one of them can win outright and the other can't.
const _patternCounts = new Int32Array(243);

function guessEntropy(guess, candidates) {
  const total = candidates.length;
  // Empty pool (e.g. the tracked answer list doesn't contain the real answer,
  // so narrowing against true feedback stranded it at zero) has no
  // patterns to score. Return a neutral zero profile instead of falling
  // through to 0/0 divisions further down.
  if (total === 0) return { bits: 0, pWin: 0, adjustedBits: 0 };

  _patternCounts.fill(0);

  for (let i = 0; i < candidates.length; i++) {
    _patternCounts[feedbackCode(guess, candidates[i])]++;
  }

  let bits = 0;

  for (let i = 0; i < 243; i++) {
    const count = _patternCounts[i];
    if (count === 0) continue;
    const p = count / total;
    bits -= p * Math.log2(p);
  }

  // p_win: probability the guess IS the answer, i.e. the (at most one) candidate
  // that produces the all-green GGGGG pattern (code 242).
  const pWin = _patternCounts[WIN_CODE] / total;

  return { bits, pWin, adjustedBits: bits + pWin };
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

  return {
    bits,
    pWin,
    adjustedBits: bits + pWin,
    bucketsUsed: k,
    expectedRemaining: sumSquares / N,
    maxBucket,
    mean,
    variance,
    stdDev: Math.sqrt(variance),
    klDivergence,
    buckets,
  };
}

// Top-N guesses by win-bonus-adjusted entropy (see guessPartitionProfile for the
// derivation); fullDictionary widens the pool once candidates are small;
// hardModeHistory restricts to Wordle Hard Mode. Ranking by adjustedBits rather
// than raw bits means a guess that could win immediately is never just tied with
// an equally-splitting guess that can't ever be the answer -- it's ranked ahead
// of it, in proportion to how likely that immediate win actually is.
function findBestGuesses(candidates, topN = 5, hardModeHistory = null, fullDictionary = null) {
  const useFullDictionary = candidates.length <= 500 && fullDictionary && fullDictionary.size > 0;
  const basePool = useFullDictionary
    ? new Set([...candidates, ...fullDictionary])
    : new Set(candidates);

  let pool = basePool;
  let hardModeApplied = false;

  if (hardModeHistory && hardModeHistory.length) {
    const filtered = [...basePool].filter((word) =>
      hardModeHistory.every((h) => feedbackCode(h.guess, word) === h.code)
    );
    if (filtered.length > 0) {
      pool = new Set(filtered);
      hardModeApplied = true;
    }
  }

  let best = [];

  for (const guess of pool) {
    const { bits, pWin, adjustedBits } = guessEntropy(guess, candidates);
    best.push({ word: guess, bits, pWin, adjustedBits });
    best.sort((a, b) => b.adjustedBits - a.adjustedBits);
    if (best.length > topN) best.pop();
  }

  return {
    searched: useFullDictionary ? "full dictionary" : "candidate pool",
    top: best,
    hardModeApplied,
    poolSize: pool.size,
  };
}

// Keeps only candidates consistent with the feedback a guess actually produced.
function narrowCandidates(candidates, guess, actualCode) {
  return candidates.filter((c) => feedbackCode(guess, c) === actualCode);
}
