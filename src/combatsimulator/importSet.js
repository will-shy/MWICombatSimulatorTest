import Ability from "./ability.js";
import Consumable from "./consumable.js";
import shrineDetailMap from "./data/shrineDetailMap.json";

// An "import set" is the JSON the in-game exporter / loadout plugin produces and the standard
// simulator's Solo import box accepts. This module turns one into a plain DTO that
// Player.createFromDTO understands, so it can be posted straight to a simulation worker.

const EQUIPMENT_SLOTS = [
    "head", "body", "legs", "feet", "hands", "off_hand", "pouch",
    "neck", "earrings", "ring", "back", "main_hand", "two_hand", "charm",
];

// The exporter reports guild shrine levels as { force, tempo, spirit }, keyed by the guild buff
// name instead of by shrine hrid. Translate that into the { <shrineHrid>: level } shape the rest of
// the app uses, dropping names this build has no shrine for. Returns null when there is nothing
// usable, so callers can fall back to a cached book instead of wiping it.
export function shrineLevelsFromGuildShrine(guildShrine) {
    if (!guildShrine || typeof guildShrine !== "object") {
        return null;
    }

    let levels = {};
    for (const [name, level] of Object.entries(guildShrine)) {
        const hrid = "/shrines/" + name;
        if (shrineDetailMap[hrid]) {
            levels[hrid] = Number(level) || 0;
        }
    }

    return Object.keys(levels).length > 0 ? levels : null;
}

// Resolving through the real class fills in the ability's default combat triggers when the set
// carries none, so the DTO always leaves here with a concrete trigger list.
function abilityDTO(hrid, level, triggers) {
    try {
        let ability = new Ability(hrid, Number(level) || 1, triggers);
        return { hrid: ability.hrid, level: ability.level, triggers: ability.triggers };
    } catch (e) {
        return null;
    }
}

function consumableDTO(hrid, triggers) {
    try {
        let consumable = new Consumable(hrid, triggers);
        return { hrid: consumable.hrid, triggers: consumable.triggers };
    } catch (e) {
        return null;
    }
}

// abilityOverride, when given, replaces the set's own ability list: a sparse array of
// { hrid, level } (or null) indexed by slot, which is how a variant swaps one ability for another.
export function importSetToPlayerDTO(importSet, hrid, abilityOverride = null) {
    const triggerMap = importSet.triggerMap ?? {};
    const levels = importSet.player ?? {};

    let equipment = {};
    for (const slot of EQUIPMENT_SLOTS) {
        equipment["/equipment_types/" + slot] = null;
    }
    for (const item of levels.equipment ?? []) {
        const slot = String(item?.itemLocationHrid ?? "").replace("/item_locations/", "");
        if (!item?.itemHrid || !EQUIPMENT_SLOTS.includes(slot)) {
            continue;
        }
        equipment["/equipment_types/" + slot] = {
            hrid: item.itemHrid,
            enhancementLevel: Number(item.enhancementLevel) || 0,
        };
    }

    const consumables = (list) => (list ?? [])
        .filter((entry) => entry?.itemHrid)
        .map((entry) => consumableDTO(entry.itemHrid, triggerMap[entry.itemHrid]))
        .filter(Boolean);

    const abilitySource = abilityOverride ?? (importSet.abilities ?? []).map((entry) =>
        entry?.abilityHrid ? { hrid: entry.abilityHrid, level: entry.level } : null
    );
    const abilities = abilitySource
        .filter((entry) => entry?.hrid && Number(entry.level) > 0)
        .map((entry) => abilityDTO(entry.hrid, entry.level, triggerMap[entry.hrid]))
        .filter(Boolean);

    return {
        hrid,
        staminaLevel: Number(levels.staminaLevel) || 1,
        intelligenceLevel: Number(levels.intelligenceLevel) || 1,
        attackLevel: Number(levels.attackLevel) || 1,
        meleeLevel: Number(levels.meleeLevel ?? levels.powerLevel) || 1,
        defenseLevel: Number(levels.defenseLevel) || 1,
        rangedLevel: Number(levels.rangedLevel) || 1,
        magicLevel: Number(levels.magicLevel) || 1,
        equipment,
        food: consumables(importSet.food?.["/action_types/combat"]),
        drinks: consumables(importSet.drinks?.["/action_types/combat"]),
        abilities,
        houseRooms: importSet.houseRooms ?? {},
        achievements: importSet.achievements ?? {},
        labyrinthUpgrades: importSet.labyrinthUpgrades ?? {},
        shrines: importSet.shrines ?? shrineLevelsFromGuildShrine(importSet.guildShrine) ?? {},
    };
}

// Same formula as the standard simulator's calcCombatLevel.
function combatLevelOf(dto) {
    return 0.1 * (dto.staminaLevel + dto.intelligenceLevel + dto.attackLevel + dto.defenseLevel
            + Math.max(dto.meleeLevel, dto.rangedLevel, dto.magicLevel))
        + 0.5 * Math.max(dto.attackLevel, dto.defenseLevel, dto.meleeLevel, dto.rangedLevel, dto.magicLevel);
}

// A player far below the party's top combat level is penalised on damage, drops and experience.
// The simulator reads this off the DTO and never derives it, so a party assembled anywhere other
// than the standard page has to set it: leaving it undefined turns every experience number into
// NaN, because the gain is scaled by (1 + debuffOnLevelGap).
export function applyLevelGapDebuff(playerDTOs) {
    const maxDebuff = 0.9;
    const levels = playerDTOs.map(combatLevelOf);
    const topLevel = Math.max(1, ...levels);

    playerDTOs.forEach((dto, index) => {
        const ratio = topLevel / levels[index];
        dto.combatLevel = levels[index];
        dto.debuffOnLevelGap = ratio > 1.2 ? -1 * Math.min(maxDebuff, 3 * (ratio - 1.2)) : 0;
    });
    return playerDTOs;
}

// The five slots a variant can substitute into, as { hrid, level } or null, straight from the set.
export function baselineAbilitySlots(importSet) {
    let slots = [];
    for (let i = 0; i < 5; i++) {
        const entry = (importSet.abilities ?? [])[i];
        slots.push(entry?.abilityHrid ? { hrid: entry.abilityHrid, level: Number(entry.level) || 1 } : null);
    }
    return slots;
}
