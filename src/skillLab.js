// Skill Lab page logic. Loads a guild combat-trial export as the party, picks one member, and
// runs the whole party's fight once per kit variant for that member, several times each, on the
// wasm combat kernel (worker.js "start_skill_lab", see skillLabJob.js). The fight is the Group
// Battle page's, in either of its two modes: one fight at a chosen tier, or the Trial Mode ladder.
//
// English-only by project convention for new group-battle features. See docs/skill_lab.md.
import abilityDetailMap from "./combatsimulator/data/abilityDetailMap.json";
import itemDetailMap from "./combatsimulator/data/itemDetailMap.json";
import combatMonsterDetailMap from "./combatsimulator/data/combatMonsterDetailMap.json";
import monsterGroupsData from "./combatsimulator/data/monsterGroups.json";
import GROUP_BATTLE_REGEN_BUFFS from "./combatsimulator/data/groupBattleBuffs";
import { GUILD_BUILDINGS, guildBuildingBuffs } from "./combatsimulator/data/guildBuildings";
import Shrine from "./combatsimulator/shrine.js";
import { importSetToPlayerDTO, baselineAbilitySlots } from "./combatsimulator/importSet.js";
import { ABILITY_LIST, enemyPreview } from "./combatsimulator/skillLab.js";
import { parseGuildTrialRoster, guildTrialEntryToImportSet } from "./guildTrialImport.js";
import {
    playerDetailHtml, renderDetailedStatus, dtoToSoloExport, describeTrigger, abilityName, itemName,
} from "./playerDetailView.js";
import { raidClass } from "./combatClass.js";

const STORE_KEY = "mwiSkillLabConfigV3";
const PARTY_KEY = "mwiSkillLabPartyV1";
// Shared with the Group Battle page: the levels describe the guild, not one page.
const LS_GUILD_BUILDINGS_KEY = "mwiGuildBuildingLevels";
// Handoff key read by the standard simulator (main.js) to auto-import a build.
const SOLO_IMPORT_HANDOFF_KEY = "mwiSoloImportHandoff";

const SLOTS = 5;
const DEFAULT_RUNS = 10;
const MAX_RUNS = 50;
const DEFAULT_TIME_CAP = 3600;
const ABILITY_BY_HRID = ABILITY_LIST.reduce((acc, a) => (acc[a.hrid] = a, acc), {});

// Fixed seed ladder: run i of every kit uses the same seed, so the same config always gives the
// same numbers and two kits start from identical rolls.
const seedFor = (run) => 1000 + (run + 1) * 7919;

// One worker per core, leaving one for the page. Each holds its own kernel, and a long fight's
// battle log is tens of MB while it is being reduced, so the pool is capped.
const POOL_SIZE = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));

const BUILDING_LABELS = {
    diningRoom: "Dining Room",
    library: "Library",
    dojo: "Dojo",
    armory: "Armory",
    gym: "Gym",
    archeryRange: "Archery Range",
    mysticalStudy: "Mystical Study",
};

const MONSTER_GROUPS = (monsterGroupsData.groups || []).map((g) => ({
    name: g.name,
    trialHrid: g.trialHrid || "",
    members: (g.members || []).filter((m) => combatMonsterDetailMap[m.hrid]),
}));

// ------------------------------------------------------------- ability levels

// The level for an ability the player's level is unknown for: 60 for the 0-cooldown spells
// (Entangle, Fireball, Water Strike), 20 for auras and other special abilities, 40 for everything
// else. Read off the game data rather than listed, so a new ability lands in the right bucket.
function defaultAbilityLevel(hrid) {
    const a = abilityDetailMap[hrid];
    if (!a) return 1;
    if (a.cooldownDuration === 0) return 60;
    if (a.isSpecialAbility) return 20;
    return 40;
}

// ---------------------------------------------------------------------- state

// party = { sourceName, trialHrid, members: [{ name, noLoadout, importSet }] } | null.
// Members are kept as import sets, not DTOs: a variant is the same import set with a different
// ability list (importSetToPlayerDTO's abilityOverride), so triggers resolve the same way the
// Group Battle import resolves them.
let party = loadParty();
let state = loadState();
let guildBuildingLevels = loadGuildBuildingLevels();

let running = false;
let pool = [];
let lastResult = null;

function defaultState() {
    return {
        mode: "trial",
        groupName: MONSTER_GROUPS[0] ? MONSTER_GROUPS[0].name : "",
        level: 170,
        trialBudget: DEFAULT_TIME_CAP,
        singleCap: DEFAULT_TIME_CAP,
        runs: DEFAULT_RUNS,
        focusName: "",
        nextId: 2,
        variants: [],
    };
}

function loadState() {
    let s = defaultState();
    try {
        const raw = localStorage.getItem(STORE_KEY);
        if (raw) s = { ...s, ...JSON.parse(raw) };
    } catch (e) {
        /* fall back to the defaults */
    }
    if (!MONSTER_GROUPS.some((g) => g.name === s.groupName)) s.groupName = defaultState().groupName;
    if (party && focusIndex(s) < 0) s.focusName = party.members[0].name;
    if (party && !s.variants.length) s.variants = [baselineVariant(1, party.members[focusIndex(s)])];
    return s;
}

function saveState() {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
        /* storage unavailable: the page still works, it just won't remember */
    }
}

function loadParty() {
    try {
        const p = JSON.parse(localStorage.getItem(PARTY_KEY));
        return p && Array.isArray(p.members) && p.members.length ? p : null;
    } catch (e) {
        return null;
    }
}

// Returns false when the party is too large to remember; it still works for this session.
function saveParty() {
    try {
        localStorage.setItem(PARTY_KEY, JSON.stringify(party));
        return true;
    } catch (e) {
        return false;
    }
}

function loadGuildBuildingLevels() {
    let stored = {};
    try {
        stored = JSON.parse(localStorage.getItem(LS_GUILD_BUILDINGS_KEY)) || {};
    } catch (e) {
        stored = {};
    }
    const levels = {};
    for (const b of GUILD_BUILDINGS) levels[b.id] = Math.max(0, Number(stored[b.id]) || 0);
    return levels;
}

function saveGuildBuildingLevels() {
    try {
        localStorage.setItem(LS_GUILD_BUILDINGS_KEY, JSON.stringify(guildBuildingLevels));
    } catch (e) {
        /* the levels still apply for this session */
    }
}

function focusIndex(s = state) {
    return party ? party.members.findIndex((m) => m.name === s.focusName) : -1;
}

function focusMember() {
    const i = focusIndex();
    return i >= 0 ? party.members[i] : null;
}

// ------------------------------------------------------------------ players

// A member's DTO, optionally with a different ability bar. Mirrors guildTrialEntryToPlayerDTO:
// pad the compacted ability list back to five slots and zero the level-gap debuff.
function memberDTO(member, hrid, kit = null) {
    const dto = importSetToPlayerDTO(member.importSet, hrid, kit);
    while (dto.abilities.length < SLOTS) dto.abilities.push(null);
    dto.debuffOnLevelGap = 0;
    return dto;
}

// The level an ability starts at in a kit: the member's own level when they have it equipped, else
// the default. The export only carries levels for equipped abilities (docs/group_battle.md §4.1),
// so anything else is unknown.
function abilityLevelFor(member, hrid) {
    const own = member && baselineAbilitySlots(member.importSet).find((s) => s && s.hrid === hrid);
    return own ? own.level : defaultAbilityLevel(hrid);
}

// The member's own bar at their own levels.
function baselineKit(member) {
    return baselineAbilitySlots(member.importSet).map((slot) => (slot ? { ...slot } : null));
}

function baselineVariant(id, member) {
    return { id, label: "Baseline", kit: member ? baselineKit(member) : [null, null, null, null, null] };
}

function memberWeapon(member) {
    const eq = (member.importSet.player && member.importSet.player.equipment) || [];
    const item = eq.find((i) => i.itemLocationHrid === "/item_locations/main_hand")
        || eq.find((i) => i.itemLocationHrid === "/item_locations/two_hand");
    return item || null;
}

// The combat style the member attacks with, from their weapon.
function memberStyle(member) {
    const weapon = member && memberWeapon(member);
    const stats = weapon && itemDetailMap[weapon.itemHrid]
        && itemDetailMap[weapon.itemHrid].equipmentDetail
        && itemDetailMap[weapon.itemHrid].equipmentDetail.combatStats;
    const styles = stats && stats.combatStyleHrids;
    return styles && styles.length ? styles[0] : "";
}

// The member's raid class (Wark, Smash, ..., Nature Support, Water Support) from their weapon and
// their own bar as imported, with the same name, colour and order as the Group Battle roster.
function memberClass(member) {
    const weapon = member && memberWeapon(member);
    const bar = member ? baselineAbilitySlots(member.importSet).filter(Boolean).map((s) => s.hrid) : [];
    return raidClass(weapon ? weapon.itemHrid : "", bar);
}

function classChip(c) {
    return `<span class="class-chip" style="background:${c.color}">${esc(c.label)}</span>`;
}

// Party members in class order, keeping import order within a class. Each entry keeps its import
// index, which is what the member's player hrid and the focus selection are keyed on.
function membersByClass() {
    return party.members
        .map((m, i) => ({ m, i, c: memberClass(m) }))
        .sort((a, b) => a.c.rank - b.c.rank || a.i - b.i);
}

// The extra-buff stack every group battle player fights with (worker.js builds the same one), so
// the preview's combat status matches the run.
function extraBuffsFor(dto) {
    return GROUP_BATTLE_REGEN_BUFFS
        .concat(guildBuildingBuffs(guildBuildingLevels))
        .concat(Shrine.buffsFromLevels(dto.shrines));
}

// ------------------------------------------------------------------ helpers

const el = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
const fmt = (n, d = 0) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const shortName = (hrid) => (ABILITY_BY_HRID[hrid] ? ABILITY_BY_HRID[hrid].name : String(hrid).split("/").pop());

function showError(msg) {
    const box = el("errorBox");
    box.textContent = msg;
    box.style.display = msg ? "block" : "none";
}

// A damage or heal source key from the result, as a readable name. Abilities are full hrids,
// weapon procs log under a bare one ("bloom"), and auto attacks and damage over time have their
// own keys (docs/harness.md §6).
function sourceName(key) {
    if (key === "autoAttack") return "Auto attack";
    if (key === "damageOverTime") return "Damage over time";
    if (abilityDetailMap[key]) return abilityName(key);
    if (abilityDetailMap["/abilities/" + key]) return abilityName("/abilities/" + key) + " (proc)";
    if (key.startsWith("/items/")) return itemName(key);
    return key;
}

function kitText(kit) {
    const parts = (kit || []).filter((s) => s && s.hrid).map((s) => `${shortName(s.hrid)} ${s.level}`);
    return parts.length ? parts.join(" · ") : "no abilities";
}

// ------------------------------------------------------------- party import

function importParty(text, sourceName) {
    let roster;
    try {
        roster = parseGuildTrialRoster(text);
    } catch (e) {
        showError("Could not read the file as a guild trial export: " + e.message);
        return;
    }
    if (!roster.members.length) {
        showError("No members found in that file.");
        return;
    }

    const errors = [];
    const members = [];
    for (const m of roster.members) {
        try {
            const importSet = guildTrialEntryToImportSet(m.entry);
            memberDTO({ importSet }, "check"); // fail here, not mid-run, on a member the sim can't build
            members.push({ name: m.name, noLoadout: !m.hasLoadout, importSet });
        } catch (e) {
            errors.push(m.name + ": " + e.message);
        }
    }
    if (!members.length) {
        showError("No member could be imported:\n" + errors.join("\n"));
        return;
    }

    party = { sourceName, trialHrid: roster.primaryTrial, trials: roster.trials, members };
    const remembered = saveParty();

    // Point the enemy at the trial's monster, as the Group Battle import does.
    const tail = String(roster.primaryTrial || "").replace(/^.*\//, "");
    const group = MONSTER_GROUPS.find((g) => g.trialHrid === roster.primaryTrial)
        || MONSTER_GROUPS.find((g) => g.members.some((mem) => mem.hrid === "/monsters/trial_" + tail));
    if (group) state.groupName = group.name;
    party.switchedTo = group ? group.name : "";
    party.remembered = remembered;

    // Keep the same player selected across a re-export if they are still in the guild.
    if (focusIndex() < 0) setFocus(members[0].name);
    else state.variants = state.variants.length ? state.variants : [baselineVariant(state.nextId++, focusMember())];

    lastResult = null;
    saveState();
    renderAll();
    showError(errors.length ? `Imported with ${errors.length} error(s):\n` + errors.join("\n") : "");
}

function initPartyImport() {
    const input = el("partyFile");
    const drop = el("partyDrop");
    const read = (file) => {
        if (!file) return;
        file.text()
            .then((text) => importParty(text, file.name))
            .catch((e) => showError("Could not read the file: " + e.message));
    };
    input.addEventListener("change", () => {
        read(input.files[0]);
        input.value = ""; // so re-picking the same file fires "change" again
    });
    drop.addEventListener("click", () => input.click());
    drop.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
    });
    ["dragenter", "dragover"].forEach((type) => drop.addEventListener(type, (e) => {
        e.preventDefault();
        drop.classList.add("dragging");
    }));
    ["dragleave", "drop"].forEach((type) => drop.addEventListener(type, (e) => {
        e.preventDefault();
        drop.classList.remove("dragging");
    }));
    drop.addEventListener("drop", (e) => read(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]));
}

function renderParty() {
    const status = el("partyStatus");
    const rosterHost = el("partyRoster");
    if (!party) {
        status.innerHTML = `<span class="dim">No party loaded yet.</span>`;
        rosterHost.innerHTML = "";
        return;
    }

    const noLoadout = party.members.filter((m) => m.noLoadout);
    let html = `<div><b>${party.members.length}</b> members from <span class="dim">${esc(party.sourceName || "the export")}</span>.</div>`;
    if (party.switchedTo) html += `<div>Enemy set to <b>${esc(party.switchedTo)}</b>.</div>`;
    else if (party.trialHrid) html += `<div class="warn-box">No monster group matches the trial ${esc(party.trialHrid)}. Pick the group by hand.</div>`;
    if ((party.trials || []).length > 1) {
        html += `<div class="warn-box">This file mixes several trials. Every member is simulated against the most common one.</div>`;
    }
    if (noLoadout.length) {
        html += `<div class="warn-box">${noLoadout.length} member(s) saved no trial loadout and fight with whatever they had equipped:
            <span class="dim">${esc(noLoadout.map((m) => m.name).join(", "))}</span></div>`;
    }
    if (party.remembered === false) {
        html += `<div class="warn-box">The party is too large to remember in this browser. It works until you reload.</div>`;
    }
    status.innerHTML = html;

    const fi = focusIndex();
    rosterHost.innerHTML = `
        <details class="roster">
            <summary>Show the party (${party.members.length}). Click a member to select them.</summary>
            <table>
                <thead><tr><th>#</th><th>Member</th><th>Class</th><th>Weapon</th><th style="text-align:left">Abilities (as imported)</th></tr></thead>
                <tbody>
                    ${membersByClass().map(({ m, i, c }, pos) => {
                        const weapon = memberWeapon(m);
                        const own = baselineAbilitySlots(m.importSet).filter(Boolean)
                            .map((s) => `${shortName(s.hrid)} ${s.level}`).join(" · ");
                        return `<tr class="member-row${i === fi ? " is-focus" : ""}" data-member="${i}">
                            <td>${pos + 1}</td>
                            <td>${esc(m.name)}${m.noLoadout ? ' <span class="warn" title="No saved trial loadout">⚠</span>' : ""}</td>
                            <td style="text-align:left">${classChip(c)}</td>
                            <td class="dim">${weapon ? esc(itemName(weapon.itemHrid)) + (weapon.enhancementLevel ? " +" + weapon.enhancementLevel : "") : "—"}</td>
                            <td class="kit-cell">${esc(own || "none")}</td>
                        </tr>`;
                    }).join("")}
                </tbody>
            </table>
        </details>`;
}

// --------------------------------------------------------- guild buildings

function renderBuildings() {
    el("buildingList").innerHTML = GUILD_BUILDINGS.map((b) => `
        <label><span>${esc(BUILDING_LABELS[b.id] || b.id)}</span>
            <input type="number" min="0" step="1" data-building="${b.id}" value="${guildBuildingLevels[b.id] || 0}">
        </label>`).join("");
}

// -------------------------------------------------------------- fight panel

function renderFight() {
    document.querySelectorAll(".subtab[data-mode]").forEach((b) => {
        const on = b.dataset.mode === state.mode;
        b.classList.toggle("active", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
    });

    const trial = state.mode === "trial";
    el("modeHint").innerHTML = trial
        ? `A ladder of escalating tiers (T1 = L100, +10 levels per tier, up to T21) on one shared time budget.
           Every tier starts the party at full HP and MP. The run stops at the first tier the party fails to clear,
           or when the budget runs out. Damage is summed over every tier fought.`
        : `One fight at the chosen tier, until the enemy dies, the party wipes or the time cap is hit.`;

    const groupSel = el("groupSelect");
    if (!groupSel.options.length) {
        groupSel.innerHTML = MONSTER_GROUPS.map((g) => `<option value="${esc(g.name)}">${esc(g.name)}</option>`).join("");
    }
    groupSel.value = state.groupName;

    const levelSel = el("levelSelect");
    if (!levelSel.options.length) {
        let html = "";
        for (let lv = 100; lv <= 300; lv += 10) html += `<option value="${lv}">L${lv} (T${(lv - 100) / 10 + 1})</option>`;
        levelSel.innerHTML = html;
    }
    levelSel.value = trial ? 100 : state.level;
    levelSel.disabled = trial;
    el("levelWrap").style.opacity = trial ? "0.5" : "1";
    el("levelWrap").title = trial ? "Trial Mode always starts at T1" : "";

    el("capLabel").textContent = trial ? "time budget (s)" : "time cap (s)";
    el("timeCap").value = trial ? state.trialBudget : state.singleCap;
    el("runCount").value = state.runs;

    renderEnemyPreview();
}

function renderEnemyPreview() {
    const size = party ? party.members.length : 0;
    const level = state.mode === "trial" ? 100 : Number(state.level);
    let preview;
    try {
        preview = enemyPreview(state.groupName, level, size || 1);
    } catch (e) {
        preview = { enemies: [], totalHp: 0 };
    }
    el("enemyPreview").innerHTML = `
        <div class="stat-row">
            <div class="stat"><span>Party size</span><b>${size}</b></div>
            <div class="stat"><span>Group HP${state.mode === "trial" ? " at T1" : ""}</span><b>${fmt(preview.totalHp)}</b></div>
            <div class="stat"><span>HP scaling</span><b>+${size}%</b></div>
            <div class="stat"><span>Ability haste</span><b>+${size * 2}</b></div>
        </div>
        <table class="mini">
            <thead><tr><th>Enemy</th><th>Max HP</th><th>Armor</th><th>Eva melee</th><th>Eva ranged</th><th>Eva magic</th></tr></thead>
            <tbody>
                ${preview.enemies.map((e) => `
                    <tr>
                        <td>${esc(e.name)}</td>
                        <td>${fmt(e.maxHitpoints)}</td>
                        <td>${fmt(e.armor)}</td>
                        <td>${fmt(e.evasion.melee)}</td>
                        <td>${fmt(e.evasion.ranged)}</td>
                        <td>${fmt(e.evasion.magic)}</td>
                    </tr>`).join("")}
            </tbody>
        </table>`;
}

// -------------------------------------------------------------- focus panel

function setFocus(name) {
    state.focusName = name;
    // Kits are built around one player's weapon, so a new player starts over from their own bar.
    state.variants = [baselineVariant(state.nextId++, focusMember())];
    lastResult = null;
}

function renderFocus() {
    const sel = el("focusSelect");
    if (!party) {
        sel.innerHTML = `<option value="">Load a party first</option>`;
        sel.disabled = true;
        el("focusPreview").disabled = true;
        el("focusSummary").textContent = "";
        return;
    }
    sel.disabled = false;
    el("focusPreview").disabled = false;
    // Grouped by class, in the roster's order.
    const groups = [];
    for (const { m, c } of membersByClass()) {
        const label = c.label;
        if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, members: [] });
        groups[groups.length - 1].members.push(m);
    }
    sel.innerHTML = groups.map((g) => `<optgroup label="${esc(g.label)}">${g.members.map((m) =>
        `<option value="${esc(m.name)}"${m.name === state.focusName ? " selected" : ""}>${esc(m.name)}</option>`).join("")}</optgroup>`).join("");

    const m = focusMember();
    if (!m) { el("focusSummary").textContent = ""; return; }
    const weapon = memberWeapon(m);
    const own = baselineAbilitySlots(m.importSet).filter(Boolean)
        .map((s) => `${shortName(s.hrid)} ${s.level}`).join(" · ");
    el("focusSummary").innerHTML = `
        ${weapon ? `Weapon <b>${esc(itemName(weapon.itemHrid))}${weapon.enhancementLevel ? " +" + weapon.enhancementLevel : ""}</b>. ` : "No weapon. "}
        Own bar: ${esc(own || "none")}.
        ${m.noLoadout ? '<span class="warn">No saved trial loadout, so this is what they had equipped.</span>' : ""}`;
}

// ------------------------------------------------------------- kits panel

function abilityOptions(selected) {
    let html = `<option value="">— empty —</option>`;
    for (const a of ABILITY_LIST) {
        html += `<option value="${esc(a.hrid)}"${a.hrid === selected ? " selected" : ""}>${esc(a.name)}</option>`;
    }
    return html;
}

function slotMeta(hrid, style, member) {
    const a = ABILITY_BY_HRID[hrid];
    if (!a) return `<span class="slot-meta dim">empty slot</span>`;
    const bits = [a.style === "buff" ? "buff" : a.style];
    if (a.isAoe) bits.push("AoE");
    bits.push(a.cooldown ? `cd ${a.cooldown}s` : "no cd");
    bits.push(`${a.manaCost} mp`);
    if (a.castDuration) bits.push(`cast ${a.castDuration}s`);

    // A damage ability resolves on its own style's accuracy and max damage. If that isn't the
    // weapon's style, the gear does not buff it.
    let warn = "";
    const abilityStyle = a.style && a.style !== "buff" ? "/combat_styles/" + a.style.split("/")[0] : "";
    if (abilityStyle && style && abilityStyle !== style) {
        const name = abilityStyle.split("/").pop();
        warn = `<span class="slot-warn" title="This ability uses ${name} accuracy and damage, which this player's weapon does not buff.">⚠ uses ${name}</span>`;
    }

    // The member's own triggers for this ability when they have set any, else the game defaults.
    const own = member && (member.importSet.triggerMap || {})[hrid];
    const triggers = own || (abilityDetailMap[hrid].defaultCombatTriggers || []);
    const lines = triggers.map((t) => describeTrigger(t)).join("\n") || "no condition: casts whenever ready";
    const trig = `<span class="slot-trig" title="${esc(lines)}">${own ? "own triggers" : "default triggers"}</span>`;

    return `<span class="slot-meta">${esc(bits.join(" · "))}</span>${warn}${trig}`;
}

function renderVariants() {
    const host = el("variantList");
    const member = focusMember();
    if (!member) {
        host.innerHTML = `<div class="hint" style="margin:0 0 10px">Load a party and pick a player to set up kits.</div>`;
        return;
    }
    const style = memberStyle(member);
    const color = memberClass(member).color;
    host.innerHTML = state.variants.map((v, idx) => `
        <div class="variant" data-idx="${idx}" style="border-left-color:${color}">
            <div class="variant-head">
                <input class="variant-label" data-field="label" value="${esc(v.label)}" aria-label="Kit name">
                ${idx === 0 ? '<span class="tag baseline">baseline</span>' : ""}
                <span class="grow"></span>
                <button type="button" class="btn small" data-act="preview" title="Preview the player with this kit">👁 preview</button>
                <button type="button" class="btn small" data-act="copy" title="Add a copy of this kit below it">＋ kit</button>
                ${state.variants.length > 1 ? '<button type="button" class="btn small danger" data-act="remove" title="Remove this kit">✕</button>' : ""}
            </div>
            <div class="slots">
                ${[0, 1, 2, 3, 4].map((i) => {
                    const slot = (v.kit || [])[i] || null;
                    return `
                    <div class="slot">
                        <span class="slot-no">${i === 0 ? "special" : i + 1}</span>
                        <select data-slot="${i}" data-field="slotHrid" aria-label="Slot ${i + 1} ability">${abilityOptions(slot && slot.hrid)}</select>
                        <input type="number" min="1" max="200" data-slot="${i}" data-field="slotLevel"
                               value="${slot ? Number(slot.level) || 1 : ""}" ${slot ? "" : "disabled"} aria-label="Slot ${i + 1} level">
                        <span>${slotMeta(slot && slot.hrid, style, member)}</span>
                    </div>`;
                }).join("")}
            </div>
        </div>`).join("");
}

function onVariantInput(e) {
    const card = e.target.closest(".variant");
    if (!card) return;
    const v = state.variants[Number(card.dataset.idx)];
    if (!v) return;
    const field = e.target.dataset.field;
    const i = Number(e.target.dataset.slot);

    if (field === "label") {
        v.label = e.target.value;
    } else if (field === "slotHrid") {
        const hrid = e.target.value;
        v.kit[i] = hrid ? { hrid, level: abilityLevelFor(focusMember(), hrid) } : null;
        renderVariants();
    } else if (field === "slotLevel") {
        if (v.kit[i]) v.kit[i].level = Math.max(1, Math.min(200, Number(e.target.value) || 1));
    } else {
        return;
    }
    saveState();
}

function onVariantClick(e) {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const idx = Number(btn.closest(".variant").dataset.idx);
    const v = state.variants[idx];
    if (!v) return;

    if (btn.dataset.act === "preview") {
        openPreview(`${state.focusName} — ${v.label}`, v.kit);
        return;
    }
    if (btn.dataset.act === "copy") {
        state.variants.splice(idx + 1, 0, {
            id: state.nextId++,
            label: "Kit " + (state.variants.length + 1),
            kit: v.kit.map((s) => (s ? { ...s } : null)),
        });
    } else if (btn.dataset.act === "remove" && state.variants.length > 1) {
        state.variants.splice(idx, 1);
    }
    saveState();
    renderVariants();
}

// ------------------------------------------------------------------ preview

function openPreview(title, kit) {
    const member = focusMember();
    if (!member) return;
    const dto = memberDTO(member, "preview", kit);
    el("previewTitle").textContent = title;
    const body = el("previewBody");
    body.innerHTML = `<div class="row" style="margin-bottom:6px">
            <button type="button" class="btn small export-json-btn">⧉ Export JSON</button>
            <button type="button" class="btn small open-sim-btn">↗ Open in simulator</button>
            <span class="export-status hint" style="margin:0"></span>
        </div>` + playerDetailHtml(dto);

    const status = body.querySelector(".export-status");
    const statusBtn = body.querySelector(".show-status-btn");
    statusBtn.addEventListener("click", () => {
        const panel = body.querySelector(".detailed-status");
        const open = panel.style.display !== "none";
        if (open) {
            panel.style.display = "none";
            statusBtn.textContent = "Show Detailed Combat Status";
        } else {
            renderDetailedStatus(panel, dto, undefined, extraBuffsFor(dto));
            panel.style.display = "block";
            statusBtn.textContent = "Hide Detailed Combat Status";
        }
    });
    body.querySelector(".export-json-btn").addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(JSON.stringify(dtoToSoloExport(dto)));
            status.textContent = "Copied to clipboard.";
        } catch (e) {
            status.textContent = "Copy failed: clipboard unavailable.";
        }
    });
    body.querySelector(".open-sim-btn").addEventListener("click", () => {
        try {
            localStorage.setItem(SOLO_IMPORT_HANDOFF_KEY, JSON.stringify(dtoToSoloExport(dto)));
        } catch (e) {
            status.textContent = "Could not hand the build over: storage unavailable.";
            return;
        }
        window.open("index.html", "_blank", "noopener");
    });

    el("previewOverlay").style.display = "flex";
    el("previewClose").focus();
}

function closePreview() {
    el("previewOverlay").style.display = "none";
}

// ---------------------------------------------------------------------- run

function enemyPayload() {
    const group = MONSTER_GROUPS.find((g) => g.name === state.groupName);
    const hrids = [];
    for (const m of (group ? group.members : [])) {
        for (let c = 0; c < (m.count || 1); c++) hrids.push(m.hrid);
    }
    // Unique hrids per copy, as buildWorkerEnemies on the Group Battle page assigns them. The level
    // is set per fight by skillLabJob.js.
    return hrids.map((hrid, i) => ({
        trial: true, hrid, level: 100,
        name: combatMonsterDetailMap[hrid].name,
        uniqueHrid: hrid + "#" + (i + 1),
    }));
}

function getPool() {
    while (pool.length < POOL_SIZE) pool.push(new Worker(new URL("worker.js", import.meta.url)));
    return pool;
}

// Stops every worker mid-job. The next run starts a fresh pool.
function killPool() {
    for (const w of pool) w.terminate();
    pool = [];
}

// Runs every job across the pool, one job per worker at a time. Resolves with the results in job
// order; rejects on the first kernel error.
function runJobs(jobs, onProgress) {
    return new Promise((resolve, reject) => {
        const results = new Array(jobs.length);
        let next = 0;
        let done = 0;
        const workers = getPool().slice(0, Math.min(POOL_SIZE, jobs.length));
        const feed = (w) => {
            if (next >= jobs.length) return;
            const id = next++;
            w.postMessage({ type: "start_skill_lab", id, job: jobs[id] });
        };
        for (const w of workers) {
            w.onmessage = (e) => {
                const data = e.data;
                if (data.type === "skill_lab_result") {
                    results[data.id] = data.run;
                    done++;
                    onProgress(done, jobs.length);
                    if (done === jobs.length) resolve(results);
                    else feed(w);
                } else if (data.type === "simulation_error") {
                    reject(new Error(data.error));
                }
            };
            w.onerror = (e) => reject(new Error(e.message || "worker failed to start"));
            feed(w);
        }
    });
}

async function run() {
    if (running) {
        // The button reads "Stop" while a run is going.
        killPool();
        finishRun("Stopped.");
        return;
    }
    const member = focusMember();
    if (!party || !member) { showError("Load a party and pick a player first."); return; }
    showError("");

    const fi = focusIndex();
    const focusHrid = "player" + (fi + 1);
    const basePlayers = party.members.map((m, i) => memberDTO(m, "player" + (i + 1)));
    const enemies = enemyPayload();
    if (!enemies.length) { showError("The selected monster group has no known monsters."); return; }

    const trial = state.mode === "trial";
    const settings = {
        mode: state.mode,
        groupName: state.groupName,
        level: trial ? 100 : Number(state.level),
        timeCapSeconds: trial ? state.trialBudget : state.singleCap,
        runs: Math.max(1, Math.min(MAX_RUNS, Number(state.runs) || DEFAULT_RUNS)),
        focusName: member.name,
        partySize: basePlayers.length,
        guildBuildingLevels: { ...guildBuildingLevels },
    };
    const variants = state.variants.map((v) => ({ id: v.id, label: v.label, kit: v.kit.map((s) => (s ? { ...s } : null)) }));

    // Interleaved by run, so every kit has some results early and progress reads evenly.
    const jobs = [];
    const index = [];
    const playersByVariant = variants.map((v) => {
        const players = basePlayers.slice();
        players[fi] = memberDTO(member, focusHrid, v.kit);
        return players;
    });
    for (let r = 0; r < settings.runs; r++) {
        variants.forEach((v, vi) => {
            jobs.push({
                players: playersByVariant[vi],
                enemies,
                guildBuildingLevels: settings.guildBuildingLevels,
                focusHrid,
                mode: settings.mode,
                level: settings.level,
                timeCapSeconds: settings.timeCapSeconds,
                seed: seedFor(r),
            });
            index.push(vi);
        });
    }

    running = true;
    el("runBtn").textContent = "Stop";
    el("progress").style.display = "block";
    el("progress").textContent = `Running 0 of ${jobs.length} runs on ${Math.min(POOL_SIZE, jobs.length)} workers…`;
    const t0 = performance.now();

    try {
        const results = await runJobs(jobs, (done, total) => {
            if (!running) return;
            el("progress").textContent = `Running: ${done} of ${total} runs done…`;
        });
        if (!running) return; // stopped while the last results were in flight
        const perVariant = variants.map(() => []);
        results.forEach((r, i) => perVariant[index[i]].push(r));
        lastResult = {
            settings,
            wallSeconds: (performance.now() - t0) / 1000,
            variants: variants.map((v, vi) => aggregate(v, perVariant[vi])),
        };
        finishRun("");
        renderResult();
        el("resultPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
        if (!running) return;
        killPool(); // other workers may still be busy with this run's jobs
        finishRun("");
        showError("Simulation failed: " + e.message);
    }
}

function finishRun(message) {
    running = false;
    el("runBtn").textContent = "Run simulation";
    el("progress").style.display = message ? "block" : "none";
    el("progress").textContent = message;
}

// ---------------------------------------------------------------- aggregate

function mean(xs) {
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function sd(xs) {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

// One kit's runs, averaged. Damage per second is total damage over total fight time, a true rate
// rather than an average of rates.
function aggregate(variant, runs) {
    const n = runs.length;
    const dmg = runs.map((r) => r.dmg);
    const sum = (k) => runs.reduce((s, r) => s + r[k], 0);
    const seconds = sum("seconds");

    const perAbility = {};
    const casts = {};
    const perHeal = {};
    for (const r of runs) {
        for (const [k, v] of Object.entries(r.perAbility)) {
            const e = (perAbility[k] = perAbility[k] || { dmg: 0, hits: 0, misses: 0 });
            e.dmg += v.dmg / n;
            e.hits += v.hits / n;
            e.misses += v.misses / n;
        }
        for (const [k, v] of Object.entries(r.casts)) casts[k] = (casts[k] || 0) + v / n;
        for (const [k, v] of Object.entries(r.perHeal)) perHeal[k] = (perHeal[k] || 0) + v / n;
    }

    // Trial Mode: per tier, how many runs reached it and what the player did there.
    const tiers = {};
    for (const r of runs) {
        for (const t of r.tiers) {
            const key = t.tier || 1;
            const e = (tiers[key] = tiers[key] || { tier: key, level: t.level, reached: 0, cleared: 0, dmg: 0, seconds: 0 });
            e.reached++;
            if (t.outcome === "victory") e.cleared++;
            e.dmg += t.dmg;
            e.seconds += t.seconds;
        }
    }

    const outcomes = {};
    for (const r of runs) outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;

    return {
        id: variant.id,
        label: variant.label,
        kit: variant.kit,
        n,
        dmg: mean(dmg),
        dmgSd: sd(dmg),
        // 95% confidence half-width of the mean. Kits closer than this are not separated.
        dmgCi: n > 1 ? 1.96 * sd(dmg) / Math.sqrt(n) : 0,
        dmgMin: Math.min(...dmg),
        dmgMax: Math.max(...dmg),
        dps: seconds ? sum("dmg") / seconds : 0,
        seconds: seconds / n,
        share: sum("raidDmg") ? sum("dmg") / sum("raidDmg") : 0,
        hits: sum("hits"),
        misses: sum("misses"),
        heal: sum("heal") / n,
        oom: sum("oom") / n,
        deaths: sum("deaths") / n,
        cleared: sum("cleared") / n,
        progress: sum("progress") / n,
        bossHpFrac: sum("bossHpFrac") / n,
        outcomes,
        perAbility, casts, perHeal,
        tiers: Object.values(tiers).sort((a, b) => a.tier - b.tier),
        runs: runs.map((r) => ({
            seed: r.seed, outcome: r.outcome, seconds: r.seconds, dmg: r.dmg,
            cleared: r.cleared, bossHpFrac: r.bossHpFrac, lastTier: r.tiers.length ? r.tiers[r.tiers.length - 1].tier : null,
        })),
    };
}

// ------------------------------------------------------------------ results

const OUTCOME_LABELS = {
    victory: { text: "kill", cls: "good" },
    defeat: { text: "wipe", cls: "bad" },
    timeout: { text: "time cap", cls: "warn" },
    ended: { text: "stalemate", cls: "warn" },
    completed: { text: "all tiers", cls: "good" },
};

function outcomeText(outcomes) {
    return Object.entries(outcomes)
        .map(([o, c]) => `<span class="${(OUTCOME_LABELS[o] || {}).cls || ""}">${c}× ${esc((OUTCOME_LABELS[o] || { text: o }).text)}</span>`)
        .join(" · ");
}

function deltaHtml(value, base) {
    if (!base) return '<span class="dim">—</span>';
    const pct = (value / base - 1) * 100;
    const cls = pct > 0.5 ? "good" : pct < -0.5 ? "bad" : "dim";
    return `<span class="${cls}">${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%</span>`;
}

function renderResult() {
    const panel = el("resultPanel");
    if (!lastResult) { panel.style.display = "none"; return; }
    panel.style.display = "block";

    const { settings, variants, wallSeconds } = lastResult;
    const trial = settings.mode === "trial";
    const base = variants[0];
    const best = variants.reduce((a, b) => (b.dmg > a.dmg ? b : a), variants[0]);

    el("resultSummary").innerHTML = `
        <div class="stat-row">
            <div class="stat"><span>Player</span><b>${esc(settings.focusName)}</b></div>
            <div class="stat"><span>Mode</span><b>${trial ? "Trial Mode" : `Single Tier T${(settings.level - 100) / 10 + 1}`}</b></div>
            <div class="stat"><span>Enemy</span><b>${esc(settings.groupName)}</b></div>
            <div class="stat"><span>${trial ? "Budget" : "Time cap"}</span><b>${fmt(settings.timeCapSeconds)} s</b></div>
            <div class="stat"><span>Party</span><b>${settings.partySize}</b></div>
            <div class="stat"><span>Runs per kit</span><b>${settings.runs}</b></div>
        </div>
        <p class="hint" style="margin:0 0 10px">${variants.length * settings.runs} runs in ${wallSeconds.toFixed(1)} s.
            Run <i>i</i> of every kit uses the same seed.</p>`;

    el("resultTable").innerHTML = `
        <div style="overflow-x:auto">
        <table>
            <thead>
                <tr>
                    <th>Kit</th><th>Avg damage</th><th>±95%</th><th>vs base</th>
                    <th>DPS</th><th>vs base</th><th>Raid share</th><th>Hit rate</th>
                    <th>Healing</th><th>Blocked casts</th><th>Deaths</th>
                    <th>${trial ? "Tiers cleared" : "Result"}</th>
                </tr>
            </thead>
            <tbody>
                ${variants.map((v, i) => {
                    const hit = v.hits + v.misses ? v.hits / (v.hits + v.misses) : 0;
                    const raid = trial
                        ? `${fmt(v.cleared, 1)} <span class="dim">(${fmt(v.progress, 2)})</span>`
                        : `${outcomeText(v.outcomes)}${v.bossHpFrac > 0 ? ` <span class="dim">· progress ${((1 - v.bossHpFrac) * 100).toFixed(1)}%</span>` : ""}`;
                    return `
                    <tr class="variant-row" data-idx="${i}">
                        <td>${esc(v.label)} ${i === 0 ? '<span class="tag baseline">base</span>' : ""}${v === best && variants.length > 1 ? ' <span class="tag best">best</span>' : ""}
                            <div class="dim" style="font-size:11px;white-space:normal;max-width:320px">${esc(kitText(v.kit))}</div></td>
                        <td><b>${fmt(v.dmg)}</b></td>
                        <td class="range">±${fmt(v.dmgCi)}</td>
                        <td>${i === 0 ? '<span class="dim">base</span>' : deltaHtml(v.dmg, base.dmg)}</td>
                        <td>${fmt(v.dps, 1)}</td>
                        <td>${i === 0 ? '<span class="dim">base</span>' : deltaHtml(v.dps, base.dps)}</td>
                        <td class="dim">${(v.share * 100).toFixed(2)}%</td>
                        <td class="dim">${(hit * 100).toFixed(0)}%</td>
                        <td class="dim">${v.heal ? fmt(v.heal) : "—"}</td>
                        <td class="dim">${fmt(v.oom, 1)}</td>
                        <td class="${v.deaths ? "bad" : "dim"}">${fmt(v.deaths, 1)}</td>
                        <td>${raid}</td>
                    </tr>
                    <tr class="detail-row" data-detail="${i}" style="display:none">
                        <td colspan="12">${variantDetail(v, trial)}</td>
                    </tr>`;
                }).join("")}
            </tbody>
        </table>
        </div>
        <p class="hint">Click a row for its breakdown. <b>Avg damage</b> is the player's damage on the enemy per run,
            averaged over every run. <b>±95%</b> is how far that average could move from roll luck alone: two kits
            closer together than that are not separated, so add runs. <b>DPS</b> is total damage over total fight
            time.${trial ? " In Trial Mode a kit that helps the party clear more tiers fights for longer and so deals more total damage. DPS removes that effect. <b>Tiers cleared</b> is the average, with tiers cleared plus progress into the next one in brackets." : ""}
            <b>Raid share</b> is the player's share of the whole party's damage. <b>Healing</b> leaves out passive regen.
            <b>Blocked casts</b> and <b>Deaths</b> are per run.</p>`;

    el("resultTable").querySelectorAll(".variant-row").forEach((row) => {
        row.addEventListener("click", () => {
            const d = el("resultTable").querySelector(`[data-detail="${row.dataset.idx}"]`);
            d.style.display = d.style.display === "none" ? "table-row" : "none";
        });
    });
}

function variantDetail(v, trial) {
    const abilityKeys = new Set([...Object.keys(v.perAbility), ...Object.keys(v.casts)]);
    const rows = [...abilityKeys]
        .map((k) => [k, v.perAbility[k] || { dmg: 0, hits: 0, misses: 0 }, v.casts[k] || 0])
        .sort((a, b) => b[1].dmg - a[1].dmg || b[2] - a[2]);
    const total = rows.reduce((s, [, a]) => s + a.dmg, 0) || 1;
    const heals = Object.entries(v.perHeal).sort((a, b) => b[1] - a[1]);

    return `
        <div class="breakdown">
            <div>
                <div class="bd-title">Damage by source (per run)</div>
                <table class="mini">
                    <thead><tr><th>Source</th><th>Share</th><th>Damage</th><th>Hits</th><th>Accuracy</th><th>Casts</th></tr></thead>
                    <tbody>
                        ${rows.map(([k, a, c]) => `
                            <tr>
                                <td>${esc(sourceName(k))}</td>
                                <td>${a.dmg ? (a.dmg / total * 100).toFixed(0) + "%" : "—"}</td>
                                <td>${a.dmg ? fmt(a.dmg) : "—"}</td>
                                <td>${a.hits ? fmt(a.hits, 1) : "—"}</td>
                                <td>${a.hits + a.misses ? (a.hits / (a.hits + a.misses) * 100).toFixed(0) + "%" : "—"}</td>
                                <td>${c ? fmt(c, 1) : "—"}</td>
                            </tr>`).join("")}
                    </tbody>
                </table>
                ${heals.length ? `
                <div class="bd-title" style="margin-top:10px">Healing by source (per run)</div>
                <table class="mini">
                    <thead><tr><th>Source</th><th>Healed</th></tr></thead>
                    <tbody>${heals.map(([k, h]) => `<tr><td>${esc(sourceName(k))}</td><td>${fmt(h)}</td></tr>`).join("")}</tbody>
                </table>` : ""}
            </div>
            <div>
                ${trial ? `
                <div class="bd-title">By tier</div>
                <table class="mini">
                    <thead><tr><th>Tier</th><th>Reached</th><th>Cleared</th><th>Avg damage</th><th>Avg time</th></tr></thead>
                    <tbody>
                        ${v.tiers.map((t) => `
                            <tr>
                                <td>T${t.tier} <span class="dim">L${t.level}</span></td>
                                <td>${t.reached}/${v.n}</td>
                                <td>${t.cleared}/${t.reached}</td>
                                <td>${fmt(t.dmg / t.reached)}</td>
                                <td>${fmt(t.seconds / t.reached)} s</td>
                            </tr>`).join("")}
                    </tbody>
                </table>` : ""}
                <div class="bd-title" style="${trial ? "margin-top:10px" : ""}">Runs</div>
                <table class="mini">
                    <thead><tr><th>Seed</th><th>Outcome</th><th>${trial ? "Last tier" : "Tier progress"}</th><th>Time</th><th>Damage</th></tr></thead>
                    <tbody>
                        ${v.runs.map((r) => `
                            <tr>
                                <td class="dim">${r.seed}</td>
                                <td class="${(OUTCOME_LABELS[r.outcome] || {}).cls || ""}">${esc((OUTCOME_LABELS[r.outcome] || { text: r.outcome }).text)}</td>
                                <td>${trial ? (r.lastTier ? "T" + r.lastTier : "—") : ""}${r.outcome === "victory" || r.outcome === "completed" ? (trial ? "" : "100%") : `${trial ? " · " : ""}${((1 - r.bossHpFrac) * 100).toFixed(1)}%`}</td>
                                <td>${fmt(r.seconds)} s</td>
                                <td>${fmt(r.dmg)}</td>
                            </tr>`).join("")}
                    </tbody>
                </table>
            </div>
        </div>`;
}

// ------------------------------------------------------------------- events

function renderAll() {
    renderParty();
    renderBuildings();
    renderFight();
    renderFocus();
    renderVariants();
    renderResult();
}

document.addEventListener("DOMContentLoaded", () => {
    renderAll();
    initPartyImport();

    el("partyRoster").addEventListener("click", (e) => {
        const row = e.target.closest("tr[data-member]");
        if (!row || !party) return;
        const m = party.members[Number(row.dataset.member)];
        if (!m || m.name === state.focusName) return;
        setFocus(m.name);
        saveState();
        // Keep the roster open while picking.
        renderFocus();
        renderVariants();
        renderResult();
        el("partyRoster").querySelectorAll("tr[data-member]").forEach((r) =>
            r.classList.toggle("is-focus", r === row));
    });

    el("buildingList").addEventListener("change", (e) => {
        const id = e.target.dataset.building;
        if (!id) return;
        const level = Math.max(0, Number(e.target.value) || 0);
        e.target.value = level;
        guildBuildingLevels[id] = level;
        saveGuildBuildingLevels();
    });

    document.querySelectorAll(".subtab[data-mode]").forEach((b) => b.addEventListener("click", () => {
        state.mode = b.dataset.mode;
        saveState();
        renderFight();
    }));
    el("groupSelect").addEventListener("change", (e) => { state.groupName = e.target.value; saveState(); renderEnemyPreview(); });
    el("levelSelect").addEventListener("change", (e) => { state.level = Number(e.target.value); saveState(); renderEnemyPreview(); });
    el("timeCap").addEventListener("change", (e) => {
        const v = Math.max(60, Number(e.target.value) || DEFAULT_TIME_CAP);
        e.target.value = v;
        if (state.mode === "trial") state.trialBudget = v;
        else state.singleCap = v;
        saveState();
    });
    el("runCount").addEventListener("change", (e) => {
        state.runs = Math.max(1, Math.min(MAX_RUNS, Number(e.target.value) || DEFAULT_RUNS));
        e.target.value = state.runs;
        saveState();
    });

    el("focusSelect").addEventListener("change", (e) => {
        setFocus(e.target.value);
        saveState();
        renderAll();
    });
    el("focusPreview").addEventListener("click", () => {
        const m = focusMember();
        // The member exactly as imported: their own bar at their own levels.
        if (m) openPreview(m.name + " — as imported", null);
    });

    el("variantList").addEventListener("input", onVariantInput);
    el("variantList").addEventListener("change", onVariantInput);
    el("variantList").addEventListener("click", onVariantClick);
    el("resetKits").addEventListener("click", () => {
        if (!focusMember()) return;
        if (state.variants.length > 1 && !confirm("Replace every kit with the player's own bar?")) return;
        state.variants = [baselineVariant(state.nextId++, focusMember())];
        saveState();
        renderVariants();
    });

    el("runBtn").addEventListener("click", run);

    el("previewClose").addEventListener("click", closePreview);
    el("previewOverlay").addEventListener("click", (e) => {
        if (e.target === el("previewOverlay")) closePreview();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closePreview();
    });
});
