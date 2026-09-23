// Optimization page: take a three-player group built from loadouts the plugin captured, try each
// player's candidate abilities against every combination of the others, at every selected
// difficulty tier, and rank the results by fragments per hour.
//
// Every condition is one independent simulation, so the sweep is fanned out across a pool of
// workers (see optimizationWorker.js) and the table fills in as results land.

import abilityDetailMap from "./combatsimulator/data/abilityDetailMap.json";
import itemDetailMap from "./combatsimulator/data/itemDetailMap.json";
import { applyLevelGapDebuff, baselineAbilitySlots, importSetToPlayerDTO } from "./combatsimulator/importSet.js";
import { combatZones, metricsFor, zoneDropItems, zoneFragmentItems } from "./combatsimulator/zoneDrops.js";
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
// Tier 3+ is the interesting range for fragments and matches the "T3-T5" sweep this page is for.
const TIERS = [3, 4, 5];
// Must match MAX_POOL_SIZE in optimizationWorker.js: what the page promises is what the pool runs.
const MAX_POOL_SIZE = 16;

let pluginData = { characters: {} };
let slots = [];        // per player: { characterId, loadoutId, candidates: [{ name, slots: [5 x {hrid,level}|null] }] }
let rows = [];         // finished conditions, in completion order
let conditions = [];   // what the current run is simulating, by id
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
            fragment: el("fragmentSelect").value,
            tiers: TIERS.filter((tier) => el("tier" + tier).checked),
            hours: el("simHours").value,
            mooPass: el("mooPass").checked,
            comExp: el("comExp").value,
            comDrop: el("comDrop").value,
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

    if (saved.zone) el("zoneSelect").value = saved.zone;
    if (Array.isArray(saved.tiers)) {
        for (const tier of TIERS) {
            el("tier" + tier).checked = saved.tiers.includes(tier);
        }
    }
    if (saved.hours) el("simHours").value = saved.hours;
    el("mooPass").checked = !!saved.mooPass;
    if (saved.comExp != null) el("comExp").value = saved.comExp;
    if (saved.comDrop != null) el("comDrop").value = saved.comDrop;
    if (Array.isArray(saved.slots) && saved.slots.length === PLAYER_COUNT) {
        slots = saved.slots.map((slot) => ({
            characterId: slot.characterId ?? "",
            loadoutId: slot.loadoutId ?? "",
            candidates: Array.isArray(slot.candidates) ? slot.candidates : [],
        }));
    }
    // The fragment list depends on the zone, so it is restored after the zone is applied.
    pendingFragment = saved.fragment ?? "";
}

let pendingFragment = "";

// ------------------------------------------------------------------ zone & goal

function initZones() {
    const select = el("zoneSelect");
    // Planets only: a three-player group farms group spawns, and single-monster actions drop no
    // key fragments anyway.
    for (const zone of combatZones({ multiSpawnOnly: true })) {
        select.add(new Option(zoneName(zone), zone.hrid));
    }
    select.addEventListener("change", () => { refreshFragmentOptions(); saveSetup(); });
}

// Every planet drops exactly one key fragment, so there is normally no choice to make and the
// picker stays hidden — the readout just names the target. It only appears when the zone gives a
// real choice: several fragments, or none at all (then every droppable item is offered instead).
function refreshFragmentOptions() {
    const zoneHrid = el("zoneSelect").value;
    const highestTier = Math.max(...TIERS);
    const fragments = zoneFragmentItems(zoneHrid, highestTier);
    const needsChoice = fragments.length !== 1;
    const offered = fragments.length > 0 ? fragments : zoneDropItems(zoneHrid, highestTier);

    const select = el("fragmentSelect");
    const previous = pendingFragment || select.value;
    pendingFragment = "";
    select.innerHTML = "";

    for (const item of offered) {
        const label = itemLabel(item.hrid, item.name);
        select.add(new Option(fragments.length > 0 ? `${label}  (${t("keyFragment")})` : label, item.hrid));
    }

    if (previous && [...select.options].some((option) => option.value === previous)) {
        select.value = previous;
    } else if (offered.length > 0) {
        select.value = offered[0].hrid;
    }

    el("fragmentField").classList.toggle("hidden", !needsChoice);

    const note = el("fragmentNote");
    const item = itemName();
    if (fragments.length === 0) {
        note.textContent = t("fragNoteNone");
        note.className = "hint warn";
    } else if (fragments.length > 1) {
        note.textContent = t("fragNoteMulti", { n: fragments.length, item });
        note.className = "hint";
    } else {
        note.textContent = t("fragNoteAuto", { item });
        note.className = "hint";
    }
}

// ------------------------------------------------------------------ player slots

function renderSlots() {
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
        return { name: candidate.name || t("kitName", { n: index + 2 }), slots: candidate.slots };
    }

    let kitSlots = baseline.slice();
    if (candidate && candidate.hrid) {
        kitSlots[candidate.slot ?? 1] = { hrid: candidate.hrid, level: Number(candidate.level) || 1 };
    }
    return { name: candidate?.name || t("kitName", { n: index + 2 }), slots: kitSlots };
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
        const changes = candidateDiff(candidate, baseline);
        const card = document.createElement("div");
        card.className = "candidate-kit";
        card.innerHTML = `
            <div class="candidate-head">
                <input type="text" value="${esc(candidate.name)}" maxlength="40" title="${esc(t("kitNameTitle"))}"
                       data-slot="${slotIndex}" data-candidate="${candidateIndex}" data-field="candidateName">
                <button type="button" class="btn small ghost" data-slot="${slotIndex}" data-candidate="${candidateIndex}" data-field="copyBaseline"
                        title="${esc(t("resetTitle"))}">${esc(t("reset"))}</button>
                <button type="button" class="btn small danger" data-slot="${slotIndex}" data-candidate="${candidateIndex}" data-field="removeCandidate">✕</button>
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
        case "candidateName":
            candidate.name = target.value.trim() || t("kitName", { n: candidateIndex + 2 });
            break;
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

function selectedTiers() {
    return TIERS.filter((tier) => el("tier" + tier).checked);
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
    let variants = [{ label: t("baseline"), detail: t("baselineDetail"), set, abilities: baseline }];

    slot.candidates.forEach((raw, index) => {
        const candidate = migrateCandidate(raw, baseline, index);
        variants.push({
            label: candidate.name,
            // The diff is what the table's tooltip explains; the name alone keeps columns narrow.
            detail: candidateDiff(candidate, baseline).join(" · ") || t("sameAsBaseline"),
            set,
            abilities: candidate.slots,
        });
    });
    return variants;
}

function buildConditions() {
    const zoneHrid = el("zoneSelect").value;
    const tiers = selectedTiers();
    const variantsPerPlayer = [0, 1, 2].map(playerVariants);
    if (variantsPerPlayer.some((variants) => variants.length === 0) || tiers.length === 0) {
        return [];
    }

    let built = [];
    for (const tier of tiers) {
        for (const [i, first] of variantsPerPlayer[0].entries()) {
            for (const [j, second] of variantsPerPlayer[1].entries()) {
                for (const [k, third] of variantsPerPlayer[2].entries()) {
                    const picked = [first, second, third];
                    built.push({
                        id: `${i}-${j}-${k}@T${tier}`,
                        zoneHrid,
                        difficultyTier: tier,
                        labels: picked.map((variant) => variant.label),
                        details: picked.map((variant) => variant.detail ?? t("baselineDetail")),
                        isBaseline: i === 0 && j === 0 && k === 0,
                        players: applyLevelGapDebuff(picked.map((variant, index) =>
                            importSetToPlayerDTO(variant.set, PLAYER_HRIDS[index], variant.abilities))),
                    });
                }
            }
        }
    }
    return built;
}

function updateConditionCount() {
    const variantCounts = [0, 1, 2].map((index) => playerVariants(index).length);
    const tiers = selectedTiers().length;
    const total = variantCounts.every((count) => count > 0)
        ? variantCounts.reduce((prev, cur) => prev * cur, 1) * tiers
        : 0;

    const hours = Number(el("simHours").value) || 0;
    el("conditionCount").textContent = total === 0
        ? t("pickAll")
        : t("conditionCount", { counts: variantCounts.join(" × "), tiers, total, hours });
    el("parallelism").textContent = describeParallelism(total);
    el("runBtn").disabled = total === 0 || running;
    return total;
}

// ------------------------------------------------------------------ running

function run() {
    if (running) {
        return;
    }

    conditions = buildConditions();
    if (conditions.length === 0) {
        return;
    }

    rows = [];
    running = true;
    renderResults();
    el("runBtn").disabled = true;
    el("stopBtn").disabled = false;
    setProgress(0, conditions.length);

    const itemHrid = el("fragmentSelect").value;
    const hours = Math.max(1, Number(el("simHours").value) || 10);

    worker = new Worker(new URL("optimizationWorker.js", import.meta.url));
    worker.onmessage = (event) => {
        const data = event.data;
        if (data.type === "optimization_condition_result") {
            const condition = conditions.find((c) => c.id === data.conditionId);
            rows.push({
                condition,
                metrics: metricsFor(data.simResult, itemHrid, PLAYER_HRIDS),
            });
            setProgress(data.completed, data.total);
            renderResults();
        } else if (data.type === "optimization_condition_error") {
            const condition = conditions.find((c) => c.id === data.conditionId);
            rows.push({ condition, error: data.error });
            setProgress(data.completed, data.total);
            renderResults();
        } else if (data.type === "optimization_done" || data.type === "optimization_cancelled") {
            finish(t(data.type === "optimization_cancelled" ? "stopped" : "done"));
        } else if (data.type === "optimization_error") {
            finish(t("failed", { message: data.error }));
        }
    };
    worker.onerror = (event) => finish(t("workerError", { message: event.message || t("unknown") }));

    worker.postMessage({
        type: "run_optimization",
        conditions,
        extra: {
            mooPass: el("mooPass").checked,
            comExp: Number(el("comExp").value) || 0,
            comDrop: Number(el("comDrop").value) || 0,
        },
        simulationTimeLimit: hours * ONE_HOUR,
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
    running = false;
    if (worker) {
        worker.terminate();
        worker = null;
    }
    el("stopBtn").disabled = true;
    el("progressText").textContent = t("finished", { message, done: rows.length, total: conditions.length });
    updateConditionCount();
    renderResults();
}

function setProgress(done, total) {
    const percent = total > 0 ? (100 * done) / total : 0;
    el("progressFill").style.width = percent.toFixed(1) + "%";
    el("progressText").textContent = t("progress", { done, total, pool: poolSizeFor(total) });
}

// ------------------------------------------------------------------ results

function sortedRows() {
    const key = el("sortSelect").value;
    const score = (row) => {
        if (!row.metrics) {
            return -Infinity;
        }
        switch (key) {
            case "eph": return row.metrics.encountersPerHour;
            case "xp": return average(row, "xpPerHour");
            case "dps": return average(row, "dps");
            case "deaths": return -average(row, "deathsPerHour");
            default: return row.metrics.avgFragsPerHour;
        }
    };
    return rows.slice().sort((a, b) => score(b) - score(a));
}

function average(row, field) {
    const values = PLAYER_HRIDS.map((hrid) => row.metrics.players[hrid][field]);
    return values.reduce((prev, cur) => prev + cur, 0) / values.length;
}

function renderResults() {
    const body = el("resultsBody");
    const ordered = sortedRows();
    // Always highlight the fragment-optimal condition, whatever the table is sorted by, so
    // re-sorting to inspect deaths or xp does not move the goal.
    const best = rows.filter((row) => row.metrics)
        .sort((a, b) => b.metrics.avgFragsPerHour - a.metrics.avgFragsPerHour)[0];

    el("resultsSummary").textContent = rows.length === 0 || !best
        ? ""
        : t("resultsSummary", {
            n: rows.length,
            value: fmt(best.metrics.avgFragsPerHour, 2),
            item: itemName(),
            tier: best.condition.difficultyTier,
        });

    body.innerHTML = ordered.map((row) => {
        const condition = row.condition;
        const variantCells = condition.labels
            .map((label, i) => `<td class="variant" title="${esc(condition.details?.[i] ?? "")}">${esc(label)}</td>`).join("");

        if (row.error) {
            return `<tr class="failed"><td>T${condition.difficultyTier}</td>${variantCells}` +
                `<td colspan="15">${esc(row.error)}</td></tr>`;
        }

        const metrics = row.metrics;
        const playerCells = PLAYER_HRIDS.map((hrid) => {
            const player = metrics.players[hrid];
            return `<td>${fmt(player.fragsPerHour, 2)}</td>` +
                `<td>${fmt(player.dps, 1)}</td>` +
                `<td class="${player.deathsPerHour > 0 ? "warnCell" : ""}">${fmt(player.deathsPerHour, 2)}</td>` +
                `<td>${fmtK(player.xpPerHour)}</td>`;
        }).join("");

        const classes = [condition.isBaseline ? "baseline" : "", row === best ? "best" : ""].filter(Boolean).join(" ");
        return `<tr class="${classes}"><td>T${condition.difficultyTier}</td>${variantCells}` +
            `<td class="strong">${fmt(metrics.avgFragsPerHour, 2)}</td>` +
            `<td>${fmt(metrics.encountersPerHour, 1)}</td>` +
            `<td>${fmtK(average(row, "xpPerHour"))}</td>${playerCells}</tr>`;
    }).join("");
}

function itemName() {
    const hrid = el("fragmentSelect").value;
    return itemLabel(hrid);
}

function exportCsv() {
    const header = ["tier", "player1 variant", "player2 variant", "player3 variant",
        "avg frags/h", "encounters/h", "avg xp/h"];
    for (const hrid of PLAYER_HRIDS) {
        header.push(`${hrid} frags/h`, `${hrid} dps`, `${hrid} deaths/h`, `${hrid} xp/h`);
    }

    const lines = [header.join(",")];
    for (const row of sortedRows()) {
        if (!row.metrics) {
            continue;
        }
        let cells = [row.condition.difficultyTier, ...row.condition.labels.map((l) => `"${l.replace(/"/g, '""')}"`),
            row.metrics.avgFragsPerHour.toFixed(4), row.metrics.encountersPerHour.toFixed(2),
            average(row, "xpPerHour").toFixed(0)];
        for (const hrid of PLAYER_HRIDS) {
            const player = row.metrics.players[hrid];
            cells.push(player.fragsPerHour.toFixed(4), player.dps.toFixed(2),
                player.deathsPerHour.toFixed(4), player.xpPerHour.toFixed(0));
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
}

// Everything that holds generated text, in dependency order: the zone list feeds the fragment list.
function renderAll() {
    applyStaticText();

    const zoneSelect = el("zoneSelect");
    const selectedZone = zoneSelect.value;
    zoneSelect.innerHTML = "";
    for (const zone of combatZones({ multiSpawnOnly: true })) {
        zoneSelect.add(new Option(zoneName(zone), zone.hrid));
    }
    zoneSelect.value = selectedZone;

    pendingFragment = el("fragmentSelect").value;
    refreshFragmentOptions();
    loadPluginData();
    renderSlots();
    renderResults();
}

// ------------------------------------------------------------------ boot

function init() {
    initLanguage();
    applyStaticText();
    slots = defaultSlots();
    initZones();
    loadPluginData();
    loadSetup();
    refreshFragmentOptions();
    renderSlots();

    el("playerSlots").addEventListener("change", onSlotInput);
    const CLICK_FIELDS = ["addCandidate", "removeCandidate", "copyBaseline"];
    el("playerSlots").addEventListener("click", (event) => {
        if (CLICK_FIELDS.includes(event.target.dataset.field)) {
            onSlotInput(event);
        }
    });
    for (const tier of TIERS) {
        el("tier" + tier).addEventListener("change", () => { updateConditionCount(); saveSetup(); });
    }
    el("simHours").addEventListener("change", () => { updateConditionCount(); saveSetup(); });
    el("fragmentSelect").addEventListener("change", () => {
        saveSetup();
        refreshFragmentOptions();
        renderResults();
    });
    el("mooPass").addEventListener("change", saveSetup);
    el("comExp").addEventListener("change", saveSetup);
    el("comDrop").addEventListener("change", saveSetup);
    el("sortSelect").addEventListener("change", renderResults);
    el("langToggle").addEventListener("click", (event) => {
        const next = event.target.dataset.lang;
        if (next && next !== language()) {
            setLanguage(next);
            renderAll();
        }
    });
    // Game names arrive with the shared bundle, which initialises after this script runs.
    onSharedI18nReady(renderAll);
    el("runBtn").addEventListener("click", run);
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
