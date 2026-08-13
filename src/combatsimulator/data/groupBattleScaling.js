// Party-size scaling for group-battle monsters. Shared by worker.js (the real
// sim) and groupBattle.js (the enemy table + stat preview) so the numbers shown
// in the UI can never drift from the numbers the simulation actually uses.
//
// Every rule is "per player in the group":
//   +1%  max HP        (max MP is deliberately NOT scaled)
//   +2%  attack speed  (divides attackInterval)
//   +2%  cast speed    (adds to combatStats.castSpeed)
//   +2   ability haste (flat points; cooldown * 100 / (100 + haste))
//
// The returned object is passed straight into the GroupBattleMonster options,
// which applies each bonus the same way the engine applies that stat's own
// buffs (see GroupBattleMonster.applyPartyScaling).
const GROUP_BATTLE_HP_PER_PLAYER = 0.01;
const GROUP_BATTLE_ATTACK_SPEED_PER_PLAYER = 0.02;
const GROUP_BATTLE_CAST_SPEED_PER_PLAYER = 0.02;
const GROUP_BATTLE_ABILITY_HASTE_PER_PLAYER = 2;

function groupBattleScaling(playerCount) {
    let n = Number(playerCount) || 0;
    return {
        hpMultiplier: 1 + GROUP_BATTLE_HP_PER_PLAYER * n,   // max HP only, not MP
        attackSpeedBonus: GROUP_BATTLE_ATTACK_SPEED_PER_PLAYER * n,
        castSpeedBonus: GROUP_BATTLE_CAST_SPEED_PER_PLAYER * n,
        abilityHasteBonus: GROUP_BATTLE_ABILITY_HASTE_PER_PLAYER * n,
    };
}

export default groupBattleScaling;
export {
    GROUP_BATTLE_HP_PER_PLAYER,
    GROUP_BATTLE_ATTACK_SPEED_PER_PLAYER,
    GROUP_BATTLE_CAST_SPEED_PER_PLAYER,
    GROUP_BATTLE_ABILITY_HASTE_PER_PLAYER,
};
