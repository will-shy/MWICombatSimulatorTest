// Skill Lab page logic. Builds squads of identical players, runs one trial-group
// encounter in a worker, and reports damage per squad so two kits on the same
// build can be compared side by side.
//
// English-only by project convention for new group-battle features.
import {
    PRESET_LIST, PRESETS, MONSTER_GROUPS, ABILITY_LIST,
    enemyPreview, buildStyle,
} from "./combatsimulator/skillLab.js";

const STORE_KEY = "mwiSkillLabConfig";
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

// --------------------------------------------------------------- default state

const A = (hrid, level) => ({ hrid, level });

function defaultState() {
    return {
        groupName: MONSTER_GROUPS.includes("Trial Swarm") ? "Trial Swarm" : MONSTER_GROUPS[0],
        level: 160,
        runs: 3,
        timeCapSeconds: 3600,
        infiniteMana: true,
        noPlayerDamage: true,
        auras: true,
        auraLevel: 25,
        nextId: 4,
        squads: [
            {
                id: 1, label: "Melee", presetId: pick("smash_T95", "smash_insanity"), count: 14,
                kit: [
                    A("/abilities/insanity", 20), A("/abilities/frenzy", 40), A("/abilities/berserk", 40),
                    A("/abilities/precision", 40), A("/abilities/fracturing_impact", 40),
                ],
            },
            {
                id: 2, label: "Ranged", presetId: pick("ranger_T95", "crossbow_insanity"), count: 14,
                kit: [
                    A("/abilities/insanity", 20), A("/abilities/frenzy", 40), A("/abilities/berserk", 40),
                    A("/abilities/pestilent_shot", 40), A("/abilities/penetrating_shot", 40),
                ],
            },
            {
                id: 3, label: "Magic", presetId: pick("nature_aoe_T95", "water_insanity"), count: 14,
                kit: [
                    A("/abilities/insanity", 20), A("/abilities/elemental_affinity", 40),
                    A("/abilities/firestorm", 40), A("/abilities/natures_veil", 40),
                    A("/abilities/entangle", 60),
                ],
            },
        ],
        supports: [
            { presetId: pick("wark", PRESET_LIST[0].id), count: 2 },
            { presetId: pick("nature_healer_revive", PRESET_LIST[0].id), count: 8 },
        ],
    };
}

function pick(...ids) {
    for (const id of ids) if (id && PRESETS[id]) return id;
    return PRESET_LIST[0].id;
}

let state = loadState();

function loadState() {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        if (!raw) return defaultState();
        const parsed = JSON.parse(raw);
        // Drop anything referencing a preset that no longer exists.
        parsed.squads = (parsed.squads || []).filter((s) => PRESETS[s.presetId]);
        parsed.supports = (parsed.supports || []).filter((s) => PRESETS[s.presetId]);
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
    const dps = state.squads.reduce((s, q) => s + (Number(q.count) || 0), 0);
    const sup = state.supports.reduce((s, q) => s + (Number(q.count) || 0), 0);
    return dps + sup;
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

function renderSquads() {
    const host = el("squadList");
    host.innerHTML = state.squads.map((squad, idx) => {
        const style = buildStyle(squad.presetId);
        const color = STYLE_COLORS[style] || "#9aa0aa";
        const baseline = state.squads.findIndex((s) => s.presetId === squad.presetId);
        const isVariant = baseline !== idx;
        return `
        <div class="squad" data-idx="${idx}" style="border-left-color:${color}">
            <div class="squad-head">
                <input class="squad-label" data-field="label" value="${esc(squad.label)}" aria-label="Squad name">
                ${isVariant ? '<span class="tag variant">variant</span>' : ""}
                <span class="grow"></span>
                <label class="inline">build
                    <select data-field="presetId">
                        ${PRESET_LIST.map((p) => `<option value="${esc(p.id)}"${p.id === squad.presetId ? " selected" : ""}>${esc(p.name)}</option>`).join("")}
                    </select>
                </label>
                <label class="inline">players
                    <input type="number" min="0" max="200" data-field="count" value="${Number(squad.count) || 0}">
                </label>
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

function renderSupports() {
    el("supportList").innerHTML = state.supports.map((sup, idx) => `
        <div class="support" data-idx="${idx}">
            <select data-field="presetId">
                ${PRESET_LIST.map((p) => `<option value="${esc(p.id)}"${p.id === sup.presetId ? " selected" : ""}>${esc(p.name)}</option>`).join("")}
            </select>
            <input type="number" min="0" max="100" data-field="count" value="${Number(sup.count) || 0}">
            <button type="button" class="btn small danger" data-act="remove">✕</button>
        </div>`).join("");
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
    renderSquads();
    renderSupports();
    renderOptions();
}

// ------------------------------------------------------------------- results

function renderResult(agg) {
    if (!agg) { el("resultPanel").style.display = "none"; return; }
    el("resultPanel").style.display = "block";

    const totalDmg = agg.squads.reduce((s, q) => s + q.dmg, 0) || 1;
    const timedOut = agg.outcomes.some((o) => o === "timeout");

    const baselineFor = (idx) => {
        const q = agg.squads[idx];
        const first = agg.squads.findIndex((s) => s.presetId === q.presetId);
        return first === idx ? null : agg.squads[first];
    };

    el("resultSummary").innerHTML = `
        <div class="stat-row">
            <div class="stat"><span>Outcome</span><b class="${timedOut ? "warn" : "good"}">${timedOut ? "time cap hit" : "cleared"}</b></div>
            <div class="stat"><span>Kill time</span><b>${(agg.seconds / 60).toFixed(1)} min</b></div>
            <div class="stat"><span>Group HP</span><b>${fmt(agg.totalHp)}</b></div>
            <div class="stat"><span>Party</span><b>${agg.partySize} <span class="dim">(${agg.supportCount} support)</span></b></div>
            <div class="stat"><span>Runs</span><b>${agg.runs} seed${agg.runs > 1 ? "s" : ""}</b></div>
        </div>
        ${timedOut ? `<p class="hint warn">At least one run hit the time cap, so the numbers below are a partial fight. Raise the cap or add damage.</p>` : ""}`;

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
                ${agg.squads.map((q, idx) => {
                    const base = baselineFor(idx);
                    const style = buildStyle(q.presetId);
                    const color = STYLE_COLORS[style] || "#9aa0aa";
                    const hit = q.hits + q.misses ? q.hits / (q.hits + q.misses) : 0;
                    let delta = '<span class="dim">baseline</span>';
                    if (base && base.dps > 0) {
                        const pct = (q.dps / base.dps - 1) * 100;
                        const cls = pct > 0.5 ? "good" : pct < -0.5 ? "bad" : "dim";
                        delta = `<span class="${cls}">${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%</span> <span class="dim">vs ${esc(base.label)}</span>`;
                    }
                    return `
                    <tr class="squad-row" data-idx="${idx}">
                        <td><span class="dot" style="background:${color}"></span>${esc(q.label)}</td>
                        <td class="dim">${esc(PRESETS[q.presetId] ? PRESETS[q.presetId].name : q.presetId)}</td>
                        <td>${q.n}</td>
                        <td><b>${fmt(q.dps, 1)}</b></td>
                        <td>${fmt(q.pctPerMin, 2)}</td>
                        <td class="dim">${(q.dmg / totalDmg * 100).toFixed(1)}%</td>
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
        <p class="hint">Click a row for its ability breakdown. <b>%HP / min</b> is the whole squad's share of the group's HP pool per minute; <b>DPS / player</b> is one player's damage per second. Squads sharing a build are compared against the first of that build.</p>`;

    el("resultTable").querySelectorAll(".squad-row").forEach((row) => {
        row.addEventListener("click", () => {
            const d = el("resultTable").querySelector(`[data-detail="${row.dataset.idx}"]`);
            d.style.display = d.style.display === "none" ? "table-row" : "none";
        });
    });
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

    worker.postMessage({
        type: "run_skill_lab",
        config: {
            groupName: state.groupName,
            level: Number(state.level),
            runs: Number(state.runs),
            squads: state.squads.map((s) => ({
                id: s.id, label: s.label, presetId: s.presetId,
                count: Number(s.count) || 0,
                kit: (s.kit || []).map((slot) => (slot && slot.hrid ? { hrid: slot.hrid, level: Number(slot.level) || 1 } : null)),
            })),
            supports: state.supports.map((s) => ({ presetId: s.presetId, count: Number(s.count) || 0 })),
            options: {
                infiniteMana: !!state.infiniteMana,
                noPlayerDamage: !!state.noPlayerDamage,
                auras: !!state.auras,
                auraLevel: Number(state.auraLevel) || 25,
                timeCapSeconds: Number(state.timeCapSeconds) || 3600,
            },
        },
    });
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
    else if (field === "presetId") squad.presetId = e.target.value;
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
    if (field === "presetId" || field === "slotHrid") { renderSquads(); renderEnemy(); }
}

function onSquadClick(e) {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const idx = Number(btn.closest(".squad").dataset.idx);
    const squad = state.squads[idx];
    if (!squad) return;

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
            kit: (squad.kit || []).map((s) => (s ? { ...s } : null)),
        });
    }
    saveState();
    renderSquads();
    renderEnemy();
}

function onSupportInput(e) {
    const row = e.target.closest(".support");
    if (!row) return;
    const sup = state.supports[Number(row.dataset.idx)];
    if (!sup) return;
    if (e.target.dataset.field === "presetId") sup.presetId = e.target.value;
    if (e.target.dataset.field === "count") sup.count = Math.max(0, Number(e.target.value) || 0);
    saveState();
    renderEnemy();
}

function onSupportClick(e) {
    const btn = e.target.closest("button[data-act='remove']");
    if (!btn) return;
    state.supports.splice(Number(btn.closest(".support").dataset.idx), 1);
    saveState();
    renderSupports();
    renderEnemy();
}

document.addEventListener("DOMContentLoaded", () => {
    renderAll();

    el("groupSelect").addEventListener("change", (e) => { state.groupName = e.target.value; saveState(); renderEnemy(); });
    el("levelSelect").addEventListener("change", (e) => { state.level = Number(e.target.value); saveState(); renderEnemy(); });

    el("squadList").addEventListener("input", onSquadInput);
    el("squadList").addEventListener("change", onSquadInput);
    el("squadList").addEventListener("click", onSquadClick);

    el("supportList").addEventListener("input", onSupportInput);
    el("supportList").addEventListener("change", onSupportInput);
    el("supportList").addEventListener("click", onSupportClick);

    el("addSquad").addEventListener("click", () => {
        state.squads.push({
            id: state.nextId++, label: "Squad " + (state.squads.length + 1),
            presetId: PRESET_LIST[0].id, count: 0,
            kit: [null, null, null, null, null],
        });
        saveState(); renderSquads(); renderEnemy();
    });
    el("addSupport").addEventListener("click", () => {
        state.supports.push({ presetId: PRESET_LIST[0].id, count: 0 });
        saveState(); renderSupports(); renderEnemy();
    });

    el("optInfiniteMana").addEventListener("change", (e) => { state.infiniteMana = e.target.checked; saveState(); });
    el("optNoDamage").addEventListener("change", (e) => { state.noPlayerDamage = e.target.checked; saveState(); });
    el("optAuras").addEventListener("change", (e) => { state.auras = e.target.checked; saveState(); });
    el("auraLevel").addEventListener("input", (e) => { state.auraLevel = Math.max(1, Number(e.target.value) || 1); saveState(); });
    el("runCount").addEventListener("input", (e) => { state.runs = Math.min(10, Math.max(1, Number(e.target.value) || 1)); saveState(); });
    el("timeCap").addEventListener("input", (e) => { state.timeCapSeconds = Math.max(60, Number(e.target.value) || 3600); saveState(); });

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
