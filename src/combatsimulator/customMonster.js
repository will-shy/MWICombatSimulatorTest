import CombatUnit from "./combatUnit";
import Ability from "./ability";
import { deriveTrialMonsterStats, STYLES } from "./trialMonsterScaling";

// Trial monster presets name abilities in display form ("Fierce Aura",
// "Nature's Veil"); the game's ability hrids are the lowercased, underscored,
// apostrophe-stripped form ("/abilities/fierce_aura", "/abilities/natures_veil").
// Verified this covers every ability name across all 8 trial monster presets.
function abilityNameToHrid(name) {
    return "/abilities/" + name.toLowerCase().replace(/'/g, "").replace(/\s+/g, "_");
}

// A monster built from raw FINAL combat ratings (not from game data / levels).
// Unlike Monster, this does NOT derive ratings from levels - the preset supplies
// the exact ratings the engine consumes, so updateCombatDetails writes them directly.
//
// Two spec modes:
//  - Static spec (spec.scaling is falsy): final ratings given directly
//    (accuracyRating, maxDamage, stabEvasion, totalArmor, maxHitpoints, ...).
//  - Scaling spec (spec.scaling === true, spec.level set): a trial-monster style
//    spec (see data/trialMonsterPresets.js) is derived at spec.level using the
//    shared formulas in trialMonsterScaling.js.
class CustomMonster extends CombatUnit {
    constructor(spec) {
        super();

        this.isPlayer = false;
        this.spec = spec;
        // hrid is used as the identity key throughout the sim/log. Keep it stable
        // and unique per preset instance.
        this.hrid = spec.hrid || ("/custom_monsters/" + (spec.name || "custom").toLowerCase().replace(/[^a-z0-9]+/g, "_"));
        this.name = spec.name || "Custom Monster";

        // No abilities by default (a raw-stat dummy); real game monsters can
        // carry up to 5, so scaling-spec trial monsters use that many too.
        this.abilities = [null, null, null, null, null];
        this.dropTable = [];
        this.rareDropTable = [];

        // Group-battle monsters enrage 10 minutes into the fight, then gain
        // +10% damage/accuracy per additional 10 minutes alive (same formula/
        // cadence as CombatSimulator.processEnrageTickEvent uses for zone
        // monsters), capped at 10 stacks (+100%/+100%).
        this.enrageTime = 10 * 60 * 1e9;
    }

    updateCombatDetails() {
        let s = this.spec;
        let cd = this.combatDetails;
        let cs = cd.combatStats;

        cs.combatStyleHrid = s.combatStyleHrid || "/combat_styles/smash";
        cs.damageType = s.damageType || "/damage_types/physical";

        if (s.scaling) {
            this.applyScalingSpec(s);
            return;
        }

        // attackInterval is stored in nanoseconds internally.
        cs.attackInterval = Math.round((s.attackIntervalSeconds ?? 3) * 1e9);
        cd.combatStats.attackInterval = cs.attackInterval;

        cs.castSpeed = s.castSpeed ?? 0;
        cd.abilityHaste = s.abilityHaste ?? 0;
        cd.tenacity = s.tenacity ?? 0;

        // hpMultiplier scales group-battle monsters by +1% max HP/MP per player
        // in the group (see worker.js's start_battle handler). Defaults to 1.
        let hpMult = s.hpMultiplier ?? 1;
        cd.maxHitpoints = (s.maxHitpoints ?? 110) * hpMult;
        cd.maxManapoints = (s.maxManapoints ?? 110) * hpMult;

        // Accuracy / max-damage ratings. The preset gives one accuracy and one
        // damage figure for the active style; write it to that style's rating and
        // leave the others at a small default so off-style attacks are weak.
        let acc = s.accuracyRating ?? 10;
        let dmg = s.maxDamage ?? 10;
        for (const style of STYLES) {
            cd[style + "AccuracyRating"] = 10;
            cd[style + "MaxDamage"] = 10;
        }
        let styleKey = (s.combatStyleHrid || "/combat_styles/smash").split("/").pop();
        cd[styleKey + "AccuracyRating"] = acc;
        cd[styleKey + "MaxDamage"] = dmg;

        // Evasion ratings per style.
        cd.stabEvasionRating = s.stabEvasion ?? 10;
        cd.slashEvasionRating = s.slashEvasion ?? 10;
        cd.smashEvasionRating = s.smashEvasion ?? 10;
        cd.rangedEvasionRating = s.rangedEvasion ?? 10;
        cd.magicEvasionRating = s.magicEvasion ?? 10;

        // Mitigation.
        cd.totalArmor = s.totalArmor ?? 0;
        cd.totalWaterResistance = s.totalWaterResistance ?? 0;
        cd.totalNatureResistance = s.totalNatureResistance ?? 0;
        cd.totalFireResistance = s.totalFireResistance ?? 0;

        // Threat.
        cs.threat = s.threat ?? 100;
        cd.totalThreat = 100 + (s.threat ?? 0);

        // Optional advanced combatStats (all default to 0 already on the base unit).
        let advanced = [
            "autoAttackDamage", "criticalRate", "criticalDamage", "taskDamage",
            "physicalAmplify", "waterAmplify", "natureAmplify", "fireAmplify",
            "healingAmplify", "physicalThorns", "elementalThorns", "lifeSteal",
            "manaLeech", "armorPenetration", "waterPenetration", "naturePenetration",
            "firePenetration", "parry", "mayhem", "pierce", "fury", "curse", "weaken",
            "ripple", "bloom", "blaze", "damageTaken", "attackSpeed",
        ];
        for (const key of advanced) {
            if (s[key] != null) {
                cs[key] = s[key];
            }
        }

        cs.hpRegenPer10 = s.hpRegenPer10 ?? 0.01;
        cs.mpRegenPer10 = s.mpRegenPer10 ?? 0.01;
    }

    applyScalingSpec(s) {
        let cd = this.combatDetails;
        let cs = cd.combatStats;
        let level = s.level ?? 100;
        let derived = deriveTrialMonsterStats(s, level);

        // Build real abilities from the preset (base levels are authored "at
        // tier 100" per monster.txt, so they scale with the same level/100
        // ratio as every other stat). Only build once per instance - reset()
        // calls updateCombatDetails() repeatedly and abilities shouldn't be
        // rebuilt (that would drop in-fight cooldown state via lastUsed).
        if (!this.abilitiesBuilt && s.abilities && s.abilities.length) {
            let scaleFactor = level / 100;
            s.abilities.forEach((a, i) => {
                try {
                    let abilityLevel = Math.max(1, Math.floor(a.baseLevel * scaleFactor));
                    this.abilities[i] = new Ability(abilityNameToHrid(a.name), abilityLevel);
                } catch (e) {
                    // Unknown ability hrid - leave that slot empty rather than crash the sim.
                    this.abilities[i] = null;
                }
            });
            this.abilitiesBuilt = true;
        }

        cs.attackInterval = Math.round(derived.attackIntervalSeconds * 1e9);
        cd.combatStats.attackInterval = cs.attackInterval;
        cs.castSpeed = derived.castSpeed;
        cd.abilityHaste = derived.abilityHaste;
        cd.tenacity = derived.tenacity;

        // hpMultiplier scales group-battle monsters by +1% max HP/MP per player
        // in the group (see worker.js's start_battle handler). Defaults to 1.
        let hpMult = s.hpMultiplier ?? 1;
        cd.maxHitpoints = derived.maxHitpoints * hpMult;
        cd.maxManapoints = derived.maxManapoints * hpMult;

        for (const style of STYLES) {
            cd[style + "AccuracyRating"] = derived.accuracyRating[style];
            cd[style + "MaxDamage"] = derived.maxDamage[style];
            cd[style + "EvasionRating"] = derived.evasionRating[style];
        }

        cd.totalArmor = derived.totalArmor;
        cd.totalWaterResistance = derived.totalWaterResistance;
        cd.totalNatureResistance = derived.totalNatureResistance;
        cd.totalFireResistance = derived.totalFireResistance;

        cs.threat = s.threat ?? 100;
        cd.totalThreat = 100 + (s.threat ?? 100);

        cs.hpRegenPer10 = 0.01;
        cs.mpRegenPer10 = 0.01;
    }
}

export default CustomMonster;
