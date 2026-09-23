import actionDetailMap from "./data/actionDetailMap.json";
import combatMonsterDetailMap from "./data/combatMonsterDetailMap.json";
import itemDetailMap from "./data/itemDetailMap.json";

// Which items a zone can drop, and what a finished simulation says you earn per hour. The drop
// numbers here are expected values, computed from drop rates and kill counts rather than by rolling
// dice, so two runs of the same build are comparable instead of differing by loot luck.

const ONE_SECOND = 1e9;
const ONE_HOUR = 60 * 60 * ONE_SECOND;
const PLAYER_HRIDS = ["player1", "player2", "player3", "player4", "player5"];

// multiSpawnOnly keeps the zones that spawn a group of monsters — the planets you actually farm —
// and drops the single-monster actions, which is how the standard simulator splits the two lists.
export function combatZones({ multiSpawnOnly = false } = {}) {
    return Object.values(actionDetailMap)
        .filter((action) => action.type === "/action_types/combat"
            && action.category !== "/action_categories/combat/dungeons"
            && (!multiSpawnOnly || action.combatZoneInfo?.fightInfo?.randomSpawnInfo?.maxSpawnCount > 1))
        .sort((a, b) => a.sortIndex - b.sortIndex);
}

// Every monster that can show up in a zone, random spawns and the boss alike.
export function zoneMonsterHrids(zoneHrid) {
    const fightInfo = actionDetailMap[zoneHrid]?.combatZoneInfo?.fightInfo;
    if (!fightInfo) {
        return [];
    }

    let hrids = (fightInfo.randomSpawnInfo?.spawns ?? []).map((spawn) => spawn.combatMonsterHrid);
    for (const boss of fightInfo.bossSpawns ?? []) {
        hrids.push(boss.combatMonsterHrid);
    }
    return [...new Set(hrids.filter(Boolean))];
}

function dropTablesFor(monsterHrid) {
    const monster = combatMonsterDetailMap[monsterHrid];
    return [
        ...(monster?.dropTable ?? []).map((drop) => ({ drop, rare: false })),
        ...(monster?.rareDropTable ?? []).map((drop) => ({ drop, rare: true })),
    ];
}

// Every item the zone can drop at the given tier, sorted so the rarest come last.
export function zoneDropItems(zoneHrid, difficultyTier) {
    let items = new Map();
    for (const monsterHrid of zoneMonsterHrids(zoneHrid)) {
        for (const { drop } of dropTablesFor(monsterHrid)) {
            if (drop.minDifficultyTier > difficultyTier || items.has(drop.itemHrid)) {
                continue;
            }
            items.set(drop.itemHrid, {
                hrid: drop.itemHrid,
                name: itemDetailMap[drop.itemHrid]?.name ?? drop.itemHrid,
            });
        }
    }
    return [...items.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Key fragments are what "frags" means: they are zone-specific, so the zone itself picks the goal.
// A zone that drops more than one is returned in full and the caller chooses.
export function zoneFragmentItems(zoneHrid, difficultyTier) {
    return zoneDropItems(zoneHrid, difficultyTier).filter((item) => item.hrid.endsWith("_key_fragment"));
}

// Expected drops of one item over the whole simulation, for one player's share. Mirrors the no-RNG
// column of the standard simulator: kills x effective drop rate x average stack, scaled by that
// player's drop bonuses and split across the party.
export function expectedDropsFor(simResult, itemHrid, playerHrid) {
    const tier = Number(simResult.difficultyTier) || 0;
    const dropRateMultiplier = simResult.dropRateMultiplier?.[playerHrid] ?? 1;
    const rareFindMultiplier = simResult.rareFindMultiplier?.[playerHrid] ?? 1;
    const combatDropQuantity = simResult.combatDropQuantity?.[playerHrid] ?? 0;
    const debuffOnLevelGap = simResult.debuffOnLevelGap?.[playerHrid] ?? 0;
    const numberOfPlayers = simResult.numberOfPlayers || 1;

    let total = 0;
    for (const [monsterHrid, kills] of Object.entries(simResult.deaths ?? {})) {
        if (PLAYER_HRIDS.includes(monsterHrid) || !kills) {
            continue;
        }
        for (const { drop, rare } of dropTablesFor(monsterHrid)) {
            if (drop.itemHrid !== itemHrid || drop.minDifficultyTier > tier) {
                continue;
            }

            let dropRate;
            if (rare) {
                dropRate = drop.dropRate * rareFindMultiplier;
            } else {
                const tierMultiplier = 1.0 + 0.1 * tier;
                const base = tierMultiplier * (drop.dropRate + (drop.dropRatePerDifficultyTier ?? 0) * tier);
                if (base <= 0) {
                    continue;
                }
                dropRate = Math.min(1.0, Math.min(1.0, base) * dropRateMultiplier);
            }

            const averageStack = ((drop.maxCount + drop.minCount) / 2);
            total += kills * dropRate * averageStack
                * (1 + debuffOnLevelGap) * (1 + combatDropQuantity) / numberOfPlayers;
        }
    }
    return total;
}

// Total damage a player dealt, read off the attack log: keys are the damage done, values the number
// of times that much landed, and "miss" is not damage.
function damageDealtBy(simResult, playerHrid) {
    let total = 0;
    for (const targets of Object.values(simResult.attacks?.[playerHrid] ?? {})) {
        for (const casts of Object.values(targets)) {
            for (const [hit, count] of Object.entries(casts)) {
                if (hit !== "miss") {
                    total += Number(hit) * count;
                }
            }
        }
    }
    return total;
}

// The per-condition numbers the optimization table shows. Rates are per hour except dps.
export function metricsFor(simResult, itemHrid, playerHrids) {
    const hours = simResult.simulatedTime / ONE_HOUR;
    const seconds = simResult.simulatedTime / ONE_SECOND;

    let players = {};
    for (const hrid of playerHrids) {
        players[hrid] = {
            deathsPerHour: (simResult.deaths?.[hrid] ?? 0) / hours,
            dps: damageDealtBy(simResult, hrid) / seconds,
            fragsPerHour: itemHrid ? expectedDropsFor(simResult, itemHrid, hrid) / hours : 0,
            xpPerHour: Object.values(simResult.experienceGained?.[hrid] ?? {})
                .reduce((prev, cur) => prev + cur, 0) / hours,
        };
    }

    const fragValues = playerHrids.map((hrid) => players[hrid].fragsPerHour);
    return {
        hours,
        encountersPerHour: (simResult.encounters ?? 0) / hours,
        players,
        // The ranking number: the average player's fragments per hour.
        avgFragsPerHour: fragValues.reduce((prev, cur) => prev + cur, 0) / (fragValues.length || 1),
        groupFragsPerHour: fragValues.reduce((prev, cur) => prev + cur, 0),
    };
}
