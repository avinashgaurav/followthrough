# Followthrough — "The Transcript Spine" design system

Proposed revamp direction. Synthesized from the live + source design audit
(`the design audit`), the current token system (`web/src/styles.css`),
and four reference systems: **Runway** (cinematic dark chrome), **Claude** +
**ElevenLabs** (warm editorial reading + amber lineage), **Sentry** (data-dense dark).

Status: PROPOSED — approve before it replaces the current green system.

---

## 1. The idea in one line

Followthrough's truth is an **append-only event log** — every fact is a moment in
time (said → routed → locked → ticket → shipped → told → closed). So the whole UI is
organized around a **vertical time-spine**, and a single **signal-amber playhead**
marks the live present. Dark to work, paper to read.

This is not a Linear reskin. No meeting tool in the category (Gong, Otter, Fireflies)
is built on a visible timeline + waveform language. That's the ownable move.

---

## 2. Dual surface (the signature)

Two surfaces, each with a job. Never mix them on one panel.

- **WORK surface — cinematic dark** (Runway). Chrome, lists, queues, the spine,
  metrics. Fast, dense, invisible. This is where you operate.
- **READ surface — warm paper** (Claude/ElevenLabs). Long-form only: insight bodies,
  meeting briefs, and the testimony quotes. Calm, editorial, comfortable to read.

The transition between them is the product's rhythm: scan in the dark, read on paper.

---

## 3. Color tokens

### Work surface (dark)
```
--canvas:      #0A0B0D   /* warm near-black, not pure #000 */
--p1:          #101214   /* panel */
--p2:          #16181B   /* elevated panel */
--p3:          #1C1F22   /* popovers, tooltips */
--line:        #24272C   /* 1px hairline */
--line-soft:   #1A1D21   /* dashed/inner dividers */
--ink:         #F6F7F8   /* primary text on dark */
--ink-muted:   #8A8F98   /* secondary */
--ink-subtle:  #7B8089   /* tertiary — holds WCAG AA on all dark surfaces */
```

### Read surface (paper)
```
--paper:       #FAF9F5   /* reading canvas (Claude cream) */
--paper-soft:  #F2EFE8   /* cards on paper */
--paper-line:  #E6DFD3   /* hairline on paper */
--paper-ink:   #1A1916   /* warm near-black ink */
--paper-body:  #3D3A34   /* body copy */
--paper-muted: #6C685F   /* captions on paper */
```

### Signal amber (THE accent — golden, distinct from removed Zop coral #F58549)
```
--signal:      #F4A521   /* playhead, active state, the single CTA */
--signal-hi:   #FFC24A   /* live / now glow */
--signal-ink:  #1A1206   /* text on amber fills */
--signal-line: #5A3F12   /* amber hairline on dark */
--signal-wash: rgba(244,165,33,0.12)  /* active row / current-step wash */
```

### Semantic (used sparingly)
```
--danger:  #E5484D
--warn:    #D9A531
```

**Discipline — the whole color story:** amber is *the live present* (playhead, active
nav, current pipeline step, one CTA per view). Everything **done** is just ink (a
filled amber tick, then neutral). Everything **future** is `--ink-subtle`. ≤10% amber
coverage. No second accent. This is what keeps it from looking like every other tool.

---

## 4. Typography

Three families. Fix the audit's flat hierarchy and 13px floor.

```
--serif: "Newsreader", Georgia, serif         /* testimony quotes + paper H1 */
--font:  "Inter", system-ui, sans-serif        /* all UI */
--mono:  "JetBrains Mono", ui-monospace, mono   /* timecodes, IDs, deltas, eyebrows */
```

### Scale (real contrast — audit fix #3)
| Role | Family | Size / Weight | Notes |
|---|---|---|---|
| Page H1 | serif | 28px / 500 | was 19px; real top level |
| Section H2 | Inter | 20px / 600 | |
| Item / card title | Inter | 16px / 600 | was 18px and competing with H1 |
| Body (UI) | Inter | 14px / 400 | up from 13px |
| Body (paper read) | Inter | 16px / 400, lh 1.55 | comfortable reading |
| **Testimony quote** | serif | 22–26px / 400, lh 1.4 | the centerpiece (move C) |
| Small | Inter | 13px | meta |
| Eyebrow / label | mono | 10–11px upper, ls 0.14em | |
| Timecode / ID / Δ | mono | 11–12px, tabular-nums | every time value is mono |

---

## 5. The four signature moves

### A · Time-spine + scrubber
A vertical rail (1px `--line`) runs down the primary content column. Mono timecodes
sit on it. A **playhead** (amber dot + 1px amber line, soft `--signal-hi` glow) marks
the current position and can be dragged/scrubbed.
- **Review:** spine = the call timeline; each extracted quote is a **tick** at its
  timecode; clicking a tick scrubs there.
- **Clients:** spine = the meeting timeline (#1 → #2 → #3), newest at the playhead.
- **Proof / Numbers:** spine = the said→shipped→told axis; turnaround = distance
  between ticks, labelled in mono Δdays.

### B · Waveform-as-data
One bar language everywhere, instead of generic line charts.
- **Capture:** a real audio waveform (amber bars = voiced, `--ink-subtle` = silence).
- **Numbers:** trends render as **waveform sparklines** (vertical bars, amber for the
  live/most-recent bucket). Volume-by-week, turnaround distribution, demand-by-theme
  all use the same bars. No CRM charts like this.

### C · Quotes as testimony
The citation gate is the emotional core, so quotes get the most design weight.
- Rendered on the **paper** surface, `--serif` 22–26px, warm ink.
- Attribution in mono: `— Suresh · Cloud Lead · 14:22:08`.
- A 2px amber tick on the spine links the quote to its moment in the call.
- This replaces the current cramped italic `.quote` box.

### D · Dual-surface (see §2)
Insight bodies and meeting briefs render in a paper "reading band" inset into the dark
chrome — a warm card (`--paper`, `--r-paper` 8px, `--paper-line` hairline) floating on
the dark canvas. Everything else stays dark.

---

## 6. Shape, spacing, motion

```
--r:        2px    /* dark chrome — sharp, editorial (keep current) */
--r-paper:  8px    /* paper reading cards only */
--ease-out: cubic-bezier(0.22, 1, 0.36, 1)
--dur-fast: 120ms  /* chrome: hovers, nav (product-register snap) */
--dur-med:  200ms  /* panels, modals */
--dur-spine: 320ms /* playhead scrub — the one cinematic motion */
```
- Animate `transform`/`opacity` only. Spine entry: ticks stagger in `translateY(8px)`
  + fade at `calc(var(--i) * 60ms)`.
- `prefers-reduced-motion`: playhead jumps, no scrub; ticks fade with no movement.
- Borders exactly 1px. No shadows on dark (Runway); paper cards may use one soft
  `0 1px 2px rgba(0,0,0,0.04)` on the dark canvas to lift the reading band.

---

## 7. Vocabulary — ONE dialect (audit findings #1, B1–B5)

The single highest-impact fix. Three dialects collapse to one plain-English pipeline,
shown identically in pills, Review buckets, and Numbers:

```
Found → Routed → Locked → Ticket raised → Shipped → Client told → Closed
```

- Nav: **Capture · Review · Insights · Clients · Shipped? · Numbers · Settings**
  ("Proof" → "Shipped?"; every page gets a one-line job statement under the H1).
- Noun: **"ask"** everywhere a user-facing item is meant (not "insight"/"item" mixed).
- Meta line order: **Client · Meeting #n · timecode** — the `INS-####` handle moves to
  the *end*, mono `--ink-subtle` (audit quick-win #3).
- Kill internal state words from the UI (extracted/triaged/finalized/ticketed).

---

## 8. Hierarchy & queue (audit finding #2)

- The 38-item queue must surface priority: group by **meeting**, show a single
  amber-ticked "most important here" per group, de-weight type tags to mono micro.
- One shared detail component (`InsightDetailView`) — retire Review's duplicated
  600-line inline panel (audit A2).
- Fix the dead-end `/capture?meeting=` deep links (audit A1): a real read-only meeting
  view, or route to the meeting on the Clients spine.

---

## 9. What to keep from today (the good bones)

Token discipline, the keyboard layer (`j/k`, `Cmd-K`), the split-pane triage model,
the excellent error copy, mono labels, zero AI-slop. The revamp evolves the surface
and language — it does not throw away the chassis.

---

## 10. Out of scope / guardrails

- Stays **de-branded**: no Zop palette, no cream+orange-as-Zop, amber is golden not coral.
- Product register: restraint is the material; no marketing atmosphere inside tool chrome.
- Dark-first; paper is for reading bands only, not a full light theme (yet).
