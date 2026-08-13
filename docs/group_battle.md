# Group Battle page — reference

Reference for `group-battle.html` (the "MWI Group Battle Simulator", IC guild Arsenal
internal tool). Covers the page structure, the data/control flow, and — in detail — how
monster stats scale with tier and party size.

Everything here is derived from source. File/line pointers are given so this doc can be
re-verified rather than trusted.

---

## 1. What the page is

A second entry point next to the standard simulator (`index.html`). Instead of "one player
grinds a zone for N hours", it answers **"can this raid roster kill this monster group?"**:

- N players (10–50+) fight a **fixed** enemy group, **once**, to completion.
- No respawns, no drops, no XP-rate output. The outputs are: win/lose, duration,
  who died, damage/healing breakdowns, and a full combat log.
- Two modes: **Single Tier** (one fight at a chosen level) and **Trial Mode** (default —
  a ladder of escalating tiers on one shared time budget).

### Special rules (also shown in the page's collapsible rules banner, `group-battle.html:575-582`)

| Rule | Where implemented |
| --- | --- |
| No food/drinks. Every player instead gets a flat **+3 percentage points** to HP regen and MP regen per 10s (1% → 4%) | `src/combatsimulator/data/groupBattleBuffs.js` |
| Monsters scale with group size — **per player**: +1% max HP, +2% attack speed, +2% cast speed, +2 ability haste | `data/groupBattleScaling.js` → `groupBattleMonster.js` `applyPartyScaling()` |
| Monster **enrage**: +10% damage and +10% accuracy per 10 minutes alive, capped at 10 stacks (+100%/+100%) | `src/combatsimulator/combatSimulator.js:1075-1119` |

The regen buff must be `flatBoost`, not `ratioBoost` — `CombatUnit.updateCombatDetails`
applies ratio first as a multiplier on existing regen, so a ratio of 0.03 would add 3% *of*
current regen instead of 3 percentage points. The comment at the top of `groupBattleBuffs.js`
documents this; don't "fix" it.

---

## 2. File map

| File | Role |
| --- | --- |
| `group-battle.html` | Markup + all CSS (self-contained, dark theme). No logic beyond relocating the i18n language switcher into the header. |
| `src/groupBattle.js` (~2.5k lines) | All page logic: import/roster, presets, aura assignment, enemy selection/preview, running battles, rendering results and the combat log. |
| `src/groupBattleI18nSetup.js` | `t()` + `onLanguageChange()` for this page. |
| `src/worker.js` — `case "start_battle"` (`:199-246`) | Web-worker entry for a single group battle. |
| `src/combatsimulator/groupBattleMonster.js` | `GroupBattleMonster extends Monster` — unique hrid + `applyPartyScaling()`. |
| `src/combatsimulator/data/groupBattleScaling.js` | The per-player scaling constants, shared by the worker and the UI preview. |
| `src/combatsimulator/monster.js` | Base monster derivation, including the level (labyrinth) scale factor. |
| `src/combatsimulator/combatSimulator.js` — `simulateBattle()` (`:267-321`), `battleMode` branches | The single-encounter, no-respawn simulation. |
| `src/combatsimulator/data/monsterGroups.json` | The predefined enemy groups. |
| `src/combatsimulator/data/testPlayers/*.json` | Predefined roster presets (auto-discovered). |

`src/multiWorker.js` is **not** used by this page — it belongs to the standard simulator's
all-zones/all-labyrinths sweeps.

---

## 3. UI structure (`group-battle.html`)

```
header (title, build version, disclaimer, back-link, language switcher)
<details> rules banner
#errorBox
#battleTab
  .layout (2 columns, collapses <1100px)
    card 1 — "Build Roster (N)"
      subtabs: #groupBuilderTab | #pasteJsonTab
      #predefinedPresetList     role presets + count inputs
      #userPresetList           equipment-set presets (+ hidden JSON-preset UI)
      aura level inputs         Fierce/Mystic/Crit/Guardian/Speed
      #buildRoster / #clearPlayers
      #playerList               roster grid of player cards
    card 2 — "Select Enemy Group" + "Battle Settings"
      mode subtabs: #trialMode (default) | #singleBossMode
      #enemySelect  #enemyLevelSelect  #previewEnemyBtn
      #enemyPreviewPanel        per-member stat block
      #enemyGroup               flat table of the resolved enemies
      #singleBossMode: #timeCap, #runBattle
      #trialMode:     #trialTimeCap, #runTrial, #trialModeResult
  #resultPanel (hidden until a run)
    #resultSummary #damageTotals #damageTaken #healingDone
    <details> combat log + filters
#playerModalOverlay          player/preset detail modal
#trialResultModalOverlay     per-tier combat detail modal (mirrors #resultPanel)
```

Wiring lives in the `DOMContentLoaded` handler at `src/groupBattle.js:2429-2553`.

---

## 4. Building the roster

Three preset sources feed `importedPlayers` (`[{ name, dto }]`):

1. **Predefined presets** — every `.json` under `src/combatsimulator/data/testPlayers/`, loaded
   at build time via `require.context` (`groupBattle.js:19-36`). Adding a file adds a preset with
   no code change; the display name is the filename prettified (`bow_insanity.json` → "Bow Insanity").
   Default counts are matched by substring of the filename in `PREDEFINED_DEFAULT_COUNTS`
   (`:324-334`) — e.g. `crossbow`→10, `smash`→10, `nature`→5. Unmatched presets default to 0.
2. **Equipment-set presets** — read from `localStorage["equipmentSets"]`, the sets the *standard*
   simulator saves (`refreshEquipmentSetPresets`, `:348-374`). The ↻ Refresh button re-reads them and
   preserves per-set counts by name.
3. **JSON presets** — pasted solo exports. The UI for these is currently **hidden**
   (`group-battle.html:611-619` `display:none`) but the code path is live.

**Build roster (replace)** (`buildRoster`, `:525-565`) clears the roster and appends `count` copies of
each preset, naming them `"<Preset> <i>"` and assigning hrids `player1..playerN`. Then it calls
`assignAuras()`.

Alternatively the **Paste JSON** sub-tab imports raw exports (`doImport`, `:266-309`). `parseImport`
(`:239-264`) accepts: a single solo export, a JSON array, newline-separated JSON, or the
"group export" object keyed `"1".."5"`.

### The three JSON shapes → one DTO

| Converter | Input | Notes |
| --- | --- | --- |
| `soloExportToDTO` (`:58-114`) | solo export from the standard sim | equipment is an array of `{itemLocationHrid,itemHrid,enhancementLevel}` |
| `equipmentSetToDTO` (`:169-235`) | localStorage equipment set | levels/equipment/abilities are keyed objects; a single `weapon` slot is resolved to `main_hand` vs `two_hand` from the item's own type; extra `charm` slot |
| `dtoToSoloExport` (`:125-161`) | internal DTO → solo export | inverse, for handing a preset back to `index.html` |

All converters force `food = drinks = [null,null,null]` — group battles never eat or drink.

### Aura auto-assignment (`:572-620`)

Five auras are assigned in this fixed priority order, each to the highest-skill player not yet
holding an assigned aura (one aura per player):

| Aura | Chosen by | Level input |
| --- | --- | --- |
| `/abilities/fierce_aura` | `meleeLevel` | `#auraLvlFierce` |
| `/abilities/mystic_aura` | `magicLevel` | `#auraLvlMystic` |
| `/abilities/critical_aura` | `rangedLevel` | `#auraLvlCrit` |
| `/abilities/guardian_aura` | `defenseLevel` | `#auraLvlGuardian` |
| `/abilities/speed_aura` | `attackLevel` | `#auraLvlSpeed` |

> The `auraSectionHint` i18n string matches the code (Fierce→Melee, Speed→Attack). The **hardcoded
> fallback text** in `group-battle.html` used to say the opposite; it only ever showed if i18next
> failed to load, and has been corrected to match.

`setPlayerAura` overwrites the player's existing aura slot if there is one, else the first empty
slot, else slot 0. `AURA_ABILITY_HRIDS` (`:906-910`) is the recognized aura set — note it also
includes `insanity`, `invincible`, and `revive`, which are auras despite not ending in `_aura`.

### Roster cards

`renderPlayerList` (`:1012+`) draws a grid of cards. Each card is colored on the left by combat
style (`STYLE_COLORS`, `:885-892`); magic is further split by damage element; a weapon carrying
`defensiveDamage` is classified as the synthetic **wark** (bulwark/tank) style. Aura holders get a
full glowing border tinted per aura (`AURA_COLORS`, `:912-921`). Cards show HP/MP bars and an
**OOM** badge (ability casts blocked by lack of mana) from the most recent run (`rosterOom`).

Derived stats per card are cached in a `WeakMap` keyed by DTO reference (`:929`) because building a
`Player` is expensive; `assignAuras` invalidates the entry it mutates.

Clicking a card opens the detail modal, which calls `renderDetailedStatus` (`:827-867`). That builds
a **real** `Player` with `zoneBuffs` from `/actions/combat/fly` and `extraBuffs = GROUP_BATTLE_REGEN_BUFFS`
— i.e. exactly what the worker builds — so the preview never drifts from the sim.

---

## 5. Choosing enemies

Enemy groups come from `monsterGroups.json`. Currently: Trial Badger (×2), Trial Chameleon,
Trial Jellyfish, Trial Hedgehog, and Trial Swarm (beetle + dragonfly + wasp + firefly).
Members whose hrid is missing from `combatMonsterDetailMap` are silently dropped (`:1233-1238`).

There is **no manual add/remove step**: `setEnemyGroupFromSelection` (`:1330-1334`) mirrors the
dropdown into `enemyGroup` whenever the group or level changes. `resolveSelectedEnemySpecs`
flattens the group to one spec per enemy (count copies each).

A spec is deliberately thin (`trialSpecAtLevel`, `:1288-1291`):

```js
{ trial: true, scaling: true, hrid, level, name }
```

Full stats are never transcribed — the sim rebuilds a real monster from `hrid + level`.

The level dropdown offers **L100 … L300 in steps of 10**, labelled `L<level> (T<tier>)` where
`tier = (level-100)/10 + 1`, so T1..T21 (`initEnemyLevelSelect`, `:1256-1265`). In Trial Mode the
dropdown is frozen to L100 and disabled — the ladder always starts at T1.

`monsterDerived(hrid, level, hpMult)` (`:1297-1301`) constructs a real `GroupBattleMonster`, calls
`updateCombatDetails()`, and returns its derived stats. The preview panel and the enemy table's HP
column both use it, so **there is no second stat formula anywhere in the UI**.

---

## 6. Monster stat scaling — the important part

### 6.1 Where the scaling happens

`GroupBattleMonster(dataHrid, roomLevel, {hpMultiplier, uniqueHrid, displayName})` calls
`super(dataHrid, /* difficultyTier */ 0, roomLevel)`. Group-battle monsters therefore reuse the
**labyrinth room-level scaling** path in `Monster` with `difficultyTier` pinned to 0, which is what
reproduces the trial stat table exactly.

The scale factor is (`monster.js:31,58`):

```
labyrinthScaleFactor = roomLevel / 100          // base stats are authored for level 100
```

With `difficultyTier = 0`: `levelMultiplier = 1`, `defLevelMultiplier = 1`, `levelBonus = 0`,
so the tier terms drop out entirely.

### 6.2 What scales with level, and what does not

**Scaled linearly by `f = level/100`** (`monster.js:60-82`):

- All seven skill levels: `stamina, intelligence, attack, melee, defense, ranged, magic`
- `combatStats.armor`, `waterResistance`, `natureResistance`, `fireResistance` (the flat components)
- Ability levels: `floor(baseLevel * f)` (`monster.js:36`)

**Copied verbatim, NOT scaled** (`monster.js:75-77`):

- Every percentage-style combat stat: `slashAccuracy`, `slashDamage`, `*Evasion`,
  `maxHitpointsRatio`, `maxManapointsRatio`, `abilityHaste`, `tenacity`, `castSpeed`,
  `criticalRate`, `attackInterval`, …

Any stat absent from the monster's data is zero-filled from an explicit whitelist
(`monster.js:84-152`), so e.g. `combatStats.maxHitpoints` becomes 0 and HP comes purely from the
stamina formula.

**Derived afterwards** by `CombatUnit.updateCombatDetails` (`combatUnit.js:160-300`), using the
already-scaled levels:

```
maxHitpoints      = ceil( (10 * (10 + staminaLevel)      + combatStats.maxHitpoints) * (1 + maxHitpointsRatio) )
maxManapoints     = ceil( (10 * (10 + intelligenceLevel) + combatStats.maxManapoints) * (1 + maxManapointsRatio) )
<style>AccuracyRating = (10 + attackLevel)  * (1 + combatStats.<style>Accuracy)
<style>MaxDamage      = (10 + <skill>Level) * (1 + combatStats.<style>Damage)   // melee/ranged/magic level per style
<style>EvasionRating  = (10 + defenseLevel) * (1 + combatStats.<style>Evasion)
totalArmor        = 0.2 * defenseLevel + combatStats.armor      // same shape for the 3 resistances
attackInterval    = combatStats.attackInterval / (1 + attackLevel/2000) / (1 + attackSpeed) / (1 + attackSpeedBuffs)
```

Consequences worth knowing:

- HP/MP scale **slightly sub-linearly**: the `+10` offset inside `10*(10+stamina)` does not scale.
  Doubling the level takes Trial Badger from 379,500 → 724,500 HP (×1.909, not ×2).
- Accuracy/damage/evasion are **linear in the scaled level** but the multiplicative percentage
  stays fixed, so a monster's *relative* profile is level-invariant.
- **Monsters get faster with level**, because `attackInterval` is divided by `1 + attackLevel/2000`.
- The raw `abilityHaste`, `tenacity` and `castSpeed` **stats** are constant across tiers, but the
  *effective* cast speed is not — see §6.3, `castSpeed` gets an `attackLevel/2000` term added at
  derivation time.

### 6.3 Action speed: attackInterval vs castSpeed vs abilityHaste

Three separate knobs govern how often a unit acts. They are easy to confuse and they compose, so
they get their own section.

| Knob | Formula | Governs | Applied in |
| --- | --- | --- | --- |
| `attackInterval` | `interval / (1 + attackLevel/2000) / (1 + attackSpeed) / (1 + attackSpeedBuffs)` | delay between auto-attacks | `combatUnit.js:284-292` |
| `castSpeed` | `castDuration / (1 + castSpeed)` | ability wind-up before it resolves | `combatSimulator.js:883-884` |
| `abilityHaste` | `cooldown * 100 / (100 + haste)` | how soon an ability is reusable | `ability.js:192-196`, `combatSimulator.js:1286-1290` |

**`castSpeed` is not just the data value.** `CombatUnit.updateCombatDetails` adds two terms
(`combatUnit.js:351-352`):

```js
combatStats.castSpeed += getBuffBoost("/buff_types/cast_speed").flatBoost;
combatStats.castSpeed += combatDetails.attackLevel / 2000;      // <- tier-scaled!
```

The `attackLevel/2000` term uses the same coefficient as the attack-interval speedup, and
`attackLevel` **is** tier-scaled — so effective cast speed rises with tier even when the stat
doesn't. A monster with no `castSpeed` stat still has 0.05 at L100 and 0.15 at L300.

> `totalCastSpeed` in `combatMonsterDetailMap.json` is **dead data** — no code reads it.
> `Monster.updateCombatDetails` copies only `combatDetails.combatStats.*` (`castSpeed` is in the
> zero-fill whitelist, `monster.js:131`) and the total is recomputed from the formula above.

**Casting replaces the auto-attack.** In `addNextAttackEvent` (`combatSimulator.js:854-905`):

1. If the unit already has a pending `AbilityCastEndEvent` **or** `AutoAttackEvent`, return —
   one action in flight at a time (`:854`).
2. Walk ability slots **in order**; the first that passes `shouldTrigger` + `canUseAbility`
   schedules an `AbilityCastEndEvent` at `now + castDuration/(1+castSpeed)` and sets `usedAbility`.
3. If `usedAbility`, **return before scheduling an auto-attack** (`:900-903`).
4. Otherwise schedule an `AutoAttackEvent` at `now + attackInterval`.
5. When the cast-end event fires, `tryUseAbility` resolves it (`:383`) and the loop repeats.

Consequences:

- Cast duration is **dead time** — the unit does nothing else during it, and its next action is
  gated behind it. Cast speed therefore raises total action throughput, not just one ability's timing.
- A monster with a **0-cooldown filler ability** never auto-attacks at all; its entire damage clock
  is the filler's cast time. `attackInterval` is then almost irrelevant to it.
- Longer casts widen the **stun-interrupt window**: a stun clears the target's pending
  `AbilityCastEndEvent` outright (`combatSimulator.js:1554`), cancelling the cast.

**Display caveats in this page:** the ability-detail table shows the *raw, unmodified*
`ability.castDuration` (`groupBattle.js:750`), and the enemy preview's Cast Speed tile is only
rendered when the value is non-zero (`groupBattle.js:1371`).

### 6.4 Party-size scaling

Every rule is **per player in the group**. The constants live in one place,
`data/groupBattleScaling.js`, which returns the option bag passed to `GroupBattleMonster`:

```js
groupBattleScaling(n) => {
  hpMultiplier:     1 + 0.01 * n,   // +1%  max HP (MP not scaled)
  attackSpeedBonus: 0.02 * n,       // +2%  attack speed
  castSpeedBonus:   0.02 * n,       // +2%  cast speed
  abilityHasteBonus: 2 * n,         // +2   ability haste (flat points)
}
```

They are applied *after* the whole base derivation, in
`GroupBattleMonster.applyPartyScaling()`, which `updateCombatDetails()` calls last:

```js
maxHitpoints  = floor(maxHitpoints  * hpMultiplier)
combatStats.attackInterval /= (1 + attackSpeedBonus)   // separate divisor
combatStats.castSpeed      += castSpeedBonus           // additive
combatStats.abilityHaste   += abilityHasteBonus        // additive
```

**Each bonus mirrors how the engine applies that stat's own buffs** (see §6.3), so the result equals
what an equivalent buff would produce: attack speed as a separate divisor (`combatUnit.js:288-292`),
cast speed additive into the stat (`combatUnit.js:351`), ability haste as flat points consumed by
`cooldown * 100/(100 + haste)`.

Re-application is safe on every re-derivation (`reset()` → `updateCombatDetails()`): `Monster`
re-copies `combatStats` from the game data and zero-fills anything missing on every call, so the
bonuses always land on fresh values and **never accumulate**.

Scaling affects **max HP and action speed only** — never max MP, damage, accuracy, evasion, armor or
resistances. Max MP is deliberately left alone, so a bigger group does *not* give the monster a
larger mana pool to spend on abilities.

The UI mirrors it via `groupScaling()` (`groupBattle.js`), a thin wrapper that calls the *same*
`groupBattleScaling()` helper with the current roster size, so the enemy table and stat preview
cannot drift from the sim. Preview tiles the roster scales are suffixed `(xN players, +X%)`.

### 6.5 Unique-hrid trick

`SimResult` aggregates damage/deaths/healing by `unit.hrid`, so two copies of Trial Badger would
merge into one row. `buildWorkerEnemies` (`groupBattle.js:1345-1353`) therefore assigns
`uniqueHrid = "<hrid>#<i+1>"`. But `Monster.updateCombatDetails()` re-reads
`combatMonsterDetailMap[this.hrid]` on every call, so the hrid cannot simply be renamed. The class
keeps the real key in `dataHrid` and **swaps it in for the duration of the base derivation**, then
restores the unique hrid (`groupBattleMonster.js:38-41`). Display names for result rows are stashed
in `window.__enemyNames`.

### 6.6 Worked example — Trial Badger

Base data (`combatMonsterDetailMap["/monsters/trial_badger"]`): all levels 100, `maxHitpointsRatio`
344, `slashAccuracy` 3.2, `slashDamage` 1.4, `slashEvasion` 3.7, `armor` 400, `attackInterval` 2.7s,
no `abilityHaste`, `tenacity` 3000, `enrageTime` 600s.

| | T1 (L100) | T11 (L200) | T21 (L300) |
| --- | --- | --- | --- |
| all skill levels | 100 | 200 | 300 |
| max HP (solo) | 379,500 | 724,500 | 1,069,500 |
| max HP (30 players, ×1.30) | 493,350 | 941,850 | 1,390,350 |
| slash accuracy rating | 462 | 882 | 1,302 |
| slash max damage | 264 | 504 | 744 |
| slash evasion rating | 517 | 987 | 1,457 |
| total armor | 420 | 840 | 1,260 |
| attack interval (solo) | 2.571s | 2.455s | 2.348s |
| attack interval (30 players, ÷1.60) | 1.607s | 1.534s | 1.467s |
| ability levels (e.g. Berserk 60) | 60 | 120 | 180 |
| ability haste (solo → 30 players) | 0 → 60 | 0 → 60 | 0 → 60 |
| effective castSpeed (solo → 30 players) | 0.05 → 0.65 | 0.10 → 0.70 | 0.15 → 0.75 |
| tenacity | 3000 | 3000 | 3000 |

The **solo** rows reproduce the precomputed values stored in the game data exactly — a useful
regression check if the scaling code is ever touched. The 30-player rows show the same monster after
`applyPartyScaling()`.

Note how large the party effect is at raid size: 30 players cut Trial Badger's attack interval by
~37%, cut a 15s ability cooldown to 9.4s (`15 × 100/160`), and take a 3.0s cast down from 2.86s to
1.82s — while adding only 30% more HP. Group size is now a much bigger lever on monster output than
on monster durability.

### 6.7 Enrage

Not level-dependent, but it dominates long fights.

- `enrageTime` is 600s (10 min) for all trial monsters.
- An `EnrageTickEvent` fires every **60s** (`ENRAGE_TICK_INTERVAL`, `combatSimulator.js:32`).
- `stack = min(10, floor(encounterTime / enrageTime))`, so +1 stack per 10 minutes, capped at 10.
- Each tick refreshes two 60s buffs on every living enemy: `/buff_types/damage` and
  `/buff_types/accuracy`, each with `ratioBoost = stack * 0.1`.
- Peak effect: **+100% damage and +100% accuracy at 100 minutes.**

`enemy.experienceRate` scaling from enrage is skipped in battle mode (`combatSimulator.js:731`) —
group battles produce no XP.

---

## 7. Running a battle

```
groupBattle.js  runBattle() / runTrialMode()
   → runBattleOnWorker({players, enemies, timeCapSeconds})   // FIFO of pending resolvers
   → worker.postMessage({type:"start_battle", ...})
worker.js  case "start_battle"
   → Player.createFromDTO for each; zoneBuffs from /actions/combat/fly;
     extraBuffs = GROUP_BATTLE_REGEN_BUFFS
   → partyScaling = groupBattleScaling(players.length)
   → enemies.map(e => new GroupBattleMonster(e.hrid, e.level, {...partyScaling, uniqueHrid, displayName}))
   → new CombatSimulator(players, battleZone, null, {logEvents:true, fixedEnemies})
   → simulateBattle(timeCapNs)
   → postMessage({type:"battle_result", simResult})
```

The zone `/actions/combat/fly` is a harmless stand-in used only to supply zone buffs; nothing about
the zone's monsters is used, because `battleMode` replaces the spawn logic with `fixedEnemies`
(`combatSimulator.js:443-444`). Only **one** worker exists and it handles one battle at a time;
requests are serialized through `pendingBattleResolvers` (`groupBattle.js:1602-1628`), which is what
lets Trial Mode `await` tiers sequentially.

### `simulateBattle` semantics (`combatSimulator.js:267-321`)

- Runs the event loop until `battleOver` or `simulationTime >= timeCap`.
- `checkEncounterEnd` in battle mode ends the fight as soon as **either** side is fully wiped, with
  no respawn events (`:748-758`).
- Outcome: `timeout` (cap hit) → `victory` (players alive, enemies dead) → `defeat` (no players
  alive) → `ended` (fallback).
- Result carries `battleOutcome`, `battleDurationNs`, `playerSurvivors`, `playerFinalState[]`
  (hp/mp current+max), `enemyFinalState[]` (hp current+max), plus the usual `deaths`,
  `playerOomCastCount`, `abilityCastCounts`, and `battleLog`.

### Trial Mode (`groupBattle.js:1649-1764`)

- Tiers T1..T21 (`tierLevel(tier) = 100 + 10*(tier-1)`).
- Every enemy is **re-leveled** to the tier's level each round — the per-enemy level from the
  dropdown is ignored.
- One shared `#trialTimeCap` budget; each tier's elapsed duration is subtracted, and the tier's own
  cap is whatever remains. The run stops at `remainingSeconds <= 0`.
- Players are fully restored between tiers implicitly — each tier builds fresh `Player` objects from
  the same DTOs.
- Loop continues only on `victory`; `defeat` / `timeout` / `ended` stops the run and becomes the
  `stopReason`.
- Per tier it records outcome, duration, wiped count, `bossHpFrac` (the *lowest* surviving enemy HP
  fraction), OOM total, and the full `simResult`. Per-player OOM accumulates across tiers into
  `rosterOom`, refreshing the roster badges live.
- Clicking a tier row opens `#trialResultModalOverlay`, which calls the same `renderResult` with
  `IDS_MODAL` instead of `IDS_MAIN` — one renderer, two targets (`:1893-1904`).

---

## 8. Results & combat log

`renderResult(result, scrollTo, ids)` (`:1906-1966`) writes:

- **Summary** — outcome chip, duration, enemy final states (listed first), player final states with
  HP/MP/deaths/OOM.
- **Damage Done** — `aggregateAttacks(log, "source")`, then `mergeAbilityCastCounts` folds in
  abilities that never appear in the attack log (pure buffs/heals/revives) so every cast ability is
  listed. Aura casters are tagged via `NAME_TAG_AURA_HRIDS`.
- **Damage Taken** — `aggregateAttacks(log, "target")`, plus `mergeSelfInflictedDamage`.
- **Healing Done** — `aggregateHeals` + `mergeHealCastCounts`.
- Each table row is expandable into a per-ability breakdown with hit/miss and accuracy %.

The log renderer (`renderLog`, `:2310+`) filters by kind (attack / heal / manaGain / buffCast /
enrage / death / consumable), by player, by free-text search, and can hide aura chatter.

Names are resolved through `nameFor(hrid, isPlayer)` against `window.__playerNames` /
`window.__enemyNames`, both repopulated at the start of every run.

---

## 9. Gotchas for future changes

- **Never write a second monster stat formula in the UI.** Go through `monsterDerived()` /
  `GroupBattleMonster` so the preview and the sim cannot diverge.
- **Change party-size scaling in `data/groupBattleScaling.js` only.** Both the worker and the UI
  call that one helper; hardcoding a factor in either place reintroduces UI/sim drift.
- The scaling still reads `importedPlayers.length` in the UI and `battlePlayers.length` in the
  worker. If a player is ever excluded from a battle, those two counts will disagree.
- `GroupBattleMonster.updateCombatDetails` must keep the `hrid` swap; renaming `hrid` outright
  breaks the game-data lookup, and dropping the unique hrid merges duplicate monsters in results.
- `applyPartyScaling()` must stay *after* `super.updateCombatDetails()`. `attackSpeed` in particular
  cannot be set as a stat beforehand — `Monster` re-copies `combatStats` from the game data and
  `CombatUnit` consumes `attackSpeed` into `attackInterval` during that call, so the bonus would be
  overwritten or double-counted.
- Max HP uses `Math.ceil` in `CombatUnit` but the party multiplier uses `Math.floor` — intentional as
  of commit `e8df1ad`. Max MP is **not** party-scaled.
- `attackInterval`, `castSpeed` and `abilityHaste` are three **different** knobs (see §6.3). A unit
  with a 0-cooldown filler ability never auto-attacks, so `attackInterval` is nearly irrelevant to
  it and `castSpeed` is its entire damage clock — don't reason about monster DPS from
  `attackInterval` alone.
- Adding a roster preset = drop a JSON file in `data/testPlayers/`. Adding an enemy group = add an
  entry to `monsterGroups.json`. Neither needs code changes.
- Per project convention, this page is **English-only for new features**; existing strings still go
  through `t()` / `data-i18n`.
