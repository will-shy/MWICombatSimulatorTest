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
//   2. Group HP rule: monster max HP/MP is +1% per player. Re-applied after every
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
    }

    updateCombatDetails() {
        // Monster.updateCombatDetails() (and its super) look up game data by
        // this.hrid. Temporarily restore the data key so derivation works, then
        // put the unique identity back.
        let uniqueHrid = this.hrid;
        this.hrid = this.dataHrid;
        super.updateCombatDetails();
        this.hrid = uniqueHrid;

        // Group-battle HP rule: +1% max HP/MP per player. Applied after the base
        // derivation so it survives every reset()/re-derive.
        if (this.hpMultiplier !== 1) {
            this.combatDetails.maxHitpoints = Math.floor(this.combatDetails.maxHitpoints * this.hpMultiplier);
            this.combatDetails.maxManapoints = Math.floor(this.combatDetails.maxManapoints * this.hpMultiplier);
        }
    }
}

export default GroupBattleMonster;
