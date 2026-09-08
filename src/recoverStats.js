// Recovery (HP/MP regen) analysis for the standard simulator page.
//
// The simulator restores floor(maxPool * regenRate) every regen tick, so the amount healed only
// moves in whole points: raising Stamina raises max HP smoothly, but the healing stays flat until
// max HP crosses the next 1/regenRate boundary. This module reports where the current build sits,
// which Stamina / Intelligence level crosses the next boundary, and where every number came from.
//
// Everything is measured through a real Player built the same way worker.js builds one, so the
// numbers here are the numbers the simulation itself uses (see combatSimulator.processRegenTickEvent).
import Player from "./combatsimulator/player.js";

// Must match combatSimulator.js's REGEN_TICK_INTERVAL.
export const REGEN_TICK_SECONDS = 10;
const TICKS_PER_MINUTE = 60 / REGEN_TICK_SECONDS;

// Skill cap in game; the threshold search never looks past it.
const MAX_SKILL_LEVEL = 200;
const MAX_THRESHOLDS = 5;

// Every unit starts from 10 * (10 + level), so 100 points come from nowhere but the formula.
const BASE_POOL = 100;
// CombatUnit.updateCombatDetails() gives players this before anything else is added.
const BASE_REGEN = 0.01;

const POOLS = {
    hitpoints: {
        levelKey: "staminaLevel",
        poolKey: "maxHitpoints",
        regenKey: "hpRegenPer10",
        poolRatioKey: "maxHitpointsRatio",
        levelBuffType: "/buff_types/stamina_level",
        poolBuffType: "/buff_types/max_hitpoints",
        regenBuffType: "/buff_types/hp_regen",
    },
    manapoints: {
        levelKey: "intelligenceLevel",
        poolKey: "maxManapoints",
        regenKey: "mpRegenPer10",
        poolRatioKey: "maxManapointsRatio",
        levelBuffType: "/buff_types/intelligence_level",
        poolBuffType: "/buff_types/max_manapoints",
        regenBuffType: "/buff_types/mp_regen",
    },
};

// Totals one buff source's contribution to a single buff type. Sources hand over their buffs
// unmerged so each one can be named in the breakdown; the player itself still merges them by type
// the way addPermanentBuff does, so the totals match either way.
function boostFrom(source, typeHrid) {
    let boost = { flatBoost: 0, ratioBoost: 0 };
    for (const buff of source.buffs) {
        if (buff.typeHrid === typeHrid) {
            boost.flatBoost += buff.flatBoost;
            boost.ratioBoost += buff.ratioBoost;
        }
    }
    return boost;
}

function equipmentContributions(player, stat) {
    let rows = [];
    for (const item of Object.values(player.equipment)) {
        if (!item) {
            continue;
        }
        let value = item.getCombatStat(stat);
        if (value) {
            rows.push({ source: "equipment", hrid: item.hrid, enhancementLevel: item.enhancementLevel, value });
        }
    }
    return rows;
}

// Where max HP / max MP comes from, following CombatUnit.updateCombatDetails() line for line:
// 10 * (10 + buffed level) + flat pool from equipment, all of it scaled by the max pool ratio
// buffs, then rounded up.
function poolBreakdown(player, pool, sources) {
    let baseLevel = player[pool.levelKey];
    let rows = [
        { source: "base", value: BASE_POOL },
        { source: "level", level: baseLevel, value: 10 * baseLevel },
    ];

    // Level buffs raise the skill level itself, so each one is worth 10 pool points per level.
    for (const source of sources) {
        let boost = boostFrom(source, pool.levelBuffType);
        if (boost.flatBoost) {
            rows.push({ source: "levelFlat", id: source.id, levels: boost.flatBoost, value: 10 * boost.flatBoost });
        }
        if (boost.ratioBoost) {
            rows.push({
                source: "levelRatio",
                id: source.id,
                ratio: boost.ratioBoost,
                levels: baseLevel * boost.ratioBoost,
                value: 10 * baseLevel * boost.ratioBoost,
            });
        }
    }

    rows.push(...equipmentContributions(player, pool.poolKey));

    let subtotal = rows.reduce((sum, row) => sum + row.value, 0);
    let ratioRows = [];
    let ratioTotal = player.combatDetails.combatStats[pool.poolRatioKey];
    if (ratioTotal) {
        ratioRows.push({ source: "poolRatio", id: null, ratio: ratioTotal, value: subtotal * ratioTotal });
    }
    for (const source of sources) {
        let ratio = boostFrom(source, pool.poolBuffType).ratioBoost;
        if (ratio) {
            ratioTotal += ratio;
            ratioRows.push({ source: "poolRatio", id: source.id, ratio, value: subtotal * ratio });
        }
    }
    rows.push(...ratioRows);

    // The pool is rounded up, so the panel adds up to the number the simulation uses.
    let total = player.combatDetails[pool.poolKey];
    let rounding = total - subtotal * (1 + ratioTotal);
    if (Math.abs(rounding) > 1e-9) {
        rows.push({ source: "rounding", value: rounding });
    }

    return { rows, total };
}

// Where the regen rate comes from: a flat 1% for every player, plus the equipment's own regen,
// then the regen buffs - ratio boosts scale what the equipment already gave, flat boosts add on top.
function regenBreakdown(player, pool, sources) {
    let rows = [{ source: "base", value: BASE_REGEN }];
    rows.push(...equipmentContributions(player, pool.regenKey));

    let beforeBuffs = rows.reduce((sum, row) => sum + row.value, 0);
    for (const source of sources) {
        let boost = boostFrom(source, pool.regenBuffType);
        if (boost.ratioBoost) {
            rows.push({ source: "regenRatio", id: source.id, ratio: boost.ratioBoost, value: beforeBuffs * boost.ratioBoost });
        }
        if (boost.flatBoost) {
            rows.push({ source: "regenFlat", id: source.id, value: boost.flatBoost });
        }
    }

    return { rows, total: player.combatDetails.combatStats[pool.regenKey] };
}

// dto: plain player data (levels, equipment as { hrid, enhancementLevel }, empty food/drinks/abilities).
// sources: [{ id, buffs }] - every permanent buff that applies, grouped by where it came from
// (house rooms, shrines, labyrinth upgrades, achievements, drinks). `id` is opaque here and comes
// back on the breakdown rows for the caller to label.
function buildPlayer(dto, sources) {
    let player = Player.createFromDTO(structuredClone(dto));

    player.permanentBuffs = {};
    for (const source of sources) {
        for (const buff of source.buffs) {
            player.addPermanentBuff(buff);
        }
    }
    // Copies the permanent buffs into the active set and recomputes combatDetails, exactly like the
    // start of a simulated fight. Safe to call repeatedly: Player.updateCombatDetails() rebuilds
    // every combat stat from the equipment before the buffs are re-applied.
    player.clearBuffs();

    return player;
}

// Re-measures the player with one skill level replaced. Returns the pool size, the regen rate and
// the whole points restored per tick.
function measure(player, pool, level) {
    player[pool.levelKey] = level;
    player.clearBuffs();

    let details = player.combatDetails;
    let maxPool = details[pool.poolKey];
    let regen = details.combatStats[pool.regenKey];

    return {
        level,
        effectiveLevel: details[pool.levelKey],
        maxPool,
        regen,
        perTick: Math.floor(maxPool * regen),
    };
}

// Smallest whole pool size that restores `target` points per tick, i.e. the lowest H with
// floor(H * regen) >= target. Derived rather than searched, then nudged to absorb float error.
function poolNeededFor(target, regen) {
    if (!(regen > 0)) {
        return null;
    }

    let pool = Math.ceil(target / regen);
    while (Math.floor(pool * regen) < target) {
        pool++;
    }
    while (pool > 0 && Math.floor((pool - 1) * regen) >= target) {
        pool--;
    }

    return pool;
}

function analysePool(player, pool, sources) {
    let baseLevel = player[pool.levelKey];
    let current = measure(player, pool, baseLevel);

    // The regen rate does not depend on the skill level, so every threshold is a pool size the
    // level has to reach. Walk the levels rather than inverting the pool formula: the level to pool
    // mapping runs through the same buff pass the simulation uses, rounding included.
    let thresholds = [];
    let perTick = current.perTick;
    for (let level = baseLevel + 1; level <= MAX_SKILL_LEVEL && thresholds.length < MAX_THRESHOLDS; level++) {
        let step = measure(player, pool, level);
        if (step.perTick > perTick) {
            thresholds.push({ ...step, levelsNeeded: level - baseLevel });
            perTick = step.perTick;
        }
    }

    measure(player, pool, baseLevel);

    return {
        ...current,
        perMinute: current.perTick * TICKS_PER_MINUTE,
        poolNeededForNextPoint: poolNeededFor(current.perTick + 1, current.regen),
        thresholds,
        poolSources: poolBreakdown(player, pool, sources),
        regenSources: regenBreakdown(player, pool, sources),
    };
}

// Returns the HP and MP recovery picture for one build:
//  - maxPool / regen / perTick as the simulation computes them right now
//  - poolNeededForNextPoint: the max HP (or MP) at which the tick restores one more point
//  - thresholds: the next few Stamina (or Intelligence) levels that each add a point per tick
//  - poolSources / regenSources: every contribution that adds up to those two numbers
export function computeRecoverStats(dto, sources) {
    let player = buildPlayer(dto, sources);

    return {
        hitpoints: analysePool(player, POOLS.hitpoints, sources),
        manapoints: analysePool(player, POOLS.manapoints, sources),
    };
}
