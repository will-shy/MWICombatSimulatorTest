// Skill Lab jobs, run on the wasm combat kernel inside worker.js ("start_skill_lab").
//
// One job is one run of one variant: the whole party fights exactly as on the group battle page
// (same `start_battle` payload, same kernel), either one fight at a fixed level or the Trial Mode
// ladder. Only the focus player's kit differs between variants.
//
// A battle result carries the full battle log, which for a long fight is tens of MB of JSON. It is
// reduced to the focus player's numbers here, inside the worker, so only a few KB cross back to
// the page per run.

// Trial Mode's ladder, as groupBattle.js defines it: T1 = L100, +10 per tier, up to L300.
const TRIAL_MIN_LEVEL = 100;
const TRIAL_LEVEL_STEP = 10;
const MAX_TIER = 21;
const PASSIVE_REGEN_HEAL_SOURCE = "regen";

export const tierLevel = (tier) => TRIAL_MIN_LEVEL + TRIAL_LEVEL_STEP * (tier - 1);

// Each tier's seed is derived from the run's, so a ladder run is reproducible from one number.
// Same derivation as scripts/sim-sweep.mjs.
const tierSeed = (seed, tier) => (Math.imul(seed ^ (tier * 0x9e3779b9), 0x85ebca6b) >>> 0) || 1;

function battle(kernel, job) {
    return JSON.parse(kernel.battle(JSON.stringify(job)));
}

// Enemy HP left, as a fraction: the whole group's remaining HP over its full HP. The same figure as
// the group battle page's "enemy HP left".
function bossHpFrac(res) {
    const enemies = res.enemyFinalState || [];
    const max = enemies.reduce((s, e) => s + (e.maxHitpoints || 0), 0);
    return max > 0 ? enemies.reduce((s, e) => s + Math.max(0, e.currentHitpoints || 0), 0) / max : 0;
}

function emptyStats() {
    return { dmg: 0, hits: 0, misses: 0, heal: 0, oom: 0, deaths: 0, raidDmg: 0, perAbility: {}, perHeal: {}, casts: {} };
}

// The focus player's damage, healing, casts and deaths in one battle result, plus the whole
// party's damage so the page can show the focus player's share of it.
function reduce(res, focus) {
    const out = emptyStats();
    const players = new Set((res.playerFinalState || []).map((p) => p.hrid));

    // `attacks` is source → target → ability → hit → count, where hit is a damage value or "miss".
    // Only damage on enemies counts: thorns and retaliation also land under a player's name.
    for (const [source, targets] of Object.entries(res.attacks || {})) {
        if (!players.has(source)) continue;
        const isFocus = source === focus;
        for (const [target, abilities] of Object.entries(targets)) {
            if (players.has(target)) continue;
            for (const [ability, hitMap] of Object.entries(abilities)) {
                for (const [hit, count] of Object.entries(hitMap)) {
                    const dmg = hit === "miss" ? 0 : Number(hit) * count;
                    out.raidDmg += dmg;
                    if (!isFocus) continue;
                    const a = (out.perAbility[ability] = out.perAbility[ability] || { dmg: 0, hits: 0, misses: 0 });
                    if (hit === "miss") {
                        out.misses += count;
                        a.misses += count;
                    } else {
                        out.dmg += dmg;
                        out.hits += count;
                        a.dmg += dmg;
                        a.hits += count;
                    }
                }
            }
        }
    }

    // Healing comes only from the log. Passive regen is left out: with the group battle's +3pp
    // regen buff it would dominate the figure for any durable player (docs/group_battle.md §8.2).
    for (const e of res.battleLog || []) {
        if (e.kind !== "heal" || e.healer !== focus || e.healSource === PASSIVE_REGEN_HEAL_SOURCE) continue;
        out.heal += e.amount;
        out.perHeal[e.healSource] = (out.perHeal[e.healSource] || 0) + e.amount;
    }

    out.casts = { ...((res.abilityCastCounts || {})[focus] || {}) };
    out.oom = Number((res.playerOomCastCount || {})[focus]) || 0;
    out.deaths = Number((res.deaths || {})[focus]) || 0;
    return out;
}

function addInto(acc, part) {
    for (const k of ["dmg", "hits", "misses", "heal", "oom", "deaths", "raidDmg"]) acc[k] += part[k];
    for (const [k, v] of Object.entries(part.perAbility)) {
        const e = (acc.perAbility[k] = acc.perAbility[k] || { dmg: 0, hits: 0, misses: 0 });
        e.dmg += v.dmg;
        e.hits += v.hits;
        e.misses += v.misses;
    }
    for (const [k, v] of Object.entries(part.perHeal)) acc.perHeal[k] = (acc.perHeal[k] || 0) + v;
    for (const [k, v] of Object.entries(part.casts)) acc.casts[k] = (acc.casts[k] || 0) + v;
}

/**
 * job = {
 *   players, enemies, guildBuildingLevels,  // the group battle page's start_battle payload
 *   focusHrid,                              // the player whose numbers are reported
 *   mode: "trial" | "single",
 *   level,                                  // single only; the ladder always starts at T1
 *   timeCapSeconds,                         // single: the fight's cap; trial: the shared budget
 *   seed,
 * }
 *
 * Returns { seed, outcome, seconds, cleared, progress, tiers: [...], ...focus stats }, where the
 * focus stats are summed over every tier fought.
 */
export function runSkillLabJob(kernel, job) {
    const seed = job.seed >>> 0 || 1;
    const base = {
        players: job.players,
        guildBuildingLevels: job.guildBuildingLevels,
    };
    const fight = (level, timeCapSeconds, fightSeed) => battle(kernel, {
        ...base,
        enemies: job.enemies.map((e) => ({ ...e, level })),
        timeCapSeconds,
        seed: fightSeed,
    });

    const total = emptyStats();
    const tiers = [];

    if (job.mode === "single") {
        const res = fight(Number(job.level) || TRIAL_MIN_LEVEL, job.timeCapSeconds, seed);
        const part = reduce(res, job.focusHrid);
        addInto(total, part);
        const seconds = (res.battleDurationNs || 0) / 1e9;
        const boss = bossHpFrac(res);
        tiers.push({ level: Number(job.level), outcome: res.battleOutcome, seconds, bossHpFrac: boss, dmg: part.dmg });
        return {
            seed, ...total, tiers,
            outcome: res.battleOutcome,
            seconds,
            bossHpFrac: boss,
            cleared: res.battleOutcome === "victory" ? 1 : 0,
            progress: res.battleOutcome === "victory" ? 1 : 1 - boss,
        };
    }

    // Trial Mode, as runTrialMode in groupBattle.js runs it: every enemy re-leveled to the tier,
    // one shared time budget, advance on victory and stop on anything else. Players start every
    // tier at full HP and MP, because each tier is a fresh battle.
    let remaining = Number(job.timeCapSeconds) || 3600;
    let outcome = "completed";
    for (let tier = 1; tier <= MAX_TIER; tier++) {
        if (remaining <= 0) { outcome = "timeout"; break; }
        const level = tierLevel(tier);
        const res = fight(level, remaining, tierSeed(seed, tier));
        const part = reduce(res, job.focusHrid);
        addInto(total, part);
        const seconds = (res.battleDurationNs || 0) / 1e9;
        remaining -= seconds;
        tiers.push({ tier, level, outcome: res.battleOutcome, seconds, bossHpFrac: bossHpFrac(res), dmg: part.dmg });
        if (res.battleOutcome !== "victory") { outcome = res.battleOutcome; break; }
    }

    const last = tiers[tiers.length - 1];
    const cleared = tiers.filter((t) => t.outcome === "victory").length;
    return {
        seed, ...total, tiers, outcome,
        seconds: tiers.reduce((s, t) => s + t.seconds, 0),
        bossHpFrac: last ? last.bossHpFrac : 0,
        cleared,
        // One number for the whole ladder: tiers cleared, plus how far into the next one it got.
        progress: cleared + (last && last.outcome !== "victory" ? 1 - last.bossHpFrac : 0),
    };
}
