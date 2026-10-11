// A kit's display name, shared by the Optimization and Trigger Optimization pages.
import abilityDetailMap from "./combatsimulator/data/abilityDetailMap.json";
import { gameName, language, t } from "./optimizationI18n.js";

// A kit's name is its setup without the auras (special slot): initials for multi-word abilities,
// the full name for single words, e.g. "QA+EA+NV+Entangle". Always from the English game names, so
// the initials read the same in every language. Abilities of one kit whose initials collide
// (Penetrating Shot and Pestilent Shot are both PS) keep their full names. In Chinese there are no
// initials: every ability shows its full Chinese name.
export const kitName = (kitSlots) => {
    const names = (kitSlots || [])
        .filter((entry) => entry && entry.hrid && !abilityDetailMap[entry.hrid]?.isSpecialAbility)
        .map((entry) => abilityDetailMap[entry.hrid]?.name ?? entry.hrid.split("/").pop());
    if (language() === "zh") {
        const zhNames = (kitSlots || [])
            .filter((entry) => entry && entry.hrid && !abilityDetailMap[entry.hrid]?.isSpecialAbility)
            .map((entry, i) => gameName("abilityNames", entry.hrid, names[i]));
        return zhNames.length ? zhNames.join("+") : t("noAbilities");
    }
    const short = names.map((name) => {
        const words = name.split(/\s+/);
        return words.length > 1 ? words.map((w) => w[0].toUpperCase()).join("") : name;
    });
    const parts = names.map((name, i) => short.filter((s) => s === short[i]).length > 1 ? name : short[i]);
    return parts.length ? parts.join("+") : t("noAbilities");
};
