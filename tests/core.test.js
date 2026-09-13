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

console.log("core tests passed");
