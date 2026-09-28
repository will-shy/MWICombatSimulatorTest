// Guild buildings are a guild-wide bonus that applies to every member in a group battle, on top of
// each player's own house rooms. They are expressed as ordinary buffs so the sim needs no new
// concept: the `*_level` buff types are the same ones CombatUnit.updateCombatDetails reads for
// house rooms, and hp_regen / mp_regen the same ones the group-battle regen compensation uses.
//
// Regen is flatBoost, never ratioBoost, for the reason spelled out in groupBattleBuffs.js:
// ratioBoost scales the regen the player already has, so +0.3% per level would be a rounding error
// rather than +0.3 percentage points.
//
// Shared by worker.js (the real sim) and the UI's stat previews so both always agree.

// Each building: the stats one level grants. `perLevel` is the buff value added per building level.
export const GUILD_BUILDINGS = [
    {
        id: "diningRoom",
        labelKey: "guildDiningRoom",
        buffs: [
            { typeHrid: "/buff_types/stamina_level", perLevel: 2 },
            { typeHrid: "/buff_types/hp_regen", perLevel: 0.003 },
        ],
    },
    {
        id: "library",
        labelKey: "guildLibrary",
        buffs: [
            { typeHrid: "/buff_types/intelligence_level", perLevel: 2 },
            { typeHrid: "/buff_types/mp_regen", perLevel: 0.003 },
        ],
    },
    { id: "dojo", labelKey: "guildDojo", buffs: [{ typeHrid: "/buff_types/attack_level", perLevel: 2 }] },
    { id: "armory", labelKey: "guildArmory", buffs: [{ typeHrid: "/buff_types/defense_level", perLevel: 2 }] },
    { id: "gym", labelKey: "guildGym", buffs: [{ typeHrid: "/buff_types/melee_level", perLevel: 2 }] },
    { id: "archeryRange", labelKey: "guildArcheryRange", buffs: [{ typeHrid: "/buff_types/ranged_level", perLevel: 2 }] },
    { id: "mysticalStudy", labelKey: "guildMysticalStudy", buffs: [{ typeHrid: "/buff_types/magic_level", perLevel: 2 }] },
];

// levels: { <buildingId>: level }. Buildings at level 0 contribute nothing and are skipped, so an
// unset guild produces an empty list and behaves exactly as before this existed.
export function guildBuildingBuffs(levels) {
    let buffs = [];
    for (const building of GUILD_BUILDINGS) {
        const level = Number(levels?.[building.id]) || 0;
        if (level <= 0) continue;

        for (const buff of building.buffs) {
            buffs.push({
                // Unique per building AND stat: CombatUnit keeps one buff per uniqueHrid, so two
                // buildings granting the same stat must not collide.
                uniqueHrid: `/buff_uniques/guild_${building.id}_${buff.typeHrid.split("/")[2]}`,
                typeHrid: buff.typeHrid,
                ratioBoost: 0,
                ratioBoostLevelBonus: 0,
                // The level scaling is folded in here rather than passed as a Buff level, so the
                // caller never has to know which of flat/ratio a given stat uses.
                flatBoost: buff.perLevel * level,
                flatBoostLevelBonus: 0,
            });
        }
    }
    return buffs;
}

export default GUILD_BUILDINGS;
