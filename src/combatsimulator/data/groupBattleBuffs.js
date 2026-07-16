// Group battles assume no food/drinks; compensate with a flat +3 PERCENTAGE
// POINTS added to HP/MP regen per 10s (e.g. 1% -> 4%), applied to every
// player. This must be flatBoost, not ratioBoost: CombatUnit.updateCombatDetails
// applies ratioBoost as a multiplier on the player's existing regen first
// (hpRegenPer10 += hpRegenPer10 * ratioBoost), then adds flatBoost on top - so
// a ratioBoost of 0.03 would only add +3% of whatever regen the player already
// has (e.g. 1.15% -> 1.18%), not a flat +3 percentage points (1% -> 4%,
// 1.15% -> 4.15%). Shared by worker.js (the real sim) and groupBattle.js's
// detailed-status preview so both always agree.
const GROUP_BATTLE_REGEN_BUFFS = [
    {
        uniqueHrid: "/buff_uniques/group_battle_hp_regen",
        typeHrid: "/buff_types/hp_regen",
        ratioBoost: 0,
        ratioBoostLevelBonus: 0,
        flatBoost: 0.03,
        flatBoostLevelBonus: 0,
    },
    {
        uniqueHrid: "/buff_uniques/group_battle_mp_regen",
        typeHrid: "/buff_types/mp_regen",
        ratioBoost: 0,
        ratioBoostLevelBonus: 0,
        flatBoost: 0.03,
        flatBoostLevelBonus: 0,
    },
];

export default GROUP_BATTLE_REGEN_BUFFS;
