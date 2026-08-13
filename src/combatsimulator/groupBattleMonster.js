import Monster from "./monster";

// A trial/group-battle enemy backed by real game data (combatMonsterDetailMap),
// built via the standard Monster object so its stats, ability levels, attack-
// interval speedup, abilityHaste, tenacity and enrage all come straight from the
// game — no transcription, no CustomMonster.
//
// Two group-battle needs on top of plain Monster:
//   1. Unique identity. simResult aggregates damage/deaths/healing by unit.hrid,
//      so multiple copies of the same monster (e.g. 2x Trial Badger) must have
//      DISTINCT hrids or their results merge. But Monster.updateCombatDetails()
//      re-reads combatMonsterDetailMap[this.hrid] on every call, so we cannot
//      simply rename hrid. We keep the real data hrid in `dataHrid` and swap it
//      in for the duration of the base derivation, restoring the unique hrid.
//   2. Party-size scaling. See applyPartyScaling() below. Re-applied after every
//      re-derivation (reset() calls updateCombatDetails()).
//
// `roomLevel` is the trial "level" (100..300); difficultyTier is always 0, which
// makes Monster's labyrinth scaling reproduce the trial stat table exactly.
class GroupBattleMonster extends Monster {
    constructor(dataHrid, roomLevel, options = {}) {
        // Build from the real data key first.
        super(dataHrid, 0, roomLevel);

        this.dataHrid = dataHrid;
        // Unique identity for result aggregation; falls back to the data hrid.
        this.hrid = options.uniqueHrid || dataHrid;
        if (options.displayName) {
            this.name = options.displayName;
        }
        this.hpMultiplier = options.hpMultiplier ?? 1;
        this.attackSpeedBonus = options.attackSpeedBonus ?? 0;
        this.castSpeedBonus = options.castSpeedBonus ?? 0;
        this.abilityHasteBonus = options.abilityHasteBonus ?? 0;
    }

    updateCombatDetails() {
        // Monster.updateCombatDetails() (and its super) look up game data by
        // this.hrid. Temporarily restore the data key so derivation works, then
        // put the unique identity back.
        let uniqueHrid = this.hrid;
        this.hrid = this.dataHrid;
        super.updateCombatDetails();
        this.hrid = uniqueHrid;

        this.applyPartyScaling();
    }

    // Group-battle party-size rules, applied AFTER the base derivation so they
    // survive every reset()/re-derive. Monster.updateCombatDetails() re-copies
    // combatStats from the game data (and zero-fills anything missing) on every
    // call, so these bonuses are re-applied to fresh values and never accumulate.
    //
    // Each bonus is applied the same way the engine applies that stat's own
    // buffs, so the result matches what an equivalent buff would produce:
    //   - attack speed: a separate divisor on attackInterval, mirroring the
    //     attack-speed buff handling in combatUnit.js:288-292.
    //   - cast speed:   additive into combatStats.castSpeed, mirroring the
    //     cast-speed buff handling in combatUnit.js:351.
    //   - ability haste: additive flat points; consumed later as
    //     cooldown * 100 / (100 + haste) (ability.js:192-196).
    applyPartyScaling() {
        let combatStats = this.combatDetails.combatStats;

        // HP only — max MP is deliberately NOT scaled by party size.
        if (this.hpMultiplier !== 1) {
            this.combatDetails.maxHitpoints = Math.floor(this.combatDetails.maxHitpoints * this.hpMultiplier);
        }
        if (this.attackSpeedBonus) {
            combatStats.attackInterval /= 1 + this.attackSpeedBonus;
        }
        if (this.castSpeedBonus) {
            combatStats.castSpeed += this.castSpeedBonus;
        }
        if (this.abilityHasteBonus) {
            combatStats.abilityHaste += this.abilityHasteBonus;
        }
    }
}

export default GroupBattleMonster;
