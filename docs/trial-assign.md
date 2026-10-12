# Trial Assignment page — key logic

`trial-assign.html` splits the guild between two trial bosses so the **trial score** is as high as
possible. Upload the guild combat-trial export, pick two of the five bosses and the max players per
team, and the page measures, plans and verifies on the wasm kernel in the browser.

| File | Role |
| --- | --- |
| `trial-assign.html` | Markup + CSS (same palette as Group Battle and Skill Lab). |
| `src/trialAssign.js` | Page: import, settings, the site's assignment, the run pipeline, results, downloads. |
| `src/trialAssignCore.js` | No DOM, no kernel, testable in Node: guide bars, aura power, the ladder model, survival fit, planner. |
| `src/skillLabJob.js` via `worker.js` `start_skill_lab` | Every fight. Results are reduced in the worker to one player's numbers, so a long fight's log never crosses to the page. |
| `webpack.config.js` | `trialAssign` entry, the html copy, and the `/site-api` dev-server proxy. |

---

## 1. Objective

Per boss the ladder runs T1, T2, … on one shared budget (default 3600 s) and stops on time or a wipe.

```
score(p) = 200 × floor(p) + 100 × (p − floor(p))      p = tiers cleared + progress into the next
```

The total is the sum over both bosses. A tier boundary is a jump (8.99 → 1699, 9.00 → 1800), so
splits are judged by expected score, never by mean progress.

## 2. Inputs

- **Roster:** the guild trial export, imported as Group Battle does (`guildTrialImport.js`). The
  loadout wins field by field, and the profile is the fallback.
- **Build per member:** read off the weapon and saved bar (`combatClass.js` `raidClass`, mapped by
  `CLASS_TO_BUILD`). It can be edited, or the member excluded, in the member list. Magic with no
  element, or no weapon, has no guide build and starts excluded.
- **Held aura:** the special aura on either bar (profile or loadout), at the higher level.
- **Guild buildings:** shared with Group Battle (`localStorage["mwiGuildBuildingLevels"]`). The
  default when unset is Arsenal's (library 2, dojo 4, armory 1, gym 1, archery 2, mystical 1).
- **Rules per team:** exactly 2 Wark, 6 Nature Support and 2 Mana Spring Support. Coverage floors are
  Smash, Slash, Stab, Water, Ranged and Cursed Bower, 2 each, capped at `floor(available / 2)`. Warks
  don't carry auras unless ticked. All of these are editable.

## 3. Guide bars (`applyGuideBar`)

Every fight uses the Build Guide's bar for the build on that boss. That's `DEFAULT_BARS` plus
`BOSS_TWEAKS`, from the guild page's Build Guide.

- **Slot 1 is the aura:** Insanity (DPS), Invincible (Wark), Revive (supports). A special-aura
  carrier puts their aura there instead.
- **Levels:** an ability the member has equipped keeps their level, the higher of profile and
  loadout. One they don't have takes the level of an ability leaving their bar: aura for aura, the
  rest in slot order. A carrier's aura uses the site's level when the site names one.
- **Triggers:**
  - Insanity: `is_inactive` AND `current_hp ≥ ceil(cutoff × maxHP)`. The cutoff defaults to 50% and
    is editable. Max HP comes from a `Player` built with the worker's buff stack.
  - Rejuvenate: `all_allies lowest_hp_percentage ≤ 60`.
  - Quick Aid (Hedgehog): `≤ 50`.
  - Every other ability keeps the member's own trigger.
- **Comparators:** the game has only `less_than_equal` (shown as "less than"), `greater_than_equal`,
  `is_active` and `is_inactive`. Any other comparator makes the kernel throw.

## 4. Aura power

```
power = (flatBoost or ratioBoost + (level − 1) × perLevel) × (1 + skill × multiplierPerSkillLevel)
```

Every value comes from `abilityDetailMap`. `skill` is the carrier's effective level of the aura's
skill: Fierce melee, Crit ranged, Guardian defense, Mystic magic, Speed attack.

## 5. The run

1. **Reference raid** (team size − 1 players), the same for both bosses: the best holder of each aura
   carries it, the role and Cursed Bower quotas are filled by main stat, then the rest of the DPS by
   main stat.
2. **Measure:** every member alone in the last slot of the reference raid, on that boss's guide bar,
   at T9 (L180) for 600 s over N seeds. Their dps and hps (regen excluded) are per second of fight.
   These are measured directly on both bosses, so no Boss Matrix approximation is involved.
3. **Calibrate:** the reference raid plus the strongest member left out runs the ladder N times
   (clear time per tier). A copy with the weakest supports swapped in also runs, which separates
   healing's effect on survival.
4. **Plan** (§6), giving the best split plus distinct alternatives from other parts of the
   trade-off curve.
5. **Verify:** each candidate, plus the current assignment if one is loaded, runs the full ladder on
   both bosses on the same seeds. **The highest simulated total is picked**; predictions only choose
   what to simulate.

| Effort | Seeds to measure | Calibration ladders | Verify ladders per boss |
| --- | --- | --- | --- |
| Quick | 2 | 8 | 10 |
| Standard | 4 | 20 | 40 |
| Thorough | 6 | 40 | 100 |

## 6. The model (`trialAssignCore.js`)

Team power on a boss is relative to the auras the scores were measured under:

```
all    = (1 + Speed)/(1 + Speed_ref) × critF(Crit)/critF(Crit_ref)      critF(c) = 1 + (0.05 + c)(0.5 + c)
power  = Σ dps[boss] × all × (physical ? (1+Fierce)/(1+Fierce_ref) : 1) × (magic ? (1+Mystic)/(1+Mystic_ref) : 1)
             × (DPS carrier ? KAPPA : 1)                                  KAPPA = 0.7: a carrier gives up Insanity
H      = Σ hps
```

Ladder walk with the calibrated tier times `t_k` and calibrated power `P0`:

```
clear(t)   = t_k[t] × (P0 / power)^ALPHA                          ALPHA = 1.2; beyond calibration, the last four tiers' growth
survive(t) = exp(a − g(t − 9) + beta × ln(H / H0) + s z)          only when the boss wiped a calibration run
each tier: wipe first → stop at t − 1 + WIPE × survive/clear      WIPE = 0.85: damage falls as players die
           out of time → stop at t − 1 + left/clear
expected score = average of score(progress + SIGMA e) over e ~ N(0,1), and over z when survival applies
                                                                  SIGMA = 0.15; 9-point quadrature each
```

- **Survival fit:** censored log-normal maximum likelihood. A wipe at d observes τ = d; a clear or
  timeout at d says only τ > d. Fitting beta needs the two healing levels; otherwise beta = 10.
  Fitted values ran 9–14: survival is very steep in healing.
- **Carriers:** in-team, so nobody moves for an aura. Each aura goes to the team's strongest holder,
  weighted by what it amplifies there (Fierce by the physical damage share, Mystic by the magic
  share, Crit and Speed 1, Guardian 0.5). An aura worth under 0.5% of the team's damage is skipped.
  Placing carriers before the split let a strong player's own damage outbid a stronger aura.

## 7. The planner (`plan`)

1. **Roles:** the top 2 × quota of each role (Wark by main stat, supports by hps), snake-drafted. The
   harder-hitting boss picks first.
2. **Bench:** the weakest DPS go to the bench while the pool exceeds the open slots, ranked by
   `max(dps_A/P0_A, dps_B/P0_B)`. A short roster splits the shortfall evenly.
3. **Starts:** for λ = e^−3 … e^3, rank by `dps_A/P0_A − λ × dps_B/P0_B`. The floors are placed first
   (top on A, bottom on B), then A is filled from the top.
4. **Local search** until nothing improves:
   - DPS ↔ DPS swaps of different builds, keeping the floors.
   - Role ↔ role swaps of the same build, which move healing between the bosses.
5. **Candidates:** the improved best start, plus the improved best of the A-leaning half and the
   B-leaning half of the curve, deduplicated.

What the model misses, which verification exists for: debuffs beyond the floors, which healer is
where (only total hps counts), tank quality, mana, and Swarm's four-enemy fight. Predictions run
optimistic on bosses that wipe raids.

## 8. The site's assignment

- **Load from site:** fetches `/api/g/<guild>/config`: `frozen.combat` (name → boss) and
  `frozen.roster` (builds). The site sends no CORS headers, so the page goes through the dev
  server's `/site-api` proxy (`webpack.config.js`), then the site directly, then the paste box. A
  published copy has no proxy.
- **Paste:** the Combat Trials section's text. Each row reads `<name> <build> · bring <aura>` or
  `<name> <build> 🔮 brings <aura> <level>`; this is the only source that names the carriers. The
  pasted JSON form has no carriers, so the in-team rule picks them.
- **"Use the site's builds"** overrides the inferred builds.
- **Preview** simulates only the site's two teams.
- In a full run, the site's split is evaluated and verified on the same seeds, as the baseline. With
  no site assignment loaded, the export's own `combatTrial` split is the baseline, when ≥ 80% of a
  team was exported for each boss.

## 9. Output

- **Summary:** per-boss tier, score and clears, plus the total vs the baseline.
- **Splits compared:** predicted vs simulated, for every candidate and the baseline.
- **Teams:** sorted by dps on that boss, with carriers and a "moved" tag (on the other boss in the
  baseline).
- **Downloads:** one guild trial export per boss, with the guide's bars, triggers and carriers
  written into both loadout and profile (`combatTrial` set), importable into Group Battle.
- **Copy teams as text:** the teams grouped by build.

## 10. Gotchas

- **Max parallel:** defaults to the browser's `navigator.hardwareConcurrency` and can't go above it
  (Settings, remembered). Each worker holds its own kernel and briefly one fight's full log, so lower
  it on a machine short of memory.
- **Stale gear:** builds and gear come from the export, so a stale export gives a stale split.
- **No churn control:** the planner optimises score only, and a best split can move half the raid.
- **Testing:** keep `trialAssignCore.js` free of DOM and JSON imports, so it can be loaded in Node
  for tests.
