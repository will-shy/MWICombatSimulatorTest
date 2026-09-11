// Skill Lab page logic. Builds squads of identical players, runs one trial-group
// encounter in a worker, and reports damage per squad so two kits on the same
// build can be compared side by side.
//
// English-only by project convention for new group-battle features.
import {
    PRESET_LIST, PRESETS, MONSTER_GROUPS, ABILITY_LIST, CUSTOM_BUILD_PREFIX,
    enemyPreview, buildStyle, presetKit, squadDTO,
    getBuild, customBuildList, setCustomBuilds, equipmentSetToSoloExport,
} from "./combatsimulator/skillLab.js";
import { playerDetailHtml, renderDetailedStatus, dtoToSoloExport } from "./playerDetailView.js";

const STORE_KEY = "mwiSkillLabConfigV2";
// Where the standard simulator keeps its saved equipment sets, and the key it
// reads on load to auto-import a build. Both must match src/main.js.
const LS_EQUIPMENT_SETS_KEY = "equipmentSets";
const SOLO_IMPORT_HANDOFF_KEY = "mwiSoloImportHandoff";
const ABILITY_BY_HRID = ABILITY_LIST.reduce((acc, a) => (acc[a.hrid] = a, acc), {});

const STYLE_COLORS = {
    "/combat_styles/smash": "#e8963c",
    "/combat_styles/slash": "#e05a5a",
    "/combat_styles/stab": "#e8d24c",
    "/combat_styles/ranged": "#5fbf6f",
    "/combat_styles/magic": "#9b7fe0",
};

let worker = new Worker(new URL("skillLabWorker.js", import.meta.url));
let running = false;
let lastResult = null;
// Options the displayed result was produced with — the panel explains the result
// it is showing, not whatever the checkboxes say now.
let lastRunOptions = null;

// --------------------------------------------------------------- default state

const A = (hrid, level) => ({ hrid, level });

function defaultState() {
    return {
        groupName: MONSTER_GROUPS.includes("Trial Swarm") ? "Trial Swarm" : MONSTER_GROUPS[0],
        level: 160,
        runs: 3,
        timeCapSeconds: 3600,
        infiniteMana: false,
        noPlayerDamage: true,
        auras: true,
        auraLevel: 25,
        nextId: 9,
        squads: [
            {
                id: 1, label: "Melee", presetId: pick("smash_T95"), count: 14,
                kit: [
                    A("/abilities/insanity", 20), A("/abilities/frenzy", 40), A("/abilities/berserk", 40),
                    A("/abilities/precision", 40), A("/abilities/fracturing_impact", 40),
                ],
            },
            {
                id: 2, label: "Ranged", presetId: pick("xbow_T95", "bow_T95"), count: 14,
                kit: [
                    A("/abilities/insanity", 20), A("/abilities/frenzy", 40), A("/abilities/berserk", 40),
                    A("/abilities/pestilent_shot", 40), A("/abilities/penetrating_shot", 40),
                ],
            },
            {
                id: 3, label: "Magic", presetId: pick("nature_aoe_T95"), count: 14,
                kit: [
                    A("/abilities/insanity", 20), A("/abilities/elemental_affinity", 40),
                    A("/abilities/firestorm", 40), A("/abilities/natures_veil", 40),
                    A("/abilities/entangle", 60),
                ],
            },
            // Support squads: fight normally (their debuffs and Mana Spring's mana
            // feed benefit the raid) but their damage is excluded from the analysis.
            // Kits prefill from the preset and stay editable — the Water squad's
            // Mana Spring level lives right in its slot list.
            supportSquad(4, "Tank", "wark", 2),
            supportSquad(5, "Nature Support", "nature_healer_revive", 6),
            supportSquad(6, "Water Support", "water_T95", 2),
            supportSquad(7, "Stab Support", "stab_T95", 2),
            supportSquad(8, "Bow Support", "bow_T95", 2),
        ],
    };
}

function supportSquad(id, label, presetId, count) {
    const pid = pick(presetId, PRESET_LIST[0].id);
    return { id, label, presetId: pid, count, support: true, kit: presetKit(pid) };
}

function pick(...ids) {
    for (const id of ids) if (id && PRESETS[id]) return id;
    return PRESET_LIST[0].id;
}

// --------------------------------------------------- builds from saved gear

// Besides the bundled presets, any equipment set saved in the standard simulator
// (same browser, localStorage "equipmentSets") can be used as a squad's build.
// They are read at page load and again on Refresh, so a set saved in the other
// tab shows up here without a reload. Returns the names that failed to convert.
function loadSavedBuilds() {
    let sets = {};
    try {
        sets = JSON.parse(localStorage.getItem(LS_EQUIPMENT_SETS_KEY)) || {};
    } catch (e) {
        sets = {};
    }

    const builds = [];
    const failed = [];
    for (const name of Object.keys(sets)) {
        try {
            builds.push({
                id: CUSTOM_BUILD_PREFIX + name,
                name,
                export: equipmentSetToSoloExport(sets[name]),
            });
        } catch (e) {
            failed.push(name + ": " + e.message);
        }
    }
    setCustomBuilds(builds);
    return failed;
}

// Must run before loadState(), which drops squads whose build no longer resolves
// — a squad on a saved set has to be resolvable at that point or it is lost.
loadSavedBuilds();

let state = loadState();

function loadState() {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        if (!raw) return defaultState();
        const parsed = JSON.parse(raw);
        // Drop anything referencing a build that no longer exists.
        parsed.squads = (parsed.squads || []).filter((s) => getBuild(s.presetId));
        if (!parsed.squads.length) return defaultState();
        return { ...defaultState(), ...parsed };
    } catch (e) {
        return defaultState();
    }
}

function saveState() {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
        /* storage unavailable — the page still works, it just won't remember */
    }
}

// ------------------------------------------------------------------- helpers

const el = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
const fmt = (n, d = 0) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

function partySize() {
    return state.squads.reduce((s, q) => s + (Number(q.count) || 0), 0);
}

function styleName(hrid) {
    return hrid ? hrid.split("/").pop() : "";
}

function showError(msg) {
    const box = el("errorBox");
    box.textContent = msg;
    box.style.display = msg ? "block" : "none";
}

// --------------------------------------------------------------- enemy panel

function renderEnemy() {
    const groupSel = el("groupSelect");
    if (!groupSel.options.length) {
        groupSel.innerHTML = MONSTER_GROUPS.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join("");
    }
    groupSel.value = state.groupName;

    const levelSel = el("levelSelect");
    if (!levelSel.options.length) {
        let html = "";
        for (let lv = 100; lv <= 300; lv += 10) {
            html += `<option value="${lv}">L${lv} (T${(lv - 100) / 10 + 1})</option>`;
        }
        levelSel.innerHTML = html;
    }
    levelSel.value = state.level;

    const size = partySize();
    let preview;
    try {
        preview = enemyPreview(state.groupName, Number(state.level), size || 1);
    } catch (e) {
        preview = { enemies: [], totalHp: 0 };
    }

    el("enemyPreview").innerHTML = `
        <div class="stat-row">
            <div class="stat"><span>Party size</span><b>${size}</b></div>
            <div class="stat"><span>Group HP</span><b>${fmt(preview.totalHp)}</b></div>
            <div class="stat"><span>HP scaling</span><b>+${size}% </b></div>
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

// --------------------------------------------------------------- squad panel

function abilityOptions(selected) {
    let html = `<option value="">— empty —</option>`;
    for (const a of ABILITY_LIST) {
        const sel = a.hrid === selected ? " selected" : "";
        html += `<option value="${esc(a.hrid)}"${sel}>${esc(a.name)}</option>`;
    }
    return html;
}

function slotMeta(hrid, squadStyle) {
    const a = ABILITY_BY_HRID[hrid];
    if (!a) return `<span class="slot-meta dim">empty slot</span>`;
    const bits = [];
    bits.push(a.style === "buff" ? "buff" : a.style);
    if (a.isAoe) bits.push("AoE");
    bits.push(a.cooldown ? `cd ${a.cooldown}s` : "no cd");
    bits.push(`${a.manaCost} mp`);
    if (a.castDuration) bits.push(`cast ${a.castDuration}s`);

    // A damage ability resolves on its own style's accuracy and max damage. If
    // that isn't the build's weapon style, the gear does not buff it.
    let warn = "";
    const abilityStyle = a.style && a.style !== "buff" ? "/combat_styles/" + a.style.split("/")[0] : "";
    if (abilityStyle && squadStyle && abilityStyle !== squadStyle) {
        warn = `<span class="slot-warn" title="This ability resolves on ${styleName(abilityStyle)} accuracy and damage, which this build's weapon does not buff.">⚠ uses ${styleName(abilityStyle)} rating</span>`;
    }
    return `<span class="slot-meta">${esc(bits.join(" · "))}</span>${warn}`;
}

// Build picker: bundled presets first, then whatever equipment sets are loaded.
// A squad whose saved set has since been deleted keeps its id in a "missing"
// option, so the squad is visible and fixable instead of silently re-pointed.
function buildOptions(selected) {
    const opt = (id, name) => `<option value="${esc(id)}"${id === selected ? " selected" : ""}>${esc(name)}</option>`;
    let html = `<optgroup label="Presets">${PRESET_LIST.map((p) => opt(p.id, p.name)).join("")}</optgroup>`;
    const saved = customBuildList();
    if (saved.length) {
        html += `<optgroup label="Saved equipment sets">${saved.map((b) => opt(b.id, b.name)).join("")}</optgroup>`;
    }
    if (!getBuild(selected)) {
        html += opt(selected, selected.replace(CUSTOM_BUILD_PREFIX, "") + " (missing)");
    }
    return html;
}

// The saved-gear panel: one chip per equipment set, each opening its preview.
function renderSavedBuilds() {
    const host = el("savedBuilds");
    const saved = customBuildList();
    if (!saved.length) {
        host.innerHTML = `<div class="hint" style="margin:0">No equipment sets found in this browser. Save one in the
            <a href="index.html" target="_blank" rel="noopener">standard simulator ↗</a>, then press Refresh.</div>`;
        return;
    }
    host.innerHTML = saved.map((b) => {
        const style = styleName(buildStyle(b.id));
        return `<button type="button" class="chip-btn" data-build="${esc(b.id)}"
                        title="Preview this build's gear, levels and abilities">${esc(b.name)}${
            style ? ` <span class="dim">${esc(style)}</span>` : ""}</button>`;
    }).join("");
}

function renderSquads() {
    const host = el("squadList");
    host.innerHTML = state.squads.map((squad, idx) => {
        const style = buildStyle(squad.presetId);
        const color = STYLE_COLORS[style] || "#9aa0aa";
        const baseline = state.squads.findIndex((s) => s.presetId === squad.presetId && !!s.support === !!squad.support);
        const isVariant = baseline !== idx;
        return `
        <div class="squad${squad.support ? " is-support" : ""}" data-idx="${idx}" style="border-left-color:${color}">
            <div class="squad-head">
                <input class="squad-label" data-field="label" value="${esc(squad.label)}" aria-label="Squad name">
                ${squad.support ? '<span class="tag support">support</span>' : ""}
                ${isVariant ? '<span class="tag variant">variant</span>' : ""}
                <span class="grow"></span>
                <label class="inline" title="A support squad fights normally — its debuffs and mana feeds help the raid — but its damage is excluded from the analysis, and auras are carried by supports first.">
                    <input type="checkbox" data-field="support"${squad.support ? " checked" : ""}> support
                </label>
                <label class="inline">build
                    <select data-field="presetId">${buildOptions(squad.presetId)}</select>
                </label>
                <label class="inline">players
                    <input type="number" min="0" max="200" data-field="count" value="${Number(squad.count) || 0}">
                </label>
                <button type="button" class="btn small" data-act="preview" title="Preview this squad's gear, levels and abilities exactly as it will be simulated">👁 preview</button>
                <button type="button" class="btn small" data-act="variant" title="Split players off into a copy of this squad, so you can change its kit and compare">＋ variant</button>
                <button type="button" class="btn small danger" data-act="remove" title="Remove this squad">✕</button>
            </div>
            <div class="slots">
                ${[0, 1, 2, 3, 4].map((i) => {
                    const slot = (squad.kit || [])[i] || null;
                    return `
                    <div class="slot">
                        <span class="slot-no">${i === 0 ? "aura" : i}</span>
                        <select data-slot="${i}" data-field="slotHrid">${abilityOptions(slot && slot.hrid)}</select>
                        <input type="number" class="slot-level" min="1" max="200" data-slot="${i}" data-field="slotLevel"
                               value="${slot ? Number(slot.level) || 1 : 1}" ${slot ? "" : "disabled"} aria-label="Ability level">
                        ${slotMeta(slot && slot.hrid, style)}
                    </div>`;
                }).join("")}
            </div>
        </div>`;
    }).join("");
}

function renderOptions() {
    el("optInfiniteMana").checked = !!state.infiniteMana;
    el("optNoDamage").checked = !!state.noPlayerDamage;
    el("optAuras").checked = !!state.auras;
    el("auraLevel").value = state.auraLevel;
    el("runCount").value = state.runs;
    el("timeCap").value = state.timeCapSeconds;
}

function renderAll() {
    renderEnemy();
    renderSavedBuilds();
    renderSquads();
    renderOptions();
}

// --------------------------------------------------------- build preview

// Preview modal: the same build detail the group-battle page shows, rendered from
// the DTO the simulation would actually build, plus the two handoffs — copy the
// build as a solo export, or open it in the standard simulator.
function openPreview(title, presetId, kit) {
    const dto = squadDTO(presetId, kit);
    if (!dto) {
        showError(`Build "${presetId}" is not available — press Refresh under Saved builds, or pick another build.`);
        return;
    }

    const build = getBuild(presetId);
    el("previewTitle").textContent = build && build.name !== title ? `${title} — ${build.name}` : title;
    const body = el("previewBody");
    body.innerHTML = `<div class="row" style="margin-bottom:6px">
            <button type="button" class="btn small export-json-btn">⧉ Export JSON</button>
            <button type="button" class="btn small open-sim-btn">↗ Open in simulator</button>
            <span class="export-status hint" style="margin:0"></span>
        </div>
        <p class="hint" style="margin:0 0 10px">Food and drinks are never part of a Skill Lab build, so they are empty
            here and in anything handed to the simulator.</p>` + playerDetailHtml(dto);

    const status = body.querySelector(".export-status");

    const statusBtn = body.querySelector(".show-status-btn");
    statusBtn.addEventListener("click", () => {
        const panel = body.querySelector(".detailed-status");
        const open = panel.style.display !== "none";
        if (open) {
            panel.style.display = "none";
            statusBtn.textContent = "Show Detailed Combat Status";
        } else {
            renderDetailedStatus(panel, dto);
            panel.style.display = "block";
            statusBtn.textContent = "Hide Detailed Combat Status";
        }
    });

    body.querySelector(".export-json-btn").addEventListener("click", async () => {
        const json = JSON.stringify(dtoToSoloExport(dto));
        try {
            await navigator.clipboard.writeText(json);
            status.textContent = "Copied to clipboard.";
        } catch (e) {
            status.textContent = "Copy failed — clipboard unavailable.";
        }
    });

    // Hand the build to the standard simulator: it consumes this key on load.
    body.querySelector(".open-sim-btn").addEventListener("click", () => {
        try {
            localStorage.setItem(SOLO_IMPORT_HANDOFF_KEY, JSON.stringify(dtoToSoloExport(dto)));
        } catch (e) {
            status.textContent = "Could not hand the build over — storage unavailable.";
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

// Reload the saved equipment sets from localStorage (Refresh, and on page load).
function refreshSavedBuilds() {
    const failed = loadSavedBuilds();
    renderSavedBuilds();
    renderSquads();
    showError(failed.length
        ? `Skipped ${failed.length} equipment set(s):\n` + failed.join("\n")
        : "");
}

// ------------------------------------------------------------------- results

function renderResult(agg) {
    if (!agg) { el("resultPanel").style.display = "none"; return; }
    el("resultPanel").style.display = "block";

    // Analysis covers non-support squads only; supports render dimmed below it.
    const dpsSquads = agg.squads.filter((q) => !q.support);
    const supSquads = agg.squads.filter((q) => q.support);
    const totalDmg = dpsSquads.reduce((s, q) => s + q.dmg, 0) || 1;
    const timedOut = agg.outcomes.some((o) => o === "timeout");
    const wiped = agg.outcomes.some((o) => o === "defeat");
    const outcome = outcomeSummary(agg.outcomes);
    const deaths = agg.partySize - (agg.survivors ?? agg.partySize);

    const baselineFor = (q) => {
        const idx = agg.squads.indexOf(q);
        const first = agg.squads.findIndex((s) => s.presetId === q.presetId && !!s.support === !!q.support);
        return first === idx ? null : agg.squads[first];
    };

    el("resultSummary").innerHTML = `
        <div class="stat-row">
            <div class="stat"><span>Outcome</span><b class="${outcome.cls}">${esc(outcome.text)}</b></div>
            <div class="stat"><span>Kill time</span><b>${(agg.seconds / 60).toFixed(1)} min</b></div>
            <div class="stat"><span>Group HP</span><b>${fmt(agg.totalHp)}</b></div>
            <div class="stat"><span>Party</span><b>${agg.partySize} <span class="dim">(${agg.supportCount} support)</span></b></div>
            <div class="stat"><span>Survivors</span><b class="${deaths ? "bad" : ""}">${agg.survivors ?? agg.partySize} <span class="dim">/ ${agg.partySize}</span></b></div>
            <div class="stat"><span>Runs</span><b>${agg.runs} seed${agg.runs > 1 ? "s" : ""}</b></div>
        </div>
        ${wiped ? `<p class="hint bad">The party wiped in at least one run — the fight ended early, so every damage number below covers a shorter fight than a clear would.</p>` : ""}
        ${timedOut ? `<p class="hint warn">At least one run hit the time cap, so the numbers below are a partial fight. Raise the cap or add damage.</p>` : ""}
        ${(lastRunOptions || state).noPlayerDamage && !wiped ? `<p class="hint">Players take no damage with the current options, so a wipe cannot happen — untick <b>players take no damage</b> to test survival.</p>` : ""}`;

    el("resultTable").innerHTML = `
        <table>
            <thead>
                <tr>
                    <th>Squad</th><th>Build</th><th>Players</th>
                    <th>DPS / player</th><th>%HP / min</th><th>Share</th>
                    <th>Hit rate</th><th>Blocked casts</th><th>vs baseline</th>
                </tr>
            </thead>
            <tbody>
                ${[...dpsSquads, ...supSquads].map((q) => {
                    const idx = agg.squads.indexOf(q);
                    const base = baselineFor(q);
                    const style = buildStyle(q.presetId);
                    const color = STYLE_COLORS[style] || "#9aa0aa";
                    const hit = q.hits + q.misses ? q.hits / (q.hits + q.misses) : 0;
                    let delta = '<span class="dim">baseline</span>';
                    if (base && base.dps > 0) {
                        const pct = (q.dps / base.dps - 1) * 100;
                        const cls = pct > 0.5 ? "good" : pct < -0.5 ? "bad" : "dim";
                        delta = `<span class="${cls}">${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%</span> <span class="dim">vs ${esc(base.label)}</span>`;
                    }
                    const shareCell = q.support ? '<span class="dim">excluded</span>' : `${(q.dmg / totalDmg * 100).toFixed(1)}%`;
                    return `
                    <tr class="squad-row${q.support ? " support-row" : ""}" data-idx="${idx}">
                        <td><span class="dot" style="background:${color}"></span>${esc(q.label)}${q.support ? ' <span class="tag support">support</span>' : ""}</td>
                        <td class="dim">${esc(PRESETS[q.presetId] ? PRESETS[q.presetId].name : q.presetId)}</td>
                        <td>${q.n}</td>
                        <td>${q.support ? `<span class="dim">${fmt(q.dps, 1)}</span>` : `<b>${fmt(q.dps, 1)}</b>`}</td>
                        <td>${q.support ? `<span class="dim">${fmt(q.pctPerMin, 2)}</span>` : fmt(q.pctPerMin, 2)}</td>
                        <td class="dim">${shareCell}</td>
                        <td class="dim">${(hit * 100).toFixed(0)}%</td>
                        <td class="dim">${fmt(q.oom)}</td>
                        <td>${delta}</td>
                    </tr>
                    <tr class="detail-row" data-detail="${idx}" style="display:none">
                        <td colspan="9">${abilityBreakdown(q)}</td>
                    </tr>`;
                }).join("")}
            </tbody>
        </table>
        <p class="hint">Click a row for its ability breakdown. <b>%HP / min</b> is the whole squad's share of the group's HP pool per minute; <b>DPS / player</b> is one player's damage per second. <b>Share</b> covers non-support squads only — support squads fight and debuff, but their damage is excluded from the analysis. Squads sharing a build are compared against the first of that build.</p>`;

    el("resultTable").querySelectorAll(".squad-row").forEach((row) => {
        row.addEventListener("click", () => {
            const d = el("resultTable").querySelector(`[data-detail="${row.dataset.idx}"]`);
            d.style.display = d.style.display === "none" ? "table-row" : "none";
        });
    });
}

// Engine outcomes in the page's words, collapsed across seeds: one label when
// every run agreed, otherwise a count per distinct outcome ("2× victory · 1× wiped").
const OUTCOME_LABELS = {
    victory: { text: "victory", cls: "good" },
    defeat: { text: "wiped", cls: "bad" },
    timeout: { text: "time cap hit", cls: "warn" },
    ended: { text: "stalemate", cls: "warn" },
};

function outcomeSummary(outcomes) {
    const counts = new Map();
    for (const o of outcomes) counts.set(o, (counts.get(o) || 0) + 1);
    // Worst outcome present drives the colour: wipe, then time cap, then clear.
    const cls = counts.has("defeat") ? "bad"
        : counts.has("timeout") || counts.has("ended") ? "warn" : "good";
    if (counts.size === 1) {
        const only = outcomes[0];
        return { text: (OUTCOME_LABELS[only] || { text: only }).text, cls };
    }
    const text = [...counts.entries()]
        .map(([o, n]) => `${n}× ${(OUTCOME_LABELS[o] || { text: o }).text}`)
        .join(" · ");
    return { text, cls };
}

function abilityBreakdown(q) {
    const rows = Object.entries(q.perAbility).sort((a, b) => b[1].dmg - a[1].dmg);
    const total = rows.reduce((s, [, v]) => s + v.dmg, 0) || 1;
    const casts = Object.entries(q.casts).sort((a, b) => b[1] - a[1]);
    return `
        <div class="breakdown">
            <div>
                <div class="bd-title">Damage by ability</div>
                <table class="mini">
                    <thead><tr><th>Source</th><th>Share</th><th>Damage</th><th>Hits</th><th>Accuracy</th></tr></thead>
                    <tbody>
                        ${rows.map(([name, v]) => `
                            <tr>
                                <td>${esc(name.replace("/abilities/", ""))}</td>
                                <td>${(v.dmg / total * 100).toFixed(0)}%</td>
                                <td>${fmt(v.dmg)}</td>
                                <td>${fmt(v.hits)}</td>
                                <td>${v.hits + v.misses ? (v.hits / (v.hits + v.misses) * 100).toFixed(0) + "%" : "—"}</td>
                            </tr>`).join("")}
                    </tbody>
                </table>
            </div>
            <div>
                <div class="bd-title">Casts (squad total)</div>
                <table class="mini">
                    <thead><tr><th>Ability</th><th>Casts</th></tr></thead>
                    <tbody>
                        ${casts.map(([name, c]) => `<tr><td>${esc(name.replace("/abilities/", ""))}</td><td>${fmt(c)}</td></tr>`).join("")}
                    </tbody>
                </table>
                <div class="bd-title" style="margin-top:10px">Damage by target</div>
                <table class="mini">
                    <thead><tr><th>Enemy</th><th>Damage</th></tr></thead>
                    <tbody>
                        ${Object.entries(q.perTarget).sort((a, b) => b[1] - a[1]).map(([name, v]) =>
                            `<tr><td>${esc(name.replace("/monsters/", ""))}</td><td>${fmt(v)}</td></tr>`).join("")}
                    </tbody>
                </table>
            </div>
        </div>`;
}

// ---------------------------------------------------------------------- run

function run() {
    if (running) return;
    if (!partySize()) { showError("The roster is empty — give at least one squad a player count above zero."); return; }
    showError("");
    running = true;
    el("runBtn").disabled = true;
    el("progress").style.display = "block";
    el("progress").textContent = "Running run 1…";

    const config = {
        groupName: state.groupName,
        level: Number(state.level),
        runs: Number(state.runs),
        // Saved-gear builds aren't bundled, so the worker gets them by value.
        customBuilds: customBuildList().map((b) => ({ id: b.id, name: b.name, export: b.export })),
        squads: state.squads.map((s) => ({
            id: s.id, label: s.label, presetId: s.presetId,
            count: Number(s.count) || 0,
            support: !!s.support,
            kit: (s.kit || []).map((slot) => (slot && slot.hrid ? { hrid: slot.hrid, level: Number(slot.level) || 1 } : null)),
        })),
        options: {
            infiniteMana: !!state.infiniteMana,
            noPlayerDamage: !!state.noPlayerDamage,
            auras: !!state.auras,
            auraLevel: Number(state.auraLevel) || 25,
            timeCapSeconds: Number(state.timeCapSeconds) || 3600,
        },
    };

    lastRunOptions = config.options;
    worker.postMessage({ type: "run_skill_lab", config });
}

worker.onmessage = (event) => {
    const data = event.data;
    if (data.type === "skill_lab_progress") {
        el("progress").textContent =
            `Run ${data.done} of ${data.total} done — ${(data.seconds / 60).toFixed(1)} min, ${data.outcome}` +
            (data.done < data.total ? ` · running run ${data.done + 1}…` : "");
        return;
    }
    if (data.type === "skill_lab_result") {
        running = false;
        el("runBtn").disabled = false;
        el("progress").style.display = "none";
        lastResult = data.result;
        renderResult(lastResult);
        el("resultPanel").scrollIntoView({ behavior: "smooth", block: "start" });
        return;
    }
    if (data.type === "skill_lab_error") {
        running = false;
        el("runBtn").disabled = false;
        el("progress").style.display = "none";
        showError("Simulation failed: " + data.error);
    }
};

// ------------------------------------------------------------------- events

function onSquadInput(e) {
    const squadEl = e.target.closest(".squad");
    if (!squadEl) return;
    const squad = state.squads[Number(squadEl.dataset.idx)];
    if (!squad) return;
    const field = e.target.dataset.field;

    if (field === "label") squad.label = e.target.value;
    else if (field === "support") squad.support = e.target.checked;
    else if (field === "presetId") {
        squad.presetId = e.target.value;
        // A support squad runs its preset's own kit by default; refresh it so the
        // slots show what the new preset actually casts.
        if (squad.support) squad.kit = presetKit(squad.presetId);
    }
    else if (field === "count") squad.count = Math.max(0, Number(e.target.value) || 0);
    else if (field === "slotHrid") {
        const i = Number(e.target.dataset.slot);
        squad.kit = squad.kit || [null, null, null, null, null];
        const hrid = e.target.value;
        if (!hrid) {
            squad.kit[i] = null;
        } else {
            const meta = ABILITY_BY_HRID[hrid];
            const keepLevel = squad.kit[i] && squad.kit[i].level;
            squad.kit[i] = { hrid, level: keepLevel || (meta && meta.isSpecial ? 20 : 40) };
        }
    } else if (field === "slotLevel") {
        const i = Number(e.target.dataset.slot);
        if (squad.kit && squad.kit[i]) squad.kit[i].level = Math.max(1, Number(e.target.value) || 1);
    } else {
        return;
    }
    saveState();
    if (field === "count") renderEnemy();
    if (field === "presetId" || field === "slotHrid" || field === "support") { renderSquads(); renderEnemy(); }
}

function onSquadClick(e) {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const idx = Number(btn.closest(".squad").dataset.idx);
    const squad = state.squads[idx];
    if (!squad) return;

    if (btn.dataset.act === "preview") {
        openPreview(squad.label, squad.presetId, squad.kit || []);
        return;
    }

    if (btn.dataset.act === "remove") {
        state.squads.splice(idx, 1);
        if (!state.squads.length) state.squads.push({ ...defaultState().squads[0], id: state.nextId++ });
    } else if (btn.dataset.act === "variant") {
        // Move players off this squad into a copy, so the party size is unchanged
        // — the "swap 5 people onto a new kit" workflow.
        const take = Math.min(5, Number(squad.count) || 0);
        squad.count = (Number(squad.count) || 0) - take;
        state.squads.splice(idx + 1, 0, {
            id: state.nextId++,
            label: squad.label + " B",
            presetId: squad.presetId,
            count: take,
            support: !!squad.support,
            kit: (squad.kit || []).map((s) => (s ? { ...s } : null)),
        });
    }
    saveState();
    renderSquads();
    renderEnemy();
}

document.addEventListener("DOMContentLoaded", () => {
    renderAll();

    el("groupSelect").addEventListener("change", (e) => { state.groupName = e.target.value; saveState(); renderEnemy(); });
    el("levelSelect").addEventListener("change", (e) => { state.level = Number(e.target.value); saveState(); renderEnemy(); });

    el("squadList").addEventListener("input", onSquadInput);
    el("squadList").addEventListener("change", onSquadInput);
    el("squadList").addEventListener("click", onSquadClick);

    el("addSquad").addEventListener("click", () => {
        state.squads.push({
            id: state.nextId++, label: "Squad " + (state.squads.length + 1),
            presetId: PRESET_LIST[0].id, count: 0, support: false,
            kit: [null, null, null, null, null],
        });
        saveState(); renderSquads(); renderEnemy();
    });

    el("optInfiniteMana").addEventListener("change", (e) => { state.infiniteMana = e.target.checked; saveState(); });
    el("optNoDamage").addEventListener("change", (e) => { state.noPlayerDamage = e.target.checked; saveState(); });
    el("optAuras").addEventListener("change", (e) => { state.auras = e.target.checked; saveState(); });
    el("auraLevel").addEventListener("input", (e) => { state.auraLevel = Math.max(1, Number(e.target.value) || 1); saveState(); });
    el("runCount").addEventListener("input", (e) => { state.runs = Math.min(10, Math.max(1, Number(e.target.value) || 1)); saveState(); });
    el("timeCap").addEventListener("input", (e) => { state.timeCapSeconds = Math.max(60, Number(e.target.value) || 3600); saveState(); });

    el("refreshBuilds").addEventListener("click", refreshSavedBuilds);
    el("savedBuilds").addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-build]");
        if (!btn) return;
        const build = getBuild(btn.dataset.build);
        // A saved set previews on its own gear and its own abilities.
        openPreview(build ? build.name : btn.dataset.build, btn.dataset.build, null);
    });

    el("previewClose").addEventListener("click", closePreview);
    el("previewOverlay").addEventListener("click", (e) => {
        if (e.target === el("previewOverlay")) closePreview();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closePreview();
    });

    el("runBtn").addEventListener("click", run);
    el("resetBtn").addEventListener("click", () => {
        if (!confirm("Reset the roster, kits and options back to the defaults?")) return;
        state = defaultState();
        saveState();
        renderAll();
        lastResult = null;
        renderResult(null);
    });
});
