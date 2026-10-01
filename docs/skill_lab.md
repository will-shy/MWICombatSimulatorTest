# Skill Lab page — reference

Reference for `skill-lab.html`: an ability-kit bench for **one member of a real raid**. Load the
guild's combat-trial export, pick a member, give them several kits, and the page runs the whole
party's fight once per kit, several times each, on the wasm combat kernel. It answers "which bar
should this player run?" in the fight the guild actually takes.

File/line pointers are given so this doc can be re-verified rather than trusted.

---

## 1. Files

| File | Role |
| --- | --- |
| `skill-lab.html` | Markup + CSS (same palette as `group-battle.html`). |
| `src/skillLab.js` | All page logic: party import, guild buildings, mode, player, kits, worker pool, aggregation, results. |
| `src/skillLabJob.js` | One run of one kit (single fight or ladder) on the kernel, reduced to the focus player's numbers. Runs inside `worker.js`. |
| `src/worker.js` — `case "start_skill_lab"` | The message the page sends. Same worker and kernel as every other page. |
| `src/guildTrialImport.js` | The guild trial export → import set, shared with the Group Battle page (`docs/group_battle.md` §4.1). |
| `src/combatsimulator/importSet.js` | `importSetToPlayerDTO(set, hrid, abilityOverride)` builds every DTO, including each kit. |
| `src/playerDetailView.js` | The preview dialog (shared with Group Battle). `describeTrigger` is exported for the kit slots. |
| `src/combatClass.js` | Class colour and order from the weapon, shared with the Group Battle roster. |
| `src/combatsimulator/skillLab.js` | **The old JS-kernel squad bench.** The page uses only `ABILITY_LIST` and `enemyPreview` from it. It stays because `src/skillLabMatrix.js` (the Boss Matrix batch driver, `webpack.matrix.config.js`) still runs on it. |

---

## 2. Rules

### The fight is the Group Battle page's fight

- The party is the whole guild export, built with the Group Battle importer: the loadout wins
  field by field, a member with no loadout falls back to their profile, food and drinks are empty
  (`docs/group_battle.md` §4.1). Player `i` of the export is `player${i+1}`, as on that page.
- Each job is the same `start_battle` payload that page sends: `players`, `enemies` (one entry per
  copy, `trial: true`, unique `hrid#n`), `guildBuildingLevels`. Regen compensation, guild buildings,
  shrines, party-size scaling and enrage are all applied by the kernel, so there is no Skill Lab
  version of any of them.
- **Players take real damage and spend real mana.** The old bench's "infinite mana" and "players
  take no damage" options were hooks on the JS kernel. The wasm kernel has no such hooks
  (Rust repo `docs/combat.md` §19), so they are gone. A kit that gets its player killed, or the raid
  wiped, scores lower. That is intended.
- Guild building levels share `localStorage["mwiGuildBuildingLevels"]` with the Group Battle page.

### Two modes (`skillLabJob.js`)

- **Trial Mode (default):** T1 = L100, +10 per tier, up to T21, on one shared budget (default
  3600 s). Every tier is a fresh battle at full HP/MP, and the run stops at the first non-victory.
  This is the same as `runTrialMode` in `groupBattle.js`. Tier seeds come from the run seed with
  the same `tierSeed` as `scripts/sim-sweep.mjs`. The run outcome is `completed` when all 21 tiers
  are cleared, and `timeout` when the budget runs out between tiers.
- **Single Tier:** one fight at the chosen level, with its own time cap (default 3600 s).
- The budget and the cap are stored separately (`trialBudget`, `singleCap`), so switching modes
  doesn't overwrite one with the other.

### Only the focus player changes

- Every kit runs the same party. The only difference is the focus player's ability list, passed as
  `importSetToPlayerDTO`'s `abilityOverride`. Their gear, levels, house rooms and shrines stay as
  imported.
- **Triggers:** an ability the member has a trigger entry for (merged loadout + profile
  `triggerMap`) uses their own triggers. Anything else uses the game's `defaultCombatTriggers`.
  The slot shows which, with the conditions in a tooltip. The page doesn't edit triggers.
- Picking a different player resets the kits to that player's bar, because kits are built around
  one weapon.

### Ability levels (`abilityLevelFor`, `defaultAbilityLevel`)

An ability the member has **equipped** starts at **their own level**. This applies to the baseline
kit (their bar as imported) and to an equipped ability picked into another kit's slot. The export
only carries levels for equipped abilities, so any other ability falls back to a default read from
the game data:

| Rule | Level | Today |
| --- | --- | --- |
| `cooldownDuration === 0` | 60 | Entangle, Fireball, Water Strike |
| `isSpecialAbility` | 20 | the five auras, Insanity, Invincible, Revive, Promote |
| everything else | 40 | |

Choosing an ability in a slot resets that slot's level by this rule. Levels stay editable. One
consequence: a kit that swaps an equipped ability (own level, say 85) for an unknown one (default
40) is also comparing levels, not just abilities. Set the level by hand when that matters.

### Runs and seeds

- Default **10 runs per kit** (max 50). Run `i` of every kit uses seed `1000 + (i+1)·7919`, so
  results are reproducible and kits start from the same rolls. As `docs/harness.md` §7 warns,
  a changed bar diverges from the first differing event, so same-seed runs aren't paired samples.
- Jobs are interleaved by run index and spread over a pool of `worker.js` instances
  (`min(6, cores − 1)`). Each worker holds its own kernel. **Stop** terminates the pool, and the
  next run starts a fresh one.

### What a run reports (`reduce` in `skillLabJob.js`)

The kernel always produces the full battle log (`setup.rs` sets `log_events = true` for battles),
which is tens of MB of JSON for a long ladder. It is reduced **inside the worker**, and only the
focus player's numbers reach the page:

- **Damage** comes from `attacks[focus]`, counting **enemy targets only** (thorns and retaliation can
  also land under a player's hrid). Hits and misses are counted per source key. `"miss"` is a key,
  not a number.
- **Healing** comes from `battleLog` `heal` entries with `healer === focus`, **excluding
  `healSource: "regen"`** for the same reason as `docs/group_battle.md` §8.2.
- **Casts** from `abilityCastCounts`, **blocked casts** from `playerOomCastCount`, **deaths** from `deaths`.
- `raidDmg` is the whole party's damage on enemies, for the raid-share column.
- Everything is summed over every tier fought.

### Aggregation (`aggregate` in `skillLab.js`)

- **Avg damage** is the mean per run. **±95%** is `1.96·sd/√n`: kits closer than that are not
  separated, so add runs.
- **DPS** is total damage over total fight time (a true rate, not an average of rates).
- In Trial Mode, total damage is confounded with ladder length: a kit that helps the raid clear
  another tier deals more because it fights longer. DPS, and the **tiers cleared** column (the
  average, plus the `cleared + tier progress` score), separate the two.
- **Tier progress** is `1 − Σ remaining HP / Σ max HP` over the whole enemy group. `bossHpFrac` holds
  the remaining fraction, and the page always shows progress, never HP left. Two badgers, one dead
  and one at 90%, is 55% progress. The Group Battle page and `sim-sweep` use the same formula.
- "vs base" compares with kit 1 on both average damage and DPS. "best" marks the highest average damage.
- Expanded rows show damage by source with casts and accuracy, healing by source, a per-tier
  table (reached, cleared, average damage and time) and the per-run list with seeds.

Source keys are shown through `sourceName`: `autoAttack`, `damageOverTime`, full ability hrids,
and bare-hrid weapon procs such as `bloom`, which are shown with "(proc)".

### Party list

The party table and the player dropdown are in **class order**: Wark → Cursed Bow → Water Support →
Nature Support → Slash → Stab → Smash → Ranged → Fire → Water → Nature DPS → unknown (magic with no
element, unarmed), with import order kept within a class. The class comes from `raidClass` in `src/combatClass.js`, read off the weapon
and, for the support classes, the member's bar as imported (nature + Rejuvenate, water + Mana
Spring). The Group Battle roster uses the same module, so a class has the same name, colour and
order on both pages. The rules are in `docs/group_battle.md` §4.8. Sorting is display
only: a member keeps their import index, which their `player${i+1}` hrid and the focus selection
are keyed on. The dropdown groups members under one heading per class.

### Persistence

| Key | Holds |
| --- | --- |
| `mwiSkillLabConfigV3` | mode, group, level, budget/cap, runs, focus member name, kits |
| `mwiSkillLabPartyV1` | the imported party as `{ name, noLoadout, importSet }` per member (small, unlike the 3 MB export). If storage is full, the page says so and still works until a reload. |
| `mwiGuildBuildingLevels` | shared with Group Battle |

The focus player is stored by **name**, so re-importing a fresh export keeps the same player and kits.

---

## 3. Gotchas

- A combat-logic change has to be made in the Rust repo and the wasm rebuilt (`src/wasm/README.md`).
  An edit to `src/combatsimulator/` changes nothing here except the enemy preview, which still
  builds a JS `GroupBattleMonster` (as Group Battle's preview does).
- Don't pass the battle result to the page. Reduce it in `skillLabJob.js`; it is far too big to
  post per run.
- If you change the ladder rules on the Group Battle page (`runTrialMode`), change them in
  `skillLabJob.js` and `scripts/sim-sweep.mjs` too. They are three copies of the same loop.
- The Rust repo's `docs/combat.md` §19 still describes the old JS-kernel Skill Lab. The Boss Matrix
  driver is now the only thing that behaves that way.
