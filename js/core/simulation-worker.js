/* Entrople, deep simulation worker.
   Batch-simulates Entrople's own win-bonus-adjusted entropy search across many
   different fixed opening guesses against one answer, off the main thread, so
   the "Deep Simulation" tab can throw hundreds or thousands of games at the
   math without freezing the page. Pure computation, no DOM access.

   The actual game-playing logic (simulateGameFromOpener) lives in
   simulation.js and is shared with app.js's main-thread fallback, so there
   is exactly one implementation to keep correct -- this file is just the
   batching/progress-reporting loop around it.
   Credit: Antwaun Tune */

importScripts("entropy-math.js", "simulation.js");

self.onmessage = (event) => {
  const msg = event.data;
  if (msg && msg.type === "run") runSimulation(msg);
};

function runSimulation({ answer, openers, answerPool, fullDictionaryArr, hardMode }) {
  const fullDictionary = new Set(fullDictionaryArr);
  const total = openers.length;
  const BATCH = 10; // openers per progress message, keeps postMessage overhead low
  let batch = [];
  const startedAt = Date.now();

  for (let i = 0; i < total; i++) {
    // Timed individually (not just the batch total) so the UI can surface
    // which specific openers made the entropy search work hardest -- e.g. a
    // duplicate-letter opener against a large late-game candidate pool can
    // take meaningfully longer to search than a high-information opener.
    const gameStartedAt = performance.now();
    const result = simulateGameFromOpener(answer, openers[i], answerPool, fullDictionary, hardMode);
    result.elapsedMs = performance.now() - gameStartedAt;
    batch.push(result);

    if (batch.length >= BATCH || i === total - 1) {
      self.postMessage({ type: "progress", batch, done: i + 1, total });
      batch = [];
    }
  }

  self.postMessage({ type: "done", elapsedMs: Date.now() - startedAt, total });
}
