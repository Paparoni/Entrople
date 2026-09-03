/* Entrople, pure Wordle feedback + information-theory math. No DOM access.
   Credit: Antwaun Tune */

const MAX_PATTERNS = 243; // 3^5 possible feedback patterns
const MAX_BITS_PER_GUESS = Math.log2(MAX_PATTERNS);
const VOWELS = "AEIOU";

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

// Shannon entropy (bits) of `guess` against the current candidate pool.
const _patternCounts = new Int32Array(243);

function guessEntropy(guess, candidates) {
  _patternCounts.fill(0);

  for (let i = 0; i < candidates.length; i++) {
    _patternCounts[feedbackCode(guess, candidates[i])]++;
  }

  const total = candidates.length;
  let bits = 0;

  for (let i = 0; i < 243; i++) {
    const count = _patternCounts[i];
    if (count === 0) continue;
    const p = count / total;
    bits -= p * Math.log2(p);
  }

  return bits;
}

// Full partition profile (entropy, bucket stats, KL divergence) for a guess.
function guessPartitionProfile(guess, candidates) {
  _patternCounts.fill(0);
  for (let i = 0; i < candidates.length; i++) {
    _patternCounts[feedbackCode(guess, candidates[i])]++;
  }

  const N = candidates.length;
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

  return {
    bits,
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

// Top-N highest-entropy guesses; fullDictionary widens the pool once candidates are small; hardModeHistory restricts to Wordle Hard Mode.
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
    const bits = guessEntropy(guess, candidates);
    best.push({ word: guess, bits });
    best.sort((a, b) => b.bits - a.bits);
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
