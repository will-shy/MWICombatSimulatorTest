# Driving the simulator headlessly — harness notes

How to run batch experiments against `group-battle.html` from a terminal: turn a guild trial export
into a battle job, run it many times on the wasm combat kernel, and get numbers that mean something.

Everything here was learned the hard way during a T8 hedgehog investigation. The **Pitfalls** and
**Getting numbers that mean something** sections are the parts worth reading before you start —
several of them silently produce wrong answers rather than errors.

Every simulation runs on the wasm combat kernel (`src/wasm/`, see its README), a Rust port that
reproduces the JS kernel in `src/combatsimulator/` bit for bit. The harness runs that same wasm
build directly in Node. The browser is used only to build each arm's job, once. An 850s T8 fight
with 56 players takes about 0.2s on one core, and a sweep spreads its runs across every core.

---

## 0. Quickstart

Most experiments need no new driver code — `scripts/sim-sweep.mjs` does the whole loop.

```bash
# 1. dev server (leave it running; it dies with the session)
npx webpack serve --mode development --no-open

# 2. build roster variants by editing an exported guild trial JSON (see §5)

# 3. sweep — the FIRST arm is the control everything is compared against
node scripts/sim-sweep.mjs \
  --arm "base=$HOME/Downloads/roster.json" \
  --arm "nodojo=/tmp/nodojo.json"
```

```
L170, 900s cap, 60 runs/arm, seed 7, buildings {"diningRoom":0,"library":2,"dojo":4,...}

score: boss HP left, % (lower is better)
arm       min     q1    med     q3    max   mean  kills  alive  seed w-l    U vs base
base      0.0    8.2   14.3   39.8   67.1   22.5      7  13/60       -       -
nodojo    0.0   15.6   20.7   42.6   82.9   29.6      2   7/60   24-35   1393/3600  p=0.984

120 runs in 3.9s on 13 threads
```

Useful flags: `--runs 40` (the default), `--level 170` (L170 = T8), `--cap 900`, `--ladder` for the
full escalating run, `--buildings '{...}'` for guild building levels, `--seed N` to reproduce a
sweep, `--json out.json` to dump per-run data, `--save-jobs DIR` to keep each arm's job.
`node scripts/sim-sweep.mjs` with no arms prints the full usage.

What it does:

1. **Builds a job per arm in the page.** It imports the roster, clicks Run and captures the
   `start_battle` message the page posts to its worker, without letting it through. That message
   is exactly what the kernel would receive. This is the only step that needs the dev server and
   Chrome, about 6s per arm.
2. **Runs every job on the wasm kernel in Node**, on a pool of worker threads (`--jobs`, default
   cores − 1). It loads `src/wasm/` and the data maps the same way `src/worker.js` does.
3. **Reports** one row per arm against the first.

An arm can also be a job saved by `--save-jobs`. A saved job runs as saved, with no browser or dev
server, which makes it the fastest way to iterate on a variant (§5).

It resolves Playwright out of the npx cache and drives an installed Chrome, so there is nothing to
install.

Drop to a hand-written driver only when you need something the sweep doesn't report: per-player
breakdowns, per-ability mana, death timelines. §4 covers where that data lives and how to run the
kernel yourself.

---

## 1. Dev server

Needed only to build jobs from rosters. Saved jobs don't need it.

```bash
lsof -ti:9000 -sTCP:LISTEN | xargs kill 2>/dev/null   # free the port first
npx webpack serve --mode development --no-open
```

Run it in the background. Then **poll, don't sleep** — `timeout` is not on macOS by default and a
fixed `sleep` either wastes time or races:

```bash
for i in $(seq 1 60); do
  curl -sf -o /dev/null http://localhost:9000/group-battle.html && echo SERVING && break
  sleep 1
done
```

Watch mode is on, so edits to `src/` rebuild automatically — no restart needed between code
changes, only between *browser* sessions.

**Edits to `src/combatsimulator/` no longer change any result.** The kernel is compiled from the
Rust port, and neither the page nor the harness runs the JS combat code any more. What a JS edit
still changes is everything *before* the kernel: roster import, the player DTOs and the enemy
payload the page builds. To test a change to the combat logic itself, make it in the Rust repo and
rebuild the wasm (`src/wasm/README.md`).

**The server dies when the agent session ends.** Background tasks are not reparented. Restart it
and re-run; nothing is corrupted. Jobs saved with `--save-jobs` survive, and a sweep over saved
jobs does not need the server at all.

---

## 2. Playwright

There is no `playwright` dependency in this repo and no bundled browser. Two things to work around:

```js
// Resolve the module out of the npx cache rather than node_modules.
import { chromium } from "/Users/<you>/.npm/_npx/<hash>/node_modules/playwright/index.mjs";

// No chromium download; drive the installed Google Chrome instead.
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--no-sandbox"],
});
```

Find the hash with `ls ~/.npm/_npx/*/node_modules/playwright/index.mjs`. It is stable but not
guaranteed; resolve it at script-build time rather than hardcoding if you care.

Write driver scripts into the session scratchpad, not the repo. They are throwaway and must not be
committed.

---

## 3. Driving the page

### Guild building levels

Set them in `localStorage` **before** the page reads them, then reload:

```js
await page.goto("http://localhost:9000/group-battle.html");
await page.evaluate((l) => localStorage.setItem("mwiGuildBuildingLevels", JSON.stringify(l)),
  { diningRoom: 0, library: 2, dojo: 4, armory: 1, gym: 1, archeryRange: 1, mysticalStudy: 1 });
await page.reload();
```

`goto` → `setItem` → `reload` is the whole trick: the first load seeds the origin, the reload picks
the values up. Setting them after load leaves the in-memory copy stale. The levels end up on the
job as `guildBuildingLevels`.

### Importing a roster

```js
await page.waitForSelector("#guildTrialDrop");
await page.setInputFiles("#guildTrialFile", "/abs/path/roster.json");
await page.waitForSelector(".roster-row", { timeout: 30000 });
await page.waitForTimeout(1800);        // derived summaries for 50+ players
```

`setInputFiles` fires `change`, which is what the import listens for. The extra wait is not
superstition — each player's summary builds a real `Player`, and 56 of them is not instant.

### Running one fight

```js
await page.click('.subtab[data-modetab="singleBossMode"]');
await page.selectOption("#enemyLevelSelect", "170");     // L170 = T8
await page.fill("#timeCap", "900");
await page.click("#runBattle");
await page.waitForSelector("#resultPanel:not([style*='display: none'])", { timeout: 60000 });
```

On the wasm kernel this takes about a second. Level ↔ tier is `level = 100 + 10*(tier-1)`, so
T8 = L170.

**A single-tier run at tier N reproduces that tier of a ladder**, because Trial Mode restores every
player to full HP/MP between tiers. That makes isolating one tier both valid and cheaper than
running the whole ladder.

### Running the full ladder

```js
await page.click('.subtab[data-modetab="trialMode"]');
await page.fill("#trialTimeCap", "3600");
await page.click("#runTrial");
await page.waitForFunction(() =>
  !document.getElementById("runTrial").disabled &&
  document.getElementById("trialModeResult").style.display === "block",
  null, { timeout: 600000 });
```

Note the ladder shares one budget, so **T8 only inherits what T1–T7 left** — typically 750–850s.
Conclusions drawn from a 900s single-tier run can overstate what the ladder will do.

`sim-sweep --ladder` does not click through the page tier by tier. It captures the tier-1 message
and runs the ladder itself, the way `runTrialMode` in `groupBattle.js` does: every enemy is
re-leveled to the tier, the time budget is shared, a victory advances and anything else stops. On
the same per-tier seeds it reproduces the page's Trial Mode table tier for tier.

### Capturing the job, and seeding the page

The page creates its worker at load, so patch `Worker.prototype.postMessage` before any page
script runs. This is how `sim-sweep` captures jobs:

```js
await page.addInitScript(() => {
  const post = Worker.prototype.postMessage;
  window.__jobs = [];
  Worker.prototype.postMessage = function (msg, ...rest) {
    if (msg?.type === "start_battle") {
      msg = { ...msg, seed: 12345 };                  // optional: pin the page's seed
      window.__jobs.push(JSON.parse(JSON.stringify(msg)));
    }
    return post.call(this, msg, ...rest);             // drop this line to capture without running
  };
});
```

The worker accepts `seed` on the message, and `__lastBattleResult.seed` reports the seed a run used,
whether it was pinned or drawn at random. A result from the page and a result from Node (§4) on the
same job and seed are byte-identical.

---

## 4. Getting data out

### From the page

`renderResult` stashes the raw result on the page. This is the richest source by far — prefer it
over scraping rendered tables:

```js
const out = await page.evaluate(() => {
  const res = window.__lastBattleResult;          // full SimResult
  const names = window.__playerNames;             // hrid -> display name
  const enemies = window.__enemyNames;            // uniqueHrid -> display name
  // ...aggregate here, return plain JSON
});
```

### From the kernel directly

For per-player analysis over many runs, skip the page: save the jobs once
(`sim-sweep --save-jobs DIR --runs 1 --arm ...`) and run the kernel on them in Node. This is what
the sweep's worker threads do:

```js
import { readFileSync } from "node:fs";
const REPO = "/abs/path/to/MWICombatSimulatorTest";

// The data maps, keyed the way src/worker.js imports them.
const data = {};
const workerSrc = readFileSync(`${REPO}/src/worker.js`, "utf8");
for (const [, name, file] of workerSrc.matchAll(/import (\w+) from "\.\/combatsimulator\/data\/([\w.-]+)\.json"/g))
  data[name] = JSON.parse(readFileSync(`${REPO}/src/combatsimulator/data/${file}.json`, "utf8"));

// Import the glue from source: with no "type": "module" in package.json, importing the .js by
// path makes Node reparse it and warn.
const glue = readFileSync(`${REPO}/src/wasm/mwi_wasm.js`, "utf8");
const { initSync, CombatKernel } = await import("data:text/javascript;base64," + Buffer.from(glue).toString("base64"));
initSync({ module: readFileSync(`${REPO}/src/wasm/mwi_wasm_bg.wasm`) });
const kernel = new CombatKernel(JSON.stringify(data));

const job = JSON.parse(readFileSync("/tmp/jobs/baseline.json", "utf8"));
const res = JSON.parse(kernel.battle(JSON.stringify({ ...job, seed: 12345 })));
```

Build the kernel once per thread and reuse it; building it parses every data map. A full T8 result
with its battle log is about 16 MB of JSON, so reduce each result to what you need before keeping
it.

### Useful fields

| Field | Contents |
| --- | --- |
| `battleOutcome` | `victory` / `defeat` / `timeout` / `ended` |
| `battleDurationNs` | fight length |
| `playerFinalState[]` | `hrid`, current/max HP and MP — also the only easy source of **max HP per player** |
| `enemyFinalState[]` | current/max HP, for "boss HP left" |
| `battleLog[]` | every event; `kind` is `attack` / `heal` / `death` / `manaGain` / `buffCast` / `consumable` / `enrage` |
| `abilityCastCounts[hrid][abilityHrid]` | true cast counts including non-damaging abilities |
| `playerOomCastCount[hrid]` | casts blocked by insufficient mana |
| `hitpointsSpent[hrid][abilityHrid]` | self-inflicted HP (Insanity) |
| `seed` | the seed the run used (page results only; in Node you passed it) |

Attack log entries carry `premitigatedHit` (damage before armour/resistance). It is absent for
damage-over-time, so always fall back to `hit`. A miss logs `hit: "miss"`, a string (see §6).

Players are `player1`, `player2`, … in the roster file's order, so the member at index `i` of the
export is `job.players[i]` and has hrid `player${i + 1}`. That is how to find one member's entries
in `battleLog` from a script, where `__playerNames` isn't available.

The HP/MP time series (`timeSeriesData`) is not produced by the wasm kernel. Reconstruct HP over
time from the `attack` and `heal` entries in `battleLog`, which carry `targetHpAfter`, and MP from
`manaGain`'s `targetMpAfter` (spend shows only as the gap between gains).

Scrape the DOM only for things the result object doesn't hold — the roster table (`#playerList
tbody tr.roster-row`) and the detail dialog's derived stat tiles (`#playerModalBody .stat-tile`,
after clicking `.show-status-btn`), which is where attack interval, cast speed, healing amplify and
max MP live.

---

## 5. Building roster variants

There are two places to make a variant: in the exported roster before import, or in a saved job
after it.

### Editing the roster export

Edit the exported JSON and re-import it. No app changes needed.

**Write every change to BOTH `combatLoadout` and `profile`.** The importer prefers the loadout field
by field and falls back to the profile, so editing one and not the other silently does nothing for
some members and works for others.

```js
for (const box of [m.combatLoadout, m.profile]) {
  if (!box) continue;
  box.equippedAbilities = newBar;                  // slotNumber 1..5
  box.abilityCombatTriggersMap = { ...box.abilityCombatTriggersMap, [hrid]: triggers };
  delete box.abilityCombatTriggersMap[droppedHrid];
}
```

Identify who is a healer the same way the importer does — loadout abilities if non-empty, else
profile:

```js
const eq = (lo.equippedAbilities?.length ? lo.equippedAbilities : prof.equippedAbilities) || [];
```

Using the *union* of both instead gives a different (larger) set. Both scans are defensible; just
don't mix them between the builder and the analysis or your groups won't line up.

Trigger shape:

```js
{ dependencyHrid: "/combat_trigger_dependencies/all_allies",
  conditionHrid:  "/combat_trigger_conditions/lowest_hp_percentage",
  comparatorHrid: "/combat_trigger_comparators/less_than_equal",
  value: 60 }
```

Multiple triggers on one ability are **ANDed**.

### Editing a saved job

A job from `--save-jobs` is the message the page built: `{ type, players, enemies, timeCapSeconds,
guildBuildingLevels }`. Each `players[]` entry is the importer's resolved DTO, so the
loadout/profile split is gone. Abilities are `{ hrid, level, triggers }` in slot order, and there is
also `equipment`, `food`, `drinks`, `houseRooms`, `achievements`, `shrines` and the skill levels.

```js
const job = JSON.parse(readFileSync("/tmp/jobs/base.json", "utf8"));
job.guildBuildingLevels = { ...job.guildBuildingLevels, dojo: 0 };
const p = job.players.find((p) => p.hrid === hrid);
const i = p.abilities.findIndex((a) => a.hrid === "/abilities/revive");
p.abilities.unshift(...p.abilities.splice(i, 1));                                // move to slot 1
writeFileSync("/tmp/jobs/variant.json", JSON.stringify(job));
```

This skips the import step, so it can't catch an edit the importer would have treated differently.
Use it for building levels, slot order, triggers and time caps. For anything that goes through the
importer's resolution (equipment, levels, which abilities count as equipped), edit the roster.

---

## 6. Pitfalls

These each produced a wrong answer before being caught. The code they point at is the JS kernel in
`src/combatsimulator/`. It no longer runs, but the wasm kernel reproduces it exactly, quirks
included, so it is still the place to read the mechanics. `docs/combat.md` in the Rust repo
describes the same rules and cites the JS lines.

**`self` + `lowest_hp_percentage` throws.** `Trigger.isActiveMultiTarget` only accepts `all_allies`
and `all_enemies`, and `getDependencyValue` has no case for `lowest_hp_percentage`. To express "my
HP below X%" use `self` + `current_hp` + a per-player absolute computed from their max HP.

**Ability mana costs must come from `abilityDetailMap`.** A hardcoded subset silently values the
missing ones at 0 — a Guardian Aura at 100 mana went uncounted and understated one healer's spend
by 400.

```js
const MANA = Object.fromEntries(Object.entries(abilityDetailMap).map(([h, d]) => [h, d.manaCost]));
```

**Weapon-proc abilities log under a bare hrid.** `new Ability("bloom")` sets `hrid = "bloom"`, not
`/abilities/bloom`, so heal entries appear as `healSource: "bloom"`. Filtering on the full hrid
returns zero and looks exactly like "the mechanic doesn't work". Dump the distinct `healSource`
values before trusting a filter.

**Thorns fire on misses.** In `processAttack` the thorns block sits *outside* the hit check, so any
attack procs them regardless of whether it lands. Attack *count* drives thorn damage, not accuracy.

**Life steal is auto-attack only** (`!abilityEffect` branch), so it returns nearly nothing on an
ability-driven rotation.

**Bloom procs on ability casts only**, never on auto-attacks — it lives in `tryUseAbility`.

**An unaffordable high-slot ability blocks the whole bar.** `addNextAttackEvent` walks slots in
order and the first that triggers but fails `canUseAbility` sets `skipNextAbility`, so *nothing*
below it casts that action. A 200-mana Revive in slot 1 with no mana guard stops a healer healing
entirely. This also means **slot order is a real variable** — test it.

**A miss is logged as `hit: "miss"`, not 0.** Summing `hit` over attack entries turns into string
concatenation at the first miss and ends as `NaN`. Filter on `typeof e.hit === "number"`.

**A JS edit to the combat code tests nothing.** See §1: the kernel is compiled. A "fix" made in
`src/combatsimulator/` and then swept will show no effect at all, which reads exactly like a fix
that doesn't help.

---

## 7. Getting numbers that mean something

The simulation is stochastic and the outcome here is **bimodal** — the raid either holds and fights
~750s or cascades and dies in ~200s. That shapes the whole methodology.

**Runs are cheap now; use them.** The early rules here were written at n=6 on the JS kernel, where
n=3 separated nothing and n=4 let Armory appear to make the raid *worse*, which is mechanically
impossible. The sweep now defaults to 40 runs per arm and finishes in seconds. Go to 100+ for
effects of a few percent.

**Always include a control arm in the same batch.** At n=6, the *identical* baseline config
measured 19.2%, 26.1% and 34.1% median boss HP across three sessions, and comparing against a
control from another batch produced flatly wrong rankings. That was sampling noise, not drift: on
the same seeds the kernel gives the same numbers every time. But a control from another invocation
was still sampled on other seeds. Put it in the same run.

**Seeds make a sweep reproducible, not independent of the roster.** The header prints the base seed,
and `--seed N` replays the sweep exactly. `--json` records each run's seed, and `--seeds a,b` reruns
chosen ones, e.g. to open one outlier in a hand-written driver. Every arm uses the same seeds, which
is what `seed w-l` counts (runs where the arm beat / lost to the control on the same seed). Don't
lean on it: a changed roster makes different random draws from the first differing event, so
same-seed runs quickly stop being alike. Dojo 4 → 0 went 24-35 on 60 seeds while U put it clearly
behind. Identical arms tie on every seed, which is a cheap check that two jobs really are the same.

**Use Mann-Whitney U, not means.** Bimodality makes means hostage to one outlier. The null is
U = n²/2 and the max is n². The p-value is exact up to n=20 and a normal approximation beyond that.

```js
const U = (a, b) => a.reduce((u, x) => u + b.reduce((v, y) => v + (x < y ? 1 : x === y ? 0.5 : 0), 0), 0);
```

**Score the ladder by progress, not by boss HP.** In `--ladder` mode the score is tiers cleared plus
the fraction of the last tier's boss taken off (7.9 = cleared T7, T8 boss at 10%). Boss HP on its own
compares runs that died on different tiers.

**Normalise anything that scales with fight length.** OOM counts, total healing and total damage all
grow with duration, so a change that shortens the fight looks like it reduced them. One A/B had to
be discarded for exactly this (317s vs 541s arms). Use per-second-alive rates, or hold duration
fixed by capping and comparing boss HP left.

**Watch for metrics hitting the floor.** Once a config reaches ~0% boss HP left there is no room to
show further improvement — switch to kills and survivor counts, or test on a weaker baseline that
has headroom.

**Prefer a mechanism you can point at in the code.** Several effects here are ~1% of a stat against
a 29-point spread. Cheap runs make them reachable, but four arms landing in the order predicted from
the source beforehand is still better evidence than any one p-value.

---

## 8. Orchestration

A typical sweep fits in a foreground `Bash` call: about 6s per roster arm to build the job, then a
few seconds for the runs (120 T8 runs at a 900s cap took 3.9s on 13 threads). Sweeps over saved
jobs skip the build step.

Only very large sweeps (thousands of runs, or many roster arms) risk the 120s foreground timeout.
Put those in the background:

```
Bash(run_in_background: true) → node scripts/sim-sweep.mjs --arm ... --arm ...
Monitor(command: tail -f <task output> | grep --line-buffered "p=|rror")
```

Make the grep alternation cover **failure** as well as progress — a monitor watching only for
success lines stays silent through a crash, and silence is indistinguishable from "still running".
A kernel error names the arm and seed that caused it; rerun that one with `--seeds`.

Monitors expire after 30 minutes; re-arm only if the underlying run is still going.
