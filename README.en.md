# 🐋 Whale Memory

**A long-term memory system that forgets, associates, and actually remembers *who someone is*.**

Zero dependencies · Fully local · Chinese-first (works in any language) · Node.js

[![CI](https://github.com/yokipeek/whale-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/yokipeek/whale-memory/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![Docs](https://img.shields.io/badge/docs-ARCHITECTURE-blue)](docs/ARCHITECTURE.md)
[![Deploy](https://img.shields.io/badge/docs-DEPLOYMENT-orange)](DEPLOYMENT.md)

[中文版 README](README.md)

```
Your bot forgets everything after the context window rolls over?
Compress the history once and the earlier half is gone?
Dump it all into a vector store and the noise drowns out the signal —
and you still can't tell why it brought that one thing up?
```

Whale Memory solves this with a mechanism you can explain, debug, and let grow its own vocabulary. No cloud calls, no dependencies, and one memory is just a few JSON files you can open and read.

---

## Contents

- [What problem it solves](#what-problem-it-solves)
- [How it works, for non-engineers](#how-it-works-for-non-engineers)
- [30-second start](#30-second-start)
- [Architecture](#architecture)
- [Core mechanisms (technical)](#core-mechanisms-technical)
- [API](#api)
- [How it differs from other approaches](#how-it-differs-from-other-approaches)
- [Known limits](#known-limits)
- [Project story: where these numbers come from](#project-story-where-these-numbers-come-from)
- [Contributing](#contributing)

> **Want to run it for real?** See [DEPLOYMENT.md](DEPLOYMENT.md) — three routes (library only /
> wire into your bot / full companion replica), scheduling, backup and migration, vocabulary
> self-learning, and a troubleshooting chapter. This README explains *how it thinks*; that one
> explains *how it runs*.

---

## What problem it solves

The two usual approaches both have a hard failure:

| Approach | Failure |
|---|---|
| **Context window only** | Amnesia after a day. One compression and the earlier part fades. |
| **Everything into a vector store** | Noise grows, retrieval slows down, you can't explain *why* an item surfaced — and it **never forgets**, so a line from three years ago ranks equal to yesterday's. |

Whale Memory takes a third path: **structured writes, graded forgetting, justified recall.**

Four design principles:

1. **Layered writes** — episodes are episodes, facts are facts, promises are promises. Not one soup.
2. **Hybrid scoring** — literal, semantic, importance and recency combined. Not a single cosine value.
3. **Graded forgetting** — decay → demote → cold storage. Not "keep all" or "delete all".
4. **Everything explainable** — every `recall()` hit carries `evidence` / `score` / `why`. You can trace why she brought *that* up.

---

## How it works, for non-engineers

> No jargon in this section. If you only want to know how it thinks, this is enough.

### Picture a room with cabinets

You say something; she does four things.

**Step 1: Understand what you said.** She has to split your sentence into words — like taking a necklace apart into beads. This needs a dictionary, and **this step matters more than you'd think**: if the dictionary has no entry for a private nickname you two invented, she sees only loose bricks and can't match anything. So the system ships with a tool that reads your own chat history and builds her a small personal dictionary. Words you use a few times, she learns to recognize.

**Step 2: Decide whether it's worth remembering.** Not every line matters. "you there" and "haha" get dropped. For everything else she weighs it: a passing remark is light; a promise, a fear, a name you call her — heavy.

**Step 3: File it in the right cabinet.**

| Cabinet | Holds | Behavior |
|---|---|---|
| **Episode log** | what was said, day by day | writes constantly, gets digested later |
| **Key facts** | who this person is, preferences, promises | durable, decays slowly |
| **Sticky notes** | things she wanted to say and didn't | expires on its own in a few days |
| **Recipe book** | learned procedures | "synthesize the audio first, then send" |
| **Basement** | old memories that sank | not deleted — just moved down. Still diggable |

**Step 4: How she remembers when you ask.** You ask "do you remember me staying up late" — she does three things.

**1. Pick the real clues out of your question.** "staying up late" stays; "do", "you", "remember" get dropped — they point at nothing. There's a subtlety here, a **double ruler**:

- Ruler one: is this word **rare in her own memories**? "staying up late" appears a few times — good clue.
- Ruler two: rare in her diary is **not enough**. "represents" might also appear twice in her diary, but it's everywhere in the language. Not a clue.

Both must pass before she uses it.

**2. Find it three ways at once** — by literal text, by meaning (she read all her own diaries and learned that "staying up late" and "pulling an all-nighter" sit close together), and by weight (important and recent ranks higher).

**3. Lay the pages on the table — but fewer rather than forced.** At most five pages. If only one is genuinely relevant, only one goes down.

> Laying down one irrelevant page is worse than laying down one correct page. That's how she ends up saying "you told me last time..." and getting it wrong.

**How she forgets.** She doesn't delete. She just makes old things harder to find. Yesterday's — one glance. Three days ago — you have to dig a little. Three months ago — you have to ask precisely. Three years ago — she herself has almost lost it, and one reminder brings it back fuzzy. **But it's always findable.**

That's unlike a disk drive, which is "there" or "not there". She's "clear" or "blurry". Which is why the decay curve here is **power-law, not exponential**: exponential makes first love and last Wednesday's noodles vanish together one year out.

**What she does while "sleeping."** Every half hour, a timer (which you wire up) runs maintenance: copy today's worth-keeping episodes into the key facts, merge repeats, reweigh old items and sink the faded ones, and — the interesting step — shuffle fragments from different days and recombine them. Two unremarkable lines three days apart get joined: *"he doesn't want sweet talk, he wants someone keeping watch for him."* That inference goes into its own drawer, **kept separate from your literal words**, so she doesn't mistake her own guess for something you actually said.

---

## 30-second start

```bash
npm install whale-memory
```

Or just copy the `src/` and `data/` directories into your project — **there are no dependencies**, only Node built-ins.

> ⚠️ Don't skip `data/`. It holds a 920 KB Chinese segmentation dictionary. Without it segmentation degrades and retrieval gets noticeably worse.

```js
import { createMemoryStore } from 'whale-memory';

const mem = createMemoryStore({ dir: './my-memory' });

// Log an episode (who said what, when)
mem.logEpisode({ who: 'him', text: 'stayed up until 3am again', at: Date.now() });

// Store a durable fact
mem.remember('Does not smoke; likes small blue whales', {
  kind: 'semantic',
  layer: 'long',
  who: 'him',
  importance: 4,
});

// Ask
const hits = mem.recall('does he smoke', { limit: 3 });
// → [{ id, text, evidence: 0.34, score: 0.70, confidence, confidenceLabel, ... }]
```

**That's only "the library runs."** To wire it into a real bot — logging episodes, injecting
prompt context, scheduling maintenance, backup and migration, teaching it your private vocabulary —
read [DEPLOYMENT.md](DEPLOYMENT.md).

Run the full example:

```bash
npm run demo
```

It builds a temporary store, writes a few memories, asks four questions, then cleans up.

---

## Architecture

![architecture](docs/diagrams/whale-memory-architecture.png)

> Interactive version (zoom, light/dark, export PNG/SVG): [docs/diagrams/whale-memory-architecture.html](docs/diagrams/whale-memory-architecture.html)

Three paths, one store:

| Path | When | What |
|---|---|---|
| **Write** | every incoming message | segment → decide if worth keeping → persist |
| **Read** | every reply | pick clues → three-way scoring → assemble working memory |
| **Digest** | on a timer (30 min recommended) | consolidate → merge → decay → replay |

---

## Core mechanisms (technical)

### 1. Chinese segmentation: why a dictionary is mandatory

Character n-grams are the lazy option, and they have one fatal flaw:

```
"你还记得我答应过什么吗"
  n-gram     → 你还 / 还记 / 记得 / 得我 / 我答 / 答应 / 应过 / 过什 / 什么
                ↑ half of these are cross-word fragments
```

Those fragments ("还记", "得我") are naturally rare in any corpus, so they get scored as **rare clues**. That's "five weak pieces of evidence adding up to look like one strong one."

Whale Memory does longest-match against jieba's 109k-word dictionary:

```
"你还记得我答应过什么吗"
  dictionary → 记得 / 答应 / 过 / 什么
```

**Critical detail: not one character is dropped.** The single-character fallback is essential — the older method would segment "她的胃" into "胃不好", so a query for "她的胃" reduced to the single char "胃" while the memory side produced "胃不", and by-word comparison never matched.

### 2. Vocabulary self-learning: teach it your private words

A general dictionary has no entry for nicknames you invented. Longest-match degrades to single chars:

```
大肥鱼 → 大 | 肥 | 鱼      (all three are common characters → all judged "not a clue")
```

No threshold can save this — **the segmentation is wrong, not the scoring**.

So there's a new-word discovery pass (`scripts/learn-lexicon.mjs`) that runs on your own corpus:

| Condition | Test | Why |
|---|---|---|
| ① Seen often enough | frequency ≥ 3 | once or twice is noise |
| ② Always together | PMI ≥ 4.0 | these characters stick together, not by chance |
| ③ Can take other neighbors | left/right entropy ≥ 0.9 | it's a complete unit |

Condition ③ is the key one:

```
"大肥鱼"  left neighbors: 是/叫/这/…  right entropy also high  → real word ✓
"肥鱼"    left neighbor is always "大"  left entropy 0          → just the tail of a longer word ✗
```

High entropy = messy neighbors = real word. Low entropy = fixed neighbor = part of something else. This automatically strips sub-words absorbed by longer ones.

Found words go to `data/jieba-learned.txt` and get **merged** with the general dictionary. The original stays untouched — delete the learned file and you're back to the stock dictionary.

### 3. Scoring: evidence and ranking must be separate signals

This is the most important design decision in the project.

```
✗ Wrong: threshold on the total score
   score = literal×0.34 + semantic×0.36 + memScore×0.30
   if (score < 0.3) drop

   Consequence: when memScore (importance/decay) shifts, the whole store's
   scores translate together — taking the should-be-recalled with them.

Measured: turning the "how fresh is a memory with no timestamp" knob from
1 to 0.75 dropped recall from 10/11 to 8/11 — and those items all shared the
same value, so lowering it did NOT change the ranking. Pure loss.

✓ Correct: threshold on evidence, rank by total score
   evidence = sum of clue rarity, saturating via s/(s+K)
   if (evidence < gate) drop       ← only answers "is there a real relation"
   score    = three-way fusion     ← only answers "what ranks first"
```

Rarity is a **double ruler**:

```js
rarity = inStoreRarity × generalChineseRarity × singleCharPenalty

inStoreRarity     = log((N+1)/(df+1)) / log(N+1)   // logarithmic: small stores don't collapse
generalChineseRarity = jiebaFrequency / 99          // 0 = most common, 99 = most specific
singleCharPenalty = 0.35                            // Chinese semantic units are basically ≥2 chars
```

**Why logarithmic rather than `1 - df/N`:**

With 3 memories, a word appearing once gives `1 - 1/(3×0.25) = -0.33` → clamped to zero → **the one memory that should match has evidence = 0, and the whole query returns nothing**. The logarithmic form yields 0.5 on small stores and scores normally.

### 4. Three-way fusion

```js
score = literal × 0.34 + semantic × 0.36 + memScore × 0.30

literal   = normalized BM25 (who wrote these words)
semantic  = LSA space × 0.62 + n-gram cosine × 0.38
memScore  = importance × power-law decay × hit count
```

**Why two semantic paths:**

- n-gram alone: "send me a voice message" matches anything containing "voice", but "the most ideal sound" matches nothing — zero overlap.
- LSA alone: with little data, short-sentence vectors flatten into "all about the same", and exact names or model numbers blur.
- Weighted together, each fixes the other's disease: LSA catches paraphrase, n-gram catches exact strings.

The LSA space is **learned from her own corpus** (PMI-weighted co-occurrence matrix + randomized SVD), not a pretrained model. Zero dependencies, portable, and fully introspectable — you can trace which shared contexts pulled two words together. A black-box embedding cannot give you that.

### 5. Power-law decay

```
recency = (1 + age_days)^(-alpha)

      alpha:   core → 0      (never decays)
               long → 0.35   (half-life ≈ 180 days)
            working → 0.90   (half-life ≈ 21 days)
```

**Why not exponential half-life:**

Exponential decay means "a 180-day-old memory is always exactly half of a 179-day-old one." People don't work that way.

What Anderson & Schooler measured on news-headline memory is a power law: `P(recall) ≈ frequency^a × recency^-b`.

The power law has a **long tail** — something from a year ago is still faintly there, still faintly there ten years on, rather than exactly zero after a few years.

Exponential decay makes first love and last Wednesday's noodles die together one year out. In a companion setting that's fatal.

Measured (`tests/core.test.mjs`):

```js
scoreMemory(365 days ago) > scoreMemory(3650 days ago) > 0
```

### 6. Merging duplicates

The semantic layer only appends. Say the same thing two different ways and you get two entries.

The cost isn't disk space — it's that **top-k gets filled by N variants of one item**, and other memories never fit into the injection window.

```js
textSimilarity(a, b) = |bigram(a) ∩ bigram(b)| / min(|bigram(a)|, |bigram(b)|)
```

**The denominator is `min`, not the union**, and that's deliberate: the target case is "A is a fragment of B".

All 5 duplicate pairs in the measured set had this shape:

```
"，我口头答应了名分"                        ← stored as a bare tail
"要我叫他丈夫/让我做妻子，我口头答应了名分"  ← the complete sentence
```

Dividing by the union dilutes this below 0.6 with the length difference — never reaching the threshold.

Threshold 0.95: at 0.92 it starts merging "two different things that happened the same day", which is irreversible information loss.

### 7. Sleep replay

Shuffle fragments from several days and recombine them, looking for connections not noticed at the time.

Found associations are written as `kind: 'insight'` and get **their own dedicated slot** in `gatherWorkingMemory`.

Why a dedicated slot: measured, replay insights score 0.44 and can never beat same-topic literal lines (0.64/0.63). With `relevantSlots=2` they never surfaced once — **a mechanism that exists but never appears is the same as not building it**.

---

## API

### `createMemoryStore({ dir, log?, now?, bm25CacheMs? })`

| Param | Default | Meaning |
|---|---|---|
| `dir` | required | memory store directory |
| `log` | `() => {}` | log callback |
| `now` | `Date.now` | time source (injectable for tests) |
| `bm25CacheMs` | 15000 | BM25 index cache duration |

Returns a store object; every method below lives on it.

### Writing

| Method | Purpose |
|---|---|
| `remember(text, opts)` | store a semantic memory. Same layer + same `who` + identical text merges (max importance, hits+1) |
| `logEpisode({ who, text, at, ... })` | store an episodic line, persisted per day |
| `addPending(text, { who, expiresInMs })` | store "wanted to say it, didn't" — expires |
| `learnProcedures(text, { who })` | learn a procedure |
| `setProfile(who, text, { importance, tags })` | write someone's profile |

`remember` options:

```js
{
  kind = 'semantic',        // episodic | semantic | pending | core | profile
  layer = null,             // core | long | working (inferred from kind if omitted)
  who = '',                 // who this is about (zero-width chars stripped)
  where = '',               // where it happened
  tags = [],
  importance = null,        // 1~5
  at = null,                // timestamp
  source = 'ai',
  attr = '',                // attribute key, for same-attribute conflict detection
  derivedFrom = null,       // provenance (which raw messages produced this)
}
```

### Reading

| Method | Purpose |
|---|---|
| `recall(query, opts)` | top-k retrieval |
| `gatherWorkingMemory(query, opts)` | assemble the five-slot working memory |
| `tipOfTongue(query)` | "on the tip of my tongue" — traces exist, can't retrieve them |
| `searchCold(query)` | dig back out of cold storage |
| `stats()` | statistics |

`recall` options:

```js
{
  limit = 8,
  who = '',                  // only this person's (core is always visible)
  layers = null,             // restrict to certain layers
  includeEpisodic = true,
  episodicDays = 14,         // only episodes from the last N days
  minScore = 0.01,           // second gate on total score
  evidenceGate = 0.15,       // evidence gate. 0 = off
  evidenceBucket = false,    // cap this pass's count by top evidence
  currentMood = null,        // current mood (affects what surfaces)
  dedupe = true,             // interference competition penalty
}
```

Every result carries:

```js
{
  id, text, kind, layer, who,
  evidence,          // 0~1 ("is this genuinely related to the question")
  score,             // final score (importance/recency included; decides rank)
  bm25, semantic, memScore,   // raw per-path scores
  confidence, confidenceLabel, // very-fuzzy | fuzzy | glimpse | clear
  hits,
}
```

`confidence` exists so the model can say "I don't remember clearly" on a `fuzzy` hit instead of asserting a weak match as fact.

### Maintenance

| Method | Purpose |
|---|---|
| `decay({ coldThreshold })` | decay + sink below-threshold items into cold storage |
| `mergeDuplicates({ threshold, dryRun })` | merge duplicates |
| `markConsolidated(day)` | advance the consolidation watermark |
| `forget(id)` | hard delete |
| `patchItem(id, patch)` | edit one (text / importance / tags / who / where) |
| `reviseFact(id, newText, { reason })` | rewrite a fact, keeping history |

### Scheduled maintenance

```js
setInterval(() => {
  mem.decay({ coldThreshold: 0.06 });
  mem.mergeDuplicates({ threshold: 0.95 });
  // consolidate / replay / self-narrative as needed (may require your LLM)
}, 30 * 60 * 1000);
```

> A ready-made script ships in the repo: `node scripts/memory-tick.mjs --dir ./data/memory`.
> Supports `--dry-run` and `--max-days`. See [DEPLOYMENT.md §5](DEPLOYMENT.md#5-定时任务让它自己整理记忆).

---

## How it differs from other approaches

| | Context window | Pure vector store | Whale Memory |
|---|---|---|---|
| Survives across sessions | ✗ | ✓ | ✓ |
| Forgets | loses everything | ✗ append-only | ✓ power law + layers + cold storage |
| Explains "why this surfaced" | — | ✗ one cosine value | ✓ evidence / score / three paths |
| Chinese segmentation | — | usually ignored | ✓ jieba dictionary + self-learning |
| Learns your private words | — | ✗ | ✓ mined from your corpus |
| Learns procedures | ✗ | ✗ | ✓ procedural memory |
| Self-narrative | ✗ | ✗ | ✓ timeline / milestones / autobiography |
| Zero dependencies | ✓ | ✗ | ✓ |
| Data readable | — | ✗ binary | ✓ plain JSON |

---

## Known limits

Listed honestly, so you don't step in it:

1. **Not a turnkey chat plugin.** This is a library; you wire it into your own app.
2. **Consolidation and replay want your LLM.** Local rule-based digesting (`memory-local-digest`) is free, but "distill it into one first-person fact" needs a model. You can skip it — the semantic layer just grows slower.
3. **Vocabulary learning needs a corpus.** Below a few tens of thousands of characters the statistics aren't significant enough to mine anything. The general dictionary still works.
4. **Not multi-tenant.** One store, one directory. Isolate users by giving them different directories.
5. **No concurrent-write guarantees.** Two processes writing the same directory will overwrite each other. Give it one owning process.
6. **The LSA space needs ≥60 documents** before it activates; below that it falls back to n-gram automatically.
7. **`evidenceGate`'s default (0.15) was tuned on long Chinese sentences.** For English short sentences start around 0.3 — don't copy the number.

---

## Project story: where these numbers come from

Every magic number here has a measurement behind it. A few of them, so you know what you're turning when you tune.

### Lesson 1: don't copy someone else's threshold

The mechanism was originally ported from a sibling project that used 0.30 as its evidence gate.

Copied over, only 61% of 18 real questions hit — **worse than leaving it alone**.

Why: their data is mostly short sentences, so `s` is large. Ours is mostly long sentences; one memory matches 2–3 clues, so `s` is small and `C` sits lower overall. The same number on a different distribution is simply wrong.

**It ended up at 0.15, and became a configurable parameter.**

### Lesson 2: I overfit against 11 self-authored examples

After finding the regression I started adjusting thresholds one at a time. Every fix broke something else.

In the end the 18 real questions sat at 61%, with 2 queries returning nothing at all.

Textbook overfitting: the parameters had been tuned to look good on those 11 invented cases.

**The fix was splitting the changes into independent switches, measuring them one at a time, and holding back a 15-question set that never took part in tuning.** That's when two of the changes turned out to be net losses:

| Change | Verdict |
|---|---|
| Dictionary segmentation | genuine win |
| Vocabulary self-learning | genuine win |
| Evidence gate | mixed; kept at a mild default |
| "Don't force it" count buckets | **a loss on this store**; off by default |

### Lesson 3: zero-width spaces silently orphaned 11% of memories

Nicknames copied from other apps often carry U+200B.

So `'Pure White'` and `'Pure\u200b White'` are not equal in JS — and `recall`'s `who` filter uses strict equality. **Those memories were unreachable.**

Measured: 26 of 237 (11%) were silently orphaned.

`remember()` now strips all zero-width characters on the **write** side. Write-side, not read-side: reads happen every turn, and they can't clean up existing data anyway.

### Lesson 4: the gate nearly killed the insights

`insight` is the cross-day association produced by replay — e.g. "he lets you call him husband, then flips out when you actually do."

Such a line **should not** match your current question literally, and that's exactly why it's the most valuable thing to recall.

The evidence gate nearly blocked all of them → the `insight` slot was permanently empty.

Fix: `gatherWorkingMemory` calls `recall` with `evidenceGate: 0`. Because **"remembering" and "string matching" are different jobs** — the gate exists to save tokens when injecting k items. Working memory has a fixed number of slots and doesn't need that saving.

---

## Running the tests

```bash
npm test
```

13 tests covering segmentation, double-ruler rarity, zero-width cleanup, duplicate merging, power-law decay, and the five working-memory slots.

No dependencies — `node --test` is enough.

> **CI gotcha**: the `test` script uses an explicit path (`node --test tests/core.test.mjs`), not a glob.
> Node 18/20's `--test` does not accept glob strings (it treats `"tests/*.test.mjs"` as a literal path and
> throws `MODULE_NOT_FOUND`); Node 22/24 does. This made 6 of 12 CI jobs fail on old versions only,
> which looks like a version compatibility problem but is actually a script-writing problem.

---

## Contributing

Read the three hard rules in [CONTRIBUTING.md](CONTRIBUTING.md) first:

1. Any change must be independently switchable off.
2. Any threshold must come with its provenance.
3. Any scoring change must ship two datasets (a tuning set **and** a generalization set that never took part in tuning).

Rule 3 comes from this project's worst incident — see [Lesson 2](#lesson-2-i-overfit-against-11-self-authored-examples) above.

Before changing code, look at [ARCHITECTURE.md §11 "Rejected designs"](docs/ARCHITECTURE.md) — 5 approaches that looked workable and failed in measurement.

Version history: [CHANGELOG.md](CHANGELOG.md).

---

## License

MIT. The segmentation dictionary comes from jieba (MIT) — see `data/jieba-NOTICE.txt`.

`data/jieba-learned.txt` is **sample data**; see [data/README.md](data/README.md).
