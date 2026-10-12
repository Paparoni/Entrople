# Entrople
An entropy-driven Wordle solve analyzer, based on the rules of [Wordle](https://www.nytimes.com/games/wordle/index.html) by Josh Wardle. Enter an answer and a set of guesses, and Entrople scores the solve against a live word pool, narrows the real candidate space guess by guess, and shows the information-theory math behind the route, including the balanced-information route it would have taken itself.
### Author: Antwaun Tune (tuneantwaun@gmail.com)
Try it out here: https://paparoni.github.io/Entrople/

You can either:

- Walk through a real (or hypothetical) game guess by guess, and see how each guess narrowed the candidate pool.
- Compare your guesses against the balanced-information picks the bot would have made at each step.
- Watch Entrople solve today's real Wordle live, the moment it rolls over at midnight Eastern.
- Run a **Deep Simulation**: fix an answer, fix a different opening word per game, and let Entrople's balanced-information search play out the rest. Batches of anywhere from a handful to thousands of games run in a background Web Worker and report a win rate, a guesses-to-solve distribution, and exactly which openers leave the search short of a win inside six guesses. Large batches (especially against the full guess dictionary) are genuinely heavy client-side computation, so the tab warns up front and lets you cancel a run in progress.


# Word data
Entrople pulls its word lists and definitions live from public sources at runtime, rather than shipping a bundled wordbank.

- ['wordle-words'](https://github.com/steve-kasica/wordle-words) by Steve Kasica, used as the answer list.
- ['wordle-list'](https://github.com/tabatkins/wordle-list) by Tab Atkins, used as the guess list.
- [Free Dictionary API](https://dictionaryapi.dev/), used for word definitions.
- [Wiktionary](https://www.wiktionary.org/), used as a fallback definition source.

Without a network connection, the solve grid still works, but the deep entropy analysis and definitions are disabled.

# Algorithm
For any given guess, Entrople looks at every word still in the candidate pool and figures out what feedback pattern (green/yellow/gray) that guess would produce against each candidate, grouping candidates into buckets by pattern. For example:

    Guess word: AROSE
    ----------------------
    Potential Answer: ABACK
    Colors: GBBBB (the 'A' in AROSE is correct, nothing else is).
    ----------------------
    Potential Answer: BEARD
    Colors: YYBBY ('A', 'R', and 'E' are all in the word, but in different places).
    ----------------------
    Potential Answer: ALARM
    Colors: GBBBB (notice this is the same pattern as ABACK).

Rather than stopping at bucket sizes, Entrople treats this distribution as a probability distribution over the 3^5 = 243 possible feedback patterns, and scores each guess by its Shannon entropy:

    bits = -Σ p(pattern) * log2(p(pattern))

This is Shannon's entropy formula from information theory (see Math citations below for sources).

A guess that splits the candidate pool into many small, evenly-sized buckets carries more bits of information than one that produces a few large, lopsided buckets, so higher entropy roughly means "narrows the answer down faster." Alongside entropy, Entrople also tracks:

- **Expected remaining candidates**: the average pool size you'd expect to be left with after this guess, weighted by how likely each bucket is.
- **Bucket statistics**: the largest bucket, and the mean, variance, and standard deviation across all buckets, to show how evenly a guess splits the pool.
- **KL divergence**: how far the guess's actual pattern distribution is from a perfectly uniform distribution over all 243 patterns, as another lens on how efficient a guess is.

At each step of a solve, Entrople searches either the narrowed candidate pool or, once the pool is small enough, the full guess dictionary. It ranks legal guesses by a balanced information score: an equal blend of win-adjusted Shannon entropy and candidate-reduction information, `log₂(N / E[N′])`. The second term favors guesses that leave fewer candidates on average, while the first favors evenly informative feedback partitions.

**Win-bonus correction.** Raw Shannon entropy alone has a blind spot: it scores a guess purely by how evenly it splits the candidate pool, so a guess that can never be the answer can tie exactly with a guess that could win outright this turn, as long as both split the pool the same way. Following Alex Healy's analysis (see Math citations below), Entrople corrects for this by adding a small bonus to a guess's entropy equal to the probability that the guess itself is the hidden answer:

    adjustedBits = bits + p_win,   p_win = Pr(guess is the answer)

p_win is nonzero only when the guess is itself still a live candidate (it's the fraction of the pool, 1/N, that the guess's own all-green GGGGG bucket represents). This falls directly out of Healy's derivation: he shows that assigning the all-green outcome a value of -1 bit, instead of the 0 a same-sized bucket would otherwise contribute, is algebraically equivalent to adding p_win to the guess's ordinary entropy. Entrople combines that adjusted entropy with candidate-reduction information for its Top 5 rankings and auto-solve, so an immediate win and a lower expected posterior pool both count.

## Opening book and exact endgame
One-step entropy is a proxy. The real objective is to **minimize expected guesses** (and never fail inside six), which Bertsimas & Paskov (2025) solve exactly by dynamic programming and Cunanan & Thielscher (2023) confirm with an independent optimality proof. Both land on **SALET** as the best opener, and both show the entropy proxy loses the most ground on small late-game pools full of look-alike words (`BATCH / CATCH / HATCH / MATCH / WATCH…`). Entrople now adds these corrections on top of the balanced ranking:

- **Opening book.** On a fresh board (pool of 1,000+ words, no Hard Mode history), SALET is placed first. It is skipped automatically if SALET isn't a legal guess in the loaded dictionary.
- **Exact endgame.** When 100 or fewer candidates remain and at least two guesses are left, Entrople searches the feedback tree over every remaining candidate plus the 40 best information probes, ranking by (1) probability of finishing inside the guesses left, then (2) expected guesses. This lets it pick a non-answer probe that splits a swap family instead of guessing its members one at a time. The search is capped at 2 million feedback evaluations and falls back to the entropy ranking if it runs out; Hard Mode legality is enforced at every level of the tree.
- **Last guess.** With one guess left only a live candidate can win, so probes are never suggested.

Benchmark over all 2,315 original answers (Entrople's own play, answer list as the candidate pool):

| Mode | Before | After |
| --- | --- | --- |
| Normal | 3.479 avg, 67 five-guess games | 3.429 avg, 40 five-guess games, 2 six-guess wins |
| Hard | 3.586 avg, 16 failures | 3.513 avg, 3 failures |

The proven optimum for Normal mode is 3.421. The remaining Hard Mode failures are `_OUND` swap families where Hard Mode forbids a probe. A six-guess finish is still a win: the search guarantees finishing inside the limit and minimizes the average, not the worst case.

## Step-through entry
The Solve Analyzer works like a Wordle board. Type the answer and press ENTER, then type each guess and press ENTER to lock it in. Colors are computed from the answer, the keyboard tracks letter states, and after every guess you see how far the live pool narrowed. "Show Entrople's pick" reveals what the engine would play for the guess you are about to make (nothing is shown unless you ask). Works with the physical or on-screen keyboard; UNDO steps back one guess, EXAMPLE loads a sample solve.

## Verification

Run the core feedback, Hard Mode, and ranking checks with:

```sh
node tests/core.test.js
```

# Math citations
[Claude Shannon](https://en.wikipedia.org/wiki/Claude_Shannon) - author of ["A Mathematical Theory of Communication"](https://people.math.harvard.edu/~ctm/home/text/others/shannon/entropy/entropy.pdf), the source of the entropy formula used throughout

[Thomas M. Cover and Joy A. Thomas](https://doi.org/10.1002/047174882X) - *Elements of Information Theory* (2nd ed.), source for the conditional-probability and conditional-entropy framing used by the Traps Avoided analysis

[3Blue1Brown](https://www.3blue1brown.com/) - ["Solving Wordle using information theory"](https://www.youtube.com/watch?v=v68zYyaEmEA), which popularized applying entropy to Wordle guesses

[Kullback-Leibler divergence](https://en.wikipedia.org/wiki/Kullback%E2%80%93Leibler_divergence) - used to measure how far a guess's pattern distribution is from uniform

[Alex Selby](https://github.com/alex1770) - [Score calculator](https://github.com/alex1770/wordle) author, whose bucket-based scoring approach informed the feedback-bucketing math here

[Dimitris Bertsimas and Alex Paskov](https://pubsonline.informs.org/doi/10.1287/opre.2022.0434) - "An Exact Solution to Wordle" (Operations Research, 2025), source of the SALET opening book and the expected-guesses objective behind the exact endgame

[Michael Cunanan and Michael Thielscher](https://arxiv.org/abs/2305.09111) - "On Optimal Strategies for Wordle and General Guessing Games" (IJCAI 2023), independent proof of SALET as the optimal opener

[Alexander D. Healy](http://www.alexhealy.net/) - ["On Optimal Strategies for Wordle"](http://www.alexhealy.net/papers/wordle.pdf), source of the win-bonus correction (rewarding a guess that could itself be the answer) used in Entrople's best-guess ranking

# Credits
[ybenhayun](https://github.com/ybenhayun) - [Original bot](https://ybenhayun.github.io/wordlebot/) author

[Josh Wardle](https://www.powerlanguage.co.uk/) - creator of the original [Wordle](https://www.nytimes.com/games/wordle/index.html)

[Steve Kasica](https://github.com/steve-kasica) - [wordle-words](https://github.com/steve-kasica/wordle-words) answer list

[Tab Atkins](https://github.com/tabatkins) - [wordle-list](https://github.com/tabatkins/wordle-list) guess list

[Free Dictionary API](https://dictionaryapi.dev/) and [Wiktionary](https://www.wiktionary.org/) - definition data

Created by Antwaun Tune.
