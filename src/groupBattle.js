import Player from "./combatsimulator/player.js";
import Ability from "./combatsimulator/ability.js";
import Zone from "./combatsimulator/zone.js";
import itemDetailMap from "./combatsimulator/data/itemDetailMap.json";
import abilityDetailMap from "./combatsimulator/data/abilityDetailMap.json";
import combatTriggerDependencyDetailMap from "./combatsimulator/data/combatTriggerDependencyDetailMap.json";
import combatTriggerConditionDetailMap from "./combatsimulator/data/combatTriggerConditionDetailMap.json";
import combatTriggerComparatorDetailMap from "./combatsimulator/data/combatTriggerComparatorDetailMap.json";
import trialMonsterPresets from "./combatsimulator/data/trialMonsterPresets.js";
import { deriveTrialMonsterStats } from "./combatsimulator/trialMonsterScaling.js";
import { t, onLanguageChange } from "./groupBattleI18nSetup.js";
import rangerExport from "./combatsimulator/data/testPlayers/ranger.json";
import healerExport from "./combatsimulator/data/testPlayers/healer.json";
import tankExport from "./combatsimulator/data/testPlayers/tank.json";
import smashExport from "./combatsimulator/data/testPlayers/smash.json";
import GROUP_BATTLE_REGEN_BUFFS from "./combatsimulator/data/groupBattleBuffs";

const ONE_SECOND = 1e9;
const PRESET_STORAGE_KEY = "mwiGroupBattleMonsterPresets";

let worker = new Worker(new URL("worker.js", import.meta.url));

// Imported players: array of { name, dto }
let importedPlayers = [];
// Enemy group: array of custom monster specs (spec objects).
let enemyGroup = [];
// Saved monster presets: array of spec objects.
let presets = [];
// Index of the preset currently loaded in the editor, or -1 for a new one.
let editingPresetIndex = -1;

// ------------------------------------------------------------------ Import ---

// Convert one "solo export" JSON object (the format produced by the main app's
// Import/Export -> Solo export) into a Player.createFromDTO-compatible DTO.
function soloExportToDTO(exp, hrid) {
    const equipmentTypes = [
        "head", "body", "legs", "feet", "hands", "main_hand", "two_hand",
        "off_hand", "pouch", "neck", "earrings", "ring", "back",
    ];

    let equipment = {};
    for (const type of equipmentTypes) {
        let match = (exp.player.equipment || []).find(
            (item) => item.itemLocationHrid === "/item_locations/" + type
        );
        // Skip unknown/invalid item hrids so a bad export doesn't break the whole import.
        equipment["/equipment_types/" + type] =
            match && match.itemHrid && itemDetailMap[match.itemHrid]
                ? { hrid: match.itemHrid, enhancementLevel: Number(match.enhancementLevel) || 0 }
                : null;
    }

    const triggerMap = exp.triggerMap || {};

    // Per user requirement: group battles assume no food or drink for any player.
    let food = [null, null, null];
    let drinks = [null, null, null];

    let abilities = [0, 1, 2, 3, 4].map((i) => {
        let entry = (exp.abilities || [])[i];
        if (!entry || !entry.abilityHrid) return null;
        try {
            return buildAbilityDTO(entry.abilityHrid, Number(entry.level) || 1, triggerMap[entry.abilityHrid]);
        } catch (e) {
            return null;
        }
    });

    // houseRooms: createFromDTO expects an object of hrid -> level
    let houseRooms = exp.houseRooms || {};

    let p = exp.player;

    return {
        hrid: hrid,
        staminaLevel: Number(p.staminaLevel) || 1,
        intelligenceLevel: Number(p.intelligenceLevel) || 1,
        attackLevel: Number(p.attackLevel) || 1,
        meleeLevel: Number(p.meleeLevel) || 1,
        defenseLevel: Number(p.defenseLevel) || 1,
        rangedLevel: Number(p.rangedLevel) || 1,
        magicLevel: Number(p.magicLevel) || 1,
        equipment: equipment,
        food: food,
        drinks: drinks,
        abilities: abilities,
        houseRooms: houseRooms,
        achievements: exp.achievements || {},
        debuffOnLevelGap: Number(exp.debuffOnLevelGap) || 0,
    };
}

function buildAbilityDTO(hrid, level, triggers) {
    let ability = new Ability(hrid, level, triggers);
    return { hrid: ability.hrid, level: ability.level, triggers: ability.triggers };
}

// Accepts: a JSON array of export objects/strings, OR newline-separated export
// strings, OR the "group" export (an object keyed "1".."5").
function parseImport(text) {
    text = text.trim();
    if (!text) return [];

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        // Fall back to newline-separated JSON strings.
        let lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
        return lines.map((line) => JSON.parse(line));
    }

    let exports = [];
    if (Array.isArray(parsed)) {
        exports = parsed;
    } else if (parsed.player) {
        // A single solo export object.
        exports = [parsed];
    } else {
        // Group export: object keyed by player number, values are JSON strings or objects.
        exports = Object.values(parsed);
    }

    return exports.map((e) => (typeof e === "string" ? JSON.parse(e) : e));
}

function doImport(append) {
    const textarea = document.getElementById("importText");
    let exports;
    try {
        exports = parseImport(textarea.value);
    } catch (e) {
        showError(t("couldNotParseImport", { msg: e.message }));
        return;
    }

    if (!exports.length) {
        showError(t("noPlayerDataFound"));
        return;
    }

    if (!append) {
        importedPlayers = [];
    }

    let errors = [];
    exports.forEach((exp, idx) => {
        try {
            if (!exp || !exp.player) {
                throw new Error("missing 'player' field");
            }
            let index = importedPlayers.length + 1;
            let hrid = "player" + index;
            let dto = soloExportToDTO(exp, hrid);
            let name = exp.name || (t("player") + " " + index);
            importedPlayers.push({ name, dto });
        } catch (e) {
            errors.push("Entry " + (idx + 1) + ": " + e.message);
        }
    });

    renderPlayerList();
    if (errors.length) {
        showError(t("importedWithErrors", { count: errors.length, errors: errors.join("\n") }));
    } else {
        clearError();
        textarea.value = "";
    }
    document.getElementById("playerList").scrollIntoView({ behavior: "smooth", block: "center" });
}

// Built-in test rosters (one export each), by role. Food/drinks are always
// stripped by soloExportToDTO regardless of what the source export contains.
const TEST_ROLE_EXPORTS = [
    { key: "Ranger", inputId: "testCountRanger", export: rangerExport },
    { key: "Healer", inputId: "testCountHealer", export: healerExport },
    { key: "Tank", inputId: "testCountTank", export: tankExport },
    { key: "Smash", inputId: "testCountSmash", export: smashExport },
];

function doTestImport() {
    importedPlayers = [];

    let errors = [];
    for (const role of TEST_ROLE_EXPORTS) {
        let count = Math.max(0, Number(document.getElementById(role.inputId).value) || 0);
        for (let i = 1; i <= count; i++) {
            try {
                let index = importedPlayers.length + 1;
                let hrid = "player" + index;
                let dto = soloExportToDTO(role.export, hrid);
                importedPlayers.push({ name: role.key + " " + i, dto });
            } catch (e) {
                errors.push(role.key + " " + i + ": " + e.message);
            }
        }
    }

    renderPlayerList();
    if (errors.length) {
        showError(t("importedWithErrors", { count: errors.length, errors: errors.join("\n") }));
    } else {
        clearError();
    }
    document.getElementById("playerList").scrollIntoView({ behavior: "smooth", block: "center" });
}

// Prefer the game's real translated item/ability name (i18next, loaded by
// js/i18n.js) when available, falling back to the English detail map name.
function itemName(hrid) {
    if (typeof i18next !== "undefined" && i18next.exists("itemNames." + hrid)) {
        return i18next.t("itemNames." + hrid);
    }
    return itemDetailMap[hrid] ? itemDetailMap[hrid].name : hrid.split("/").pop();
}
function abilityName(hrid) {
    if (typeof i18next !== "undefined" && i18next.exists("abilityNames." + hrid)) {
        return i18next.t("abilityNames." + hrid);
    }
    return abilityDetailMap[hrid] ? abilityDetailMap[hrid].name : hrid.split("/").pop();
}
function skillName(skillHrid) {
    if (typeof i18next !== "undefined" && i18next.exists("skillNames." + skillHrid)) {
        return i18next.t("skillNames." + skillHrid);
    }
    return skillHrid.split("/").pop();
}
function combatStyleName(hrid) {
    if (!hrid) return "";
    if (typeof i18next !== "undefined" && i18next.exists("combatStyleNames." + hrid)) {
        return i18next.t("combatStyleNames." + hrid);
    }
    return hrid.split("/").pop();
}
function damageTypeName(hrid) {
    if (!hrid) return "";
    if (typeof i18next !== "undefined" && i18next.exists("damageTypeNames." + hrid)) {
        return i18next.t("damageTypeNames." + hrid);
    }
    return hrid.split("/").pop();
}
function equipSlotName(slot) {
    // Matches js/i18n.js's characterItemsUtil camelCase keys; two_hand has no
    // dedicated translation in the game data, so it falls back to main_hand's.
    const camel = { main_hand: "mainHand", two_hand: "mainHand", off_hand: "offHand" }[slot]
        || slot.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (typeof i18next !== "undefined" && i18next.exists("characterItemsUtil." + camel)) {
        return i18next.t("characterItemsUtil." + camel);
    }
    return slot.replace(/_/g, " ");
}

const EQUIP_SLOT_ORDER = [
    "main_hand", "two_hand", "off_hand",
    "head", "body", "legs", "feet",
    "hands", "neck", "earrings", "ring",
    "pouch", "back",
];

function playerDetailHtml(d) {
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

    // Abilities
    let abilityItems = (d.abilities || [])
        .filter(Boolean)
        .map((a) => `<li>${escapeHtml(abilityName(a.hrid))} <span class="dim">L${a.level}</span></li>`);
    let abilityHtml = abilityItems.length
        ? `<ul class="detail-abilities">${abilityItems.join("")}</ul>`
        : `<div class="empty">${escapeHtml(t("noAbilities"))}</div>`;

    return `<div class="detail-body">
        ${skillHtml}
        <div class="detail-cols">
            <div><h5>${escapeHtml(t("equipment"))}</h5>${equipHtml}</div>
            <div><h5>${escapeHtml(t("abilities"))}</h5>${abilityHtml}</div>
        </div>
        <div class="row" style="margin-top:10px;">
            <button class="secondary show-status-btn">Show Detailed Combat Status</button>
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

function abilityDetailHtml(ability) {
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
// including the group-battle +3% HP/MP regen buff) and renders its fully
// computed combat stats + per-ability cooldown/mana/trigger info, so you can
// verify the sim's actual decision inputs rather than guessing from the log.
function renderDetailedStatus(container, dto) {
    let zone = new Zone("/actions/combat/fly");
    let player = Player.createFromDTO(structuredClone(dto));
    player.zoneBuffs = zone.buffs;
    player.extraBuffs = GROUP_BATTLE_REGEN_BUFFS;
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

    let abilityHtml = player.abilities.filter(Boolean).map(abilityDetailHtml).join("");
    html += `<h4 style="margin-top:12px;">${escapeHtml(t("abilities"))}</h4>` +
        (abilityHtml || `<div class="empty">${escapeHtml(t("noAbilities"))}</div>`);

    container.innerHTML = html;
}

// Re-renders anything whose displayed monster HP depends on the current
// player count (enemy group table already added, and any open preview).
function refreshHpDependentViews() {
    if (enemyGroup.length) {
        renderEnemyGroup();
    }
    if (document.getElementById("enemyPreviewPanel").style.display !== "none") {
        renderEnemyPreview();
    }
    if (selectedTrialMonsterIndex != null && document.getElementById("trialStatusPreview")) {
        renderTrialPreview();
    }
}

function renderPlayerList() {
    const container = document.getElementById("playerList");
    document.getElementById("playerCount").textContent = importedPlayers.length;

    // Enemy HP scales with player count - refresh anything showing it.
    refreshHpDependentViews();

    if (!importedPlayers.length) {
        container.innerHTML = '<div class="empty">No players imported yet.</div>';
        return;
    }

    let html = "";
    importedPlayers.forEach((p, i) => {
        let d = p.dto;
        let style = "unarmed";
        let main = d.equipment["/equipment_types/main_hand"] || d.equipment["/equipment_types/two_hand"];
        if (main) style = itemName(main.hrid);
        html += `<div class="player-card">
            <div class="player-head">
                <button class="expand-btn" data-expand="${i}" aria-label="expand">▸</button>
                <span class="pnum">${i + 1}</span>
                <input class="name-edit" data-i="${i}" value="${escapeHtml(p.name)}" />
                <span class="dim">${escapeHtml(style)}</span>
                <button class="btn-x" data-remove="${i}">x</button>
            </div>
            <div class="player-detail" id="pdetail-${i}" style="display:none;" data-player-index="${i}">${playerDetailHtml(d)}</div>
        </div>`;
    });
    container.innerHTML = html;

    container.querySelectorAll("[data-remove]").forEach((btn) => {
        btn.addEventListener("click", () => {
            importedPlayers.splice(Number(btn.dataset.remove), 1);
            reindexPlayers();
            renderPlayerList();
        });
    });
    container.querySelectorAll(".name-edit").forEach((inp) => {
        inp.addEventListener("change", () => {
            importedPlayers[Number(inp.dataset.i)].name = inp.value;
        });
    });
    container.querySelectorAll(".show-status-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            let playerDetail = btn.closest(".player-detail");
            let idx = Number(playerDetail.dataset.playerIndex);
            let statusEl = playerDetail.querySelector(".detailed-status");
            let open = statusEl.style.display !== "none";
            if (open) {
                statusEl.style.display = "none";
                btn.textContent = "Show Detailed Combat Status";
            } else {
                renderDetailedStatus(statusEl, importedPlayers[idx].dto);
                statusEl.style.display = "block";
                btn.textContent = "Hide Detailed Combat Status";
            }
        });
    });
    container.querySelectorAll("[data-expand]").forEach((btn) => {
        btn.addEventListener("click", () => {
            let detail = document.getElementById("pdetail-" + btn.dataset.expand);
            let open = detail.style.display !== "none";
            detail.style.display = open ? "none" : "block";
            btn.textContent = open ? "▸" : "▾";
        });
    });
}

function reindexPlayers() {
    importedPlayers.forEach((p, i) => {
        p.dto.hrid = "player" + (i + 1);
    });
}

// ------------------------------------------------------------------- Enemies -

// Refresh the "add enemy" dropdown from saved presets.
// The enemy dropdown lists every Trial Monster preset, then every custom preset,
// each option value tagged "trial:<i>" or "custom:<i>" so addEnemy() knows which
// list + whether a level applies.
function refreshEnemySelect() {
    const select = document.getElementById("enemySelect");
    select.innerHTML = "";

    trialMonsterPresets.forEach((m, i) => {
        let opt = document.createElement("option");
        opt.value = "trial:" + i;
        opt.textContent = m.name;
        select.appendChild(opt);
    });

    presets.forEach((p, i) => {
        let opt = document.createElement("option");
        opt.value = "custom:" + i;
        opt.textContent = p.name + " (" + t("custom") + ")";
        select.appendChild(opt);
    });

    syncEnemyLevelSelect();
}

function initEnemyLevelSelect() {
    const select = document.getElementById("enemyLevelSelect");
    select.innerHTML = "";
    for (let lvl = 100; lvl <= 300; lvl += 10) {
        let opt = document.createElement("option");
        opt.value = String(lvl);
        opt.textContent = "L" + lvl + " (T" + ((lvl - 100) / 10 + 1) + ")";
        select.appendChild(opt);
    }
}

// Enables/disables the level dropdown depending on whether the selected monster
// is a level-scaled Trial Monster or a fixed-stat custom preset.
function syncEnemyLevelSelect() {
    const enemySelect = document.getElementById("enemySelect");
    const levelSelect = document.getElementById("enemyLevelSelect");
    const isTrial = (enemySelect.value || "").startsWith("trial:");
    levelSelect.disabled = !isTrial;
    levelSelect.style.opacity = isTrial ? "1" : "0.5";
}

// Resolves the currently selected #enemySelect option into a monster spec.
// Returns null (and shows an error) if nothing usable is selected. Shared by
// addEnemy() and the enemy preview panel so both stay in sync.
function resolveSelectedEnemySpec() {
    const value = document.getElementById("enemySelect").value;
    if (!value) {
        showError(t("selectMonsterFirst"));
        return null;
    }

    const [kind, idxStr] = value.split(":");
    const idx = Number(idxStr);

    if (kind === "trial") {
        const m = trialMonsterPresets[idx];
        if (!m) { showError(t("unknownTrialMonster")); return null; }
        const level = Number(document.getElementById("enemyLevelSelect").value) || 100;
        return Object.assign({ scaling: true, level }, m);
    }
    const p = presets[idx];
    if (!p) { showError(t("unknownCustomPreset")); return null; }
    return p;
}

function addEnemy() {
    const count = Math.max(1, Number(document.getElementById("enemyCountToAdd").value) || 1);
    const spec = resolveSelectedEnemySpec();
    if (!spec) return;

    for (let i = 0; i < count; i++) {
        if (enemyGroup.length >= 20) {
            showError(t("maxEnemiesError"));
            break;
        }
        enemyGroup.push(structuredClone(spec));
    }
    renderEnemyGroup();
}

function enemyMaxHp(e) {
    let base = e.scaling ? deriveTrialMonsterStats(e, e.level ?? 100).maxHitpoints : e.maxHitpoints;
    return base * groupHpMultiplier();
}

// Renders the full stat preview for the currently selected #enemySelect
// monster (trial or custom) into the Build Enemy Group panel.
function renderEnemyPreview() {
    const spec = resolveSelectedEnemySpec();
    const panel = document.getElementById("enemyPreviewPanel");
    if (!spec) {
        panel.style.display = "none";
        return;
    }

    const hpMult = groupHpMultiplier();
    const styles = ["stab", "slash", "smash", "ranged", "magic"];
    let tiles = [];
    let levelsHtml = "";
    let abilitiesHtml = "";

    if (spec.scaling) {
        const level = spec.level ?? 100;
        const derived = deriveTrialMonsterStats(spec, level);
        document.getElementById("enemyPreviewName").textContent = spec.name + " (L" + level + ")";

        tiles.push([t("combatStyle"), combatStyleName(spec.combatStyleHrid)]);
        tiles.push([t("damageType"), damageTypeName(spec.damageType)]);
        tiles.push([t("attackInterval"), spec.attackIntervalSeconds + "s"]);
        tiles.push([t("abilityHaste"), spec.abilityHaste]);
        if (spec.castSpeed) tiles.push([t("castSpeed"), (spec.castSpeed * 100) + "%"]);
        tiles.push([t("maxHitpoints") + ` (x${importedPlayers.length} players, +${((hpMult - 1) * 100).toFixed(0)}%)`, fmtNum(derived.maxHitpoints * hpMult), true]);
        tiles.push([t("maxManapoints"), fmtNum(derived.maxManapoints * hpMult)]);
        tiles.push([t("tenacity"), spec.tenacity]);
        tiles.push([t("threat"), 100]);
        tiles.push([t("armor"), Math.round(derived.totalArmor)]);
        tiles.push([t("waterResistance"), Math.round(derived.totalWaterResistance)]);
        tiles.push([t("natureResistance"), Math.round(derived.totalNatureResistance)]);
        tiles.push([t("fireResistance"), Math.round(derived.totalFireResistance)]);

        for (const style of styles) {
            if (spec.accuracyBonusPct && spec.accuracyBonusPct[style] != null) {
                let styleLabel = combatStyleName("/combat_styles/" + style);
                tiles.push([styleLabel + " " + t("accuracy"), Math.round(derived.accuracyRating[style]), true]);
                tiles.push([styleLabel + " " + t("maxDamage"), Math.round(derived.maxDamage[style]), true]);
            }
        }
        for (const style of styles) {
            let styleLabel = combatStyleName("/combat_styles/" + style);
            tiles.push([styleLabel + " " + t("evasion"), Math.round(derived.evasionRating[style])]);
        }

        levelsHtml = `<h4>Levels</h4><div class="detail-skills">${levelTilesHtml(derived.levels)}</div>`;
        if (spec.abilities && spec.abilities.length) {
            abilitiesHtml = `<h4>${escapeHtml(t("abilities"))}</h4><div class="detail-skills">` +
                spec.abilities.map((a) => `<span class="chip">${escapeHtml(a.name)} <span class="dim">L${a.baseLevel}</span></span>`).join("") +
                "</div>";
        }
    } else {
        document.getElementById("enemyPreviewName").textContent = spec.name || t("custom");

        tiles.push([t("combatStyle"), combatStyleName(spec.combatStyleHrid)]);
        tiles.push([t("damageType"), damageTypeName(spec.damageType)]);
        tiles.push([t("attackInterval"), (spec.attackIntervalSeconds ?? 3) + "s"]);
        tiles.push([t("abilityHaste"), spec.abilityHaste ?? 0]);
        if (spec.castSpeed) tiles.push([t("castSpeed"), (spec.castSpeed * 100) + "%"]);
        tiles.push([t("maxHitpoints") + ` (x${importedPlayers.length} players, +${((hpMult - 1) * 100).toFixed(0)}%)`, fmtNum((spec.maxHitpoints ?? 110) * hpMult), true]);
        tiles.push([t("maxManapoints"), fmtNum((spec.maxManapoints ?? 110) * hpMult)]);
        tiles.push([t("tenacity"), spec.tenacity ?? 0]);
        tiles.push([t("threat"), spec.threat ?? 100]);
        tiles.push([t("armor"), Math.round(spec.totalArmor ?? 0)]);
        tiles.push([t("waterResistance"), Math.round(spec.totalWaterResistance ?? 0)]);
        tiles.push([t("natureResistance"), Math.round(spec.totalNatureResistance ?? 0)]);
        tiles.push([t("fireResistance"), Math.round(spec.totalFireResistance ?? 0)]);

        let activeStyle = (spec.combatStyleHrid || "/combat_styles/smash").split("/").pop();
        let styleLabel = combatStyleName(spec.combatStyleHrid);
        tiles.push([styleLabel + " " + t("accuracy"), spec.accuracyRating ?? 10, true]);
        tiles.push([styleLabel + " " + t("maxDamage"), spec.maxDamage ?? 10, true]);

        tiles.push([t("stabEvasion"), spec.stabEvasion ?? 10]);
        tiles.push([t("slashEvasion"), spec.slashEvasion ?? 10]);
        tiles.push([t("smashEvasion"), spec.smashEvasion ?? 10]);
        tiles.push([t("rangedEvasion"), spec.rangedEvasion ?? 10]);
        tiles.push([t("magicEvasion"), spec.magicEvasion ?? 10]);
    }

    let html = '<div class="stat-grid">' + tiles.map(([label, value, hi]) =>
        `<div class="stat-tile${hi ? " highlight" : ""}"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(String(value))}</div></div>`
    ).join("") + "</div>" + levelsHtml + abilitiesHtml;

    document.getElementById("enemyPreviewStats").innerHTML = html;
    panel.style.display = "block";
    clearError();
}

function renderEnemyGroup() {
    const container = document.getElementById("enemyGroup");
    if (!enemyGroup.length) {
        container.innerHTML = `<div class="empty">${escapeHtml(t("noEnemiesAdded"))}</div>`;
        return;
    }
    let html = `<table class="tbl"><thead><tr><th>#</th><th>${escapeHtml(t("monster"))}</th><th>${escapeHtml(t("style"))}</th><th>${escapeHtml(t("level"))}</th><th>${escapeHtml(t("hp"))}</th><th></th></tr></thead><tbody>`;
    enemyGroup.forEach((e, i) => {
        let style = combatStyleName(e.combatStyleHrid);
        html += `<tr><td>${i + 1}</td><td>${escapeHtml(e.name || t("custom"))}</td><td>${escapeHtml(style)}</td>
            <td>${e.scaling ? (e.level ?? 100) : "-"}</td>
            <td>${fmtNum(enemyMaxHp(e))}</td>
            <td><button class="btn-x" data-removeenemy="${i}">x</button></td></tr>`;
    });
    html += "</tbody></table>";
    container.innerHTML = html;

    container.querySelectorAll("[data-removeenemy]").forEach((btn) => {
        btn.addEventListener("click", () => {
            enemyGroup.splice(Number(btn.dataset.removeenemy), 1);
            renderEnemyGroup();
        });
    });
}

// ------------------------------------------------------------- Trial Monsters -

let selectedTrialMonsterIndex = 0;

function renderTrialMonsterList() {
    const container = document.getElementById("trialMonsterList");
    let html = "";
    trialMonsterPresets.forEach((m, i) => {
        html += `<div class="trial-card ${i === selectedTrialMonsterIndex ? "active" : ""}" data-trial="${i}">
            <div class="tm-name">${escapeHtml(m.name)}</div>
            <div class="tm-meta">${escapeHtml(combatStyleName(m.combatStyleHrid))} · ${escapeHtml(damageTypeName(m.damageType))}${m.spawnCount > 1 ? " · x" + m.spawnCount + " " + escapeHtml(t("perEncounter")) : ""}</div>
        </div>`;
    });
    container.innerHTML = html;
    container.querySelectorAll("[data-trial]").forEach((el) => {
        el.addEventListener("click", () => {
            selectedTrialMonsterIndex = Number(el.dataset.trial);
            renderTrialMonsterList();
            renderTrialPreview();
        });
    });
}

const LEVEL_SKILL_ORDER = ["stamina", "intelligence", "attack", "melee", "defense", "ranged", "magic"];

function levelTilesHtml(levels) {
    return LEVEL_SKILL_ORDER
        .map((k) => `<span class="chip">${escapeHtml(skillName("/skills/" + k))} <span class="dim">${levels[k]}</span></span>`)
        .join("");
}

function initTrialLevelSelect() {
    const select = document.getElementById("trialLevel");
    select.innerHTML = "";
    for (let lvl = 100; lvl <= 300; lvl += 10) {
        let opt = document.createElement("option");
        opt.value = String(lvl);
        opt.textContent = "L" + lvl + " (T" + ((lvl - 100) / 10 + 1) + ")";
        select.appendChild(opt);
    }
}

// Monster HP scales +1% per player currently imported (see worker.js's
// start_battle handler, which applies the same formula with the real battle
// roster). Previews use the current import count so the number shown matches
// what a battle would actually run with.
function groupHpMultiplier() {
    return 1 + 0.01 * importedPlayers.length;
}

function renderTrialPreview() {
    const m = trialMonsterPresets[selectedTrialMonsterIndex];
    const level = Number(document.getElementById("trialLevel").value) || 100;
    const derived = deriveTrialMonsterStats(m, level);
    const hpMult = groupHpMultiplier();

    document.getElementById("trialPreviewName").textContent = m.name + " (L" + level + ")";
    // weakPoints is free-form gameplay-tip text authored only in English in
    // trialMonsterPresets.js; not translated (would need its own CN copy).
    document.getElementById("trialWeakPoints").textContent = m.weakPoints || "";

    let styles = ["stab", "slash", "smash", "ranged", "magic"];

    let tiles = [];
    tiles.push([t("combatStyle"), combatStyleName(m.combatStyleHrid)]);
    tiles.push([t("damageType"), damageTypeName(m.damageType)]);
    tiles.push([t("attackInterval"), m.attackIntervalSeconds + "s"]);
    tiles.push([t("abilityHaste"), m.abilityHaste]);
    if (m.castSpeed) tiles.push([t("castSpeed"), (m.castSpeed * 100) + "%"]);
    tiles.push([t("maxHitpoints") + ` (x${importedPlayers.length} players, +${((hpMult - 1) * 100).toFixed(0)}%)`, fmtNum(derived.maxHitpoints * hpMult), true]);
    tiles.push([t("maxManapoints"), fmtNum(derived.maxManapoints * hpMult)]);
    tiles.push([t("tenacity"), m.tenacity]);
    tiles.push([t("threat"), 100]);
    tiles.push([t("armor"), Math.round(derived.totalArmor)]);
    tiles.push([t("waterResistance"), Math.round(derived.totalWaterResistance)]);
    tiles.push([t("natureResistance"), Math.round(derived.totalNatureResistance)]);
    tiles.push([t("fireResistance"), Math.round(derived.totalFireResistance)]);

    for (const style of styles) {
        if (m.accuracyBonusPct && m.accuracyBonusPct[style] != null) {
            let styleLabel = combatStyleName("/combat_styles/" + style);
            tiles.push([styleLabel + " " + t("accuracy"), Math.round(derived.accuracyRating[style]), true]);
            tiles.push([styleLabel + " " + t("maxDamage"), Math.round(derived.maxDamage[style]), true]);
        }
    }
    for (const style of styles) {
        let styleLabel = combatStyleName("/combat_styles/" + style);
        tiles.push([styleLabel + " " + t("evasion"), Math.round(derived.evasionRating[style])]);
    }

    let html = '<div class="stat-grid">' + tiles.map(([label, value, hi]) =>
        `<div class="stat-tile${hi ? " highlight" : ""}"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(String(value))}</div></div>`
    ).join("") + "</div>";

    html += `<h4>Levels</h4><div class="detail-skills">` + levelTilesHtml(derived.levels) + "</div>";

    if (m.abilities && m.abilities.length) {
        html += `<h4>${escapeHtml(t("abilities"))}</h4><div class="detail-skills">` +
            m.abilities.map((a) => `<span class="chip">${escapeHtml(a.name)} <span class="dim">L${a.baseLevel}</span></span>`).join("") +
            "</div>";
    }

    document.getElementById("trialStatusPreview").innerHTML = html;
}

// Shortcut from the Presets tab preview: mirror the current selection into the
// Battle tab's unified enemy selector, then reuse addEnemy() so there is one
// code path for adding enemies to the group.
function addTrialMonsterToGroup() {
    const level = Number(document.getElementById("trialLevel").value) || 100;
    const count = Math.max(1, Number(document.getElementById("trialCountToAdd").value) || 1);

    document.getElementById("enemySelect").value = "trial:" + selectedTrialMonsterIndex;
    document.getElementById("enemyLevelSelect").value = String(level);
    document.getElementById("enemyCountToAdd").value = String(count);
    syncEnemyLevelSelect();

    addEnemy();
    switchTab("battleTab");
    document.getElementById("enemyGroup").scrollIntoView({ behavior: "smooth", block: "center" });
}

// ------------------------------------------------------------------- Presets -

function loadPresets() {
    try {
        let raw = localStorage.getItem(PRESET_STORAGE_KEY);
        presets = raw ? JSON.parse(raw) : [];
    } catch (e) {
        presets = [];
    }
}

function savePresetsToStorage() {
    try {
        localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
    } catch (e) {
        showError(t("couldNotSavePresets", { msg: e.message }));
    }
}

function renderPresetList() {
    document.getElementById("presetCount").textContent = presets.length;
    const container = document.getElementById("presetList");
    if (!presets.length) {
        container.innerHTML = `<div class="empty">${escapeHtml(t("noPresetsYet"))}</div>`;
        return;
    }
    let html = `<table class="tbl"><thead><tr><th>${escapeHtml(t("name"))}</th><th>${escapeHtml(t("combatStyle"))}</th><th>${escapeHtml(t("hp"))}</th><th>${escapeHtml(t("attackInterval"))}</th><th></th><th></th></tr></thead><tbody>`;
    presets.forEach((p, i) => {
        html += `<tr>
            <td>${escapeHtml(p.name)}</td>
            <td>${escapeHtml(combatStyleName(p.combatStyleHrid))}</td>
            <td>${fmtNum(p.maxHitpoints)}</td>
            <td>${(p.attackIntervalSeconds ?? 3)}s</td>
            <td><button class="secondary" data-editpreset="${i}">${escapeHtml(t("edit"))}</button></td>
            <td><button class="btn-x" data-delpreset="${i}">x</button></td>
        </tr>`;
    });
    html += "</tbody></table>";
    container.innerHTML = html;

    container.querySelectorAll("[data-editpreset]").forEach((btn) => {
        btn.addEventListener("click", () => loadPresetIntoEditor(Number(btn.dataset.editpreset)));
    });
    container.querySelectorAll("[data-delpreset]").forEach((btn) => {
        btn.addEventListener("click", () => {
            presets.splice(Number(btn.dataset.delpreset), 1);
            savePresetsToStorage();
            renderPresetList();
            refreshEnemySelect();
        });
    });
}

// Map preset spec <-> editor form fields.
const EDITOR_NUM_FIELDS = [
    "abilityHaste", "accuracyRating", "maxDamage", "maxHitpoints", "maxManapoints",
    "stabEvasion", "slashEvasion", "smashEvasion", "rangedEvasion", "magicEvasion",
    "totalArmor", "totalWaterResistance", "totalNatureResistance", "totalFireResistance",
    "tenacity", "threat",
];

function readEditor() {
    let spec = {
        name: document.getElementById("f_name").value.trim() || "Custom Monster",
        combatStyleHrid: document.getElementById("f_combatStyleHrid").value,
        damageType: document.getElementById("f_damageType").value,
        attackIntervalSeconds: Number(document.getElementById("f_attackIntervalSeconds").value) || 3,
        // Cast speed is shown as a percentage in the UI; store as a ratio.
        castSpeed: (Number(document.getElementById("f_castSpeed").value) || 0) / 100,
    };
    for (const f of EDITOR_NUM_FIELDS) {
        spec[f] = Number(document.getElementById("f_" + f).value) || 0;
    }
    return spec;
}

function loadPresetIntoEditor(index) {
    editingPresetIndex = index;
    let p = presets[index];
    fillEditor(p);
    switchTab("presetsTab");
    setPresetStatus(t("editingPreset", { name: p.name }));
}

function fillEditor(spec) {
    document.getElementById("f_name").value = spec.name || "";
    document.getElementById("f_combatStyleHrid").value = spec.combatStyleHrid || "/combat_styles/smash";
    document.getElementById("f_damageType").value = spec.damageType || "/damage_types/physical";
    document.getElementById("f_attackIntervalSeconds").value = spec.attackIntervalSeconds ?? 3;
    document.getElementById("f_castSpeed").value = ((spec.castSpeed ?? 0) * 100);
    for (const f of EDITOR_NUM_FIELDS) {
        document.getElementById("f_" + f).value = spec[f] ?? (f === "threat" ? 100 : 0);
    }
}

function clearEditor() {
    editingPresetIndex = -1;
    fillEditor({ name: "", threat: 100, attackIntervalSeconds: 3, maxHitpoints: 110, maxManapoints: 110 });
    setPresetStatus(t("newPreset"));
}

function savePreset() {
    let spec = readEditor();
    if (editingPresetIndex >= 0 && presets[editingPresetIndex]) {
        presets[editingPresetIndex] = spec;
    } else {
        presets.push(spec);
        editingPresetIndex = presets.length - 1;
    }
    savePresetsToStorage();
    renderPresetList();
    refreshEnemySelect();
    setPresetStatus(t("savedPreset", { name: spec.name }));
}

function setPresetStatus(msg) {
    document.getElementById("presetStatus").textContent = msg;
}

// Parse an in-game stat block (label: value per line) into a preset spec and
// fill the editor. Understands K/M suffixes and %.
function parseStatBlock(text) {
    let spec = { threat: 100, attackIntervalSeconds: 3, maxHitpoints: 110, maxManapoints: 110 };

    const num = (v) => {
        v = v.trim().replace(/,/g, "");
        let pct = v.endsWith("%");
        v = v.replace("%", "").replace(/s$/, "").trim();
        let mult = 1;
        if (/k$/i.test(v)) { mult = 1e3; v = v.slice(0, -1); }
        else if (/m$/i.test(v)) { mult = 1e6; v = v.slice(0, -1); }
        let n = parseFloat(v) * mult;
        return { n: isNaN(n) ? 0 : n, pct };
    };

    const styleMap = { ranged: "/combat_styles/ranged", magic: "/combat_styles/magic", smash: "/combat_styles/smash", slash: "/combat_styles/slash", stab: "/combat_styles/stab" };
    const dmgMap = { physical: "/damage_types/physical", water: "/damage_types/water", nature: "/damage_types/nature", fire: "/damage_types/fire" };

    let activeStyle = null;
    let accByStyle = {};
    let dmgByStyle = {};

    for (let line of text.split("\n")) {
        let idx = line.indexOf(":");
        if (idx < 0) continue;
        let label = line.slice(0, idx).trim().toLowerCase();
        let value = line.slice(idx + 1).trim();
        if (!value) continue;

        if (label === "combat style") { activeStyle = styleMap[value.trim().toLowerCase()] || null; if (activeStyle) spec.combatStyleHrid = activeStyle; continue; }
        if (label === "damage type") { spec.damageType = dmgMap[value.trim().toLowerCase()] || spec.damageType; continue; }
        if (label === "attack interval") { spec.attackIntervalSeconds = num(value).n; continue; }
        if (label === "cast speed") { let r = num(value); spec.castSpeed = r.pct ? r.n / 100 : r.n; continue; }
        if (label === "ability haste") { spec.abilityHaste = num(value).n; continue; }
        if (label === "max hitpoints") { spec.maxHitpoints = num(value).n; continue; }
        if (label === "max manapoints") { spec.maxManapoints = num(value).n; continue; }
        if (label === "armor") { spec.totalArmor = num(value).n; continue; }
        if (label === "water resistance") { spec.totalWaterResistance = num(value).n; continue; }
        if (label === "nature resistance") { spec.totalNatureResistance = num(value).n; continue; }
        if (label === "fire resistance") { spec.totalFireResistance = num(value).n; continue; }
        if (label === "tenacity") { spec.tenacity = num(value).n; continue; }
        if (label === "threat") { spec.threat = num(value).n; continue; }

        let evMatch = label.match(/^(stab|slash|smash|ranged|magic) evasion$/);
        if (evMatch) { spec[evMatch[1] + "Evasion"] = num(value).n; continue; }

        let accMatch = label.match(/^(stab|slash|smash|ranged|magic) accuracy$/);
        if (accMatch) { accByStyle[accMatch[1]] = num(value).n; continue; }

        let dmgMatch = label.match(/^(stab|slash|smash|ranged|magic) damage$/);
        if (dmgMatch) { dmgByStyle[dmgMatch[1]] = num(value).n; continue; }
        // "Defensive Damage" and anything else: ignored.
    }

    // Pick accuracy/max-damage for the active style (fall back to the only one present).
    let styleKey = (spec.combatStyleHrid || "").split("/").pop();
    spec.accuracyRating = accByStyle[styleKey] ?? Object.values(accByStyle)[0] ?? 10;
    spec.maxDamage = dmgByStyle[styleKey] ?? Object.values(dmgByStyle)[0] ?? 10;

    return spec;
}

function fmtNum(n) {
    if (n == null) return "-";
    if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 ? 1 : 0) + "K";
    return String(Math.round(n));
}

function switchTab(tabId) {
    document.querySelectorAll(".tabpanel").forEach((el) => {
        el.style.display = el.id === tabId ? "" : "none";
    });
    document.querySelectorAll(".tab").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.tab === tabId);
    });
}

// ----------------------------------------------------------------- Run battle

function runBattle() {
    clearError();
    if (!importedPlayers.length) {
        showError(t("importAtLeastOnePlayer"));
        return;
    }
    if (!enemyGroup.length) {
        showError(t("addAtLeastOneEnemy"));
        return;
    }

    let playersToSim = importedPlayers.map((p) => structuredClone(p.dto));
    let timeCapSeconds = Number(document.getElementById("timeCap").value) || 3600;

    // Remember display names keyed by hrid for the result view.
    window.__playerNames = {};
    importedPlayers.forEach((p) => (window.__playerNames[p.dto.hrid] = p.name));

    document.getElementById("runBattle").disabled = true;
    document.getElementById("battleStatus").textContent = t("simulating");

    // Each enemy entry is a custom monster spec; wrap so the worker builds a CustomMonster.
    // Give each a unique hrid so multiple copies are tracked separately.
    let enemies = enemyGroup.map((spec, i) => {
        let copy = structuredClone(spec);
        copy.hrid = "/custom_monsters/e" + (i + 1) + "_" + (spec.name || "custom").toLowerCase().replace(/[^a-z0-9]+/g, "_");
        return { custom: copy };
    });

    // Remember enemy display names keyed by hrid for the result view.
    window.__enemyNames = {};
    enemies.forEach((e) => (window.__enemyNames[e.custom.hrid] = e.custom.name));

    worker.postMessage({
        type: "start_battle",
        players: playersToSim,
        enemies: enemies,
        timeCapSeconds: timeCapSeconds,
    });
}

worker.onmessage = function (event) {
    switch (event.data.type) {
        case "battle_result":
            document.getElementById("runBattle").disabled = false;
            document.getElementById("battleStatus").textContent = "";
            renderResult(event.data.simResult);
            break;
        case "simulation_error":
            document.getElementById("runBattle").disabled = false;
            document.getElementById("battleStatus").textContent = "";
            showError(t("simulationErrorPrefix") + event.data.error);
            break;
    }
};

// ------------------------------------------------------------------- Results

function nameFor(hrid, isPlayer) {
    if (isPlayer && window.__playerNames && window.__playerNames[hrid]) {
        return window.__playerNames[hrid];
    }
    if (!isPlayer && window.__enemyNames && window.__enemyNames[hrid]) {
        return window.__enemyNames[hrid];
    }
    return hrid;
}

function fmtTime(ns) {
    let s = ns / ONE_SECOND;
    let m = Math.floor(s / 60);
    let rem = (s % 60).toFixed(1);
    return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

function renderResult(result, scrollTo = true) {
    const panel = document.getElementById("resultPanel");
    panel.style.display = "block";
    if (scrollTo) {
        panel.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    const outcomeLabels = {
        victory: `<span class="outcome win">${escapeHtml(t("outcomeVictory"))}</span>`,
        defeat: `<span class="outcome lose">${escapeHtml(t("outcomeDefeat"))}</span>`,
        timeout: `<span class="outcome draw">${escapeHtml(t("outcomeTimeout"))}</span>`,
        ended: `<span class="outcome draw">${escapeHtml(t("outcomeEnded"))}</span>`,
    };

    let summary = `<div class="summary-row">${outcomeLabels[result.battleOutcome] || result.battleOutcome}</div>`;
    summary += `<div class="summary-row"><b>${escapeHtml(t("battleDuration"))}</b> ${fmtTime(result.battleDurationNs)}</div>`;

    // Player final states
    summary += `<div class="final-states"><h4>${escapeHtml(t("players"))}</h4><table class="tbl"><thead><tr><th>${escapeHtml(t("name"))}</th><th>${escapeHtml(t("hp"))}</th><th>${escapeHtml(t("mp"))}</th><th>${escapeHtml(t("deaths"))}</th></tr></thead><tbody>`;
    for (const ps of result.playerFinalState || []) {
        let deaths = (result.deaths && result.deaths[ps.hrid]) || 0;
        let dead = ps.currentHitpoints <= 0;
        summary += `<tr class="${dead ? "dead" : ""}">
            <td>${escapeHtml(nameFor(ps.hrid, true))}</td>
            <td>${Math.round(ps.currentHitpoints)}/${ps.maxHitpoints}</td>
            <td>${Math.round(ps.currentManapoints)}/${ps.maxManapoints}</td>
            <td>${deaths}</td></tr>`;
    }
    summary += "</tbody></table></div>";

    summary += `<div class="final-states"><h4>${escapeHtml(t("enemies"))}</h4><table class="tbl"><thead><tr><th>${escapeHtml(t("name"))}</th><th>${escapeHtml(t("hp"))}</th></tr></thead><tbody>`;
    for (const es of result.enemyFinalState || []) {
        let dead = es.currentHitpoints <= 0;
        summary += `<tr class="${dead ? "dead" : ""}">
            <td>${escapeHtml(nameFor(es.hrid, false))}</td>
            <td>${Math.round(es.currentHitpoints)}/${es.maxHitpoints}</td></tr>`;
    }
    summary += "</tbody></table></div>";

    document.getElementById("resultSummary").innerHTML = summary;

    // Damage totals (per source) and damage taken (per target/player)
    renderDamageTotals(result);
    renderDamageTaken(result);

    // Combat log
    window.__battleLog = result.battleLog || [];
    window.__lastBattleResult = result;
    renderLog();
}

// Shared aggregator: groups attack log entries by a top-level key (source for
// Damage Done, target for Damage Taken) and, within each, by ability - so both
// tables can offer the same "click a row to see the breakdown" behavior.
function aggregateAttacks(battleLog, groupBy) {
    let groups = {};
    for (const entry of battleLog || []) {
        if (entry.kind !== "attack") continue;
        let isHit = typeof entry.hit === "number";
        let hrid = groupBy === "source" ? entry.source : entry.target;
        let isPlayer = groupBy === "source" ? entry.sourceIsPlayer : entry.targetIsPlayer;
        let key = hrid + "|" + isPlayer;

        if (!groups[key]) {
            groups[key] = { name: nameFor(hrid, isPlayer), isPlayer, dmg: 0, hits: 0, misses: 0, byAbility: {} };
        }
        let g = groups[key];
        if (isHit) { g.dmg += entry.hit; g.hits += 1; } else { g.misses += 1; }

        let abilityKey = entry.ability;
        if (!g.byAbility[abilityKey]) {
            g.byAbility[abilityKey] = { name: abilityOrItemName(abilityKey), dmg: 0, hits: 0, misses: 0 };
        }
        let a = g.byAbility[abilityKey];
        if (isHit) { a.dmg += entry.hit; a.hits += 1; } else { a.misses += 1; }
    }
    return groups;
}

function accuracyPct(hits, misses) {
    let total = hits + misses;
    return total > 0 ? Math.round(100 * hits / total) : 0;
}

// Renders an expandable damage table. rowIdPrefix must be unique per table
// instance (e.g. "dmgdone", "dmgtaken") so both tables can be open at once.
function renderExpandableDamageTable(containerId, titleKey, groups, dur, rowIdPrefix) {
    let rows = Object.values(groups).sort((a, b) => b.dmg - a.dmg);
    let html = `<h4>${escapeHtml(t(titleKey))}</h4><table class="tbl"><thead><tr>
        <th>${escapeHtml(t("source"))}</th><th>${escapeHtml(t("totalDmg"))}</th>
        <th>${escapeHtml(t("hits"))}</th><th>${escapeHtml(t("accuracy"))}</th><th>${escapeHtml(t("dps"))}</th>
    </tr></thead><tbody>`;

    rows.forEach((r, i) => {
        let rowId = rowIdPrefix + i;
        let acc = accuracyPct(r.hits, r.misses);
        html += `<tr class="expandable ${r.isPlayer ? "src-player" : "src-enemy"}" data-detail-toggle="${rowId}">
            <td>${escapeHtml(r.name)}</td><td>${Math.round(r.dmg).toLocaleString()}</td>
            <td>${r.hits}</td><td>${acc}%</td><td>${(r.dmg / dur).toFixed(1)}</td></tr>`;

        let abilityRows = Object.values(r.byAbility).sort((a, b) => b.dmg - a.dmg);
        html += `<tr class="detail-row" id="detailrow-${rowId}" style="display:none;"><td colspan="5"><div class="detail-inner">
            <table class="sub-tbl"><thead><tr>
                <th>${escapeHtml(t("abilities"))}</th><th>${escapeHtml(t("totalDmg"))}</th>
                <th>${escapeHtml(t("hits"))}</th><th>${escapeHtml(t("accuracy"))}</th><th>${escapeHtml(t("dps"))}</th>
            </tr></thead><tbody>`;
        for (const a of abilityRows) {
            let aAcc = accuracyPct(a.hits, a.misses);
            html += `<tr><td>${escapeHtml(a.name)}</td><td>${Math.round(a.dmg).toLocaleString()}</td>
                <td>${a.hits}</td><td>${aAcc}%</td><td>${(a.dmg / dur).toFixed(1)}</td></tr>`;
        }
        html += "</tbody></table></div></td></tr>";
    });

    html += "</tbody></table>";
    const container = document.getElementById(containerId);
    container.innerHTML = html;

    container.querySelectorAll("[data-detail-toggle]").forEach((row) => {
        row.addEventListener("click", () => {
            let id = row.dataset.detailToggle;
            let detail = document.getElementById("detailrow-" + id);
            let open = detail.style.display !== "none";
            detail.style.display = open ? "none" : "table-row";
            row.classList.toggle("open", !open);
        });
    });
}

function renderDamageTotals(result) {
    let dur = result.battleDurationNs / ONE_SECOND || 1;
    let doneGroups = aggregateAttacks(result.battleLog, "source");
    renderExpandableDamageTable("damageTotals", "damageDone", doneGroups, dur, "dmgdone");
}

function renderDamageTaken(result) {
    let dur = result.battleDurationNs / ONE_SECOND || 1;
    let takenGroups = aggregateAttacks(result.battleLog, "target");
    renderExpandableDamageTable("damageTaken", "damageTaken", takenGroups, dur, "dmgtaken");
}

function renderLog() {
    const filter = document.getElementById("logFilter").value;
    const search = document.getElementById("logSearch").value.trim().toLowerCase();
    const container = document.getElementById("combatLog");
    let log = window.__battleLog || [];

    let lines = [];
    for (const e of log) {
        if (filter !== "all" && e.kind !== filter) continue;
        let line = formatLogEntry(e);
        if (search && !line.text.toLowerCase().includes(search)) continue;
        lines.push(line);
    }

    if (!lines.length) {
        container.innerHTML = `<div class="empty">${escapeHtml(t("noLogEntriesMatch"))}</div>`;
        return;
    }

    // Cap rendering for very large logs.
    const CAP = 5000;
    let shown = lines.slice(0, CAP);
    let html = shown.map((l) =>
        `<div class="log-line ${l.cls}"><span class="log-time">${fmtTime(l.time)}</span>${l.text}</div>`
    ).join("");
    if (lines.length > CAP) {
        html += `<div class="empty">${escapeHtml(t("moreEntriesHidden", { count: lines.length - CAP }))}</div>`;
    }
    container.innerHTML = html;
    document.getElementById("logCount").textContent = lines.length;
}

// Translates an ability/consumable hrid to a display name via i18next
// (abilityNames/itemNames), falling back to the raw hrid tail.
function abilityOrItemName(hrid) {
    let tail = hrid.replace(/^.*\//, "");
    if (typeof i18next !== "undefined") {
        if (i18next.exists("abilityNames." + hrid)) return i18next.t("abilityNames." + hrid);
        if (i18next.exists("itemNames." + hrid)) return i18next.t("itemNames." + hrid);
    }
    return tail;
}

function formatLogEntry(e) {
    let time = e.time;
    if (e.kind === "attack") {
        let src = nameFor(e.source, e.sourceIsPlayer);
        let tgt = nameFor(e.target, e.targetIsPlayer);
        let cls = e.sourceIsPlayer ? "l-player-atk" : "l-enemy-atk";
        if (e.hit === "miss") {
            return { time, cls: cls + " l-miss", text: `${esc(src)} <i>${esc(t("misses"))}</i> ${esc(tgt)} <span class="dim">(${esc(abilityOrItemName(e.ability))})</span>` };
        }
        let hpPct = e.targetMaxHp ? Math.max(0, Math.round(100 * e.targetHpAfter / e.targetMaxHp)) : 0;
        return {
            time, cls,
            text: t("hitsForDamage", {
                src: esc(src), tgt: esc(tgt),
                dmg: `<b>${Math.round(e.hit).toLocaleString()}</b>`,
                ability: `<span class="dim">(${esc(abilityOrItemName(e.ability))})</span>`,
            }) + ` → ${esc(tgt)} ${hpPct}% HP`,
        };
    }
    if (e.kind === "heal") {
        return { time, cls: "l-heal", text: `${esc(nameFor(e.unit, e.isPlayer))} ${esc(t("heals"))} <b>${Math.round(e.amount).toLocaleString()}</b> <span class="dim">(${esc(abilityOrItemName(e.healSource))})</span>` };
    }
    if (e.kind === "manaGain") {
        return { time, cls: "l-mana", text: `${esc(nameFor(e.unit, e.isPlayer))} ${esc(t("gainsMana"))} <b>${Math.round(e.amount).toLocaleString()}</b> MP <span class="dim">(${esc(abilityOrItemName(e.manaSource))})</span>` };
    }
    if (e.kind === "death") {
        return { time, cls: "l-death", text: `☠ ${esc(nameFor(e.unit, e.isPlayer))} <b>${esc(t("died"))}</b>` };
    }
    if (e.kind === "consumable") {
        return { time, cls: "l-consume", text: `${esc(nameFor(e.unit, e.isPlayer))} ${esc(t("consumes"))} ${esc(abilityOrItemName(e.consumable))}` };
    }
    if (e.kind === "buffCast") {
        let selfCast = e.unit === e.target;
        let text = selfCast
            ? `${esc(nameFor(e.unit, e.isPlayer))} ${esc(t("casts"))} <b>${esc(abilityOrItemName(e.ability))}</b>`
            : t("castsOn", {
                src: esc(nameFor(e.unit, e.isPlayer)),
                ability: `<b>${esc(abilityOrItemName(e.ability))}</b>`,
                tgt: esc(nameFor(e.target, e.targetIsPlayer)),
            });
        return { time, cls: "l-buffcast", text };
    }
    if (e.kind === "enrage") {
        let pct = e.stack * 10;
        let text = "⚡ " + t("enragesText", { src: esc(nameFor(e.unit, e.isPlayer)), stack: e.stack, pct });
        return { time, cls: "l-enrage", text };
    }
    return { time, cls: "", text: JSON.stringify(e) };
}

// --------------------------------------------------------------------- Utils

function esc(s) { return escapeHtml(String(s)); }
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function showError(msg) {
    let el = document.getElementById("errorBox");
    el.textContent = msg;
    el.style.display = "block";
}
function clearError() {
    document.getElementById("errorBox").style.display = "none";
}

// ---------------------------------------------------------------------- Init

window.addEventListener("DOMContentLoaded", () => {
    loadPresets();

    initEnemyLevelSelect();
    refreshEnemySelect();
    renderPlayerList();
    renderEnemyGroup();
    renderPresetList();
    clearEditor();

    initTrialLevelSelect();
    renderTrialMonsterList();
    renderTrialPreview();

    // Re-render dynamic (JS-built) content when the language switcher fires,
    // since translated strings baked into HTML at render time don't update
    // on their own the way data-i18n elements do.
    onLanguageChange(() => {
        renderPlayerList();
        renderEnemyGroup();
        renderPresetList();
        renderTrialMonsterList();
        renderTrialPreview();
        if (window.__lastBattleResult) {
            renderResult(window.__lastBattleResult, false);
        }
    });

    // Tabs
    document.querySelectorAll(".tab").forEach((btn) => {
        btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    // Players
    document.getElementById("importReplace").addEventListener("click", () => doImport(false));
    document.getElementById("importAppend").addEventListener("click", () => doImport(true));
    document.getElementById("clearPlayers").addEventListener("click", () => {
        importedPlayers = [];
        renderPlayerList();
    });
    document.getElementById("importTestGroup").addEventListener("click", doTestImport);

    // Enemy group
    document.getElementById("addEnemy").addEventListener("click", addEnemy);
    document.getElementById("enemySelect").addEventListener("change", () => {
        syncEnemyLevelSelect();
        // Selection changed - hide any stale preview until the user asks again.
        document.getElementById("enemyPreviewPanel").style.display = "none";
    });
    document.getElementById("enemyLevelSelect").addEventListener("change", () => {
        // Live-update the preview if it's already open for a Trial Monster.
        if (document.getElementById("enemyPreviewPanel").style.display !== "none") {
            renderEnemyPreview();
        }
    });
    document.getElementById("previewEnemyBtn").addEventListener("click", renderEnemyPreview);
    document.getElementById("closeEnemyPreviewBtn").addEventListener("click", () => {
        document.getElementById("enemyPreviewPanel").style.display = "none";
    });
    document.getElementById("clearEnemies").addEventListener("click", () => {
        enemyGroup = [];
        renderEnemyGroup();
    });

    // Battle
    document.getElementById("runBattle").addEventListener("click", runBattle);
    document.getElementById("logFilter").addEventListener("change", renderLog);
    document.getElementById("logSearch").addEventListener("input", renderLog);

    // Presets
    document.getElementById("savePresetBtn").addEventListener("click", savePreset);
    document.getElementById("newPresetBtn").addEventListener("click", clearEditor);
    document.getElementById("parsePasteBtn").addEventListener("click", () => {
        let spec = parseStatBlock(document.getElementById("pasteBlock").value);
        let nm = document.getElementById("pasteName").value.trim();
        if (nm) spec.name = nm;
        editingPresetIndex = -1;
        fillEditor(spec);
        setPresetStatus(t("parsedReview"));
    });
    // Trial monsters
    document.getElementById("trialLevel").addEventListener("change", renderTrialPreview);
    document.getElementById("addTrialMonsterBtn").addEventListener("click", addTrialMonsterToGroup);
});
