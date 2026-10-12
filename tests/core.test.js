const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

vm.runInThisContext(fs.readFileSync("js/core/entropy-math.js", "utf8"), {
  filename: "js/core/entropy-math.js",
});

function historyEntry(guess, answer) {
  return { guess, code: feedbackCode(guess, answer) };
}

// Wordle feedback must account for duplicate letters after greens are removed.
assert.deepEqual(feedback("AABCD", "BANAL"), ["present", "correct", "present", "absent", "absent"]);
assert.equal(feedbackCode("AABCD", "BANAL"), 144);

// The allocation-free hot-path encoder must stay exactly aligned with the
// rendering feedback implementation, including after many duplicate-letter
// comparisons that reuse its shared count buffer.
const feedbackWords = ["ALLOT", "SALLY", "CROWN", "CRANE", "BANAL", "AABCD", "SHEEP", "EERIE"];
const markValue = { absent: 0, present: 1, correct: 2 };
for (const guess of feedbackWords) {
  for (const answer of feedbackWords) {
    const codeFromMarks = feedback(guess, answer).reduce(
      (code, mark) => code * 3 + markValue[mark],
      0
    );
    assert.equal(feedbackCode(guess, answer), codeFromMarks, `${guess} → ${answer}`);
  }
}

// Hard mode keeps revealed hints, but must still allow gray-letter probes.
const crownHistory = buildHardModeConstraints([historyEntry("CRANE", "CROWN")]);
assert.equal(isHardModeLegal("CRAWN", crownHistory), true);
assert.equal(isHardModeLegal("BRAWM", crownHistory), false);

// Yellow letters must move, and revealed duplicate counts must be retained.
const yellowHistory = buildHardModeConstraints([historyEntry("RAISE", "SUGAR")]);
assert.equal(isHardModeLegal("STARS", yellowHistory), true);
assert.equal(isHardModeLegal("RAISE", yellowHistory), false);

const duplicateHistory = buildHardModeConstraints([historyEntry("AABCD", "BANAL")]);
assert.equal(isHardModeLegal("BAAAC", duplicateHistory), true);
assert.equal(isHardModeLegal("BAZCD", duplicateHistory), false);

// The balanced ranking is the exact mean of its two documented components.
const profile = guessPartitionProfile("CRANE", ["CROWN", "CRAWN", "CRANE"]);
assert.equal(
  profile.rankingScore,
  (profile.adjustedBits + profile.candidateReductionBits) / 2
);
assert.equal(profile.expectedRemaining > 0, true);

// A Hard Mode search can include a legal probe that is not feedback-identical
// to the actual answer; the previous implementation incorrectly excluded it.
const best = findBestGuesses(
  ["CROWN"],
  5,
  [historyEntry("CRANE", "CROWN")],
  new Set(["CROWN", "CRAWN"])
);
assert.equal(best.hardModeApplied, true);
assert.equal(best.poolSize, 2);

// --- Exact endgame search (Bertsimas & Paskov 2025 style expected-guesses objective) ---

// A swap family: guessing its members one by one is slow, but a non-answer probe
// that touches every distinguishing letter (B, C, H, M, W, L, P) finishes fast.
const family = ["BATCH", "CATCH", "HATCH", "MATCH", "WATCH", "LATCH", "PATCH"];
const familyDict = new Set([...family, "BLIMP", "WHOMP", "CLAMP", "CHOMP", "WHELP", "PLUMB"]);

const probePick = findBestGuesses(family, 3, null, familyDict, { guessesLeft: 4 });
assert.equal(probePick.searched, "exact endgame search");
assert.equal(probePick.top[0].method, "exact");
assert.equal(family.includes(probePick.top[0].word), false, "should prefer a probe over a family member");
assert.equal(probePick.top[0].exactPWin, 1);
assert.equal(probePick.top[0].exactExpected < 2.5, true);

const bestMember = findBestGuesses(family, 7, null, new Set(family), { guessesLeft: 4 }).top[0];
assert.equal(bestMember.exactExpected > probePick.top[0].exactExpected, true, "probe beats guessing members");

// With one guess left only a live candidate can win, so never suggest a probe.
const lastGuess = findBestGuesses(family, 3, null, familyDict, { guessesLeft: 1 });
assert.equal(family.includes(lastGuess.top[0].word), true);

// Two candidates, two guesses: guess one (50% win now, certain next turn) = 1.5 expected.
const pair = findBestGuesses(["PICKY", "PIGGY"], 2, null, new Set(["PICKY", "PIGGY", "CIGAR"]), { guessesLeft: 6 });
assert.equal(family.includes(pair.top[0].word), false);
assert.equal(["PICKY", "PIGGY"].includes(pair.top[0].word), true);
assert.equal(Math.abs(pair.top[0].exactExpected - 1.5) < 1e-9, true);

// Exact search can be switched off and falls back to the entropy ranking.
const entropyOnly = findBestGuesses(family, 3, null, familyDict, { guessesLeft: 4, exactEndgame: false });
assert.equal(entropyOnly.top[0].method, "entropy");

// Hard Mode: every probe must stay legal, so the exact result must too.
const hardFamilyHistory = [historyEntry("PATCH", "BATCH")];
const hardPick = findBestGuesses(family.filter((w) => w !== "PATCH"), 3, hardFamilyHistory, familyDict, { guessesLeft: 5 });
const hardConstraints = buildHardModeConstraints(hardFamilyHistory);
assert.equal(hardPick.top.every((e) => isHardModeLegal(e.word, hardConstraints)), true);

// --- Opening book ---
const bigPool = Array.from({ length: 1200 }, (_, i) => {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return a[i % 26] + a[Math.floor(i / 26) % 26] + a[Math.floor(i / 676) % 26] + "AB";
});
const bookDict = new Set([...bigPool, OPENING_BOOK_WORD]);
const book = findBestGuesses(bigPool, 1, null, bookDict, { guessesLeft: 6 });
assert.equal(book.top[0].word, OPENING_BOOK_WORD);
assert.equal(book.top[0].method, "book");
// Never applied to a narrowed board or when the book word isn't a legal guess.
assert.equal(findBestGuesses(bigPool.slice(0, 50), 1, null, bookDict, { guessesLeft: 5 }).top[0].method === "book", false);
assert.equal(findBestGuesses(bigPool, 1, null, new Set(bigPool), { guessesLeft: 6 }).top[0].method === "book", false);
assert.equal(findBestGuesses(bigPool, 1, null, bookDict, { guessesLeft: 6, openingBook: false }).top[0].method === "book", false);

console.log("core tests passed");
