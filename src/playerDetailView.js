// Shared "what is this build actually running" renderer: the equipment/ability
// summary and the fully computed combat-status panel behind the group-battle
// roster cards and the Skill Lab build preview. Extracted from groupBattle.js so
// both pages show the exact same numbers for the same DTO.
//
// UI labels come from an injected `t(key)` so the group-battle page can pass its
// i18next-backed translator; without one the English defaults below are used
// (the Skill Lab page is English-only by project convention). Item/ability/skill
// names go through i18next directly when the page loaded it, and fall back to
// the game data's English names when it didn't.
import Player from "./combatsimulator/player.js";
import Zone from "./combatsimulator/zone.js";
import itemDetailMap from "./combatsimulator/data/itemDetailMap.json";
import abilityDetailMap from "./combatsimulator/data/abilityDetailMap.json";
import combatTriggerDependencyDetailMap from "./combatsimulator/data/combatTriggerDependencyDetailMap.json";
import combatTriggerConditionDetailMap from "./combatsimulator/data/combatTriggerConditionDetailMap.json";
import combatTriggerComparatorDetailMap from "./combatsimulator/data/combatTriggerComparatorDetailMap.json";
import houseRoomDetailMap from "./combatsimulator/data/houseRoomDetailMap.json";
import shrineDetailMap from "./combatsimulator/data/shrineDetailMap.json";
import achievementTierDetailMap from "./combatsimulator/data/achievementTierDetailMap.json";
import achievementDetailMap from "./combatsimulator/data/achievementDetailMap.json";
import GROUP_BATTLE_REGEN_BUFFS from "./combatsimulator/data/groupBattleBuffs";
import Shrine from "./combatsimulator/shrine.js";

const ONE_SECOND = 1e9;

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// English fallbacks for every label the renderers below ask for.
const DEFAULT_LABELS = {
    equipment: "Equipment",
    abilities: "Abilities",
    noCombatEquipment: "No combat equipment.",
    noAbilities: "No abilities.",
    showDetailedStatus: "Show Detailed Combat Status",
    hideDetailedStatus: "Hide Detailed Combat Status",
    combatStyle: "Combat Style",
    damageType: "Damage Type",
    attackInterval: "Attack Interval",
    manaCost: "Mana Cost",
    cooldown: "Cooldown",
    castTime: "Cast Time",
    triggersWhen: "Triggers when:",
    noTriggerCondition: "No trigger condition (casts whenever off cooldown &amp; affordable)",
    characterBonuses: "Character Bonuses",
    houseCombatRooms: "House (combat)",
    guildShrines: "Guild Shrines",
    achievementTiers: "Achievements",
    damage: "Damage",
    bonusOn: "ON",
    bonusOff: "OFF",
    none: "None",
};
const defaultT = (key) => DEFAULT_LABELS[key] ?? key;

// Inverse of soloExportToDTO / equipmentSetToDTO: turn an internal player DTO
// back into the "solo export" JSON the standard simulator's Import/Export uses,
// so a preset (or roster player) can be re-imported there. Food/drinks are
// intentionally empty (group battles strip them).
export function dtoToSoloExport(dto) {
    let equipment = [];
    for (const [key, val] of Object.entries(dto.equipment || {})) {
        if (!val || !val.hrid) continue;
        let type = key.replace("/equipment_types/", "");
        equipment.push({
            itemLocationHrid: "/item_locations/" + type,
            itemHrid: val.hrid,
            enhancementLevel: Number(val.enhancementLevel) || 0,
        });
    }

    let triggerMap = {};
    let abilities = (dto.abilities || []).filter(Boolean).map((a) => {
        if (a.triggers) triggerMap[a.hrid] = a.triggers;
        return { abilityHrid: a.hrid, level: Number(a.level) || 1 };
    });

    return {
        player: {
            staminaLevel: dto.staminaLevel ?? 1,
            intelligenceLevel: dto.intelligenceLevel ?? 1,
            attackLevel: dto.attackLevel ?? 1,
            meleeLevel: dto.meleeLevel ?? 1,
            defenseLevel: dto.defenseLevel ?? 1,
            rangedLevel: dto.rangedLevel ?? 1,
            magicLevel: dto.magicLevel ?? 1,
            equipment,
        },
        food: { "/action_types/combat": [{ itemHrid: "" }, { itemHrid: "" }, { itemHrid: "" }] },
        drinks: { "/action_types/combat": [{ itemHrid: "" }, { itemHrid: "" }, { itemHrid: "" }] },
        abilities,
        triggerMap,
        houseRooms: dto.houseRooms || {},
        achievements: dto.achievements || {},
        // Only set on DTOs that came from a real character (guild trial import); carrying it keeps
        // the shrine levels through an export / "open in original simulator" round trip.
        ...(dto.shrines && Object.keys(dto.shrines).length ? { shrines: dto.shrines } : {}),
    };
}

// Prefer the game's real translated item/ability name (i18next, loaded by
// js/i18n.js) when available, falling back to the English detail map name.
export function itemName(hrid) {
    if (typeof i18next !== "undefined" && i18next.exists("itemNames." + hrid)) {
        return i18next.t("itemNames." + hrid);
    }
    return itemDetailMap[hrid] ? itemDetailMap[hrid].name : hrid.split("/").pop();
}
export function abilityName(hrid) {
    if (typeof i18next !== "undefined" && i18next.exists("abilityNames." + hrid)) {
        return i18next.t("abilityNames." + hrid);
    }
    return abilityDetailMap[hrid] ? abilityDetailMap[hrid].name : hrid.split("/").pop();
}
export function skillName(skillHrid) {
    if (typeof i18next !== "undefined" && i18next.exists("skillNames." + skillHrid)) {
        return i18next.t("skillNames." + skillHrid);
    }
    return skillHrid.split("/").pop();
}
export function combatStyleName(hrid) {
    if (!hrid) return "";
    if (typeof i18next !== "undefined" && i18next.exists("combatStyleNames." + hrid)) {
        return i18next.t("combatStyleNames." + hrid);
    }
    return hrid.split("/").pop();
}
export function damageTypeName(hrid) {
    if (!hrid) return "";
    if (typeof i18next !== "undefined" && i18next.exists("damageTypeNames." + hrid)) {
        return i18next.t("damageTypeNames." + hrid);
    }
    return hrid.split("/").pop();
}
export function equipSlotName(slot) {
    // Matches js/i18n.js's characterItemsUtil camelCase keys; two_hand has no
    // dedicated translation in the game data, so it falls back to main_hand's.
    const camel = { main_hand: "mainHand", two_hand: "mainHand", off_hand: "offHand" }[slot]
        || slot.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (typeof i18next !== "undefined" && i18next.exists("characterItemsUtil." + camel)) {
        return i18next.t("characterItemsUtil." + camel);
    }
    return slot.replace(/_/g, " ");
}

export const EQUIP_SLOT_ORDER = [
    "main_hand", "two_hand", "off_hand",
    "head", "body", "legs", "feet",
    "hands", "neck", "earrings", "ring",
    "pouch", "back",
];

// The buff types combatUnit.js actually reads off a house room's actionBuffs. A room whose action
// buffs are all outside this set (a kitchen's cooking efficiency, the observatory's enhancing
// success) is passed to the sim but contributes nothing to combat, so it has no place here.
const COMBAT_HOUSE_BUFF_TYPES = new Set([
    "/buff_types/attack_level", "/buff_types/melee_level", "/buff_types/defense_level",
    "/buff_types/ranged_level", "/buff_types/magic_level", "/buff_types/stamina_level",
    "/buff_types/intelligence_level", "/buff_types/attack_speed", "/buff_types/cast_speed",
    "/buff_types/hp_regen", "/buff_types/mp_regen",
]);
const COMBAT_HOUSE_ROOMS = Object.keys(houseRoomDetailMap).filter((hrid) =>
    (houseRoomDetailMap[hrid].actionBuffs ?? []).some((b) => COMBAT_HOUSE_BUFF_TYPES.has(b.typeHrid))
);

// Achievement tiers are all-or-nothing: completing every achievement in a tier grants that tier's
// buff. Only Elite's is a combat buff (+2% damage) - the others are efficiency, gathering,
// enhancing success, wisdom and rare find, none of which combatUnit.js reads for damage or survival.
const COMBAT_ACHIEVEMENT_TIERS = Object.entries(achievementTierDetailMap)
    .filter(([, tier]) => tier.buff?.typeHrid === "/buff_types/damage")
    .map(([hrid, tier]) => ({
        hrid,
        name: tier.name,
        pct: ((tier.buff.ratioBoost || tier.buff.flatBoost) * 100).toFixed(0),
        // The achievements that must ALL be complete for this tier's buff to apply.
        required: Object.values(achievementDetailMap).filter((a) => a.tierHrid === hrid).map((a) => a.hrid),
    }));

function houseRoomName(hrid) {
    if (typeof i18next !== "undefined" && i18next.exists("houseRoomNames." + hrid)) {
        return i18next.t("houseRoomNames." + hrid);
    }
    return houseRoomDetailMap[hrid]?.name ?? hrid.split("/").pop();
}

function shrineName(hrid) {
    if (typeof i18next !== "undefined" && i18next.exists("shrineNames." + hrid)) {
        return i18next.t("shrineNames." + hrid);
    }
    return shrineDetailMap[hrid]?.name ?? hrid.split("/").pop();
}

function chip(label, value, color) {
    let style = color ? ` style="color:${color};border-color:${color};"` : "";
    return `<span class="chip"${style}><span class="dim">${escapeHtml(label)}</span> ${escapeHtml(String(value))}</span>`;
}

// House / shrines / achievement tiers - the per-character bonuses that apply on top of gear and
// abilities. Only the combat-relevant ones are listed; the rest are carried into the sim but never
// read during a fight. Returns "" when the DTO carries none of them (a preset-built player).
function characterBonusesHtml(d, t) {
    const houseRooms = d.houseRooms ?? {};
    const shrines = d.shrines ?? {};
    const achievements = d.achievements ?? {};

    if (!Object.keys(houseRooms).length && !Object.keys(shrines).length && !Object.keys(achievements).length) {
        return "";
    }

    let houseChips = COMBAT_HOUSE_ROOMS
        .map((hrid) => ({ hrid, level: Number(houseRooms[hrid]) || 0 }))
        .filter((room) => room.level > 0)
        .sort((a, b) => b.level - a.level)
        .map((room) => chip(houseRoomName(room.hrid), room.level))
        .join("");

    // Every combat shrine is listed, including the ones at 0, so a shrine the guild never built is
    // visibly missing rather than just absent from the row. A DTO with no shrine data at all (a
    // preset-built player) gets no row, rather than a misleading row of zeros.
    let shrineChips = Object.keys(shrines).length
        ? Object.keys(shrineDetailMap).map((hrid) => chip(shrineName(hrid), Number(shrines[hrid]) || 0)).join("")
        : "";

    let achievementChips = COMBAT_ACHIEVEMENT_TIERS.map((tier) => {
        let earned = tier.required.length > 0 && tier.required.every((hrid) => achievements[hrid]);
        let missing = tier.required.filter((hrid) => !achievements[hrid]).length;
        let label = `${tier.name} +${tier.pct}% ${t("damage")}`;
        let value = earned ? t("bonusOn") : `${t("bonusOff")} (${missing})`;
        return chip(label, value, earned ? "#4caf50" : "#9aa0aa");
    }).join("");

    const row = (labelKey, chips) => chips
        ? `<div style="display:flex; align-items:baseline; gap:8px; margin-bottom:4px;">
               <span class="dim" style="flex:0 0 110px; font-size:12px;">${escapeHtml(t(labelKey))}</span>
               <span class="detail-skills" style="margin-bottom:0;">${chips}</span>
           </div>`
        : "";

    return `<h5 style="margin-top:10px;">${escapeHtml(t("characterBonuses"))}</h5>
        ${row("houseCombatRooms", houseChips || chip("", t("none")))}
        ${row("guildShrines", shrineChips)}
        ${row("achievementTiers", achievementChips)}`;
}

export function playerDetailHtml(d, t = defaultT) {
    // Skills
    let skills = [
        ["/skills/attack", d.attackLevel], ["/skills/melee", d.meleeLevel], ["/skills/defense", d.defenseLevel],
        ["/skills/stamina", d.staminaLevel], ["/skills/ranged", d.rangedLevel], ["/skills/magic", d.magicLevel],
        ["/skills/intelligence", d.intelligenceLevel],
    ].map(([hrid, v]) => [skillName(hrid), v]);
    let skillHtml = '<div class="detail-skills">' +
        skills.map(([n, v]) => `<span class="chip"><span class="dim">${n}</span> ${v}</span>`).join("") +
        "</div>";

    // Equipment (only populated combat slots)
    let equipRows = EQUIP_SLOT_ORDER
        .map((slot) => {
            let e = d.equipment["/equipment_types/" + slot];
            if (!e) return null;
            let enh = e.enhancementLevel ? ` +${e.enhancementLevel}` : "";
            return `<tr><td class="dim">${escapeHtml(equipSlotName(slot))}</td><td>${escapeHtml(itemName(e.hrid))}${enh}</td></tr>`;
        })
        .filter(Boolean);
    let equipHtml = equipRows.length
        ? `<table class="tbl">${equipRows.join("")}</table>`
        : `<div class="empty">${escapeHtml(t("noCombatEquipment"))}</div>`;

    // Abilities, each with the trigger conditions it fires on. The triggers decide what the sim
    // actually casts, so they belong next to the ability rather than behind the detailed-status
    // button - a bar that looks right can still behave oddly because of one condition.
    let abilityItems = (d.abilities || [])
        .filter(Boolean)
        .map((a) => {
            let triggers = (a.triggers || []).map(
                (tr) => `<li>${escapeHtml(describeTrigger(tr))}</li>`).join("");
            let triggerHtml = triggers
                ? `<ul class="detail-triggers">${triggers}</ul>`
                : `<div class="detail-triggers dim">${t("noTriggerCondition")}</div>`;
            return `<li>${escapeHtml(abilityName(a.hrid))} <span class="dim">L${a.level}</span>${triggerHtml}</li>`;
        });
    let abilityHtml = abilityItems.length
        ? `<ul class="detail-abilities">${abilityItems.join("")}</ul>`
        : `<div class="empty">${escapeHtml(t("noAbilities"))}</div>`;

    return `<div class="detail-body">
        ${skillHtml}
        ${characterBonusesHtml(d, t)}
        <div class="detail-cols">
            <div><h5>${escapeHtml(t("equipment"))}</h5>${equipHtml}</div>
            <div><h5>${escapeHtml(t("abilities"))}</h5>${abilityHtml}</div>
        </div>
        <div class="row" style="margin-top:10px;">
            <button class="secondary show-status-btn">${escapeHtml(t("showDetailedStatus"))}</button>
        </div>
        <div class="detailed-status" style="display:none;"></div>
    </div>`;
}

// Formats one Ability's cooldown/mana/triggers into plain-language lines so
// you can see exactly why the sim picked auto-attack over an ability (still
// on cooldown, not enough mana, or a trigger condition not currently true).
function translatedOr(ns, hrid, fallback) {
    if (typeof i18next !== "undefined" && i18next.exists(ns + "." + hrid)) {
        return i18next.t(ns + "." + hrid);
    }
    return fallback;
}

function describeTrigger(trigger) {
    let depName = translatedOr("combatTriggerDependencyNames", trigger.dependencyHrid,
        combatTriggerDependencyDetailMap[trigger.dependencyHrid]?.name || trigger.dependencyHrid);
    let condName = translatedOr("combatTriggerConditionNames", trigger.conditionHrid,
        combatTriggerConditionDetailMap[trigger.conditionHrid]?.name || trigger.conditionHrid);
    let cmpInfo = combatTriggerComparatorDetailMap[trigger.comparatorHrid];
    let cmpName = translatedOr("combatTriggerComparatorNames", trigger.comparatorHrid,
        cmpInfo?.name || trigger.comparatorHrid);
    return cmpInfo?.allowValue
        ? `${depName} ${condName} ${cmpName} ${trigger.value}`
        : `${depName} ${condName} ${cmpName}`;
}

function abilityDetailHtml(ability, t) {
    if (!ability) return "";
    let triggerLines = (ability.triggers || []).map((tr) => `<li>${escapeHtml(describeTrigger(tr))}</li>`).join("");
    return `<div class="ability-detail">
        <b>${escapeHtml(abilityName(ability.hrid))}</b> <span class="dim">L${ability.level}</span>
        <table class="tbl">
            <tr><td class="dim">${escapeHtml(t("manaCost"))}</td><td>${ability.manaCost}</td></tr>
            <tr><td class="dim">${escapeHtml(t("cooldown"))}</td><td>${(ability.cooldownDuration / ONE_SECOND).toFixed(1)}s</td></tr>
            <tr><td class="dim">${escapeHtml(t("castTime"))}</td><td>${(ability.castDuration / ONE_SECOND).toFixed(2)}s</td></tr>
        </table>
        ${triggerLines ? `<div class="dim" style="margin-top:4px;">${escapeHtml(t("triggersWhen"))}</div><ul class="detail-abilities">${triggerLines}</ul>` : `<div class="dim" style="margin-top:4px;">${t("noTriggerCondition")}</div>`}
    </div>`;
}

// Mirrors main.js's updateCombatStatsUI() field lists/sources/formatting
// exactly (verified against src/main.js), so this panel shows the same
// numbers the standard simulator page would for the same build:
//  - FLOOR_FROM_DETAILS: Math.floor(player.combatDetails[stat]) - ratings live
//    directly on combatDetails, not nested under combatStats.
//  - FLOOR_FROM_COMBAT_STATS: Math.floor(player.combatDetails.combatStats[stat]).
//    abilityHaste/tenacity are populated here from equipment by
//    Player.updateCombatDetails() before CombatUnit's buff-boost pass runs.
//  - PERCENT_FROM_COMBAT_STATS: displayed as (100*value)%, up to 4 decimals.
const FLOOR_FROM_DETAILS = [
    "maxHitpoints", "maxManapoints",
    "stabAccuracyRating", "stabMaxDamage",
    "slashAccuracyRating", "slashMaxDamage",
    "smashAccuracyRating", "smashMaxDamage",
    "rangedAccuracyRating", "rangedMaxDamage",
    "magicAccuracyRating", "magicMaxDamage",
    "defensiveMaxDamage",
    "stabEvasionRating", "slashEvasionRating", "smashEvasionRating",
    "rangedEvasionRating", "magicEvasionRating",
    "totalArmor", "totalWaterResistance", "totalNatureResistance", "totalFireResistance",
    "totalThreat",
];
const FLOOR_FROM_COMBAT_STATS = ["abilityHaste", "tenacity"];
const PERCENT_FROM_COMBAT_STATS = [
    "physicalAmplify", "waterAmplify", "natureAmplify", "fireAmplify", "healingAmplify",
    "lifeSteal", "hpRegenPer10", "mpRegenPer10", "physicalThorns", "elementalThorns",
    "criticalRate", "criticalDamage", "combatExperience", "taskDamage",
    "armorPenetration", "waterPenetration", "naturePenetration", "firePenetration",
    "manaLeech", "castSpeed", "parry", "mayhem", "pierce", "curse", "fury", "weaken",
    "ripple", "bloom", "blaze", "attackSpeed", "autoAttackDamage", "abilityDamage",
    "drinkConcentration", "foodHaste",
    "staminaExperience", "intelligenceExperience", "attackExperience", "defenseExperience",
    "meleeExperience", "rangedExperience", "magicExperience",
];
// Human-readable labels for stats without an existing t() key (kept English-only).
const STAT_LABELS = {
    stabAccuracyRating: "Stab Accuracy", stabMaxDamage: "Stab Max Damage",
    slashAccuracyRating: "Slash Accuracy", slashMaxDamage: "Slash Max Damage",
    smashAccuracyRating: "Smash Accuracy", smashMaxDamage: "Smash Max Damage",
    rangedAccuracyRating: "Ranged Accuracy", rangedMaxDamage: "Ranged Max Damage",
    magicAccuracyRating: "Magic Accuracy", magicMaxDamage: "Magic Max Damage",
    defensiveMaxDamage: "Defensive Max Damage",
    stabEvasionRating: "Stab Evasion", slashEvasionRating: "Slash Evasion",
    smashEvasionRating: "Smash Evasion", rangedEvasionRating: "Ranged Evasion",
    magicEvasionRating: "Magic Evasion",
    totalArmor: "Armor", totalWaterResistance: "Water Resistance",
    totalNatureResistance: "Nature Resistance", totalFireResistance: "Fire Resistance",
    totalThreat: "Threat", abilityHaste: "Ability Haste", tenacity: "Tenacity",
    physicalAmplify: "Physical Amplify", waterAmplify: "Water Amplify",
    natureAmplify: "Nature Amplify", fireAmplify: "Fire Amplify", healingAmplify: "Healing Amplify",
    lifeSteal: "Life Steal", hpRegenPer10: "HP Regen /10s", mpRegenPer10: "MP Regen /10s",
    physicalThorns: "Physical Thorns", elementalThorns: "Elemental Thorns",
    criticalRate: "Critical Rate", criticalDamage: "Critical Damage",
    combatExperience: "Combat Experience Rate", taskDamage: "Task Damage",
    armorPenetration: "Armor Penetration", waterPenetration: "Water Penetration",
    naturePenetration: "Nature Penetration", firePenetration: "Fire Penetration",
    manaLeech: "Mana Leech", castSpeed: "Cast Speed", parry: "Parry", mayhem: "Mayhem",
    pierce: "Pierce", curse: "Curse", fury: "Fury", weaken: "Weaken", ripple: "Ripple",
    bloom: "Bloom", blaze: "Blaze", attackSpeed: "Attack Speed",
    autoAttackDamage: "Auto Attack Damage", abilityDamage: "Ability Damage",
    drinkConcentration: "Drink Concentration", foodHaste: "Food Haste",
    staminaExperience: "Stamina Experience", intelligenceExperience: "Intelligence Experience",
    attackExperience: "Attack Experience", defenseExperience: "Defense Experience",
    meleeExperience: "Melee Experience", rangedExperience: "Ranged Experience",
    magicExperience: "Magic Experience",
};

// Builds a real Player from the DTO (same construction the worker uses,
// including the group-battle +3% HP/MP regen buff and the character's shrines) and renders its fully
// computed combat stats + per-ability cooldown/mana/trigger info, so you can
// verify the sim's actual decision inputs rather than guessing from the log.
// extraBuffs, when given, replaces the default stack - the group-battle page passes the same one
// its worker uses (regen compensation + guild buildings + shrines) so this panel matches the run.
export function renderDetailedStatus(container, dto, t = defaultT, extraBuffs = null) {
    let zone = new Zone("/actions/combat/fly");
    let player = Player.createFromDTO(structuredClone(dto));
    player.zoneBuffs = zone.buffs;
    player.extraBuffs = extraBuffs
        ?? GROUP_BATTLE_REGEN_BUFFS.concat(Shrine.buffsFromLevels(player.shrines));
    player.reset(0);
    player.generatePermanentBuffs();
    player.reset(0);

    let cd = player.combatDetails;
    let cs = cd.combatStats;
    let activeStyle = (cs.combatStyleHrid || "").split("/").pop();

    let tiles = [
        [t("combatStyle"), combatStyleName(cs.combatStyleHrid)],
        [t("damageType"), damageTypeName(cs.damageType)],
        [t("attackInterval"), (cs.attackInterval / ONE_SECOND).toLocaleString() + "s"],
    ];

    for (const stat of FLOOR_FROM_DETAILS) {
        let hi = stat.startsWith(activeStyle) && (stat.includes("Accuracy") || stat.includes("MaxDamage"));
        tiles.push([STAT_LABELS[stat] || stat, Math.floor(cd[stat]).toLocaleString(), hi]);
    }
    for (const stat of FLOOR_FROM_COMBAT_STATS) {
        tiles.push([STAT_LABELS[stat] || stat, Math.floor(cs[stat])]);
    }
    for (const stat of PERCENT_FROM_COMBAT_STATS) {
        let value = (100 * cs[stat]).toLocaleString([], { minimumFractionDigits: 0, maximumFractionDigits: 4 });
        tiles.push([STAT_LABELS[stat] || stat, value + "%"]);
    }

    let html = '<div class="stat-grid">' + tiles.map(([label, value, hi]) =>
        `<div class="stat-tile${hi ? " highlight" : ""}"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(String(value))}</div></div>`
    ).join("") + "</div>";

    let abilityHtml = player.abilities.filter(Boolean).map((a) => abilityDetailHtml(a, t)).join("");
    html += `<h4 style="margin-top:12px;">${escapeHtml(t("abilities"))}</h4>` +
        (abilityHtml || `<div class="empty">${escapeHtml(t("noAbilities"))}</div>`);

    container.innerHTML = html;
}
