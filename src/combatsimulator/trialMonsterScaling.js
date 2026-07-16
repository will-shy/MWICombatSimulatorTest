// Pure functions to derive full combat ratings for a trial-monster scaling spec
// (see data/trialMonsterPresets.js) at a given level. Used both by CustomMonster
// (to actually run the sim) and by the UI (to preview stats without simulating).

const STYLES = ["stab", "slash", "smash", "ranged", "magic"];

function deriveTrialMonsterStats(spec, level) {
    let accuracyRating = {};
    let maxDamage = {};
    let evasionRating = {};

    for (const style of STYLES) {
        let accBonus = (spec.accuracyBonusPct && spec.accuracyBonusPct[style]) || 0;
        let dmgBonus = (spec.damageBonusPct && spec.damageBonusPct[style]) || 0;
        let evBonus = (spec.evasionBonusPct && spec.evasionBonusPct[style]) || 0;
        accuracyRating[style] = (10 + level) * (1 + accBonus);
        maxDamage[style] = (10 + level) * (1 + dmgBonus);
        evasionRating[style] = (10 + level) * (1 + evBonus);
    }

    let totalArmor = 0.2 * level + spec.armorScalingBase * (level / 100);
    let totalWaterResistance = 0.1 * (level + level) + spec.waterResScalingBase * (level / 100);
    let totalNatureResistance = 0.1 * (level + level) + spec.natureResScalingBase * (level / 100);
    let totalFireResistance = 0.1 * (level + level) + spec.fireResScalingBase * (level / 100);

    let maxHitpoints = spec.hpRatio * 10 * (level + 10);
    let maxManapoints = spec.mpRatio * 10 * (level + 10);

    // All 7 base levels scale 1:1 with the selected level (verified against
    // monster.txt's "Levels (@100): Stamina 100, Intelligence 100, ..." lines
    // and every monster's "Derived at level 100" block).
    let levels = {
        stamina: level, intelligence: level, attack: level, melee: level,
        defense: level, ranged: level, magic: level,
    };

    return {
        level,
        levels,
        accuracyRating, maxDamage, evasionRating,
        totalArmor, totalWaterResistance, totalNatureResistance, totalFireResistance,
        maxHitpoints, maxManapoints,
        attackIntervalSeconds: spec.attackIntervalSeconds,
        abilityHaste: spec.abilityHaste,
        castSpeed: spec.castSpeed,
        tenacity: spec.tenacity,
    };
}

export { deriveTrialMonsterStats, STYLES };
