# Entrople
An entropy-driven Wordle solve analyzer, based on the rules of [Wordle](https://www.nytimes.com/games/wordle/index.html) by Josh Wardle. Enter an answer and a set of guesses, and Entrople scores the solve against a live word pool, narrows the real candidate space guess by guess, and shows the information-theory math behind the route, including the mathematically optimal route it would have taken itself.
### Author: Antwaun Tune (tuneantwaun@gmail.com)
Try it out here: https://paparoni.github.io/Entrople/

You can either:

- Walk through a real (or hypothetical) game guess by guess, and see how each guess narrowed the candidate pool.
- Compare your guesses against the entropy-optimal picks the bot would have made at each step.


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

At each step of a solve, Entrople finds the top-entropy guesses either from the narrowed candidate pool, or, once the pool is small enough, from the full guess dictionary, since a non-candidate word can sometimes split a small pool more evenly than any remaining candidate. Guesses are then re-ranked against this profile to show how the actual guess made in the game compares to the guess Entrople itself would have picked.

**Win-bonus correction.** Raw Shannon entropy alone has a blind spot: it scores a guess purely by how evenly it splits the candidate pool, so a guess that can never be the answer can tie exactly with a guess that could win outright this turn, as long as both split the pool the same way. Following Alex Healy's analysis (see Math citations below), Entrople corrects for this by adding a small bonus to a guess's entropy equal to the probability that the guess itself is the hidden answer:

    adjustedBits = bits + p_win,   p_win = Pr(guess is the answer)

p_win is nonzero only when the guess is itself still a live candidate (it's the fraction of the pool, 1/N, that the guess's own all-green GGGGG bucket represents). This falls directly out of Healy's derivation: he shows that assigning the all-green outcome a value of -1 bit, instead of the 0 a same-sized bucket would otherwise contribute, is algebraically equivalent to adding p_win to the guess's ordinary entropy. Entrople's best-guess search, its top-5 rankings, and its own auto-solve all rank guesses by this adjusted score rather than raw entropy, so a guess that could win immediately is never just tied with one that only narrows the field.

# Math citations
[Claude Shannon](https://en.wikipedia.org/wiki/Claude_Shannon) - author of ["A Mathematical Theory of Communication"](https://people.math.harvard.edu/~ctm/home/text/others/shannon/entropy/entropy.pdf), the source of the entropy formula used throughout

[3Blue1Brown](https://www.3blue1brown.com/) - ["Solving Wordle using information theory"](https://www.youtube.com/watch?v=v68zYyaEmEA), which popularized applying entropy to Wordle guesses

[Kullback-Leibler divergence](https://en.wikipedia.org/wiki/Kullback%E2%80%93Leibler_divergence) - used to measure how far a guess's pattern distribution is from uniform

[Alex Selby](https://github.com/alex1770) - [Score calculator](https://github.com/alex1770/wordle) author, whose bucket-based scoring approach informed the feedback-bucketing math here

[Alexander D. Healy](http://www.alexhealy.net/) - ["On Optimal Strategies for Wordle"](http://www.alexhealy.net/papers/wordle.pdf), source of the win-bonus correction (rewarding a guess that could itself be the answer) used in Entrople's best-guess ranking

# Credits
[ybenhayun](https://github.com/ybenhayun) - [Original bot](https://ybenhayun.github.io/wordlebot/) author

[Josh Wardle](https://www.powerlanguage.co.uk/) - creator of the original [Wordle](https://www.nytimes.com/games/wordle/index.html)

[Steve Kasica](https://github.com/steve-kasica) - [wordle-words](https://github.com/steve-kasica/wordle-words) answer list

[Tab Atkins](https://github.com/tabatkins) - [wordle-list](https://github.com/tabatkins/wordle-list) guess list

[Free Dictionary API](https://dictionaryapi.dev/) and [Wiktionary](https://www.wiktionary.org/) - definition data

Created by Antwaun Tune.
