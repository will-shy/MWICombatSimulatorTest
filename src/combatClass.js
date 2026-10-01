// A player's raid "class" for the roster views, from their weapon and, for the two support classes,
// the abilities they bring. Shared by the Group Battle and Skill Lab pages so a class has the same
// name, colour and place in the list on both.
//
//   Wark            a bulwark (a weapon with defensiveDamage), whatever its style
//   Cursed Bow      the Cursed Bow (refined or not), played as support
//   Water Support   a water weapon that brings Mana Spring
//   Nature Support  a nature weapon that brings Rejuvenate
//   Slash / Stab / Smash
//   Ranged          any ranged weapon except the Cursed Bow
//   Fire / Water    magic DPS by element
//   Nature DPS
//
// A nature player bringing both Rejuvenate and Mana Spring is a Nature Support. Mana Spring on a
// nature weapon alone, or Rejuvenate on a water one, does not make a support class.
import itemDetailMap from "./combatsimulator/data/itemDetailMap.json";

// In display order: Wark, then the supports (Cursed Bow, Water, Nature), then physical DPS, magic
// DPS, and the fallbacks. `label` is the English name (Skill Lab is English-only); `labelKey` is the
// Group Battle page's i18n key for it.
export const CLASSES = [
    { key: "wark", label: "Wark", labelKey: "styleWark", color: "#4bb3c4" },
    { key: "cursedBow", label: "Cursed Bow", labelKey: "classCursedBow", color: "#c77dff" },
    { key: "waterSupport", label: "Water Support", labelKey: "classWaterSupport", color: "#a9cff7" },
    { key: "natureSupport", label: "Nature Support", labelKey: "classNatureSupport", color: "#d4f0b0" },
    { key: "slash", label: "Slash", labelKey: "classSlash", color: "#e05a5a" },
    { key: "stab", label: "Stab", labelKey: "classStab", color: "#e8d24c" },
    { key: "smash", label: "Smash", labelKey: "classSmash", color: "#e8963c" },
    { key: "ranged", label: "Ranged", labelKey: "classRanged", color: "#5fbf6f" },
    { key: "fire", label: "Fire", labelKey: "classFire", color: "#ff6b3d" },
    { key: "water", label: "Water", labelKey: "classWater", color: "#4c9be8" },
    { key: "natureDps", label: "Nature DPS", labelKey: "classNatureDps", color: "#a3d44a" },
    // Fallbacks: a magic weapon with no known element, and no weapon at all.
    { key: "magic", label: "Magic", labelKey: "classMagic", color: "#9b7fe0" },
    { key: "unarmed", label: "Unarmed", labelKey: "unarmed", color: "#9aa0aa" },
];

const BY_KEY = Object.fromEntries(CLASSES.map((c, rank) => [c.key, { ...c, rank }]));

const REJUVENATE = "/abilities/rejuvenate";
const MANA_SPRING = "/abilities/mana_spring";

// A weapon is a "bulwark" (defensive) if its combat stats include defensiveDamage.
export function isBulwark(itemHrid) {
    const cs = itemDetailMap[itemHrid]?.equipmentDetail?.combatStats;
    return !!(cs && "defensiveDamage" in cs);
}

const isCursedBow = (itemHrid) => /^\/items\/cursed_bow(_refined)?$/.test(itemHrid);

/**
 * The class for an equipped weapon (main hand or two hand, "" for none) and the abilities on the
 * bar (hrids). Returns { key, label, labelKey, color, rank }, where a lower rank sorts first.
 */
export function raidClass(weaponHrid, abilityHrids = []) {
    const cs = weaponHrid ? itemDetailMap[weaponHrid]?.equipmentDetail?.combatStats : null;
    if (!cs) return BY_KEY.unarmed;
    if (isBulwark(weaponHrid)) return BY_KEY.wark;

    const abilities = new Set(abilityHrids);
    switch (cs.combatStyleHrids?.[0]) {
        case "/combat_styles/smash": return BY_KEY.smash;
        case "/combat_styles/slash": return BY_KEY.slash;
        case "/combat_styles/stab": return BY_KEY.stab;
        case "/combat_styles/ranged": return isCursedBow(weaponHrid) ? BY_KEY.cursedBow : BY_KEY.ranged;
        case "/combat_styles/magic":
            switch (cs.damageType) {
                case "/damage_types/fire": return BY_KEY.fire;
                case "/damage_types/water": return abilities.has(MANA_SPRING) ? BY_KEY.waterSupport : BY_KEY.water;
                case "/damage_types/nature": return abilities.has(REJUVENATE) ? BY_KEY.natureSupport : BY_KEY.natureDps;
                default: return BY_KEY.magic;
            }
        default: return BY_KEY.unarmed;
    }
}
