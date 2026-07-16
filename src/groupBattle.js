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
import GROUP_BATTLE_REGEN_BUFFS from "./combatsimulator/data/groupBattleBuffs";

// Auto-load every predefined preset from the testPlayers folder. Each JSON file
// is one solo-export; the preset's display name is derived from the filename
// (e.g. "bow_insanity.json" -> "Bow Insanity"). Adding a file there adds a
// preset with no code change.
const TEST_PLAYER_CTX = require.context(
    "./combatsimulator/data/testPlayers", false, /\.json$/
);
function prettyPresetName(file) {
    return file
        .replace(/^\.\//, "").replace(/\.json$/, "")
        .split(/[_-]+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
}
// [{ key, id, export }], sorted by name for a stable UI order.
const PREDEFINED_PRESETS = TEST_PLAYER_CTX.keys()
    .map((file) => ({
        key: prettyPresetName(file),
        id: file.replace(/^\.\//, "").replace(/\.json$/, ""),
        export: TEST_PLAYER_CTX(file),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

const ONE_SECOND = 1e9;
const PRESET_STORAGE_KEY = "mwiGroupBattleMonsterPresets";
// Handoff key read by the original simulator (main.js) to auto-import a preset.
// Must match SOLO_IMPORT_HANDOFF_KEY in src/main.js.
const SOLO_IMPORT_HANDOFF_KEY = "mwiSoloImportHandoff";

let worker = new Worker(new URL("worker.js", import.meta.url));

// Imported players: array of { name, dto }
let importedPlayers = [];
// OOM (out-of-mana blocked casts) totals from the most recent run, keyed by
// player dto.hrid. Accumulated across all tiers in Trial Mode; single battle in
// Single Boss. Shown as a badge on each roster card. Empty until a run happens.
let rosterOom = {};
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

// Inverse of soloExportToDTO / equipmentSetToDTO: turn an internal player DTO
// back into the "solo export" JSON the standard simulator's Import/Export uses,
// so a preset (or roster player) can be re-imported there. Food/drinks are
// intentionally empty (group battles strip them).
function dtoToSoloExport(dto) {
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
    };
}

// Convert one "equipment set" (the object shape the standard simulator persists
// in localStorage under "equipmentSets") into a Player.createFromDTO-compatible
// DTO. This shape differs from a solo export: levels/equipment/abilities are
// keyed objects (not arrays), the weapon lives under a single "weapon" slot
// (main_hand vs two_hand is inferred from the item's own equipment type), and
// there is an extra "charm" slot.
function equipmentSetToDTO(set, hrid) {
    const levels = set.levels || {};
    const lvl = (skill) => Number(levels[skill]) || 1;

    let equipment = {};
    const simpleSlots = [
        "head", "body", "legs", "feet", "hands",
        "off_hand", "pouch", "neck", "earrings", "ring", "back", "charm",
    ];
    for (const slot of simpleSlots) {
        let entry = (set.equipment || {})[slot];
        let itemHrid = entry && entry.equipment;
        equipment["/equipment_types/" + slot] =
            itemHrid && itemDetailMap[itemHrid]
                ? { hrid: itemHrid, enhancementLevel: Number(entry.enhancementLevel) || 0 }
                : null;
    }
    // Weapon: resolve to main_hand or two_hand from the item's own type.
    equipment["/equipment_types/main_hand"] = null;
    equipment["/equipment_types/two_hand"] = null;
    let weaponEntry = (set.equipment || {}).weapon;
    let weaponHrid = weaponEntry && weaponEntry.equipment;
    if (weaponHrid && itemDetailMap[weaponHrid]) {
        let wtype = itemDetailMap[weaponHrid].equipmentDetail?.type;
        let slot = wtype === "/equipment_types/two_hand" ? "two_hand" : "main_hand";
        equipment["/equipment_types/" + slot] = {
            hrid: weaponHrid,
            enhancementLevel: Number(weaponEntry.enhancementLevel) || 0,
        };
    }

    const triggerMap = set.triggerMap || {};

    // Group battles assume no food or drink for any player.
    let food = [null, null, null];
    let drinks = [null, null, null];

    // Equipment set abilities are keyed 0..4 as { ability, level }.
    let abilities = [0, 1, 2, 3, 4].map((i) => {
        let entry = (set.abilities || {})[i];
        let abilityHrid = entry && entry.ability;
        if (!abilityHrid) return null;
        try {
            return buildAbilityDTO(abilityHrid, Number(entry.level) || 1, triggerMap[abilityHrid]);
        } catch (e) {
            return null;
        }
    });

    return {
        hrid: hrid,
        staminaLevel: lvl("stamina"),
        intelligenceLevel: lvl("intelligence"),
        attackLevel: lvl("attack"),
        meleeLevel: lvl("melee"),
        defenseLevel: lvl("defense"),
        rangedLevel: lvl("ranged"),
        magicLevel: lvl("magic"),
        equipment: equipment,
        food: food,
        drinks: drinks,
        abilities: abilities,
        houseRooms: set.houseRooms || {},
        achievements: set.achievements || {},
        debuffOnLevelGap: 0,
    };
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

// ------------------------------------------------------------ Group Builder ---
// The Group Builder assembles a roster from "presets", each with a count. Three
// kinds of preset feed it:
//   1. PREDEFINED_PRESETS - hardcoded role rosters (cannot be edited).
//   2. jsonPresets         - named solo-exports pasted by the user (session only).
//   3. equipmentSetPresets - the standard sim's saved equipment sets, read from
//                            localStorage (refreshable).
// "Build roster (replace)" rebuilds importedPlayers from every preset's count.

const LS_EQUIPMENT_SETS_KEY = "equipmentSets";

// Default counts for the standard team, matched by a substring of the preset id
// (filename). First matching rule wins; presets not matched default to 0.
const PREDEFINED_DEFAULT_COUNTS = [
    ["crossbow", 10], ["bow", 2], ["nature", 5], ["slash", 2],
    ["wark", 3], ["water", 2], ["stab", 2], ["smash", 10],
];
function defaultCountForPreset(id) {
    let lc = id.toLowerCase();
    for (const [needle, n] of PREDEFINED_DEFAULT_COUNTS) {
        if (lc.includes(needle)) return n;
    }
    return 0;
}

// Per-preset chosen count, keyed by preset id (dynamic count inputs are rendered
// by renderPredefinedPresets). Seeded from PREDEFINED_DEFAULT_COUNTS.
let predefinedCounts = {};

// User presets loaded from pasted JSON: { name, dto, count }.
let jsonPresets = [];
// User presets loaded from localStorage equipment sets: { name, dto, count }.
let equipmentSetPresets = [];

// Read the standard simulator's saved equipment sets from localStorage and turn
// each into a preset. Preserves the previously entered count for a set of the
// same name so a Refresh does not wipe the user's chosen counts.
function refreshEquipmentSetPresets() {
    let prevCounts = {};
    for (const p of equipmentSetPresets) prevCounts[p.name] = p.count;

    let sets = {};
    try {
        sets = JSON.parse(localStorage.getItem(LS_EQUIPMENT_SETS_KEY)) || {};
    } catch (e) {
        sets = {};
    }

    equipmentSetPresets = [];
    let errors = [];
    for (const name of Object.keys(sets)) {
        try {
            let dto = equipmentSetToDTO(sets[name], "preset");
            equipmentSetPresets.push({ name, dto, count: prevCounts[name] ?? 0 });
        } catch (e) {
            errors.push(name + ": " + e.message);
        }
    }

    renderUserPresetList();
    if (errors.length) {
        showError(t("equipmentSetsLoadedWithErrors", { count: errors.length, errors: errors.join("\n") }));
    }
}

// Add a named preset from the JSON textarea. Uses only the FIRST export in the
// pasted data (a preset is a single player template that gets multiplied by
// count). Not persisted.
function addJsonPreset() {
    let nameInput = document.getElementById("jsonPresetName");
    let textarea = document.getElementById("jsonPresetText");
    let name = nameInput.value.trim();

    if (!name) {
        showError(t("presetNameRequired"));
        return;
    }
    let exports;
    try {
        exports = parseImport(textarea.value);
    } catch (e) {
        showError(t("couldNotParseImport", { msg: e.message }));
        return;
    }
    if (!exports.length || !exports[0] || !exports[0].player) {
        showError(t("noPlayerDataFound"));
        return;
    }

    let dto;
    try {
        dto = soloExportToDTO(exports[0], "preset");
    } catch (e) {
        showError(t("couldNotParseImport", { msg: e.message }));
        return;
    }

    jsonPresets.push({ name, dto, count: 1 });
    nameInput.value = "";
    textarea.value = "";
    clearError();
    renderUserPresetList();
}

// Render the predefined presets (auto-loaded from the testPlayers folder): each
// a clickable name (opens the review modal) plus a count input. Counts persist
// in predefinedCounts across re-renders.
function renderPredefinedPresets() {
    let container = document.getElementById("predefinedPresetList");
    if (!container) return;
    container.innerHTML = "";

    PREDEFINED_PRESETS.forEach((role) => {
        if (!(role.id in predefinedCounts)) predefinedCounts[role.id] = defaultCountForPreset(role.id);

        let row = document.createElement("div");
        row.className = "preset-row";

        let name = document.createElement("span");
        name.className = "preset-name preset-review";
        name.textContent = role.key;
        name.title = t("clickForDetails");
        name.addEventListener("click", () => {
            try {
                openDetailModal(role.key, soloExportToDTO(role.export, "preset"));
            } catch (e) {
                showError(t("couldNotParseImport", { msg: e.message }));
            }
        });

        let count = document.createElement("input");
        count.type = "number";
        count.min = "0";
        count.max = "50";
        count.value = predefinedCounts[role.id];
        count.style.width = "60px";
        count.title = t("presetCountTitle");
        count.addEventListener("input", () => {
            predefinedCounts[role.id] = Math.max(0, Number(count.value) || 0);
        });

        row.appendChild(name);
        row.appendChild(count);
        container.appendChild(row);
    });
}

// Render the combined user-preset list (JSON presets + equipment set presets),
// each row with an editable count and (for JSON presets) a remove button.
function renderUserPresetList() {
    let container = document.getElementById("userPresetList");
    container.innerHTML = "";

    if (!jsonPresets.length && !equipmentSetPresets.length) {
        let empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = t("noUserPresets");
        container.appendChild(empty);
        return;
    }

    const addRow = (preset, kind, index) => {
        let row = document.createElement("div");
        row.className = "preset-row";

        // Clicking the name (or its area) opens the review modal.
        let name = document.createElement("span");
        name.className = "preset-name preset-review";
        name.textContent = preset.name;
        name.title = t("clickForDetails");
        name.addEventListener("click", () => openPresetModal(preset));

        let count = document.createElement("input");
        count.type = "number";
        count.min = "0";
        count.max = "50";
        count.value = preset.count;
        count.style.width = "60px";
        count.title = t("presetCountTitle");
        count.addEventListener("input", () => {
            preset.count = Math.max(0, Number(count.value) || 0);
        });

        row.appendChild(name);
        // JSON presets keep a small source tag; equipment-set presets don't need
        // one (all visible presets are equipment sets, so the label just adds noise).
        if (kind === "json") {
            let src = document.createElement("span");
            src.className = "preset-src";
            src.textContent = t("srcJson");
            row.appendChild(src);
        }
        row.appendChild(count);

        if (kind === "json") {
            let remove = document.createElement("button");
            remove.className = "remove-preset";
            remove.textContent = "✕";
            remove.title = t("removePreset");
            remove.addEventListener("click", () => {
                jsonPresets.splice(index, 1);
                renderUserPresetList();
            });
            row.appendChild(remove);
        }

        container.appendChild(row);
    };

    jsonPresets.forEach((p, i) => addRow(p, "json", i));
    equipmentSetPresets.forEach((p, i) => addRow(p, "equipmentSet", i));
}

// Rebuild the entire roster from every preset's count (predefined + user).
function buildRoster() {
    importedPlayers = [];
    rosterOom = {}; // stale OOM from a prior run no longer applies
    let errors = [];

    const addCopies = (label, count, buildDto) => {
        for (let i = 1; i <= count; i++) {
            try {
                let index = importedPlayers.length + 1;
                let dto = buildDto("player" + index);
                importedPlayers.push({ name: label + " " + i, dto });
            } catch (e) {
                errors.push(label + " " + i + ": " + e.message);
            }
        }
    };

    for (const role of PREDEFINED_PRESETS) {
        let count = Math.max(0, Number(predefinedCounts[role.id]) || 0);
        addCopies(role.key, count, (hrid) => soloExportToDTO(role.export, hrid));
    }
    for (const preset of jsonPresets) {
        addCopies(preset.name, Math.max(0, Number(preset.count) || 0),
            (hrid) => ({ ...structuredClone(preset.dto), hrid }));
    }
    for (const preset of equipmentSetPresets) {
        addCopies(preset.name, Math.max(0, Number(preset.count) || 0),
            (hrid) => ({ ...structuredClone(preset.dto), hrid }));
    }

    // Auto-assign auras to the best-fit players (overrides their original aura).
    assignAuras();

    renderPlayerList();
    if (errors.length) {
        showError(t("importedWithErrors", { count: errors.length, errors: errors.join("\n") }));
    } else {
        clearError();
    }
    document.getElementById("playerList").scrollIntoView({ behavior: "smooth", block: "center" });
}

// -------------------------------------------------------------- Aura assign ---
// Each aura is carried by the roster member with the highest matching skill.
// Priority order below is also the tie/assignment order: an assigned player is
// excluded from later auras (one aura per player). The chosen aura OVERRIDES the
// player's original aura ability (or takes an empty ability slot).
const AURA_ASSIGNMENTS = [
    { hrid: "/abilities/fierce_aura", inputId: "auraLvlFierce", skill: "attackLevel" },
    { hrid: "/abilities/mystic_aura", inputId: "auraLvlMystic", skill: "magicLevel" },
    { hrid: "/abilities/critical_aura", inputId: "auraLvlCrit", skill: "rangedLevel" },
    { hrid: "/abilities/guardian_aura", inputId: "auraLvlGuardian", skill: "defenseLevel" },
    { hrid: "/abilities/speed_aura", inputId: "auraLvlSpeed", skill: "meleeLevel" },
];

// Replace/insert an aura ability in a player's DTO ability list. Prefers to
// overwrite the player's existing aura slot; else the first empty slot; else
// slot 0. Ability slots are a fixed length-5 array of {hrid,level,triggers}|null.
function setPlayerAura(dto, auraHrid, level) {
    if (!Array.isArray(dto.abilities)) dto.abilities = [null, null, null, null, null];
    let auraDto;
    try {
        auraDto = buildAbilityDTO(auraHrid, level, undefined);
    } catch (e) {
        return; // unknown aura hrid in this data set — skip
    }
    let idx = dto.abilities.findIndex((a) => a && AURA_ABILITY_HRIDS.has(a.hrid));
    if (idx < 0) idx = dto.abilities.findIndex((a) => !a);
    if (idx < 0) idx = 0;
    dto.abilities[idx] = auraDto;
}

// Assign every configured aura to the best-fit, not-yet-assigned player.
function assignAuras() {
    if (!importedPlayers.length) return;
    let assigned = new Set(); // roster indices already carrying an assigned aura

    for (const aura of AURA_ASSIGNMENTS) {
        let level = Number(document.getElementById(aura.inputId)?.value);
        if (!Number.isFinite(level)) level = 30;

        // Best unassigned player by the aura's skill.
        let bestIdx = -1, bestSkill = -Infinity;
        importedPlayers.forEach((p, i) => {
            if (assigned.has(i)) return;
            let s = Number(p.dto[aura.skill]) || 0;
            if (s > bestSkill) { bestSkill = s; bestIdx = i; }
        });
        if (bestIdx < 0) break; // no players left to assign

        setPlayerAura(importedPlayers[bestIdx].dto, aura.hrid, level);
        assigned.add(bestIdx);
        // Derived summary is cached by dto reference; invalidate for this player.
        derivedSummaryCache.delete(importedPlayers[bestIdx].dto);
    }
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

// The five real combat styles map to a color; magic is further split by damage
// element (fire/water/nature). "unarmed"/unknown falls back to a neutral color.
// "wark" is a synthetic style for defensive/bulwark players (a bulwark uses the
// smash style but plays a distinct tank role) - detected via the weapon's
// defensiveDamage stat, and given its own color.
const STYLE_COLORS = {
    "/combat_styles/smash": "#e8963c",   // orange
    "/combat_styles/slash": "#e05a5a",   // red
    "/combat_styles/stab": "#e8d24c",    // yellow
    "/combat_styles/ranged": "#5fbf6f",  // green
    "/combat_styles/magic": "#9b7fe0",   // violet (overridden by element below)
    wark: "#4bb3c4",                     // cyan/teal - defensive (bulwark)
};

// A weapon is a "bulwark" (defensive) if its combat stats include defensiveDamage.
function isBulwark(hrid) {
    let cs = itemDetailMap[hrid]?.equipmentDetail?.combatStats;
    return !!(cs && "defensiveDamage" in cs);
}
const MAGIC_ELEMENT_COLORS = {
    "/damage_types/fire": "#ff6b3d",
    "/damage_types/water": "#4c9be8",
    "/damage_types/nature": "#5fbf6f",
};
// Aura abilities. Most end in "_aura", but Insanity, Invincible, and Revive are
// auras too despite their hrids not following that pattern.
const AURA_ABILITY_HRIDS = new Set([
    "/abilities/critical_aura", "/abilities/fierce_aura", "/abilities/guardian_aura",
    "/abilities/mystic_aura", "/abilities/speed_aura",
    "/abilities/insanity", "/abilities/invincible", "/abilities/revive",
]);
// Each aura gets its own border/glow color on the roster card.
const AURA_COLORS = {
    "/abilities/critical_aura": "#f0c250", // gold
    "/abilities/fierce_aura": "#ff6b3d",   // red-orange
    "/abilities/guardian_aura": "#4c9be8", // blue
    "/abilities/mystic_aura": "#9b7fe0",   // violet
    "/abilities/speed_aura": "#4bd0a0",    // teal-green
    "/abilities/insanity": "#e0489b",      // magenta
    "/abilities/invincible": "#d8dde3",    // silver-white
    "/abilities/revive": "#7ee081",        // light green
};
function auraColor(hrid) {
    return AURA_COLORS[hrid] || "#f0c250";
}

// Cache of derived summaries keyed by dto reference, so we build each Player
// only once per import (constructing a Player + combat details is expensive and
// renderPlayerList runs on every roster change).
const derivedSummaryCache = new WeakMap();

function derivePlayerSummary(dto) {
    if (derivedSummaryCache.has(dto)) return derivedSummaryCache.get(dto);

    let summary;
    try {
        let zone = new Zone("/actions/combat/fly");
        let player = Player.createFromDTO(structuredClone(dto));
        player.zoneBuffs = zone.buffs;
        player.extraBuffs = GROUP_BATTLE_REGEN_BUFFS;
        player.reset(0);
        player.generatePermanentBuffs();
        player.reset(0);

        let cd = player.combatDetails;
        let cs = cd.combatStats;
        summary = {
            maxHitpoints: cd.maxHitpoints,
            maxManapoints: cd.maxManapoints,
            combatStyleHrid: cs.combatStyleHrid || "",
            damageType: cs.damageType || "",
        };
    } catch (e) {
        summary = { maxHitpoints: 0, maxManapoints: 0, combatStyleHrid: "", damageType: "" };
    }

    // Weapon (main_hand preferred, else two_hand) + enhancement level.
    let weapon = dto.equipment["/equipment_types/main_hand"] || dto.equipment["/equipment_types/two_hand"];
    summary.weaponName = weapon ? itemName(weapon.hrid) : null;
    summary.weaponEnh = weapon ? (Number(weapon.enhancementLevel) || 0) : 0;
    // Defensive ("wark") if the equipped weapon is a bulwark.
    summary.isWark = weapon ? isBulwark(weapon.hrid) : false;

    // Aura: an equipped aura ability, if any (used for the distinct border).
    let aura = (dto.abilities || []).find((a) => a && AURA_ABILITY_HRIDS.has(a.hrid));
    summary.auraHrid = aura ? aura.hrid : null;

    derivedSummaryCache.set(dto, summary);
    return summary;
}

// Resolve the accent color for a player's card from combat style + element.
function styleColor(summary) {
    if (summary.isWark) return STYLE_COLORS.wark;
    if (summary.combatStyleHrid === "/combat_styles/magic") {
        return MAGIC_ELEMENT_COLORS[summary.damageType] || STYLE_COLORS["/combat_styles/magic"];
    }
    return STYLE_COLORS[summary.combatStyleHrid] || "var(--dim)";
}

// Fixed display order for the roster:
//   Wark → Ranged → Stab → Smash → Slash → Magic(Nature → Fire → Water) → other.
// Lower rank sorts first. Within the same rank, original import order is kept.
function styleRank(summary) {
    if (summary.isWark) return 0;
    switch (summary.combatStyleHrid) {
        case "/combat_styles/ranged": return 1;
        case "/combat_styles/stab": return 2;
        case "/combat_styles/smash": return 3;
        case "/combat_styles/slash": return 4;
        case "/combat_styles/magic":
            switch (summary.damageType) {
                case "/damage_types/nature": return 5;
                case "/damage_types/fire": return 6;
                case "/damage_types/water": return 7;
                default: return 8; // magic, unknown element
            }
        default: return 9; // unarmed / unknown
    }
}

// Short label for the style chip, e.g. "Ranged", "Magic · Fire", or "Wark".
function styleLabel(summary) {
    if (summary.isWark) return t("styleWark");
    if (!summary.combatStyleHrid) return t("unarmed");
    let base = combatStyleName(summary.combatStyleHrid);
    if (summary.combatStyleHrid === "/combat_styles/magic" && summary.damageType) {
        return base + " · " + damageTypeName(summary.damageType);
    }
    return base;
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

    // Display in a fixed style order (Wark, Ranged, Stab, Smash, Slash, Magic
    // by element, then others), while keeping each card's ORIGINAL import index
    // so remove/rename/modal still target the right entry. A stable sort keeps
    // import order within a style group.
    let ordered = importedPlayers
        .map((p, i) => ({ p, i, s: derivePlayerSummary(p.dto) }))
        .sort((a, b) => styleRank(a.s) - styleRank(b.s));

    // Aura-count-by-type subtitle (only auras actually present in the roster).
    let auraCounts = {};
    for (const { s } of ordered) {
        if (s.auraHrid) auraCounts[s.auraHrid] = (auraCounts[s.auraHrid] || 0) + 1;
    }
    let auraChips = Object.entries(auraCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([hrid, n]) =>
            `<span class="aura-chip" style="--accent-aura:${auraColor(hrid)};">${escapeHtml(abilityName(hrid))} ×${n}</span>`)
        .join("");
    let html = auraChips
        ? `<div class="roster-aura-summary"><span class="dim">${escapeHtml(t("aurasLabel"))}</span> ${auraChips}</div>`
        : "";

    html += '<div class="roster-grid">';
    ordered.forEach(({ p, i, s }) => {
        let accent = styleColor(s);
        let auraClass = s.auraHrid ? " has-aura" : "";
        let auraName = s.auraHrid ? abilityName(s.auraHrid) : "";
        let auraCol = s.auraHrid ? auraColor(s.auraHrid) : "";
        let auraVar = s.auraHrid ? ` --accent-aura:${auraCol};` : "";

        let weaponLine = s.weaponName
            ? `${escapeHtml(s.weaponName)}${s.weaponEnh ? " +" + s.weaponEnh : ""}`
            : `<span class="dim">${escapeHtml(t("noWeapon"))}</span>`;

        // OOM badge (from the most recent run), keyed by this player's hrid.
        let oom = rosterOom[p.dto.hrid] || 0;
        let oomBadge = oom > 0
            ? `<span class="rc-oom" title="${escapeHtml(t("oomTooltip"))}">${escapeHtml(t("oomColumn"))} ${oom}</span>`
            : "";

        // Percentages are 100% at import (players start full); bars still convey
        // relative HP/MP magnitude via the numeric label.
        html += `<div class="roster-card${auraClass}" data-open="${i}" style="--accent-style:${accent};${auraVar}" title="${escapeHtml(t("clickForDetails"))}">
            <button class="rc-remove" data-remove="${i}" title="${escapeHtml(t("removePlayer"))}">✕</button>
            ${oomBadge}
            <div class="rc-name">${escapeHtml(p.name)}</div>
            <div class="rc-weapon">${weaponLine}</div>
            ${auraName ? `<div class="rc-aura" style="color:${auraCol};">✦ ${escapeHtml(auraName)}</div>` : ""}
            <div class="rc-style" style="background:${accent};">${escapeHtml(styleLabel(s))}</div>
            <div class="rc-bar rc-hp"><div class="rc-bar-fill" style="width:100%;"></div><span class="rc-bar-label">HP ${fmtNum(s.maxHitpoints)}</span></div>
            <div class="rc-bar rc-mp"><div class="rc-bar-fill" style="width:100%;"></div><span class="rc-bar-label">MP ${fmtNum(s.maxManapoints)}</span></div>
        </div>`;
    });
    html += "</div>";
    container.innerHTML = html;

    container.querySelectorAll(".rc-remove").forEach((btn) => {
        btn.addEventListener("click", (ev) => {
            ev.stopPropagation(); // don't also open the detail modal
            importedPlayers.splice(Number(btn.dataset.remove), 1);
            reindexPlayers();
            renderPlayerList();
        });
    });
    container.querySelectorAll(".roster-card").forEach((card) => {
        card.addEventListener("click", () => openPlayerModal(Number(card.dataset.open)));
        // Rename via double-click on the name (keeps single-click for details).
        let nameEl = card.querySelector(".rc-name");
        nameEl.addEventListener("dblclick", (ev) => {
            ev.stopPropagation();
            beginRename(card, Number(card.dataset.open), nameEl);
        });
    });
}

// Inline-edit a player's name in place. Committed on blur / Enter.
function beginRename(card, idx, nameEl) {
    let input = document.createElement("input");
    input.className = "name-edit";
    input.value = importedPlayers[idx].name;
    input.addEventListener("click", (e) => e.stopPropagation());
    let commit = () => {
        importedPlayers[idx].name = input.value.trim() || importedPlayers[idx].name;
        renderPlayerList();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); input.blur(); }
        if (e.key === "Escape") { e.preventDefault(); renderPlayerList(); }
    });
    nameEl.replaceWith(input);
    input.focus();
    input.select();
}

// --------------------------------------------------------------- Detail modal -

// Shared modal renderer: shows the equipment/ability summary for a DTO, the
// on-demand detailed combat status, and an "Export JSON" button that copies a
// re-importable solo-export to the clipboard.
function openDetailModal(title, dto) {
    let overlay = document.getElementById("playerModalOverlay");
    let titleEl = document.getElementById("playerModalTitle");
    let bodyEl = document.getElementById("playerModalBody");

    titleEl.textContent = title;

    // Export toolbar + the standard detail body.
    let toolbar = `<div class="row" style="margin-bottom:10px;">
        <button class="secondary export-json-btn">${escapeHtml(t("exportJson"))}</button>
        <button class="secondary open-original-btn">${escapeHtml(t("openInOriginal"))}</button>
        <span class="export-status hint"></span>
    </div>`;
    bodyEl.innerHTML = toolbar + playerDetailHtml(dto);

    // Wire the "Show Detailed Combat Status" button inside the modal body.
    let statusBtn = bodyEl.querySelector(".show-status-btn");
    if (statusBtn) {
        statusBtn.addEventListener("click", () => {
            let statusEl = bodyEl.querySelector(".detailed-status");
            let open = statusEl.style.display !== "none";
            if (open) {
                statusEl.style.display = "none";
                statusBtn.textContent = t("showDetailedStatus");
            } else {
                renderDetailedStatus(statusEl, dto);
                statusEl.style.display = "block";
                statusBtn.textContent = t("hideDetailedStatus");
            }
        });
    }

    // Wire the Export JSON button: copy a solo-export to the clipboard.
    let exportBtn = bodyEl.querySelector(".export-json-btn");
    let exportStatus = bodyEl.querySelector(".export-status");
    if (exportBtn) {
        exportBtn.addEventListener("click", async () => {
            let json = JSON.stringify(dtoToSoloExport(dto));
            try {
                await navigator.clipboard.writeText(json);
                exportStatus.textContent = t("copiedToClipboard");
            } catch (e) {
                // Fallback for browsers/contexts without clipboard access.
                let ta = document.createElement("textarea");
                ta.value = json;
                bodyEl.appendChild(ta);
                ta.select();
                try { document.execCommand("copy"); exportStatus.textContent = t("copiedToClipboard"); }
                catch (e2) { exportStatus.textContent = t("copyFailed"); }
                ta.remove();
            }
        });
    }

    // Wire "Open in original simulator": stash the solo-export in localStorage
    // (the original page consumes SOLO_IMPORT_HANDOFF_KEY on load and applies it)
    // and open index.html in a new tab.
    let openBtn = bodyEl.querySelector(".open-original-btn");
    if (openBtn) {
        openBtn.addEventListener("click", () => {
            try {
                localStorage.setItem(SOLO_IMPORT_HANDOFF_KEY, JSON.stringify(dtoToSoloExport(dto)));
            } catch (e) {
                exportStatus.textContent = t("copyFailed");
                return;
            }
            window.open("index.html", "_blank", "noopener");
        });
    }

    overlay.style.display = "flex";
    document.getElementById("playerModalClose").focus();
}

// Opens the detail modal for a roster player.
function openPlayerModal(idx) {
    let p = importedPlayers[idx];
    if (!p) return;
    openDetailModal(p.name, p.dto);
}

// Opens the detail modal for a user preset (JSON or equipment set).
function openPresetModal(preset) {
    if (!preset) return;
    openDetailModal(preset.name, preset.dto);
}

function closePlayerModal() {
    let overlay = document.getElementById("playerModalOverlay");
    if (overlay) overlay.style.display = "none";
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
// is a level-scaled Trial Monster or a fixed-stat custom preset. In Trial Mode
// the tier is frozen to T1 regardless of the selected monster.
function syncEnemyLevelSelect() {
    const enemySelect = document.getElementById("enemySelect");
    const levelSelect = document.getElementById("enemyLevelSelect");

    if (currentBattleMode === "trialMode") {
        levelSelect.value = String(TRIAL_MIN_LEVEL);
        levelSelect.disabled = true;
        levelSelect.style.opacity = "0.5";
        return;
    }

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

function switchSubTab(subTabId) {
    document.querySelectorAll(".subtabpanel").forEach((el) => {
        el.style.display = el.id === subTabId ? "" : "none";
    });
    // Scope to import sub-tab buttons only (they carry data-subtab), so this
    // doesn't fight the battle-mode tabs which reuse the .subtab visual class.
    document.querySelectorAll(".subtab[data-subtab]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.subtab === subTabId);
    });
}

// Battle-mode tabs (Single Boss / Trial Mode) inside the enemy card.
// Trial Mode is the default.
let currentBattleMode = "trialMode";
function switchModeTab(modeTabId) {
    currentBattleMode = modeTabId;
    document.querySelectorAll(".modepanel").forEach((el) => {
        el.style.display = el.id === modeTabId ? "" : "none";
    });
    document.querySelectorAll(".subtab[data-modetab]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.modetab === modeTabId);
    });

    // Trial Mode always starts at T1 (L100) and escalates automatically, so the
    // per-enemy tier selector is frozen to L100 and disabled while in that mode.
    const levelSelect = document.getElementById("enemyLevelSelect");
    const frozenNote = document.getElementById("trialTierFrozenNote");
    if (modeTabId === "trialMode") {
        levelSelect.value = String(TRIAL_MIN_LEVEL);
        levelSelect.disabled = true;
        levelSelect.style.opacity = "0.5";
        if (frozenNote) frozenNote.style.display = "";
    } else {
        if (frozenNote) frozenNote.style.display = "none";
        // Restore normal enable/disable behavior for the current enemy.
        syncEnemyLevelSelect();
    }
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

    runBattleOnWorker({ players: playersToSim, enemies, timeCapSeconds })
        .then((simResult) => {
            document.getElementById("runBattle").disabled = false;
            document.getElementById("battleStatus").textContent = "";
            // OOM badges on roster cards reflect this single battle.
            rosterOom = { ...(simResult.playerOomCastCount || {}) };
            renderResult(simResult);
            renderPlayerList();
        })
        .catch((err) => {
            document.getElementById("runBattle").disabled = false;
            document.getElementById("battleStatus").textContent = "";
            showError(t("simulationErrorPrefix") + err);
        });
}

// Promise-based single-battle request. The worker runs one battle at a time, so
// requests are serialized via a FIFO queue of pending resolvers. This lets Trial
// Mode await tiers sequentially while single-boss keeps working unchanged.
let pendingBattleResolvers = [];
function runBattleOnWorker({ players, enemies, timeCapSeconds }) {
    return new Promise((resolve, reject) => {
        pendingBattleResolvers.push({ resolve, reject });
        worker.postMessage({
            type: "start_battle",
            players,
            enemies,
            timeCapSeconds,
        });
    });
}

worker.onmessage = function (event) {
    switch (event.data.type) {
        case "battle_result": {
            let pending = pendingBattleResolvers.shift();
            if (pending) pending.resolve(event.data.simResult);
            break;
        }
        case "simulation_error": {
            let pending = pendingBattleResolvers.shift();
            if (pending) pending.reject(event.data.error);
            break;
        }
    }
};

// ---------------------------------------------------------------- Trial Mode -

const TRIAL_MIN_LEVEL = 100;
const TRIAL_MAX_LEVEL = 300;      // matches the level-select bound
const TRIAL_LEVEL_STEP = 10;
const trialModeState = { running: false };

function tierLevel(tier) {
    return TRIAL_MIN_LEVEL + TRIAL_LEVEL_STEP * (tier - 1);
}
function maxTier() {
    return (TRIAL_MAX_LEVEL - TRIAL_MIN_LEVEL) / TRIAL_LEVEL_STEP + 1;
}

// Runs the current enemy group through escalating tiers (T1=L100, T2=L110, …)
// until the group wipes, a tier ends inconclusively, or the total time budget
// runs out. Players recover to full between tiers automatically (each battle
// builds fresh Players from the DTO). Ignores the per-enemy level chosen when
// building the group: every scaling enemy is re-leveled to the tier's level.
async function runTrialMode() {
    clearError();
    if (trialModeState.running) return;

    if (!importedPlayers.length) {
        showError(t("importAtLeastOnePlayer"));
        return;
    }
    if (!enemyGroup.length) {
        showError(t("addAtLeastOneEnemy"));
        return;
    }
    let scalingCount = enemyGroup.filter((e) => e.scaling).length;
    if (!scalingCount) {
        showError(t("trialNeedsScalingEnemy"));
        return;
    }
    if (scalingCount < enemyGroup.length) {
        // Non-scaling custom enemies won't escalate; warn but continue.
        showError(t("trialHasStaticEnemies"));
    }

    let playersToSim = importedPlayers.map((p) => structuredClone(p.dto));
    let totalBudgetSeconds = Number(document.getElementById("trialTimeCap").value) || 3600;

    // Names for the result view (same maps the single-boss result uses).
    window.__playerNames = {};
    importedPlayers.forEach((p) => (window.__playerNames[p.dto.hrid] = p.name));

    trialModeState.running = true;
    let runBtn = document.getElementById("runTrial");
    runBtn.disabled = true;

    let remainingSeconds = totalBudgetSeconds;
    let tiers = [];       // per-tier records
    let stopReason = "completed"; // completed | defeat | timeout | ended
    rosterOom = {};       // reset per-player OOM totals for this run

    try {
        for (let tier = 1; tier <= maxTier(); tier++) {
            if (remainingSeconds <= 0) { stopReason = "timeout"; break; }

            let level = tierLevel(tier);
            document.getElementById("trialStatus").textContent =
                t("trialRunningTier", { tier, level });

            // Re-level scaling enemies to this tier; give each a unique hrid.
            let enemies = enemyGroup.map((spec, i) => {
                let copy = structuredClone(spec);
                if (copy.scaling) copy.level = level;
                copy.hrid = "/custom_monsters/e" + (i + 1) + "_" +
                    (spec.name || "custom").toLowerCase().replace(/[^a-z0-9]+/g, "_");
                return { custom: copy };
            });

            let simResult = await runBattleOnWorker({
                players: playersToSim,
                enemies,
                timeCapSeconds: remainingSeconds,
            });

            let durationNs = simResult.battleDurationNs ?? simResult.simulatedTime ?? 0;
            let durationSeconds = durationNs / 1e9;
            remainingSeconds -= durationSeconds;

            let wiped = (simResult.playerFinalState || [])
                .filter((p) => p.currentHitpoints <= 0).length;

            // Lowest surviving enemy HP fraction (the "last boss" health).
            let enemyStates = simResult.enemyFinalState || [];
            let bossHpFrac = null;
            if (enemyStates.length) {
                let alive = enemyStates.filter((e) => e.currentHitpoints > 0);
                let ref = (alive.length ? alive : enemyStates)
                    .reduce((a, b) => (a.maxHitpoints ? a.currentHitpoints / a.maxHitpoints : 0)
                        <= (b.maxHitpoints ? b.currentHitpoints / b.maxHitpoints : 0) ? a : b);
                bossHpFrac = ref.maxHitpoints ? ref.currentHitpoints / ref.maxHitpoints : 0;
            }

            // Total OOM (ability casts blocked by lack of mana) across all players.
            let oomMap = simResult.playerOomCastCount || {};
            let oomTotal = Object.values(oomMap).reduce((a, n) => a + (Number(n) || 0), 0);
            // Accumulate per-player OOM across tiers for the roster-card badges.
            for (const [hrid, n] of Object.entries(oomMap)) {
                rosterOom[hrid] = (rosterOom[hrid] || 0) + (Number(n) || 0);
            }
            renderPlayerList(); // refresh card badges live as tiers complete

            tiers.push({
                tier, level,
                outcome: simResult.battleOutcome,
                durationSeconds,
                wiped,
                totalPlayers: (simResult.playerFinalState || []).length,
                bossHpFrac,
                oomTotal,
                // Full battle result kept so clicking the tier row can show the
                // same combat detail view the single-boss mode renders.
                result: simResult,
            });

            renderTrialModeResult(tiers, null); // live progress

            if (simResult.battleOutcome === "victory") {
                continue; // advance to next tier
            }
            // defeat / timeout / ended -> stop the run
            stopReason = simResult.battleOutcome;
            break;
        }
        // Falling out of the loop with every tier won means the whole ladder
        // was cleared; stopReason stays "completed".
    } catch (err) {
        showError(t("simulationErrorPrefix") + err);
    } finally {
        trialModeState.running = false;
        runBtn.disabled = false;
        document.getElementById("trialStatus").textContent = "";
    }

    renderTrialModeResult(tiers, stopReason);
}

function trialOutcomeLabel(outcome) {
    switch (outcome) {
        case "victory": return t("trialOutcomeVictory");
        case "defeat": return t("trialOutcomeDefeat");
        case "timeout": return t("trialOutcomeTimeout");
        default: return t("trialOutcomeEnded");
    }
}

// Renders the trial-mode summary + per-tier table. `stopReason` is null while
// the run is still in progress.
function renderTrialModeResult(tiers, stopReason) {
    const container = document.getElementById("trialModeResult");
    if (!tiers.length) { container.innerHTML = ""; return; }

    let reached = tiers[tiers.length - 1];
    let clearedThrough = tiers.filter((x) => x.outcome === "victory").length;

    let headline;
    if (stopReason === null) {
        headline = t("trialInProgress", { tier: reached.tier, level: reached.level });
    } else {
        headline = t("trialReachedTier", {
            tier: reached.tier, level: reached.level, cleared: clearedThrough,
        });
    }

    let rows = tiers.map((x, i) => {
        let bossHp = x.bossHpFrac == null ? "—"
            : (x.outcome === "victory" ? "0%" : (x.bossHpFrac * 100).toFixed(1) + "%");
        let wipeCls = x.wiped > 0 ? ' style="color:#ff6b6b;"' : "";
        // Rows with a stored result are clickable to open the combat-detail modal.
        let clickable = x.result ? ' class="trial-tier-row" data-tier-index="' + i + '" title="' + escapeHtml(t("clickForCombatDetails")) + '"' : "";
        let oom = x.oomTotal || 0;
        return `<tr${clickable}>
            <td>T${x.tier}</td>
            <td>L${x.level}</td>
            <td>${escapeHtml(trialOutcomeLabel(x.outcome))}</td>
            <td>${fmtTime(x.durationSeconds * 1e9)}</td>
            <td${wipeCls}>${x.wiped} / ${x.totalPlayers}</td>
            <td>${bossHp}</td>
            <td${oom > 0 ? ' style="color:#ffb347;"' : ""}>${oom}</td>
        </tr>`;
    }).join("");

    let lastBossNote = "";
    if (stopReason && stopReason !== "completed" && reached.bossHpFrac != null &&
        reached.outcome !== "victory") {
        lastBossNote = `<p class="hint">${escapeHtml(t("trialLastBossHp", {
            tier: reached.tier,
            pct: (reached.bossHpFrac * 100).toFixed(1),
        }))}</p>`;
    }

    container.innerHTML = `
        <h4 style="margin:6px 0;">${escapeHtml(headline)}</h4>
        ${lastBossNote}
        <table class="tbl">
            <thead><tr>
                <th>${escapeHtml(t("trialColTier"))}</th>
                <th>${escapeHtml(t("trialColLevel"))}</th>
                <th>${escapeHtml(t("trialColOutcome"))}</th>
                <th>${escapeHtml(t("trialColTime"))}</th>
                <th>${escapeHtml(t("trialColWiped"))}</th>
                <th>${escapeHtml(t("trialColBossHp"))}</th>
                <th title="${escapeHtml(t("oomTooltip"))}">${escapeHtml(t("trialColOom"))}</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
    container.style.display = "block";

    // Wire tier-row clicks to open the combat-detail modal for that tier.
    container.querySelectorAll(".trial-tier-row").forEach((row) => {
        row.addEventListener("click", () => {
            let x = tiers[Number(row.dataset.tierIndex)];
            if (x && x.result) openTrialResultModal(x);
        });
    });
}

// Combat-detail modal for one trial tier: renders the same content as the
// single-boss result (summary + damage done/taken + combat log) into the
// modal's own element IDs, so it's decoupled from the main result panel.
let trialModalLog = [];
function openTrialResultModal(tierRecord) {
    let overlay = document.getElementById("trialResultModalOverlay");
    let titleEl = document.getElementById("trialResultModalTitle");
    titleEl.textContent = t("trialTierResultTitle", { tier: tierRecord.tier, level: tierRecord.level });

    trialModalLog = tierRecord.result.battleLog || [];
    // Reset the modal's log filter/search so each open starts clean.
    document.getElementById("trialLogFilter").value = "all";
    document.getElementById("trialLogSearch").value = "";

    renderResult(tierRecord.result, false, IDS_MODAL);

    overlay.style.display = "flex";
    document.getElementById("trialResultModalClose").focus();
}

function closeTrialResultModal() {
    let overlay = document.getElementById("trialResultModalOverlay");
    if (overlay) overlay.style.display = "none";
}

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

// Element IDs for the two result render targets: the main single-boss panel
// (default) and the trial-tier modal. Passing IDS_MODAL lets renderResult and
// its helpers draw the same content into the modal without duplicating logic.
const IDS_MAIN = {
    summary: "resultSummary", damageTotals: "damageTotals", damageTaken: "damageTaken",
    combatLog: "combatLog", logCount: "logCount", logFilter: "logFilter", logSearch: "logSearch",
    logHideAura: "logHideAura", logPlayer: "logPlayer",
};
const IDS_MODAL = {
    summary: "trialResultSummary", damageTotals: "trialDamageTotals", damageTaken: "trialDamageTaken",
    combatLog: "trialCombatLog", logCount: "trialLogCount", logFilter: "trialLogFilter", logSearch: "trialLogSearch",
    logHideAura: "trialLogHideAura", logPlayer: "trialLogPlayer",
};

function renderResult(result, scrollTo = true, ids = IDS_MAIN) {
    if (ids === IDS_MAIN) {
        const panel = document.getElementById("resultPanel");
        panel.style.display = "block";
        if (scrollTo) {
            panel.scrollIntoView({ behavior: "smooth", block: "start" });
        }
    }

    const outcomeLabels = {
        victory: `<span class="outcome win">${escapeHtml(t("outcomeVictory"))}</span>`,
        defeat: `<span class="outcome lose">${escapeHtml(t("outcomeDefeat"))}</span>`,
        timeout: `<span class="outcome draw">${escapeHtml(t("outcomeTimeout"))}</span>`,
        ended: `<span class="outcome draw">${escapeHtml(t("outcomeEnded"))}</span>`,
    };

    let summary = `<div class="summary-row">${outcomeLabels[result.battleOutcome] || result.battleOutcome}</div>`;
    summary += `<div class="summary-row"><b>${escapeHtml(t("battleDuration"))}</b> ${fmtTime(result.battleDurationNs)}</div>`;

    // Player final states (incl. OOM = ability casts blocked by lack of mana)
    let oomMap = result.playerOomCastCount || {};
    summary += `<div class="final-states"><h4>${escapeHtml(t("players"))}</h4><table class="tbl"><thead><tr><th>${escapeHtml(t("name"))}</th><th>${escapeHtml(t("hp"))}</th><th>${escapeHtml(t("mp"))}</th><th>${escapeHtml(t("deaths"))}</th><th title="${escapeHtml(t("oomTooltip"))}">${escapeHtml(t("oomColumn"))}</th></tr></thead><tbody>`;
    for (const ps of result.playerFinalState || []) {
        let deaths = (result.deaths && result.deaths[ps.hrid]) || 0;
        let oom = oomMap[ps.hrid] || 0;
        let dead = ps.currentHitpoints <= 0;
        summary += `<tr class="${dead ? "dead" : ""}">
            <td>${escapeHtml(nameFor(ps.hrid, true))}</td>
            <td>${Math.round(ps.currentHitpoints)}/${ps.maxHitpoints}</td>
            <td>${Math.round(ps.currentManapoints)}/${ps.maxManapoints}</td>
            <td>${deaths}</td>
            <td${oom > 0 ? ' style="color:#ffb347;"' : ""}>${oom}</td></tr>`;
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

    document.getElementById(ids.summary).innerHTML = summary;

    // Damage totals (per source) and damage taken (per target/player)
    renderDamageTotals(result, ids);
    renderDamageTaken(result, ids);

    // Combat log
    if (ids === IDS_MAIN) {
        window.__battleLog = result.battleLog || [];
        window.__lastBattleResult = result;
    }
    populateLogPlayerSelect(ids, result.battleLog || []);
    renderLog(ids, result.battleLog || []);
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
// showTitle=false omits the <h4> heading (used when the section already has a
// collapsible <summary> providing the title, as in the trial modal).
function renderExpandableDamageTable(containerId, titleKey, groups, dur, rowIdPrefix, showTitle = true) {
    let rows = Object.values(groups).sort((a, b) => b.dmg - a.dmg);
    let html = `${showTitle ? `<h4>${escapeHtml(t(titleKey))}</h4>` : ""}<table class="tbl"><thead><tr>
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

function renderDamageTotals(result, ids = IDS_MAIN) {
    let dur = result.battleDurationNs / ONE_SECOND || 1;
    let doneGroups = aggregateAttacks(result.battleLog, "source");
    // rowIdPrefix must be unique per container so both tables (and the modal's
    // own tables) can be open simultaneously without colliding detail-row IDs.
    // The modal wraps each section in its own <details> summary, so skip the h4.
    renderExpandableDamageTable(ids.damageTotals, "damageDone", doneGroups, dur, ids.damageTotals + "_dd", ids === IDS_MAIN);
}

function renderDamageTaken(result, ids = IDS_MAIN) {
    let dur = result.battleDurationNs / ONE_SECOND || 1;
    let takenGroups = aggregateAttacks(result.battleLog, "target");
    renderExpandableDamageTable(ids.damageTaken, "damageTaken", takenGroups, dur, ids.damageTaken + "_dt", ids === IDS_MAIN);
}

// The ability/source hrids carried by a log entry, used to detect aura info.
function logEntryAbilityHrids(e) {
    return [e.ability, e.healSource, e.manaSource, e.consumable].filter(Boolean);
}

// Does this entry involve an aura ability (cast, heal, mana, etc.)?
function logEntryIsAura(e) {
    return logEntryAbilityHrids(e).some((h) => AURA_ABILITY_HRIDS.has(h));
}

// The acting unit for an entry (attacker/caster), as "hrid|isPlayer", or null
// if the entry has no single actor. Used for the "filter by player" dropdown.
function logEntryActor(e) {
    if (e.kind === "attack") return e.sourceIsPlayer ? e.source + "|1" : null;
    if (e.unit != null && e.isPlayer) return e.unit + "|1";
    return null;
}

// Rebuild the "filter by player" dropdown from the players that appear as
// actors in the current log. Preserves the current selection if still valid.
function populateLogPlayerSelect(ids, log) {
    let sel = document.getElementById(ids.logPlayer);
    if (!sel) return;
    let prev = sel.value;

    let seen = new Map(); // hrid -> name
    for (const e of log) {
        let actor = logEntryActor(e);
        if (!actor) continue;
        let hrid = actor.slice(0, -2); // strip "|1"
        if (!seen.has(hrid)) seen.set(hrid, nameFor(hrid, true));
    }

    let opts = `<option value="all">${escapeHtml(t("logAllPlayers"))}</option>`;
    for (const [hrid, name] of seen) {
        opts += `<option value="${escapeHtml(hrid)}">${escapeHtml(name)}</option>`;
    }
    sel.innerHTML = opts;
    // Restore prior selection if that player is still present.
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function renderLog(ids = IDS_MAIN, logOverride = null) {
    const filter = document.getElementById(ids.logFilter).value;
    const search = document.getElementById(ids.logSearch).value.trim().toLowerCase();
    const hideAura = document.getElementById(ids.logHideAura)?.checked;
    const playerSel = document.getElementById(ids.logPlayer);
    const playerFilter = playerSel ? playerSel.value : "all";
    const container = document.getElementById(ids.combatLog);
    let log = logOverride !== null ? logOverride : (window.__battleLog || []);

    let lines = [];
    for (const e of log) {
        if (filter !== "all" && e.kind !== filter) continue;
        if (hideAura && logEntryIsAura(e)) continue;
        if (playerFilter !== "all") {
            let actor = logEntryActor(e);
            if (!actor || actor.slice(0, -2) !== playerFilter) continue;
        }
        let line = formatLogEntry(e);
        if (search && !line.text.toLowerCase().includes(search)) continue;
        lines.push(line);
    }

    if (!lines.length) {
        container.innerHTML = `<div class="empty">${escapeHtml(t("noLogEntriesMatch"))}</div>`;
        document.getElementById(ids.logCount).textContent = 0;
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
    document.getElementById(ids.logCount).textContent = lines.length;
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
        renderPredefinedPresets();
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

    // Import sub-tabs (Group Builder / Paste JSON). Scope to [data-subtab] so
    // this doesn't also fire for the battle-mode tabs, which share the .subtab
    // visual class but carry data-modetab (that would call switchSubTab(undefined)
    // and hide every .subtabpanel, including the Group Builder).
    document.querySelectorAll(".subtab[data-subtab]").forEach((btn) => {
        btn.addEventListener("click", () => switchSubTab(btn.dataset.subtab));
    });

    // Player detail modal: close via ✕, clicking the backdrop, or Esc.
    document.getElementById("playerModalClose").addEventListener("click", closePlayerModal);
    document.getElementById("playerModalOverlay").addEventListener("click", (ev) => {
        if (ev.target.id === "playerModalOverlay") closePlayerModal();
    });
    document.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") {
            let overlay = document.getElementById("playerModalOverlay");
            if (overlay && overlay.style.display !== "none") closePlayerModal();
        }
    });

    // Players — Paste JSON sub-tab
    document.getElementById("importReplace").addEventListener("click", () => doImport(false));
    document.getElementById("importAppend").addEventListener("click", () => doImport(true));
    const clearRoster = () => {
        importedPlayers = [];
        rosterOom = {};
        renderPlayerList();
    };
    document.getElementById("clearPlayers").addEventListener("click", clearRoster);
    document.getElementById("clearPlayers2").addEventListener("click", clearRoster);

    // Players — Group Builder sub-tab
    document.getElementById("buildRoster").addEventListener("click", buildRoster);
    document.getElementById("addJsonPreset").addEventListener("click", addJsonPreset);
    document.getElementById("refreshEquipmentSets").addEventListener("click", refreshEquipmentSetPresets);
    refreshEquipmentSetPresets(); // initial load from localStorage

    // Predefined presets (dynamic from testPlayers folder): render rows with
    // clickable names + count inputs.
    renderPredefinedPresets();

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

    // Battle mode tabs (Single Boss / Trial Mode)
    document.querySelectorAll(".subtab[data-modetab]").forEach((btn) => {
        btn.addEventListener("click", () => switchModeTab(btn.dataset.modetab));
    });
    // Apply the default mode (Trial) so the tier selector starts frozen.
    switchModeTab(currentBattleMode);

    // Battle
    document.getElementById("runBattle").addEventListener("click", runBattle);
    document.getElementById("runTrial").addEventListener("click", runTrialMode);
    document.getElementById("logFilter").addEventListener("change", () => renderLog());
    document.getElementById("logSearch").addEventListener("input", () => renderLog());
    document.getElementById("logHideAura").addEventListener("change", () => renderLog());
    document.getElementById("logPlayer").addEventListener("change", () => renderLog());

    // Trial-tier result modal: log filter/search operate on the modal's own log.
    document.getElementById("trialLogFilter").addEventListener("change", () => renderLog(IDS_MODAL, trialModalLog));
    document.getElementById("trialLogSearch").addEventListener("input", () => renderLog(IDS_MODAL, trialModalLog));
    document.getElementById("trialLogHideAura").addEventListener("change", () => renderLog(IDS_MODAL, trialModalLog));
    document.getElementById("trialLogPlayer").addEventListener("change", () => renderLog(IDS_MODAL, trialModalLog));
    document.getElementById("trialResultModalClose").addEventListener("click", closeTrialResultModal);
    document.getElementById("trialResultModalOverlay").addEventListener("click", (ev) => {
        if (ev.target.id === "trialResultModalOverlay") closeTrialResultModal();
    });
    document.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") {
            let ov = document.getElementById("trialResultModalOverlay");
            if (ov && ov.style.display !== "none") closeTrialResultModal();
        }
    });

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
