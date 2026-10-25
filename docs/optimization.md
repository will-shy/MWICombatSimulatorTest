# Optimization page — reference

Reference for `optimization.html` / `src/optimization.js`: a fragment-farming sweep for a
**three-player group** built from loadouts the loadout plugin captured. Each player has a baseline
and any number of candidate kits; the page simulates every combination across the three players at
every selected tier and ranks them by fragments per hour.

## Files

| File | Role |
| --- | --- |
| `optimization.html` | Markup + CSS. |
| `src/optimization.js` | Plugin data, player slots, kits, preview, condition building, results table, CSV. |
| `src/optimizationWorker.js` | Pool of simulation workers (`min(cores, 16)`); one condition per task, results streamed back. |
| `src/optimizationI18n.js` | zh/en strings. |

## Rules

- **Plugin data:** the userscript (`plugin/import.user.js`) must still run on this page. It writes
  the captured loadouts into the `#mwi-plugin-data` node (and `localStorage` `mwiPluginCharacters`)
  on every page of the sim site, but draws its loadout button and panel only on `index.html`. Don't
  narrow its `@match` to the index page, or this page loses its data.
- **Tiers:** T2–T5 are selectable. The default, and what every zone switch resets to, is **T4 and
  T5 only**; T2 and T3 are opt-in. A saved setup restores its own tier choice on reload.
- **Sweep size** = (variants of player 1 × player 2 × player 3) × selected tiers. A player's
  variants are the baseline plus one per candidate kit (`playerVariants`). Every condition is an
  independent simulation of the chosen zone for N hours (`simHours`).
- **A candidate kit is a full five-slot setup** seeded from the baseline (`newCandidate`). Slot 0
  takes special abilities only; slots 1–4 take non-special ones. Picking an ability takes the
  character's real level when they have trained it, else keeps the level in the box. A candidate may
  also name another loadout (`loadoutId`), which brings that loadout's gear, levels and consumables;
  empty rides on the baseline loadout. Old single-swap candidates are migrated by `migrateCandidate`.
- **Players are built per condition** with `importSetToPlayerDTO(set, hrid, abilities)` and then
  `applyLevelGapDebuff` across the party.
- Results come back per condition; a failed one is a row with an error. The baseline row (all
  players on baseline) is highlighted with the `baseline` row class, with no text label.

## Kit names

There is no editable kit name and no "baseline" label. Every variant, baseline included, is named by
its setup **without the auras** (`kitName` in `optimization.js`): initials for multi-word abilities,
the full name for single words, joined with `+`, e.g. `QA+EA+NV+Entangle`. Initials come from the
English `abilityDetailMap` name in every language so they read the same in zh and en. A kit with only
auras shows "no abilities". The name feeds the card header, the results table's variant columns, the
preview title and the CSV.

**Language switching.** Nothing language-dependent is baked into a result row. Each condition stores its
kits as data (`kits`, `infos`), and the variant names and the cell tooltips (`conditionLabels`,
`conditionDetail`) are rebuilt on every render, so switching to Chinese relabels existing rows,
including the ability names inside the tooltips. `kitName` lives in `src/kitName.js`, shared with the
Trigger Optimization page, which names each player's kit from the DTO's abilities (not from labels or kits stored in
`mwiTriggerOptContext`, so a context saved by an older version still follows the language).

**Chinese:** in zh there are no initials: each non-aura ability shows its full Chinese name, joined with
`+` (so no collision handling is needed). Rows build their names from the stored kits at render time
(`conditionLabels`), so switching language relabels the table.

**Rangers:** a kit containing any ranged-style ability (`combatStyleHrid` `/combat_styles/ranged` on one of its
effects: Quick Shot, Steady Shot, Penetrating/Pestilent/Silencing Shot, Aqua/Flame Arrow, Rain Of Arrows) always
uses full English names for every ability, so a ranger's kit never shows initials (applies to Skill Lab too).

**Colliding initials:** if two abilities *in the same kit* get the same initials (Penetrating Shot and
Pestilent Shot are both PS), those abilities keep their full names (`Penetrating Shot+Pestilent Shot`).
Only the colliding ones are expanded.

Consequence: two variants can share a name (same non-aura abilities with different levels or another
gear loadout). The table cell tooltip (`detail`, the diff against baseline, plus "gear from …")
tells them apart. Initials can also collide across abilities (Quick Aid / Quick Shot both QA).
The same rule is used on Skill Lab (`docs/skill_lab.md`).

## Goals and charms

The **Goal** select has three choices: fragments/h (default, with the fragment item picker, shown only
for this goal), XP/h and charms/h. The goal decides (`SORT_FOR_GOAL`, `goalValue`):

- what the **best-row highlight** and the results summary judge on, whatever the table is sorted by;
- the sort the table starts on. Picking a goal also sets the sort select to it (frags / xp / charms),
  which can then be changed freely.

The goal is saved with the setup (`mwiOptimizationSetup.goal`).

**Charm score** (`charmScoreFor`, `CHARM_VALUES` in `zoneDrops.js`): every basic charm counts 1 and every
advanced charm 8.1, summed over all charm types, as **expected drops** (same maths as fragments:
kills × effective drop rate × average stack, with the player's drop bonuses and the party split). Only
basic and advanced charms are counted: they are the only charm tiers in any monster drop table. A charm's
drop rate can be negative plus a per-tier increment, so an advanced charm may not drop at all at low
difficulty tiers (a rate ≤ 0 is skipped, as for every item). The score is per hour in
`metrics.players[h].charmsPerHour` and `metrics.avgCharmsPerHour`, shown as a team-average column and a
column in each player group, and in the CSV.

## Results table

Each kit name is followed by that player's DPS and its share of the party's DPS, e.g. `(235, 34%)`
(rounded; DPS is the same number as the player's DPS column, the share is out of the three players'
total). Rows that failed show the name only.

**Weapon icon.** Each kit cell starts with the weapon that player carries in that row
(`weaponIconHtml`): the two-hand slot, else the main hand, read from the row's own DTO, so a candidate
kit that borrows another loadout shows that loadout's weapon. It is drawn from the item sprite
`assets/items_sprite.svg` (the game's `items_sprite` SVG: one `<symbol>` per item, id = the item hrid
without `/items/`, e.g. `rainbow_sword`), copied by webpack to the site root and used as
`<use href="items_sprite.svg#rainbow_sword">`. The reference has to be same-origin, so the file is
hosted here, not hot-linked. Unarmed players, or an item the sprite lacks, show no icon. The sprite was
checked before adding it: only drawing elements (`symbol`, `path`, `circle`, ...), no script, style,
handler or external link. It is about 3.9 MB, loaded once and cached.

Columns: tier, the three players' kit names, then the team group (avg frags/h, **EPH** =
encounters/h, avg XP/h, avg charms/h) and one group per player (frags/h, DPS, **DPH** = deaths/h, XP/h,
charms/h). The
English headers are EPH and DPH (zh stays 遭遇/时 and 死亡/时). The first column of the team group
and of each player group carries the `sep` class, a 2px accent left border on both header and body
cells, so the groups read apart. A new column group needs `sep` on its first header and body cell.

The three variant column headers show the player's character name (`updateVariantHeaders`), falling
back to "P1 variant" etc. until a character is picked. They follow the current slot selection, so
re-picking a character after a run renames the columns of rows from the earlier run too.

## Trigger Optimization (`trigger-optimization.html`, `src/triggerOptimization.js`)

A **Triggers** button at the start of each results row (first column, no header) opens this page in a
new tab. It tunes **combat triggers** for the three players of that row and ranks by **EPH**
(encounters per hour), not fragments.

**Handoff.** `openTriggerOptimization` in `optimization.js` writes `localStorage["mwiTriggerOptContext"]`:
zone, tier, hours, fragment item, the party's `extra` (moo pass, community buffs), kit labels, character
names, and each player's **finished DTO** (`condition.players`, level-gap debuff already applied). The new
page runs those DTOs, so it never needs the plugin data. It is opened from that button, not from the nav;
with no context it says so.

**Language.** zh/en like the Optimization page: same `mwiOptimizationLang` choice and the same
`optimizationI18n.js` (page strings are the `tr…` keys). Ability, zone and trigger dependency/condition/
comparator names come from the shared `js/i18n.js` bundle through `gameName` (namespaces
`combatTriggerDependencyNames`, `combatTriggerConditionNames`, `combatTriggerComparatorNames`), so the
HTML loads the same i18next scripts and `js/i18n.js`. The `trigger-optimization` strings are a block at
the top of each language in `optimizationI18n.js`.

**Editing.** Each player's abilities are the DTO's ability list (`dto.abilities`, empty slots and
unknown abilities already dropped). **Each ability's draft starts as a copy of its current triggers**
(shown above it as "Current"), so a number can be searched without retyping the trigger. "reset to
current" restores it, "clear" empties it. Up to 4 triggers per ability, with the main simulator's
dependency → condition → comparator → value rules and resets. The ability's `sim` checkbox (off by
default) opts it in.

**Plan preview.** Before anything runs, the page lists what it will do (`buildPlan`/`renderPlan`):
baseline, each ability with each searched number's candidate values and refinement rule, the combined
run when it applies, and a min–max simulation count. It updates on every edit and on the parallel box.
An ability is **skipped** (listed, greyed) when its trigger is unchanged from the current one and has no
number to search, because that would only repeat the baseline. Incomplete triggers are listed as skipped.

**Value search** (`kindOf`, by the trigger's condition; comparators are never iterated):

| Kind | Conditions | Candidates |
| --- | --- | --- |
| count | `number_of_active_units`, `number_of_dead_units` | 1, 2, 3; no refinement |
| percent | `lowest_hp_percentage` | 10, 30, 50, 70, 90, then ±10, ±5, ±2 around the best (0–100) |
| number | everything else with a value (current/missing HP/MP, incl. the target enemy's current HP) | a grid 1, 100, 300, 1000, 3000, 5000 plus the value already in the box (if ≤ 5000), then best ÷/× 1.5, then ÷/× 1.2; **never above 5000** (`NUMBER_MAX`) |

There is no stat scale for plain numbers on this page (an enemy's HP runs from hundreds to millions), so the first pass tries a fixed grid (capped at 5000) instead of searching around the typed value; the value in the box is just one more candidate. Within an ability the numbers are
searched one trigger at a time, each starting from the best value found for the one before.

**Parallel sims** (checkbox, default on; `optimize`):

- **On.** Every ticked ability is searched **at the same time, each against the baseline alone**
  (nothing adopted is laid over the others). Concurrent searches feed one shared queue
  (`createSimulator`): requests made in the same tick, or while a batch is running, are sent as the next
  batch, so the worker pool stays full and only one pool exists at a time. After the searches, the best
  trigger of every ability that beat the baseline is simulated **together once**. If that combination
  beats the best single ability it is adopted; otherwise only the best single ability is (a note says
  so). Abilities are assumed independent while searching, so the combined run is the check on that.
- **Off.** Coordinate descent: one baseline run, then abilities one at a time in page order (player 1's
  slots, then 2, then 3), each judged against the best so far and run on top of the triggers adopted
  before it. Rounds inside an ability still run their candidates in parallel.
- In both modes an ability's best trigger is adopted **only if its EPH beats the incumbent** (baseline,
  or the best so far in sequential mode); otherwise the current trigger is kept. Identical
  configurations are simulated once (`createSimulator` caches by configuration).

**Passes.** One ability's new trigger can change another's best value, so the search repeats
(`optimize`'s pass loop). Pass 1 is the search above. If at least two abilities are being tuned and
something was adopted, pass 2 re-searches every ability that has a number, **starting from the adopted
triggers** and laid over the others' adopted ones (`localValues`: the current value, then ±10/±5 for a
percent, ÷/× 1.5/1.2 for a number, 1–3 for a count; the usual refinement follows). The current value is
a cache hit, so it is not simulated again. Parallel mode combines each pass's winners as in pass 1, with
the state at the start of the pass as the incumbent. Passes continue **until a pass gains less than
`STOP_GAIN` = 0.5 EPH** (absolute, measured on the best-so-far EPH), at most `MAX_PASSES` = 5. Pass 1
never stops the loop on its own gain, so the second pass always happens when the conditions above hold.
Each ability's trial table is titled with its pass.

**Confirmation** (`confirmHours`, default 100, configurable). The search runs are short (`simHours`,
default 10), so a small gain can be luck. When the passes have adopted at least one trigger, the page
runs **two more simulations at the confirm length: the baseline and the final recommended triggers**
(the adopted set laid over the party), side by side. The results show them in a "Confirmation" table
right under the recommended list, with the gain over the *confirm* baseline and a verdict: confirmed
when the recommended EPH is above the baseline's, otherwise a "not confirmed, keep the current
triggers" warning. Only the final set is confirmed, not each ability's single change. Skipped when
nothing was adopted or the run was stopped. The confirm runs use their own queue and are not cached
against the search runs.

**Sims at once** (the "Sims at once" box, `poolSize`). The number of simulations running at the same
time: default and ceiling is `min(navigator.hardwareConcurrency, 16)` (shown next to the box). It is sent
with `run_optimization`; `optimizationWorker.js` clamps it to that same ceiling and to the batch size, so
a request can only lower the pool. The Optimization page itself does not send one and uses the ceiling.
Parallel mode only fills the pool when several searches have candidates at once: a single ability's
round has 3–5 candidates, so with fewer abilities than cores some cores idle.

**Stopping** (`stop`). The Stop button ends the run at once and the page keeps the partial results. Two
rules matter: (1) `optimizationWorker.js` answers `cancel_optimization` by terminating its simulation
workers, whose pending runs then never settle, so **it never posts `optimization_cancelled`**. A page
that waits for that message hangs forever, so the page terminates the pool itself and rejects the
running batch as "stopped" (`stopBatch`). (2) Everything queued or requested afterwards rejects as
"stopped" too (`createSimulator` checks the `stopped` flag when a request is made and before each
batch), so a search that is between batches cannot start a new one. The stage that is running
(search or confirmation) does not matter; the confirmation is skipped after a stop. The Optimization
page's own Stop has a different path (it ends the run itself after a timeout).

**Results** start with the **recommended triggers** (the adopted ones, at the top), then baseline, the
combined run (parallel), best so far, and a table per ability and pass with every trial. The page has no way to write them back to the game or the
Optimization page; copy them over.

Not done: trigger editing for food/drinks, a second pass automatically, persistence of drafts across
reloads (the context persists, the drafts do not).
