// Optimization page: take a three-player group built from loadouts the plugin captured, try each
// player's candidate abilities against every combination of the others, at every selected
// difficulty tier, and rank the results by fragments per hour.
//
// Every condition is one independent simulation, so the sweep is fanned out across a pool of
// workers (see optimizationWorker.js). Each zone runs in two phases: every condition at the short
// "fast" length, then only its best FINALISTS again at the long "full" length. All zones share one
// pool: every fast sim is queued up front, and a zone's full confirm jumps the queue the moment its
// fast sims are in. A single zone shows the best SHOWN of whichever phase finished last; "Sim all
// zones" shows one best row per zone, and only once that zone's full confirm is done.

import abilityDetailMap from "./combatsimulator/data/abilityDetailMap.json";
import houseRoomDetailMap from "./combatsimulator/data/houseRoomDetailMap.json";
import itemDetailMap from "./combatsimulator/data/itemDetailMap.json";
import shrineDetailMap from "./combatsimulator/data/shrineDetailMap.json";
import Player from "./combatsimulator/player.js";
import { applyLevelGapDebuff, baselineAbilitySlots, importSetToPlayerDTO } from "./combatsimulator/importSet.js";
import { combatZones, metricsFor, zoneFragmentItems } from "./combatsimulator/zoneDrops.js";
import { kitName } from "./kitName.js";
import { gameName, initLanguage, language, onSharedI18nReady, setLanguage, t } from "./optimizationI18n.js";

const ONE_HOUR = 60 * 60 * 1e9;
const PLAYER_COUNT = 3;
const PLAYER_HRIDS = ["player1", "player2", "player3"];
// Written by the loadout plugin on this origin. Must match PAGE_MIRROR_KEY in plugin/import.js.
const PLUGIN_MIRROR_KEY = "mwiPluginCharacters";
// The plugin also parks the same JSON in a DOM node and fires an event when it lands. The node is
// the reliable channel — the plugin's panel renders into this document, so it can always reach it,
// whereas a userscript's localStorage is not guaranteed to be this origin's.
const PLUGIN_MIRROR_NODE_ID = "mwi-plugin-data";
const PLUGIN_MIRROR_EVENT = "mwi-plugin-data";
const SETUP_KEY = "mwiOptimizationSetup";
// How many fast-sim conditions go on to the full sim, and how many results the table shows.
const FINALISTS = 5;
const SHOWN = 3;
// T2-T5 can be swept. T4 and T5 are the interesting ones for fragments, so they are what a zone
// starts with (DEFAULT_TIERS); T2 and T3 are opt-in.
const TIERS = [2, 3, 4, 5];
const DEFAULT_TIERS = [4, 5];
// Must match MAX_POOL_SIZE in optimizationWorker.js: what the page promises is what the pool runs.
const MAX_POOL_SIZE = 16;

let pluginData = { characters: {} };
let slots = [];        // per player: { characterId, loadoutId, candidates: [{ name, slots: [5 x {hrid,level}|null] }] }
let rows = [];         // fast-sim results: { condition, metrics | error, hours }
let fullRows = [];     // full-sim results of the finalists, same shape
let fullDone = false;  // the full phase ran to the end, so fullRows is the ranking
let zonesDone = new Set(); // all-zones run: zones whose full sim has finished (only these are shown)
let progress = null;       // while running: { fast: {done, total}, full: {done, total}, zones, zonesDone, expected }
let conditions = [];   // what the current run is simulating, by id
let expandedZones = new Set(); // all-zones run: zones whose 2nd and 3rd best rows are open
let runMode = "single"; // "single" (the Target zone) | "all" (every zone in the zone settings panel)
// Zone settings panel for "Sim all zones": zone hrid -> the tiers to sweep there. A zone with no
// tier ticked is skipped. Zones never touched start on DEFAULT_TIERS.
let zoneTiers = {};
let zoneDisabled = {}; // zone hrid -> true when switched off in the panel
let runHours = { fast: 0, full: 0 };
let worker = null;
let running = false;

const el = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const abilityName = (hrid) => gameName("abilityNames", hrid, abilityDetailMap[hrid]?.name ?? hrid);
const zoneName = (zone) => gameName("actionNames", zone.hrid, zone.name);
const itemLabel = (hrid, fallback) => gameName("itemNames", hrid, fallback ?? itemDetailMap[hrid]?.name ?? hrid);
const fmt = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : "-";
// Experience runs to millions per hour, so the table reads it in thousands.
const fmtK = (value) => Number.isFinite(value) ? (value / 1000).toFixed(1) : "-";
const slotLabelFor = (i) => i === 0 ? t("slotSpecial") : t("slot", { n: i });

// ------------------------------------------------------------------ plugin data

function loadPluginData() {
    let raw = document.getElementById(PLUGIN_MIRROR_NODE_ID)?.textContent || null;
    if (!raw) {
        try {
            raw = localStorage.getItem(PLUGIN_MIRROR_KEY);
        } catch (e) {
            raw = null;
        }
    }

    if (!raw) {
        pluginData = { characters: {} };
        el("pluginStatus").textContent = t(waitingForPlugin ? "pluginWaiting" : "pluginMissing");
        el("pluginStatus").className = "status warn";
        return false;
    }

    try {
        const parsed = JSON.parse(raw);
        pluginData = { characters: parsed.characters ?? {}, updatedAt: parsed.updatedAt };
    } catch (e) {
        pluginData = { characters: {} };
        el("pluginStatus").textContent = t("pluginParseFail", { message: e.message });
        el("pluginStatus").className = "status warn";
        return false;
    }

    const count = Object.keys(pluginData.characters).length;
    const when = pluginData.updatedAt ? new Date(pluginData.updatedAt).toLocaleString() : t("unknownTime");
    el("pluginStatus").textContent = count === 0
        ? t("pluginEmpty", { when })
        : t("pluginOk", { count, when });
    el("pluginStatus").className = count === 0 ? "status warn" : "status";
    return count > 0;
}

// The plugin writes its mirror from its own page script, and a same-tab localStorage write fires no
// storage event, so there is nothing to subscribe to: poll briefly after load instead. This also
// covers the plugin publishing a moment after this page has already read the key.
let waitingForPlugin = true;
function pollForPluginData() {
    const deadline = Date.now() + 12000;
    const tick = () => {
        if (loadPluginData()) {
            waitingForPlugin = false;
            renderSlots();
            return;
        }
        if (Date.now() < deadline) {
            setTimeout(tick, 400);
        } else {
            waitingForPlugin = false;
            loadPluginData();
        }
    };
    setTimeout(tick, 400);
}

function characterEntries() {
    return Object.entries(pluginData.characters)
        .map(([id, char]) => ({ id, name: char?.characterMeta?.name || "#" + id, char }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function loadoutEntries(characterId) {
    const char = pluginData.characters[characterId];
    return Object.values(char?.loadouts ?? {})
        .map((loadout) => ({ id: String(loadout.id), name: loadout.name || "#" + loadout.id }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

// One loadout as a complete import set: the loadout's own data, topped up with the character-level
// values (trigger map, shrines, ability book) that the plugin stores once per character.
function resolveImportSet(characterId, loadoutId) {
    const char = pluginData.characters[characterId];
    const loadout = char?.loadouts?.[loadoutId];
    if (!loadout?.data) {
        return null;
    }

    let set = { ...loadout.data };
    set.triggerMap = { ...(char.triggerMap ?? {}), ...(set.triggerMap ?? {}) };
    if (!set.guildShrine && char.guildShrine) {
        set.guildShrine = char.guildShrine;
    }
    if (!set.abilityLevels && char.abilityLevels) {
        set.abilityLevels = char.abilityLevels;
    }
    return set;
}

function abilityBookFor(characterId) {
    const char = pluginData.characters[characterId];
    if (char?.abilityLevels) {
        return char.abilityLevels;
    }
    for (const loadout of Object.values(char?.loadouts ?? {})) {
        if (loadout?.data?.abilityLevels) {
            return loadout.data.abilityLevels;
        }
    }
    return {};
}

// ------------------------------------------------------------------ setup state

function defaultSlots() {
    return Array.from({ length: PLAYER_COUNT }, () => ({ characterId: "", loadoutId: "", candidates: [] }));
}

function saveSetup() {
    try {
        localStorage.setItem(SETUP_KEY, JSON.stringify({
            zone: el("zoneSelect").value,
            goal: el("goalSelect").value,
            fastHours: el("fastHours").value,
            fullHours: el("fullHours").value,
            mooPass: el("mooPass").checked,
            comExp: el("comExp").value,
            comDrop: el("comDrop").value,
            zoneTiers,
            zoneDisabled,
            slots,
        }));
    } catch (e) { /* setup persistence is a convenience, not a requirement */ }
}

function loadSetup() {
    let saved = null;
    try {
        saved = JSON.parse(localStorage.getItem(SETUP_KEY));
    } catch (e) {
        saved = null;
    }
    if (!saved) {
        return;
    }

    // The single-zone list holds only enabled zones, so the saved pick is applied once it is built.
    pendingZone = saved.zone ?? "";
    if (saved.goal && [...el("goalSelect").options].some((o) => o.value === saved.goal)) {
        el("goalSelect").value = saved.goal;
    }
    if (saved.fastHours) el("fastHours").value = saved.fastHours;
    if (saved.fullHours) el("fullHours").value = saved.fullHours;
    el("mooPass").checked = !!saved.mooPass;
    if (saved.comExp != null) el("comExp").value = saved.comExp;
    if (saved.comDrop != null) el("comDrop").value = saved.comDrop;
    if (saved.zoneTiers && typeof saved.zoneTiers === "object") zoneTiers = saved.zoneTiers;
    if (saved.zoneDisabled && typeof saved.zoneDisabled === "object") zoneDisabled = saved.zoneDisabled;
    if (Array.isArray(saved.slots) && saved.slots.length === PLAYER_COUNT) {
        slots = saved.slots.map((slot) => ({
            characterId: slot.characterId ?? "",
            loadoutId: slot.loadoutId ?? "",
            candidates: Array.isArray(slot.candidates) ? slot.candidates : [],
        }));
    }
}

let pendingZone = "";

// ------------------------------------------------------------------ zone settings

const tiersForZone = (zoneHrid) => (zoneTiers[zoneHrid] ?? DEFAULT_TIERS).filter((tier) => TIERS.includes(tier));
// A zone is in the sweep when it is switched on and has at least one tier. Switching it off keeps its
// tiers, so switching it back on restores them.
const zoneEnabled = (zoneHrid) => !zoneDisabled[zoneHrid] && tiersForZone(zoneHrid).length > 0;

// One card per zone: an on/off box with the name, the key fragment it is scored on, and tier chips.
// A zone that is off (or has no tier) is greyed out but stays clickable.
function renderZonePanel() {
    el("zonePanel").innerHTML = combatZones({ multiSpawnOnly: true }).map((zone) => {
        const tiers = tiersForZone(zone.hrid);
        const fragment = zoneFragmentItems(zone.hrid, Math.max(...TIERS))[0];
        const hrid = esc(zone.hrid);
        return `<div class="zone-card${zoneEnabled(zone.hrid) ? "" : " off"}" data-card="${hrid}">` +
            `<label class="zone-head"><input type="checkbox" data-zone="${hrid}" data-field="zoneOn"` +
            `${zoneDisabled[zone.hrid] ? "" : " checked"}><span class="zone-name">${esc(zoneName(zone))}</span></label>` +
            `<div class="zone-item">${fragment ? esc(itemLabel(fragment.hrid, fragment.name)) : "&nbsp;"}</div>` +
            `<div class="zone-tiers">` +
            TIERS.map((tier) => `<label class="tier-chip"><input type="checkbox" data-zone="${hrid}" data-tier="${tier}"` +
                `${tiers.includes(tier) ? " checked" : ""}>T${tier}</label>`).join("") +
            `</div></div>`;
    }).join("");
}

function onZonePanelChange(event) {
    const input = event.target;
    const zoneHrid = input.dataset.zone;
    if (!zoneHrid) return;
    if (input.dataset.field === "zoneOn") {
        if (input.checked) delete zoneDisabled[zoneHrid]; else zoneDisabled[zoneHrid] = true;
        // Switching on a zone with no tier left gives it the default ones, so "on" always means swept.
        if (input.checked && tiersForZone(zoneHrid).length === 0) zoneTiers[zoneHrid] = DEFAULT_TIERS.slice();
    } else {
        const tier = Number(input.dataset.tier);
        const tiers = new Set(tiersForZone(zoneHrid));
        if (input.checked) tiers.add(tier); else tiers.delete(tier);
        zoneTiers[zoneHrid] = TIERS.filter((t) => tiers.has(t));
        // Ticking a tier of a zone that is off switches the zone on.
        if (input.checked) delete zoneDisabled[zoneHrid];
    }
    renderZonePanel();
    refreshZoneSelect();
    updateConditionCount();
    saveSetup();
}

// Bulk buttons: every zone on at T4+T5, or every zone off (their tiers are kept).
function setAllZones(on) {
    for (const zone of combatZones({ multiSpawnOnly: true })) {
        if (on) {
            delete zoneDisabled[zone.hrid];
            zoneTiers[zone.hrid] = DEFAULT_TIERS.slice();
        } else {
            zoneDisabled[zone.hrid] = true;
        }
    }
    renderZonePanel();
    refreshZoneSelect();
    updateConditionCount();
    saveSetup();
}

// The Run section's zone list for "Sim single zone": only the zones enabled in the settings panel.
// Keeps the current pick while it stays enabled, else falls back to the first enabled zone.
function refreshZoneSelect() {
    const select = el("zoneSelect");
    const previous = pendingZone || select.value;
    pendingZone = "";
    select.innerHTML = "";
    for (const zone of combatZones({ multiSpawnOnly: true }).filter((z) => zoneEnabled(z.hrid))) {
        select.add(new Option(zoneName(zone), zone.hrid));
    }
    if ([...select.options].some((option) => option.value === previous)) {
        select.value = previous;
    }
    select.disabled = select.options.length === 0;
}

// The key fragment a zone is scored on. Every planet drops exactly one.
const zoneItemHrid = (zoneHrid) => zoneFragmentItems(zoneHrid, Math.max(...TIERS))[0]?.hrid ?? null;

// What a run sweeps: [{ zoneHrid, tiers, itemHrid }]. Tiers always come from the settings panel; a
// single run takes the zone picked in the Run section, an all-zones run every enabled zone. Each zone
// is scored on its own key fragment.
function sweepZones(mode) {
    const zones = mode === "single"
        ? [el("zoneSelect").value].filter((hrid) => hrid && zoneEnabled(hrid))
        : combatZones({ multiSpawnOnly: true }).map((zone) => zone.hrid).filter(zoneEnabled);
    return zones.map((zoneHrid) => ({ zoneHrid, tiers: tiersForZone(zoneHrid), itemHrid: zoneItemHrid(zoneHrid) }));
}

// ------------------------------------------------------------------ player slots

function renderSlots() {
    updateVariantHeaders();
    const container = el("playerSlots");
    container.innerHTML = "";

    slots.forEach((slot, index) => {
        const card = document.createElement("div");
        card.className = "card";

        const characters = characterEntries();
        const loadouts = slot.characterId ? loadoutEntries(slot.characterId) : [];
        const set = slot.characterId && slot.loadoutId ? resolveImportSet(slot.characterId, slot.loadoutId) : null;
        const kit = set ? baselineAbilitySlots(set) : [];
        if (set) {
            slot.candidates = slot.candidates.map((candidate, i) => migrateCandidate(candidate, kit, i));
        }

        card.innerHTML = `
            <h3>${esc(t("player", { n: index + 1 }))} <span class="dim">${esc(PLAYER_HRIDS[index])}</span></h3>
            <label>${esc(t("labelCharacter"))}
                <select data-slot="${index}" data-field="character">
                    <option value="">${esc(t("pick"))}</option>
                    ${characters.map((c) =>
                        `<option value="${esc(c.id)}"${c.id === slot.characterId ? " selected" : ""}>${esc(c.name)}</option>`).join("")}
                </select>
            </label>
            <label>${esc(t("labelBaseline"))}
                <select data-slot="${index}" data-field="loadout"${slot.characterId ? "" : " disabled"}>
                    <option value="">${esc(t("pick"))}</option>
                    ${loadouts.map((l) =>
                        `<option value="${esc(l.id)}"${l.id === slot.loadoutId ? " selected" : ""}>${esc(l.name)}</option>`).join("")}
                </select>
            </label>
            <div class="kit">${kit.length === 0
                ? `<span class="dim">${esc(t("noLoadout"))}</span>`
                : kit.map((entry, i) => `<div class="kit-row"><span class="dim">${esc(slotLabelFor(i))}</span>` +
                    `<span>${entry ? esc(abilityName(entry.hrid)) + " <span class='dim'>Lv " + entry.level + "</span>" : `<span class='dim'>${esc(t("empty"))}</span>`}</span></div>`).join("")}</div>
            <div class="kit-actions">
                <button type="button" class="btn small ghost" data-slot="${index}" data-field="previewBaseline"${set ? "" : " disabled"}>${esc(t("preview"))}</button>
            </div>
            <div class="candidates" data-slot="${index}"></div>
            <button type="button" class="btn small" data-slot="${index}" data-field="addCandidate"${set ? "" : " disabled"}>${esc(t("addKit"))}</button>
            <div class="hint">${t("variantsHint", { n: 1 + slot.candidates.length })}</div>
        `;

        container.appendChild(card);
        renderCandidates(card.querySelector(".candidates"), index, set);
    });

    updateConditionCount();
}

// A candidate is a complete five-slot kit, seeded from the baseline so editing one ability is the
// common case but nothing stops a whole different setup. Slot 0 takes special abilities only.
function abilityOptionsFor(slotIndex) {
    return Object.values(abilityDetailMap)
        .filter((ability) => !!ability.isSpecialAbility === (slotIndex === 0))
        .sort((a, b) => a.sortIndex - b.sortIndex);
}

// Candidates used to be a single { hrid, slot, level } swap. Saved setups from that shape are
// rebuilt as a full kit so an existing setup is not silently dropped.
function migrateCandidate(candidate, baseline, index) {
    if (Array.isArray(candidate?.slots)) {
        return {
            name: candidate.name || t("kitName", { n: index + 2 }),
            loadoutId: candidate.loadoutId ?? "",
            slots: candidate.slots,
        };
    }

    let kitSlots = baseline.slice();
    if (candidate && candidate.hrid) {
        kitSlots[candidate.slot ?? 1] = { hrid: candidate.hrid, level: Number(candidate.level) || 1 };
    }
    return { name: candidate?.name || t("kitName", { n: index + 2 }), loadoutId: "", slots: kitSlots };
}

// A candidate with its own loadoutId brings that loadout's gear, levels and consumables too; an
// empty one rides on the baseline loadout and only differs in abilities.
function candidateSet(slotIndex, candidate) {
    const slot = slots[slotIndex];
    return resolveImportSet(slot.characterId, candidate?.loadoutId || slot.loadoutId);
}

// What this kit changes relative to the baseline, for the card hint and the results table.
function candidateDiff(candidate, baseline) {
    let changes = [];
    for (let i = 0; i < 5; i++) {
        const before = baseline[i];
        const after = candidate.slots[i];
        if (!before && !after) {
            continue;
        }
        if (before?.hrid !== after?.hrid) {
            changes.push(`${slotLabelFor(i)}: ${before ? abilityName(before.hrid) : t("empty")} → ${after ? abilityName(after.hrid) : t("empty")}`);
        } else if (before && after && Number(before.level) !== Number(after.level)) {
            changes.push(`${slotLabelFor(i)}: ${abilityName(after.hrid)} L${before.level} → L${after.level}`);
        }
    }
    return changes;
}

function renderCandidates(container, slotIndex, set) {
    const slot = slots[slotIndex];
    container.innerHTML = "";
    if (!set) {
        return;
    }

    const baseline = baselineAbilitySlots(set);
    const book = abilityBookFor(slot.characterId);

    slot.candidates.forEach((candidate, candidateIndex) => {
        let changes = candidateDiff(candidate, baseline);
        if (candidate.loadoutId && candidate.loadoutId !== slot.loadoutId) {
            const name = loadoutEntries(slot.characterId)
                .find((entry) => entry.id === candidate.loadoutId)?.name ?? candidate.loadoutId;
            changes.unshift(t("gearFrom", { name }));
        }
        const card = document.createElement("div");
        card.className = "candidate-kit";
        card.innerHTML = `
            <div class="candidate-head">
                <span class="kit-name" title="${esc(t("kitNameTitle"))}">${esc(kitName(candidate.slots))}</span>
                <button type="button" class="btn small ghost" data-slot="${slotIndex}" data-candidate="${candidateIndex}" data-field="previewCandidate">${esc(t("preview"))}</button>
                <button type="button" class="btn small ghost" data-slot="${slotIndex}" data-candidate="${candidateIndex}" data-field="copyBaseline"
                        title="${esc(t("resetTitle"))}">${esc(t("reset"))}</button>
                <button type="button" class="btn small danger" data-slot="${slotIndex}" data-candidate="${candidateIndex}" data-field="removeCandidate">✕</button>
            </div>
            <div class="candidate-row">
                <span class="dim">${esc(t("candidateFrom"))}</span>
                <select data-slot="${slotIndex}" data-candidate="${candidateIndex}" data-field="candidateLoadout">
                    <option value="">${esc(t("baselineLoadoutOption"))}</option>
                    ${loadoutEntries(slot.characterId).map((l) =>
                        `<option value="${esc(l.id)}"${l.id === candidate.loadoutId ? " selected" : ""}>${esc(l.name)}</option>`).join("")}
                </select>
            </div>
            ${candidate.slots.map((entry, i) => {
                const options = abilityOptionsFor(i);
                const known = entry && book[entry.hrid];
                return `<div class="candidate-row">
                    <span class="dim">${esc(slotLabelFor(i))}</span>
                    <select data-slot="${slotIndex}" data-candidate="${candidateIndex}" data-kitslot="${i}" data-field="kitAbility">
                        <option value=""${entry ? "" : " selected"}>${esc(t("emptyOption"))}</option>
                        ${options.map((ability) =>
                            `<option value="${esc(ability.hrid)}"${entry && ability.hrid === entry.hrid ? " selected" : ""}>${esc(abilityName(ability.hrid))}</option>`).join("")}
                    </select>
                    <input type="number" min="1" max="200" value="${entry ? Number(entry.level) || 1 : ""}"
                           ${entry ? "" : "disabled"}
                           title="${esc(t(known ? "knownLevel" : "unknownLevel"))}"
                           data-slot="${slotIndex}" data-candidate="${candidateIndex}" data-kitslot="${i}" data-field="kitLevel">
                </div>`;
            }).join("")}
            <div class="hint">${changes.length === 0
                ? esc(t("identicalToBaseline"))
                : esc(changes.join(" · "))}</div>
        `;
        container.appendChild(card);
    });
}

// A new kit starts as a copy of the baseline loadout, so you edit from where you are.
function newCandidate(slotIndex) {
    const slot = slots[slotIndex];
    const set = resolveImportSet(slot.characterId, slot.loadoutId);
    return {
        name: t("kitName", { n: slot.candidates.length + 2 }),
        loadoutId: "",
        slots: set ? baselineAbilitySlots(set) : [null, null, null, null, null],
    };
}

function onSlotInput(event) {
    const target = event.target;
    const slotIndex = Number(target.dataset.slot);
    const field = target.dataset.field;
    if (!Number.isInteger(slotIndex) || !field) {
        return;
    }
    const slot = slots[slotIndex];
    const candidateIndex = Number(target.dataset.candidate);
    const kitSlot = Number(target.dataset.kitslot);
    const candidate = slot.candidates[candidateIndex];

    switch (field) {
        case "character":
            slot.characterId = target.value;
            slot.loadoutId = "";
            slot.candidates = [];
            break;
        case "loadout":
            slot.loadoutId = target.value;
            break;
        case "addCandidate":
            slot.candidates.push(newCandidate(slotIndex));
            break;
        case "removeCandidate":
            slot.candidates.splice(candidateIndex, 1);
            break;
        case "candidateLoadout": {
            candidate.loadoutId = target.value;
            // Pulling in another loadout means its abilities and their levels too — that is the
            // point of loading one rather than hand-editing five slots.
            const loaded = candidateSet(slotIndex, candidate);
            if (loaded) {
                candidate.slots = baselineAbilitySlots(loaded);
            }
            break;
        }
        case "previewBaseline":
            openPreview(slotIndex, null);
            return;
        case "previewCandidate":
            openPreview(slotIndex, candidateIndex);
            return;
        case "copyBaseline": {
            const set = resolveImportSet(slot.characterId, slot.loadoutId);
            if (set) {
                candidate.slots = baselineAbilitySlots(set);
            }
            break;
        }
        case "kitAbility": {
            if (!target.value) {
                candidate.slots[kitSlot] = null;
                break;
            }
            // Follow the character's real level for the newly picked ability, as the main
            // simulator's slots do; an ability they have never trained keeps the level in the box.
            const book = abilityBookFor(slot.characterId);
            const previous = candidate.slots[kitSlot];
            candidate.slots[kitSlot] = {
                hrid: target.value,
                level: Number(book[target.value]) || Number(previous?.level) || 1,
            };
            break;
        }
        case "kitLevel":
            if (candidate.slots[kitSlot]) {
                candidate.slots[kitSlot].level = Math.max(1, Number(target.value) || 1);
            }
            break;
        default:
            return;
    }

    renderSlots();
    saveSetup();
}

// ------------------------------------------------------------------ preview

const GEAR_SLOTS = [
    ["head", "slotHead"], ["body", "slotBody"], ["legs", "slotLegs"], ["feet", "slotFeet"],
    ["hands", "slotHands"], ["main_hand", "slotMainHand"], ["two_hand", "slotTwoHand"],
    ["off_hand", "slotOffHand"], ["pouch", "slotPouch"], ["neck", "slotNeck"],
    ["earrings", "slotEarrings"], ["ring", "slotRing"], ["back", "slotBack"], ["charm", "slotCharm"],
];

function previewSection(title, rows) {
    if (rows.length === 0) {
        rows = [[t("none"), ""]];
    }
    return `<div class="preview-section"><h4>${esc(title)}</h4>` +
        rows.map(([label, value]) =>
            `<div class="preview-row"><span class="dim">${esc(label)}</span><span>${esc(value)}</span></div>`).join("") +
        `</div>`;
}

// Everything the simulation will actually be handed for this variant, read back out of the DTO so
// the preview cannot drift from what runs.
function openPreview(slotIndex, candidateIndex) {
    const slot = slots[slotIndex];
    const variants = playerVariants(slotIndex);
    const variant = variants[candidateIndex === null ? 0 : candidateIndex + 1];
    if (!variant) {
        return;
    }

    const dto = importSetToPlayerDTO(variant.set, PLAYER_HRIDS[slotIndex], variant.abilities);
    applyLevelGapDebuff([dto]);

    const levels = [
        ["stamina", dto.staminaLevel], ["intelligence", dto.intelligenceLevel],
        ["attack", dto.attackLevel], ["melee", dto.meleeLevel], ["defense", dto.defenseLevel],
        ["ranged", dto.rangedLevel], ["magic", dto.magicLevel],
    ].map(([name, value]) => [name, String(value)]);
    levels.unshift([t("combatLevel"), (dto.combatLevel ?? 0).toFixed(1)]);

    const gear = GEAR_SLOTS
        .map(([key, labelKey]) => [labelKey, dto.equipment["/equipment_types/" + key]])
        .filter(([, item]) => item)
        .map(([labelKey, item]) => [t(labelKey),
            itemLabel(item.hrid) + (item.enhancementLevel > 0 ? ` +${item.enhancementLevel}` : "")]);

    const abilities = variant.abilities
        .map((entry, i) => entry ? [slotLabelFor(i), `${abilityName(entry.hrid)}  Lv ${entry.level}`] : null)
        .filter(Boolean);

    const consumables = [...dto.food, ...dto.drinks].map((entry) => ["", itemLabel(entry.hrid)]);

    const shrines = Object.entries(dto.shrines)
        .filter(([hrid]) => shrineDetailMap[hrid])
        .map(([hrid, level]) => [
            gameName("common:shrineNames", hrid, shrineDetailMap[hrid].name), "Lv " + level]);

    const rooms = Object.entries(dto.houseRooms)
        .filter(([hrid, level]) => level > 0 && houseRoomDetailMap[hrid])
        .map(([hrid, level]) => [
            gameName("houseRoomNames", hrid, houseRoomDetailMap[hrid].name), "Lv " + level]);

    const achievementCount = Object.values(dto.achievements).filter(Boolean).length;

    // Gear and levels only: shrines, zone buffs and community buffs are applied by the simulator
    // at run time, not here, and the note in the dialog says so.
    let stats = [];
    try {
        const player = Player.createFromDTO(structuredClone(dto));
        player.updateCombatDetails();
        const details = player.combatDetails;
        const style = (details.combatStats.combatStyleHrid ?? "").split("/").pop();
        const styleKey = ["stab", "slash", "smash", "ranged", "magic"].includes(style) ? style : "smash";
        stats = [
            [t("maxHp"), String(details.maxHitpoints)],
            [t("maxMp"), String(details.maxManapoints)],
            [t("attackInterval"), (details.combatStats.attackInterval / 1e9).toFixed(2) + "s"],
            [t("accuracy"), Math.round(details[styleKey + "AccuracyRating"]).toString()],
            [t("maxDamage"), Math.round(details[styleKey + "MaxDamage"]).toString()],
        ];
    } catch (e) {
        stats = [[t("none"), e.message]];
    }

    el("previewTitle").textContent = `${t("player", { n: slotIndex + 1 })} · ${variant.label}`;
    el("previewBody").innerHTML =
        previewSection(t("secLevels"), levels) +
        previewSection(t("secStats"), stats) +
        `<div class="hint">${esc(t("statNote"))}</div>` +
        previewSection(t("secGear"), gear) +
        previewSection(t("secAbilities"), abilities) +
        previewSection(t("secConsumables"), consumables) +
        previewSection(t("secShrines"), shrines) +
        previewSection(t("secRooms"), rooms) +
        previewSection(t("secAchievements"), [[t("achievementsDone", { n: achievementCount }), ""]]);

    el("previewModal").classList.remove("hidden");
}

function closePreview() {
    el("previewModal").classList.add("hidden");
}

// ------------------------------------------------------------------ conditions

// One simulation per condition, so the pool is only ever as wide as there is work for it.
function poolSizeFor(conditionCount) {
    const cores = Number(navigator.hardwareConcurrency) || 4;
    return Math.max(1, Math.min(cores, MAX_POOL_SIZE, conditionCount || 1));
}

function describeParallelism(conditionCount) {
    const cores = Number(navigator.hardwareConcurrency) || 0;
    const pool = poolSizeFor(conditionCount);
    const coreText = cores ? t("cores", { n: cores }) : t("unknownCores");
    const capped = cores > MAX_POOL_SIZE ? t("capped", { n: MAX_POOL_SIZE }) : "";
    const limitedByWork = conditionCount > 0 && conditionCount < Math.min(cores || MAX_POOL_SIZE, MAX_POOL_SIZE)
        ? t("limitedByWork") : "";
    return t("parallel", { pool, cores: coreText, capped, limited: limitedByWork });
}

// Each player contributes its baseline plus one variant per candidate; the sweep is every
// combination of those across the three players, at every selected tier.
function playerVariants(slotIndex) {
    const slot = slots[slotIndex];
    const set = slot.characterId && slot.loadoutId ? resolveImportSet(slot.characterId, slot.loadoutId) : null;
    if (!set) {
        return [];
    }

    const baseline = baselineAbilitySlots(set);
    let variants = [{ label: kitName(baseline), detail: t("baselineDetail"), isBase: true, baseline, set, abilities: baseline }];

    slot.candidates.forEach((raw, index) => {
        const candidate = migrateCandidate(raw, baseline, index);
        // A candidate may bring its own loadout, in which case its gear and levels come from there.
        const ownSet = candidateSet(slotIndex, candidate) ?? set;
        let detail = candidateDiff(candidate, baseline);
        let gearFrom = null;
        if (candidate.loadoutId && candidate.loadoutId !== slot.loadoutId) {
            gearFrom = loadoutEntries(slot.characterId)
                .find((entry) => entry.id === candidate.loadoutId)?.name ?? candidate.loadoutId;
            detail.unshift(t("gearFrom", { name: gearFrom }));
        }
        variants.push({
            isBase: false,
            baseline,
            gearFrom,
            label: kitName(candidate.slots),
            // The diff is what the table's tooltip explains; the name alone keeps columns narrow.
            detail: detail.join(" · ") || t("sameAsBaseline"),
            set: ownSet,
            abilities: candidate.slots,
        });
    });
    return variants;
}

// The variant names of a result row, built from its kits when it has them so they follow the page
// language (a row's stored labels were made in whatever language was on when it ran).
// The tooltip text is rebuilt the same way, so ability names in it follow the language too.
// The weapon a result row's player carries, as a small icon from the item sprite (assets/items_sprite.svg,
// copied to the site root; symbol ids are the item hrid without "/items/"). Two-handers win over a
// main hand; nothing is drawn for an unarmed player or an item the sprite does not have.
function weaponIconHtml(dto) {
    const weapon = dto?.equipment?.["/equipment_types/two_hand"] ?? dto?.equipment?.["/equipment_types/main_hand"];
    const id = weapon?.hrid?.replace("/items/", "");
    if (!id) return "";
    const name = itemLabel(weapon.hrid);
    return `<svg class="weapon-icon" role="img" aria-label="${esc(name)}"><title>${esc(name)}</title>` +
        `<use href="items_sprite.svg#${esc(id)}"></use></svg>`;
}

// Symbol ids in assets/abilities_sprite.svg (the game's abilities sprite), so an ability the sprite
// lacks falls back to its name instead of drawing an empty box.
const ABILITY_ICONS = new Set([
    "aqua_arrow", "aqua_aura", "berserk", "cleave", "crippling_slash", "critical_aura",
    "elemental_affinity", "elusiveness", "entangle", "fierce_aura", "fireball", "firestorm",
    "flame_arrow", "flame_aura", "flame_blast", "fracturing_impact", "frenzy", "frost_surge",
    "guardian_aura", "heal", "ice_spear", "impale", "insanity", "invincible",
    "life_drain", "maim", "mana_spring", "minor_heal", "mystic_aura", "natures_veil",
    "penetrating_shot", "penetrating_strike", "pestilent_shot", "poke", "precision", "provoke",
    "puncture", "quick_aid", "quick_shot", "rain_of_arrows", "rejuvenate", "retribution",
    "revive", "scratch", "shield_bash", "silencing_shot", "smack", "smoke_burst",
    "speed_aura", "spike_shell", "steady_shot", "stunning_blow", "sweep", "sylvan_aura",
    "taunt", "toughness", "toxic_pollen", "vampirism", "water_strike",
]);

// A kit as ability icons, in slot order, each with its name and level as a tooltip: the aura
// (special slot) first in its own tile style, then the other abilities. An ability without an icon
// shows its name. The kit's name (kitName) still leaves the aura out.
function kitIconsHtml(kitSlots) {
    const entries = (kitSlots || []).filter((entry) => entry?.hrid);
    if (entries.length === 0) return esc(t("noAbilities"));
    return entries.map((entry) => {
        const id = entry.hrid.replace("/abilities/", "");
        const title = `${abilityName(entry.hrid)} Lv ${entry.level}`;
        const aura = abilityDetailMap[entry.hrid]?.isSpecialAbility ? " aura" : "";
        return ABILITY_ICONS.has(id)
            ? `<svg class="ability-icon${aura}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title>` +
              `<use href="abilities_sprite.svg#${esc(id)}"></use></svg>`
            : `<span class="ability-text${aura}" title="${esc(title)}">${esc(abilityName(entry.hrid))}</span>`;
    }).join("");
}

function conditionDetail(condition, i) {
    const info = condition.infos?.[i];
    if (!info) return condition.details?.[i] ?? "";
    if (info.isBase) return t("baselineDetail");
    const changes = candidateDiff({ slots: info.abilities }, info.baseline);
    if (info.gearFrom) changes.unshift(t("gearFrom", { name: info.gearFrom }));
    return changes.join(" · ") || t("sameAsBaseline");
}

const conditionLabels = (condition) => condition.kits
    ? condition.kits.map((kit) => kitName(kit))
    : condition.labels;

function buildConditions(mode) {
    const variantsPerPlayer = [0, 1, 2].map(playerVariants);
    if (variantsPerPlayer.some((variants) => variants.length === 0)) {
        return [];
    }

    let built = [];
    for (const { zoneHrid, tiers, itemHrid } of sweepZones(mode)) {
        for (const tier of tiers) {
            for (const [i, first] of variantsPerPlayer[0].entries()) {
                for (const [j, second] of variantsPerPlayer[1].entries()) {
                    for (const [k, third] of variantsPerPlayer[2].entries()) {
                        const picked = [first, second, third];
                        built.push({
                            id: `${zoneHrid}|${i}-${j}-${k}@T${tier}`,
                            zoneHrid,
                            itemHrid,
                            difficultyTier: tier,
                            labels: picked.map((variant) => variant.label),
                            kits: picked.map((variant) => variant.abilities),
                            infos: picked.map((variant) => ({
                                isBase: variant.isBase, baseline: variant.baseline,
                                abilities: variant.abilities, gearFrom: variant.gearFrom ?? null,
                            })),
                            details: picked.map((variant) => variant.detail ?? t("baselineDetail")),
                            isBaseline: i === 0 && j === 0 && k === 0,
                            players: applyLevelGapDebuff(picked.map((variant, index) =>
                                importSetToPlayerDTO(variant.set, PLAYER_HRIDS[index], variant.abilities))),
                        });
                    }
                }
            }
        }
    }
    return built;
}

function updateConditionCount() {
    const variantCounts = [0, 1, 2].map((index) => playerVariants(index).length);
    const combos = variantCounts.every((count) => count > 0)
        ? variantCounts.reduce((prev, cur) => prev * cur, 1)
        : 0;
    const tiers = sweepZones("single")[0]?.tiers.length ?? 0;
    const total = combos * tiers;
    const { fast, full } = sweepHours();
    el("conditionCount").textContent = total === 0
        ? t("pickAll")
        : t(hasFastPhase([total]) ? "conditionCount" : "conditionCountFull",
            { counts: variantCounts.join(" × "), tiers, total, fast, full, top: FINALISTS });

    const zones = sweepZones("all");
    const perZone = zones.map((zone) => combos * zone.tiers.length);
    const allTotal = perZone.reduce((sum, n) => sum + n, 0);
    el("allZonesCount").textContent = combos === 0 || zones.length === 0
        ? t("pickAllZones")
        : t(hasFastPhase(perZone) ? "allZonesCount" : "allZonesCountFull",
            { zones: zones.length, total: allTotal, fast, full, top: FINALISTS });

    el("parallelism").textContent = describeParallelism(Math.max(total, allTotal));
    el("runBtn").disabled = total === 0 || running;
    el("runAllBtn").disabled = allTotal === 0 || running;
    return total;
}

// ------------------------------------------------------------------ running

function sweepHours() {
    return {
        fast: Math.max(1, Number(el("fastHours").value) || 24),
        full: Math.max(1, Number(el("fullHours").value) || 200),
    };
}

// The fast pass only pays off when it cuts something: if no zone has more than FINALISTS
// conditions, or the fast length is not shorter, everything goes straight to the full sim.
// `perZone` is the condition count of each zone in the sweep.
function hasFastPhase(perZone) {
    const { fast, full } = sweepHours();
    return perZone.some((n) => n > FINALISTS) && fast < full;
}

// The best `n` rows of each zone, by the goal.
function bestPerZone(list, n) {
    const byZone = new Map();
    for (const row of rankByGoal(list)) {
        const kept = byZone.get(row.condition.zoneHrid) ?? [];
        if (kept.length < n) kept.push(row);
        byZone.set(row.condition.zoneHrid, kept);
    }
    return [...byZone.values()].flat();
}

function run(mode = "single") {
    if (running) {
        return;
    }

    conditions = buildConditions(mode);
    if (conditions.length === 0) {
        return;
    }
    runMode = mode;

    rows = [];
    fullRows = [];
    fullDone = false;
    zonesDone = new Set();
    expandedZones = new Set();
    running = true;
    runHours = sweepHours();
    renderResults();
    el("runBtn").disabled = true;
    el("runAllBtn").disabled = true;
    el("stopBtn").disabled = false;

    runPipeline();
}

// Every zone's sweep in one pool. Tasks are sent as copies with a "fast#"/"full#" id prefix and their
// own time limit, since the same condition can run in both phases.
function runPipeline() {
    const byZone = new Map();
    for (const condition of conditions) {
        if (!byZone.has(condition.zoneHrid)) byZone.set(condition.zoneHrid, []);
        byZone.get(condition.zoneHrid).push(condition);
    }
    const byId = new Map(conditions.map((c) => [c.id, c]));
    const task = (condition, phaseName) => ({
        ...condition,
        id: `${phaseName}#${condition.id}`,
        simulationTimeLimit: runHours[phaseName] * ONE_HOUR,
    });

    // Per zone: whether it has a fast phase, and how many sims of the current phase are outstanding.
    const zoneState = new Map();
    let initial = [];
    progress = { fast: { done: 0, total: 0 }, full: { done: 0, total: 0 }, zones: byZone.size, zonesDone: 0, expected: 0 };
    for (const [zoneHrid, list] of byZone) {
        const fast = hasFastPhase([list.length]);
        zoneState.set(zoneHrid, { fast, left: list.length });
        initial.push(...list.map((c) => task(c, fast ? "fast" : "full")));
        progress[fast ? "fast" : "full"].total += list.length;
        progress.expected += list.length + (fast ? Math.min(FINALISTS, list.length) : 0);
    }

    const zoneDone = (zoneHrid) => {
        zonesDone.add(zoneHrid);
        progress.zonesDone++;
        if (progress.zonesDone === progress.zones) {
            fullDone = true;
            worker.postMessage({ type: "close_queue" });
        }
    };

    const onTask = (data, result) => {
        const [phaseName, conditionId] = [data.conditionId.slice(0, 4), data.conditionId.slice(5)];
        const condition = byId.get(conditionId);
        const row = { condition, hours: runHours[phaseName], ...result };
        (phaseName === "fast" ? rows : fullRows).push(row);
        progress[phaseName].done++;

        const state = zoneState.get(condition.zoneHrid);
        if (--state.left === 0) {
            if (phaseName === "fast") {
                // The zone's fast sims are all in: queue its finalists, picked on the goal set now,
                // ahead of the other zones' fast sims so the zone finishes as soon as it can.
                const finalists = rankByGoal(rows.filter((r) => r.metrics && r.condition.zoneHrid === condition.zoneHrid))
                    .slice(0, FINALISTS).map((r) => r.condition);
                progress.expected -= Math.min(FINALISTS, byZone.get(condition.zoneHrid).length) - finalists.length;
                if (finalists.length === 0) {
                    zoneDone(condition.zoneHrid);
                } else {
                    state.left = finalists.length;
                    progress.full.total += finalists.length;
                    worker.postMessage({ type: "add_conditions", priority: true, conditions: finalists.map((c) => task(c, "full")) });
                }
            } else {
                zoneDone(condition.zoneHrid);
            }
        }
        setProgress();
        renderResults();
    };

    setProgress();
    worker = new Worker(new URL("optimizationWorker.js", import.meta.url));
    worker.onmessage = (event) => {
        const data = event.data;
        if (data.type === "optimization_condition_result") {
            const condition = byId.get(data.conditionId.slice(5));
            onTask(data, { metrics: metricsFor(data.simResult, condition.itemHrid, PLAYER_HRIDS) });
        } else if (data.type === "optimization_condition_error") {
            onTask(data, { error: data.error });
        } else if (data.type === "optimization_done") {
            finish(t("done"));
        } else if (data.type === "optimization_cancelled") {
            finish(t("stopped"));
        } else if (data.type === "optimization_error") {
            finish(t("failed", { message: data.error }));
        }
    };
    worker.onerror = (event) => finish(t("workerError", { message: event.message || t("unknown") }));

    worker.postMessage({
        type: "run_optimization",
        conditions: initial,
        keepOpen: true,
        extra: {
            mooPass: el("mooPass").checked,
            comExp: Number(el("comExp").value) || 0,
            comDrop: Number(el("comDrop").value) || 0,
        },
    });
}

function stop() {
    if (worker) {
        worker.postMessage({ type: "cancel_optimization" });
        // The pool terminates its simulation workers on cancel, but drop ours too so a stuck
        // condition cannot keep the page busy.
        setTimeout(() => {
            if (worker) {
                worker.terminate();
                worker = null;
            }
            finish(t("stopped"));
        }, 200);
    }
}

function finish(message) {
    if (!running) {
        return;
    }
    running = false;
    if (worker) {
        worker.terminate();
        worker = null;
    }
    el("stopBtn").disabled = true;
    el("progressText").textContent = t("finished", { message, done: rows.length + fullRows.length });
    progress = null;
    updateConditionCount();
    renderResults();
}

function setProgress() {
    const done = progress.fast.done + progress.full.done;
    const percent = progress.expected > 0 ? (100 * done) / progress.expected : 0;
    el("progressFill").style.width = Math.min(100, percent).toFixed(1) + "%";
    el("progressText").textContent = t("progressPipeline", {
        fastDone: progress.fast.done, fastTotal: progress.fast.total, fast: runHours.fast,
        fullDone: progress.full.done, fullTotal: progress.full.total, full: runHours.full,
        zonesDone: progress.zonesDone, zones: progress.zones, pool: poolSizeFor(progress.expected),
    });
}

// ------------------------------------------------------------------ results

// Best first by the selected goal; failed rows last.
function rankByGoal(list) {
    const score = (row) => row.metrics ? goalValue(row.metrics) : -Infinity;
    return list.slice().sort((a, b) => score(b) - score(a));
}

// The rows the table ranks: the full sim once it has finished, else the fast sim (still running, or
// the run was stopped before the full phase ended). The full-phase results arrive in no useful order,
// so a partial full phase is only ranked when there was no fast phase to fall back on.
function rankedSource() {
    // All zones: only the full sims of zones that have finished both phases.
    if (runMode === "all") {
        return fullRows.filter((row) => zonesDone.has(row.condition.zoneHrid));
    }
    return (fullDone && fullRows.length > 0) || rows.length === 0 ? fullRows : rows;
}

// The tier cell's tooltip: the best goal value reached at each tier of that zone, so a best-per-zone
// row also tells how far behind the other tiers were.
function tierSummary(list, zoneHrid) {
    const goal = el("goalSelect").value;
    let bestByTier = new Map();
    for (const row of list) {
        if (!row.metrics || row.condition.zoneHrid !== zoneHrid) continue;
        const value = goalValue(row.metrics);
        const tier = row.condition.difficultyTier;
        if (!bestByTier.has(tier) || value > bestByTier.get(tier)) bestByTier.set(tier, value);
    }
    return [...bestByTier.entries()].sort((a, b) => a[0] - b[0])
        .map(([tier, value]) => `T${tier}: ${goal === "xp" ? fmtK(value) + "k" : fmt(value, 2)}`)
        .join(" · ");
}

// The number the selected goal is judged on, for the best-row highlight and the summary.
function goalValue(metrics) {
    switch (el("goalSelect").value) {
        case "xp": return PLAYER_HRIDS.reduce((s, h) => s + metrics.players[h].xpPerHour, 0) / PLAYER_HRIDS.length;
        case "charms": return metrics.avgCharmsPerHour;
        default: return metrics.avgFragsPerHour;
    }
}

function average(row, field) {
    const values = PLAYER_HRIDS.map((hrid) => row.metrics.players[hrid][field]);
    return values.reduce((prev, cur) => prev + cur, 0) / values.length;
}

// Results re-render on every finished sim. Replacing the whole tbody would rebuild every row's
// sprite <use> icons each time, which makes them flash, so rows are keyed (phase length + condition)
// and a row whose markup is unchanged keeps its DOM node; only new or changed rows are parsed.
let rowCache = new Map(); // key -> { html, node }

function patchRows(body, items) {
    const next = new Map();
    const nodes = items.map(({ key, html }) => {
        let cached = rowCache.get(key);
        if (!cached || cached.html !== html) {
            const template = document.createElement("template");
            template.innerHTML = html;
            cached = { html, node: template.content.firstElementChild };
        }
        next.set(key, cached);
        return cached.node;
    });
    nodes.forEach((node, i) => {
        if (body.children[i] !== node) body.insertBefore(node, body.children[i] ?? null);
    });
    while (body.children.length > nodes.length) body.lastElementChild.remove();
    rowCache = next;
}

function renderResults() {
    updateVariantHeaders();
    const body = el("resultsBody");
    const source = rankedSource();
    // One zone: its top SHOWN as rows. All zones: each zone's top SHOWN as a group, in the game's
    // zone order; the best is the row, the others open under it. Zones are not compared with each
    // other (each scores its own fragment), so none is marked best.
    const zoneOrder = combatZones({ multiSpawnOnly: true }).map((zone) => zone.hrid);
    const groups = runMode === "all"
        ? zoneOrder.map((zoneHrid) => rankByGoal(source.filter((row) => row.condition.zoneHrid === zoneHrid)).slice(0, SHOWN))
            .filter((group) => group.length > 0)
        : rankByGoal(source).slice(0, SHOWN).map((row) => [row]);
    const ordered = groups.map((group) => group[0]);
    const goal = el("goalSelect").value;
    const best = ordered.find((row) => row.metrics);

    const stage = runMode === "all" || source === fullRows
        ? (rows.length > 0 ? t("stageFull", { hours: runHours.full, top: FINALISTS, fast: runHours.fast }) : t("stageFullOnly", { hours: runHours.full }))
        : t("stageFast", { hours: runHours.fast });
    el("resultsSummary").textContent = !best
        ? ""
        : runMode === "all"
        ? t("resultsSummaryZones", { zones: ordered.length, stage,
            n: conditions.filter((c) => zonesDone.has(c.zoneHrid)).length })
        : t(goal === "xp" ? "resultsSummaryXp" : goal === "charms" ? "resultsSummaryCharms" : "resultsSummary", {
            n: rows.length || fullRows.length,
            shown: ordered.length,
            stage,
            value: goal === "xp" ? fmtK(goalValue(best.metrics)) : fmt(goalValue(best.metrics), 2),
            item: itemLabel(best.condition.itemHrid),
            tier: best.condition.difficultyTier,
        });

    // A result row: Triggers button and expand arrow only on a group's lead row; a runner-up (rank > 1)
    // is indented under it with its rank.
    const rowHtml = (row, rank, group) => {
        const condition = row.condition;
        const zoneHrid = condition.zoneHrid;
        const lead = rank === 1;
        const expandable = lead && group.length > 1;
        const expanded = expandable && expandedZones.has(zoneHrid);
        // That player's DPS and its share of the party's DPS, e.g. "235 · 34%", shown after the kit.
        const totalDps = row.metrics ? PLAYER_HRIDS.reduce((sum, hrid) => sum + row.metrics.players[hrid].dps, 0) : 0;
        const dpsHtml = (i) => {
            const dps = row.metrics?.players[PLAYER_HRIDS[i]]?.dps;
            if (!Number.isFinite(dps)) return "";
            const share = totalDps > 0 ? Math.round((dps / totalDps) * 100) : 0;
            return `<span class="kit-dps" title="${esc(t("dpsShareTitle"))}">${Math.round(dps)} · ${share}%</span>`;
        };
        const kitCell = (label, i) => {
            const title = `${label}\n${conditionDetail(condition, i)}`;
            const kit = condition.kits ? kitIconsHtml(condition.kits[i]) : esc(label);
            // Weapon and abilities are two groups, split by a divider, so the weapon never reads as a skill.
            const weapon = weaponIconHtml(condition.players?.[i]);
            return `<span class="kit-cell" title="${esc(title)}">` +
                (weapon ? `<span class="kit-weapon">${weapon}</span>` : "") +
                `<span class="kit-abilities">${kit}</span>${dpsHtml(i)}</span>`;
        };
        const variantCells = conditionLabels(condition)
            .map((label, i) => `<td class="variant">${kitCell(label, i)}</td>`).join("");
        const zoneLabel = esc(gameName("actionNames", zoneHrid, zoneHrid));
        const zoneCell = lead
            ? `<td>${zoneLabel}</td>`
            : `<td class="indent"><span class="rank">#${rank}</span>${zoneLabel}</td>`;
        // The tooltip summarises the whole zone and changes with every result, so it is set after
        // patching rather than baked into the row (which would rebuild the row and flash its icons).
        const tierCell = `<td data-tier-zone="${esc(zoneHrid)}">T${condition.difficultyTier}</td>`;
        const headCell = expandable
            ? `<td class="row-head"><span class="chevron">${expanded ? "▾" : "▸"}</span></td>`
            : `<td class="row-head"></td>`;

        if (row.error) {
            return `<tr class="failed${lead ? "" : " runner-up"}">${headCell}${zoneCell}${tierCell}${variantCells}` +
                `<td colspan="6">${esc(row.error)}</td></tr>`;
        }

        const metrics = row.metrics;
        const avgDeaths = average(row, "deathsPerHour");
        // A runner-up's EPH, XP/h and charms/h also show their change against the zone's lead row,
        // e.g. "(+2.3%)".
        const leadRow = group[0];
        const diff = (value, leadValue) => {
            if (lead || !leadRow.metrics || !(leadValue > 0) || !Number.isFinite(value)) return "";
            const pct = ((value - leadValue) / leadValue) * 100;
            const sign = pct > 0 ? "+" : pct < 0 ? "−" : "±";
            return ` <span class="diff ${pct > 0 ? "up" : pct < 0 ? "down" : ""}" title="${esc(t("diffTitle"))}">(${sign}${Math.abs(pct).toFixed(1)}%)</span>`;
        };
        const xp = average(row, "xpPerHour");
        const classes = [lead ? "" : "runner-up", expandable ? "expandable" : "",
            condition.isBaseline ? "baseline" : "", runMode !== "all" && row === best ? "best" : ""]
            .filter(Boolean).join(" ");
        const attrs = expandable ? ` data-expand="${esc(zoneHrid)}" title="${esc(t("expandTitle"))}"` : "";
        return `<tr class="${classes}"${attrs}>${headCell}${zoneCell}${tierCell}${variantCells}` +
            `<td class="strong sep">${fmt(metrics.avgFragsPerHour, 2)}</td>` +
            `<td>${fmt(metrics.encountersPerHour, 1)}${diff(metrics.encountersPerHour, leadRow.metrics?.encountersPerHour)}</td>` +
            `<td class="${avgDeaths > 0 ? "warnCell" : ""}">${fmt(avgDeaths, 2)}</td>` +
            `<td>${fmtK(xp)}${lead ? "" : diff(xp, leadRow.metrics && average(leadRow, "xpPerHour"))}</td>` +
            `<td>${fmt(metrics.avgCharmsPerHour, 2)}${diff(metrics.avgCharmsPerHour, leadRow.metrics?.avgCharmsPerHour)}</td>` +
            `<td class="row-end">${lead ? `<button type="button" class="btn small ghost" data-id="${esc(condition.id)}" title="${esc(t("openTriggerOpt"))}">${esc(t("triggerBtn"))}</button>` : ""}</td></tr>`;
    };

    patchRows(body, groups.flatMap((group) => {
        const open = runMode === "all" && expandedZones.has(group[0].condition.zoneHrid);
        return (runMode === "all" && !open ? group.slice(0, 1) : group).map((row, i) => ({
            key: `${row.hours}|${row.condition.id}`,
            html: rowHtml(row, runMode === "all" ? i + 1 : 1, runMode === "all" ? group : [row]),
        }));
    }));
    for (const cell of body.querySelectorAll("td[data-tier-zone]")) {
        cell.title = tierSummary(source, cell.dataset.tierZone);
    }
}

// Hands one result row's party to the Trigger Optimization page (docs/optimization.md) through
// localStorage, which both pages share, and opens it in a new tab.
function openTriggerOptimization(conditionId) {
    const condition = conditions.find((c) => c.id === conditionId);
    if (!condition) return;
    const context = {
        zoneHrid: condition.zoneHrid,
        zoneName: gameName("actionNames", condition.zoneHrid, condition.zoneHrid),
        difficultyTier: condition.difficultyTier,
        // The trigger search runs many short sims, so it gets the fast length.
        hours: runHours.fast || sweepHours().fast,
        itemHrid: condition.itemHrid,
        extra: {
            mooPass: el("mooPass").checked,
            comExp: Number(el("comExp").value) || 0,
            comDrop: Number(el("comDrop").value) || 0,
        },
        labels: conditionLabels(condition),
        kits: condition.kits,
        playerNames: slots.map((slot) => pluginData.characters[slot.characterId]?.characterMeta?.name || ""),
        players: condition.players.map((dto) => ({ dto })),
    };
    try {
        localStorage.setItem("mwiTriggerOptContext", JSON.stringify(context));
    } catch (e) {
        alert(t("triggerOptStorageFailed"));
        return;
    }
    window.open("trigger-optimization.html", "_blank");
}

function exportCsv() {
    const header = ["sim hours", "zone", "tier", "player1 variant", "player2 variant", "player3 variant",
        "avg frags/h", "encounters/h", "avg deaths/h", "avg xp/h", "avg charm score/h"];
    for (const hrid of PLAYER_HRIDS) {
        header.push(`${hrid} frags/h`, `${hrid} dps`, `${hrid} deaths/h`, `${hrid} xp/h`, `${hrid} charm score/h`);
    }

    const lines = [header.join(",")];
    // Every simulated row of both phases, full sim first, so the CSV keeps what the table trims.
    for (const row of [...rankByGoal(fullRows), ...rankByGoal(rows)]) {
        if (!row.metrics) {
            continue;
        }
        let cells = [row.hours, `"${gameName("actionNames", row.condition.zoneHrid, row.condition.zoneHrid).replace(/"/g, '""')}"`,
            row.condition.difficultyTier, ...conditionLabels(row.condition).map((l) => `"${l.replace(/"/g, '""')}"`),
            row.metrics.avgFragsPerHour.toFixed(4), row.metrics.encountersPerHour.toFixed(2),
            average(row, "deathsPerHour").toFixed(4),
            average(row, "xpPerHour").toFixed(0), row.metrics.avgCharmsPerHour.toFixed(4)];
        for (const hrid of PLAYER_HRIDS) {
            const player = row.metrics.players[hrid];
            cells.push(player.fragsPerHour.toFixed(4), player.dps.toFixed(2),
                player.deathsPerHour.toFixed(4), player.xpPerHour.toFixed(0), player.charmsPerHour.toFixed(4));
        }
        lines.push(cells.join(","));
    }

    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "optimization.csv";
    link.click();
    URL.revokeObjectURL(link.href);
}

// ------------------------------------------------------------------ language

// Static markup carries its key in data-i18n-opt (text) or data-i18n-opt-title (tooltip), so the
// HTML stays readable and the whole page can be re-labelled without re-rendering it.
// The three variant columns are headed with the player's character name, falling back to the
// static "P1 variant" text until a character is picked.
function updateVariantHeaders() {
    slots.forEach((slot, index) => {
        const node = document.querySelector(`[data-i18n-opt="thP${index + 1}"]`);
        const name = pluginData.characters[slot.characterId]?.characterMeta?.name;
        if (node) {
            node.textContent = name || t(`thP${index + 1}`);
        }
    });
}

function applyStaticText() {
    document.documentElement.lang = language() === "zh" ? "zh" : "en";
    document.title = t("pageTitle");

    for (const node of document.querySelectorAll("[data-i18n-opt]")) {
        node.textContent = t(node.getAttribute("data-i18n-opt"));
    }
    for (const node of document.querySelectorAll("[data-i18n-opt-title]")) {
        node.title = t(node.getAttribute("data-i18n-opt-title"));
    }
    for (const button of document.querySelectorAll("#langToggle button")) {
        button.classList.toggle("active", button.dataset.lang === language());
    }
    updateVariantHeaders();
}

// Everything that holds generated text.
function renderAll() {
    applyStaticText();
    refreshZoneSelect();
    renderZonePanel();
    loadPluginData();
    renderSlots();
    renderResults();
}

// ------------------------------------------------------------------ boot

function init() {
    initLanguage();
    applyStaticText();
    slots = defaultSlots();
    loadPluginData();
    loadSetup();
    refreshZoneSelect();
    renderZonePanel();
    renderSlots();

    el("playerSlots").addEventListener("change", onSlotInput);
    el("zonePanel").addEventListener("change", onZonePanelChange);
    el("zonesDefault").addEventListener("click", () => setAllZones(true));
    el("zonesClear").addEventListener("click", () => setAllZones(false));
    el("resultsBody").addEventListener("click", (event) => {
        const button = event.target.closest("button[data-id]");
        if (button) {
            openTriggerOptimization(button.dataset.id);
            return;
        }
        // A click anywhere else on a zone's lead row opens or closes its 2nd and 3rd best.
        const lead = event.target.closest("tr[data-expand]");
        if (lead) {
            const zoneHrid = lead.dataset.expand;
            if (expandedZones.has(zoneHrid)) expandedZones.delete(zoneHrid); else expandedZones.add(zoneHrid);
            renderResults();
        }
    });
    const CLICK_FIELDS = ["addCandidate", "removeCandidate", "copyBaseline",
        "previewBaseline", "previewCandidate"];
    el("playerSlots").addEventListener("click", (event) => {
        if (CLICK_FIELDS.includes(event.target.dataset.field)) {
            onSlotInput(event);
        }
    });
    el("zoneSelect").addEventListener("change", () => { updateConditionCount(); saveSetup(); });
    for (const id of ["fastHours", "fullHours"]) {
        el(id).addEventListener("change", () => { updateConditionCount(); saveSetup(); });
    }
    el("mooPass").addEventListener("change", saveSetup);
    el("comExp").addEventListener("change", saveSetup);
    el("comDrop").addEventListener("change", saveSetup);
    // Re-ranks what has already run; the finalists of a finished run stay the ones picked then.
    el("goalSelect").addEventListener("change", () => {
        saveSetup();
        renderResults();
    });
    el("previewClose").addEventListener("click", closePreview);
    el("previewModal").addEventListener("click", (event) => {
        // Clicking the backdrop closes; clicking inside the dialog does not.
        if (event.target.id === "previewModal") {
            closePreview();
        }
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            closePreview();
        }
    });
    el("langToggle").addEventListener("click", (event) => {
        const next = event.target.dataset.lang;
        if (next && next !== language()) {
            setLanguage(next);
            renderAll();
        }
    });
    // Game names arrive with the shared bundle, which initialises after this script runs.
    onSharedI18nReady(renderAll);
    el("runBtn").addEventListener("click", () => run("single"));
    el("runAllBtn").addEventListener("click", () => run("all"));
    el("stopBtn").addEventListener("click", stop);
    el("reloadPlugin").addEventListener("click", () => {
        waitingForPlugin = false;
        loadPluginData();
        renderSlots();
    });
    el("exportBtn").addEventListener("click", exportCsv);

    updateConditionCount();
    // Published later in the page's life: the plugin announces it, so there is no wait.
    window.addEventListener(PLUGIN_MIRROR_EVENT, () => {
        waitingForPlugin = false;
        if (loadPluginData()) {
            renderSlots();
        }
    });

    if (Object.keys(pluginData.characters).length === 0) {
        pollForPluginData();
    } else {
        waitingForPlugin = false;
    }
}

init();
