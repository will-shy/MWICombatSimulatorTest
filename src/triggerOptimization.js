// Trigger Optimization page: opened with the Triggers button on a row of the Optimization results
// table. It takes that row's party (zone, tier, the three players' DTOs) and lets you edit the
// combat triggers of any ability, starting from the current ones. Abilities ticked "sim" get their
// trigger's numbers searched for the best encounters per hour (EPH). See docs/optimization.md,
// "Trigger Optimization".
//
// Two modes (the "Parallel sims" box):
//  - parallel (default): every ticked ability is searched at the same time, each against the
//    baseline, then the best of each are simulated together once. Concurrent searches share
//    batches, so the worker pool stays full.
//  - sequential: coordinate descent. Abilities are tuned one at a time, each on top of the
//    triggers adopted before it.
// Within an ability the numbers are searched one trigger at a time. Every candidate is one
// independent simulation, run on the Optimization page's worker pool.

import abilityDetailMap from "./combatsimulator/data/abilityDetailMap.json";
import combatTriggerDependencyDetailMap from "./combatsimulator/data/combatTriggerDependencyDetailMap.json";
import combatTriggerConditionDetailMap from "./combatsimulator/data/combatTriggerConditionDetailMap.json";
import combatTriggerComparatorDetailMap from "./combatsimulator/data/combatTriggerComparatorDetailMap.json";
import { kitName } from "./kitName.js";
import { metricsFor } from "./combatsimulator/zoneDrops.js";
import { gameName, initLanguage, language, onSharedI18nReady, setLanguage, t } from "./optimizationI18n.js";

// Written by optimization.js when a Triggers button is clicked. Must match there.
const CONTEXT_KEY = "mwiTriggerOptContext";
const ONE_HOUR = 60 * 60 * 1e9;
const PLAYER_HRIDS = ["player1", "player2", "player3"];
const MAX_TRIGGERS = 4;
// The most simulations this browser runs at once. Must match MAX_POOL_SIZE in optimizationWorker.js,
// which clamps whatever is asked for to the same number.
const MAX_POOL_SIZE = 16;
const maxPoolSize = () => Math.max(1, Math.min(Number(navigator.hardwareConcurrency) || 4, MAX_POOL_SIZE));
// The "sims at once" box, clamped to 1..max; empty or junk means the max.
const confirmHoursSetting = () => Math.max(1, Number(el("confirmHours").value) || 100);
const poolSizeSetting = () => {
    const value = Math.floor(Number(el("poolSize").value));
    return value > 0 ? Math.min(value, maxPoolSize()) : maxPoolSize();
};

// ------------------------------------------------------------------ search rules

const COUNT_CONDITIONS = [
    "/combat_trigger_conditions/number_of_active_units",
    "/combat_trigger_conditions/number_of_dead_units",
];
const PERCENT_CONDITIONS = ["/combat_trigger_conditions/lowest_hp_percentage"];

const COUNT_VALUES = [1, 2, 3];
const PERCENT_COARSE = [10, 30, 50, 70, 90];
const PERCENT_STEPS = [10, 5, 2];
// Plain numbers (current/missing HP or MP) have no known scale here (an enemy's HP runs from
// hundreds to millions), so the first pass tries a wide fixed grid, plus the value already in the box,
// and then narrows around the best.
const NUMBER_COARSE = [1, 100, 300, 1000, 3000, 5000];
// Plain numbers are never searched above this.
const NUMBER_MAX = 5000;
const NUMBER_FACTORS_REFINE = [1.5, 1.2];
// A candidate has to beat the incumbent by this much (EPH) to be adopted.
const MIN_GAIN = 1e-6;
// One ability's new trigger can change what is best for another, so the search repeats in passes.
// It stops after a pass that gains less than STOP_GAIN EPH, or at MAX_PASSES.
const STOP_GAIN = 0.5;
const MAX_PASSES = 5;

function kindOf(trigger) {
    if (!combatTriggerComparatorDetailMap[trigger.comparatorHrid]?.allowValue) return null;
    if (COUNT_CONDITIONS.includes(trigger.conditionHrid)) return "count";
    if (PERCENT_CONDITIONS.includes(trigger.conditionHrid)) return "percent";
    return "number";
}

function coarseValues(kind, start) {
    if (kind === "count") return COUNT_VALUES.slice();
    if (kind === "percent") return PERCENT_COARSE.slice();
    const own = Math.round(Number(start));
    return [...new Set(own > 0 && own <= NUMBER_MAX ? [own, ...NUMBER_COARSE] : NUMBER_COARSE)].sort((a, b) => a - b);
}

// Rounds of refinement around the best value so far: each round is the values next to it.
function refineRounds(kind) {
    if (kind === "percent") {
        return PERCENT_STEPS.map((d) => (best) => [best - d, best + d].filter((v) => v >= 0 && v <= 100));
    }
    if (kind === "number") {
        return NUMBER_FACTORS_REFINE.map((f) => (best) => [Math.round(best / f), Math.round(best * f)].filter((v) => v >= 1 && v <= NUMBER_MAX));
    }
    return [];
}

function refineText(kind) {
    if (kind === "percent") return t("trRefinePercent", { steps: PERCENT_STEPS.join(", ±") });
    if (kind === "number") return t("trRefineNumber", { factors: NUMBER_FACTORS_REFINE.join(", ") });
    return t("trRefineNone");
}

const maxRefineSims = (kind) => refineRounds(kind).length * 2;

// ------------------------------------------------------------------ state

let ctx = null;
// drafts[p][a] = { triggers: [...], sim: bool } for the ability at dto.abilities[a] of player p.
// A draft starts as a copy of the ability's current triggers.
let drafts = [];
let running = false;
let stopped = false;
let worker = null;
// Ends the batch that is running right now as "stopped" (null between batches).
let stopBatch = null;
let report = null;

const el = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n, d = 1) => Number.isFinite(n) ? n.toFixed(d) : "-";
const abilityName = (hrid) => gameName("abilityNames", hrid, abilityDetailMap[hrid]?.name ?? hrid);
const playerName = (p) => ctx.playerNames?.[p] || t("trPlayerFallback", { n: p + 1 });
const isParallel = () => el("parallel").checked;

function describe(trigger) {
    const dep = gameName("combatTriggerDependencyNames", trigger.dependencyHrid,
        combatTriggerDependencyDetailMap[trigger.dependencyHrid]?.name ?? trigger.dependencyHrid);
    const cond = gameName("combatTriggerConditionNames", trigger.conditionHrid,
        combatTriggerConditionDetailMap[trigger.conditionHrid]?.name ?? trigger.conditionHrid);
    const cmp = combatTriggerComparatorDetailMap[trigger.comparatorHrid];
    const cmpName = gameName("combatTriggerComparatorNames", trigger.comparatorHrid, cmp?.name ?? trigger.comparatorHrid);
    return cmp?.allowValue ? `${dep} ${cond} ${cmpName} ${trigger.value}` : `${dep} ${cond} ${cmpName}`;
}

const describeAll = (triggers) => triggers.length === 0
    ? t("trNoCondition")
    : triggers.map(describe).join("  AND  ");

const isComplete = (trigger) => !!(trigger.dependencyHrid && trigger.conditionHrid && trigger.comparatorHrid);
const sameTriggers = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ------------------------------------------------------------------ plan

// What the run will do, from the current drafts. Also what the "Plan preview" section shows.
// `skip` marks abilities that have nothing to simulate: an unchanged trigger with no number.
function buildPlan() {
    const items = [];
    ctx.players.forEach((player, p) => {
        player.dto.abilities.forEach((ability, a) => {
            const draft = drafts[p][a];
            if (!draft.sim || draft.triggers.length === 0) return;
            const valid = draft.triggers.every(isComplete);
            const params = [];
            draft.triggers.forEach((trigger, ti) => {
                const kind = isComplete(trigger) ? kindOf(trigger) : null;
                if (kind) params.push({ ti, kind, values: coarseValues(kind, trigger.value) });
            });
            const skip = valid && params.length === 0 && sameTriggers(draft.triggers, ability.triggers ?? []);
            const minSims = params.length === 0 ? 1 : params.reduce((s, x) => s + x.values.length, 0);
            const maxSims = params.length === 0 ? 1
                : params.reduce((s, x) => s + x.values.length + maxRefineSims(x.kind), 0);
            items.push({ p, a, valid, skip, params, minSims, maxSims });
        });
    });
    return items;
}

const runnable = (plan) => plan.filter((item) => item.valid && !item.skip);

function renderPlan() {
    const plan = buildPlan();
    const box = el("planBox");
    const good = runnable(plan);

    if (plan.length === 0) {
        box.innerHTML = t("trPlanEmpty");
        el("runBtn").disabled = true;
        return plan;
    }

    const combined = isParallel() && good.length >= 2 ? 1 : 0;
    const minTotal = 1 + combined + good.reduce((s, i) => s + i.minSims, 0);
    const maxTotal = 1 + combined + good.reduce((s, i) => s + i.maxSims, 0);
    const hours = Number(el("simHours").value) || 0;
    let html = `<div>${t("trPlanSummary", { min: minTotal, max: maxTotal, hours })} ` +
        `${esc(t(isParallel() ? "trPlanOrderPar" : "trPlanOrderSeq"))}</div>`;
    if (good.length >= 2 || (good.length === 1 && good[0].params.length > 0)) {
        html += `<div class="hint">${esc(t("trPlanPasses", { limit: STOP_GAIN, max: MAX_PASSES }))}</div>`;
    }
    html += `<div class="hint">${esc(t("trPlanConfirm", { hours: confirmHoursSetting() }))}</div>`;
    html += `<div class="plan-item">0. <b>${esc(t("trBaseline"))}</b>: ${esc(t("trPlanBaseline"))}</div>`;

    plan.forEach((item) => {
        const ability = ctx.players[item.p].dto.abilities[item.a];
        const title = `<b>${esc(playerName(item.p))} · ${esc(abilityName(ability.hrid))}</b>`;
        if (!item.valid) {
            html += `<div class="plan-item bad">${title}: ${esc(t("trPlanIncomplete"))}</div>`;
            return;
        }
        const n = good.indexOf(item) + 1;
        if (item.skip) {
            html += `<div class="plan-item dim">${title}: ${esc(t("trPlanUnchanged"))}</div>`;
            return;
        }
        html += `<div class="plan-item">${n}. ${title}` +
            ` <span class="dim">(${esc(t("trPlanSims", { min: item.minSims, max: item.maxSims }))})</span><br>` +
            `<span class="dim">${esc(describeAll(drafts[item.p][item.a].triggers))}</span>`;
        if (item.params.length === 0) {
            html += `<br>${esc(t("trPlanNoNumber"))}`;
        }
        for (const param of item.params) {
            const trigger = drafts[item.p][item.a].triggers[param.ti];
            html += `<br>• <i>${esc(describe(trigger).replace(/ \S+$/, ""))} ?</i> (${esc(t("trKind" + param.kind))}): ` +
                `${esc(t("trPlanTry", { values: param.values.join(", "), refine: refineText(param.kind) }))}`;
        }
        html += `</div>`;
    });
    if (combined) {
        html += `<div class="plan-item">${good.length + 1}. ${esc(t("trPlanCombined"))}</div>`;
    }
    box.innerHTML = html;
    el("runBtn").disabled = running || good.length === 0;
    return plan;
}

// ------------------------------------------------------------------ ability / trigger editor

const depOptions = () => Object.values(combatTriggerDependencyDetailMap)
    .sort((a, b) => a.sortIndex - b.sortIndex);

function conditionOptions(dependencyHrid) {
    const dependency = combatTriggerDependencyDetailMap[dependencyHrid];
    return Object.values(combatTriggerConditionDetailMap)
        .filter((c) => dependency.isSingleTarget ? c.isSingleTarget : c.isMultiTarget)
        .sort((a, b) => a.sortIndex - b.sortIndex);
}

function comparatorOptions(conditionHrid) {
    return combatTriggerConditionDetailMap[conditionHrid].allowedComparatorHrids
        .map((hrid) => combatTriggerComparatorDetailMap[hrid])
        .sort((a, b) => a.sortIndex - b.sortIndex);
}

const optionsHtml = (list, ns, selected) =>
    `<option value=""></option>` + list.map((o) =>
        `<option value="${esc(o.hrid)}"${o.hrid === selected ? " selected" : ""}>${esc(gameName(ns, o.hrid, o.name))}</option>`).join("");

function triggerRowHtml(p, a, ti, trigger) {
    const at = `data-p="${p}" data-a="${a}" data-ti="${ti}"`;
    let html = `<div class="trig"><select ${at} data-field="dependency">${optionsHtml(depOptions(), "combatTriggerDependencyNames", trigger.dependencyHrid)}</select>`;
    if (trigger.dependencyHrid) {
        html += `<select ${at} data-field="condition">${optionsHtml(conditionOptions(trigger.dependencyHrid), "combatTriggerConditionNames", trigger.conditionHrid)}</select>`;
    }
    if (trigger.conditionHrid) {
        html += `<select ${at} data-field="comparator">${optionsHtml(comparatorOptions(trigger.conditionHrid), "combatTriggerComparatorNames", trigger.comparatorHrid)}</select>`;
    }
    if (trigger.comparatorHrid && combatTriggerComparatorDetailMap[trigger.comparatorHrid].allowValue) {
        html += `<input type="number" ${at} data-field="value" value="${Number(trigger.value) || 0}" title="${esc(t("trStartValue"))}">`;
    }
    return html + `<button type="button" class="btn small danger" ${at} data-field="remove">✕</button></div>`;
}

function renderPlayers() {
    el("players").innerHTML = ctx.players.map((player, p) => `
        <div class="player">
            <h3>${esc(playerName(p))} <span class="dim">· ${esc(kitName(player.dto.abilities))}</span></h3>
            ${player.dto.abilities.map((ability, a) => {
                const draft = drafts[p][a];
                const at = `data-p="${p}" data-a="${a}"`;
                const changed = !sameTriggers(draft.triggers, ability.triggers ?? []);
                return `<div class="ability">
                    <div class="ability-head">
                        <b>${esc(abilityName(ability.hrid))} <span class="dim">L${ability.level}</span></b>
                        <label class="inline"><input type="checkbox" ${at} data-field="sim"${draft.sim ? " checked" : ""}> ${esc(t("trSim"))}</label>
                    </div>
                    <div class="current">${esc(t("trCurrent"))}${esc(describeAll(ability.triggers ?? []))}</div>
                    ${draft.triggers.map((trigger, ti) => triggerRowHtml(p, a, ti, trigger)).join("")}
                    <div class="row">
                        <button type="button" class="btn small ghost" ${at} data-field="add"${draft.triggers.length >= MAX_TRIGGERS ? " disabled" : ""}>${esc(t("trAddTrigger"))}</button>
                        <button type="button" class="btn small ghost" ${at} data-field="reset" title="${esc(t("trResetTitle"))}"${changed ? "" : " disabled"}>${esc(t("trReset"))}</button>
                        ${draft.triggers.length ? `<button type="button" class="btn small ghost" ${at} data-field="clear">${esc(t("trClear"))}</button>` : ""}
                    </div>
                </div>`;
            }).join("")}
        </div>`).join("");
}

function onEdit(event) {
    const target = event.target;
    const field = target.dataset.field;
    if (!field || running) return;
    if (event.type === "click" && target.tagName !== "BUTTON") return;
    if (event.type === "change" && target.tagName === "BUTTON") return;

    const p = Number(target.dataset.p);
    const a = Number(target.dataset.a);
    const ti = Number(target.dataset.ti);
    const draft = drafts[p]?.[a];
    if (!draft) return;
    const trigger = draft.triggers[ti];

    switch (field) {
        case "sim": draft.sim = target.checked; break;
        case "add":
            if (draft.triggers.length < MAX_TRIGGERS) {
                draft.triggers.push({ dependencyHrid: "", conditionHrid: "", comparatorHrid: "", value: 0 });
            }
            break;
        case "reset": draft.triggers = structuredClone(ctx.players[p].dto.abilities[a].triggers ?? []); break;
        case "clear": draft.triggers = []; break;
        case "remove": draft.triggers.splice(ti, 1); break;
        // The same resets as the main simulator's trigger dialog.
        case "dependency":
            trigger.dependencyHrid = target.value;
            trigger.conditionHrid = "";
            trigger.comparatorHrid = "";
            trigger.value = 0;
            break;
        case "condition":
            trigger.conditionHrid = target.value;
            trigger.comparatorHrid = "";
            trigger.value = 0;
            break;
        case "comparator": trigger.comparatorHrid = target.value; break;
        case "value": trigger.value = Number(target.value) || 0; break;
        default: return;
    }
    renderPlayers();
    renderPlan();
}

// ------------------------------------------------------------------ simulation

function buildCondition(id, overrides) {
    const players = ctx.players.map((player, p) => {
        const dto = structuredClone(player.dto);
        dto.abilities.forEach((ability, a) => {
            const triggers = overrides.get(`${p}:${a}`);
            if (triggers) ability.triggers = structuredClone(triggers);
        });
        return dto;
    });
    return { id, zoneHrid: ctx.zoneHrid, difficultyTier: ctx.difficultyTier, players };
}

// Runs a batch of conditions on the Optimization page's worker pool; resolves with
// Map(id -> { metrics } | { error }).
function runBatch(conditions, hours, poolSize) {
    return new Promise((resolve, reject) => {
        const results = new Map();
        worker = new Worker(new URL("optimizationWorker.js", import.meta.url));
        const batchWorker = worker;
        const finish = (fn, value) => {
            batchWorker.terminate();
            if (worker === batchWorker) worker = null;
            stopBatch = null;
            fn(value);
        };
        stopBatch = () => finish(reject, new Error("stopped"));
        batchWorker.onmessage = (event) => {
            const data = event.data;
            if (data.type === "optimization_condition_result") {
                results.set(data.conditionId, { metrics: metricsFor(data.simResult, ctx.itemHrid, PLAYER_HRIDS) });
            } else if (data.type === "optimization_condition_error") {
                results.set(data.conditionId, { error: data.error });
            } else if (data.type === "optimization_done") {
                finish(resolve, results);
            } else if (data.type === "optimization_cancelled") {
                finish(reject, new Error("stopped"));
            } else if (data.type === "optimization_error") {
                finish(reject, new Error(data.error));
            }
        };
        batchWorker.onerror = (event) => finish(reject, new Error(event.message || "worker error"));
        batchWorker.postMessage({
            type: "run_optimization",
            conditions,
            extra: ctx.extra ?? {},
            simulationTimeLimit: hours * ONE_HOUR,
            poolSize,
        });
    });
}

function setProgress(done, total) {
    el("progressBar").style.width = total ? `${Math.min(100, (done / total) * 100)}%` : "0";
    el("progressText").textContent = total ? t("trProgress", { done, total }) : "";
}

// A simulation queue shared by every concurrent search. Requests made while a batch is running
// (or in the same tick) are collected and sent as the next batch, so the pool is always as full as
// the searches allow, and only one pool exists at a time. Identical configurations are simulated
// once, and in flight requests for the same one share the result.
function createSimulator(hours, poolSize, onSimDone) {
    const inflight = new Map();
    let pending = [];
    let flushing = false;
    let timer = null;

    const flush = async () => {
        timer = null;
        if (flushing) return;
        flushing = true;
        try {
            while (pending.length > 0) {
                const batch = pending;
                pending = [];
                if (stopped) {
                    batch.forEach((x) => x.reject(new Error("stopped")));
                    continue;
                }
                try {
                    const results = await runBatch(batch.map((x, i) => buildCondition(`c${i}`, x.merged)), hours, poolSize);
                    batch.forEach((x, i) => {
                        const result = results.get(`c${i}`);
                        if (!result || result.error) {
                            x.reject(new Error(result?.error ?? "no result"));
                        } else {
                            onSimDone();
                            x.resolve(result.metrics);
                        }
                    });
                } catch (e) {
                    batch.forEach((x) => x.reject(e));
                    pending.forEach((x) => x.reject(e));
                    pending = [];
                }
            }
        } finally {
            flushing = false;
        }
    };

    return (merged) => {
        if (stopped) return Promise.reject(new Error("stopped"));
        const key = JSON.stringify([...merged.entries()].sort());
        if (!inflight.has(key)) {
            const promise = new Promise((resolve, reject) => pending.push({ merged, resolve, reject }));
            promise.catch(() => { /* the awaiting search reports it */ });
            inflight.set(key, promise);
            if (!timer && !flushing) timer = setTimeout(flush, 0);
        }
        return inflight.get(key);
    };
}

// ------------------------------------------------------------------ search

// Pass 2 onwards start from the triggers adopted so far, so a number is searched around its
// current value instead of over the whole coarse grid. The current value itself is a candidate
// (a cache hit, so it is not simulated again).
function localValues(kind, current) {
    if (kind === "count") return COUNT_VALUES.slice();
    if (kind === "percent") {
        return [current, ...PERCENT_STEPS.slice(0, 2).flatMap((d) => [current - d, current + d])]
            .filter((v) => v >= 0 && v <= 100);
    }
    return [current, ...NUMBER_FACTORS_REFINE.flatMap((f) => [Math.round(current / f), Math.round(current * f)])]
        .filter((v) => v >= 1 && v <= NUMBER_MAX);
}

// Searches one ability's trigger numbers, starting from `start` (the draft in pass 1, the adopted
// triggers after). `evaluate(configs)` takes a list of Map(abilityKey -> triggers) and resolves
// with a metrics list. Returns the best trial found.
async function searchAbility(item, evaluate, section, start, pass) {
    const key = `${item.p}:${item.a}`;
    const working = structuredClone(start);
    let bestMetrics = null;
    let bestTriggers = null;
    const consider = (metrics, triggers) => {
        if (!bestMetrics || metrics.encountersPerHour > bestMetrics.encountersPerHour + MIN_GAIN) {
            bestMetrics = metrics;
            bestTriggers = structuredClone(triggers);
        }
    };

    if (item.params.length === 0) {
        const [metrics] = await evaluate([new Map([[key, working]])]);
        section.rows.push({ triggers: structuredClone(working), metrics });
        consider(metrics, working);
        renderReport();
    }

    for (const param of item.params) {
        const tried = new Set();
        const run = async (values) => {
            const fresh = [...new Set(values)].filter((v) => !tried.has(v));
            if (fresh.length === 0 || stopped) return;
            fresh.forEach((v) => tried.add(v));
            const candidates = fresh.map((v) => {
                const triggers = structuredClone(working);
                triggers[param.ti].value = v;
                return triggers;
            });
            const metrics = await evaluate(candidates.map((triggers) => new Map([[key, triggers]])));
            candidates.forEach((triggers, i) => {
                section.rows.push({ triggers, metrics: metrics[i] });
                consider(metrics[i], triggers);
            });
            renderReport();
        };

        const current = working[param.ti].value;
        await run(pass === 1 ? coarseValues(param.kind, current) : localValues(param.kind, current));
        for (const next of refineRounds(param.kind)) {
            if (stopped) break;
            await run(next(bestTriggers ? bestTriggers[param.ti].value : working[param.ti].value));
        }
        // The next trigger of this ability starts from the best value found for this one.
        if (bestTriggers) working[param.ti].value = bestTriggers[param.ti].value;
    }
    return { bestMetrics, bestTriggers };
}

async function optimize() {
    if (running) return;
    const plan = runnable(buildPlan());
    if (plan.length === 0) return;

    const hours = Math.max(1, Number(el("simHours").value) || 10);
    const parallel = isParallel();
    running = true;
    stopped = false;
    el("runBtn").disabled = true;
    el("stopBtn").disabled = false;
    el("parallel").disabled = true;
    el("poolSize").disabled = true;
    el("confirmHours").disabled = true;
    el("errorBox").textContent = "";

    // + 2 for the confirmation runs.
    let maxTotal = 3 + (parallel && plan.length >= 2 ? 1 : 0) + plan.reduce((s, i) => s + i.maxSims, 0);
    let simsDone = 0;
    setProgress(0, maxTotal);

    // Triggers adopted so far, laid over every later simulation. In parallel mode the searches of
    // one pass are judged against the state at the start of that pass, not against each other.
    const adopted = new Map();
    const simulate = createSimulator(hours, poolSizeSetting(), () => { simsDone++; setProgress(simsDone, maxTotal); });
    const evaluate = (configs) => Promise.all(configs.map((config) => simulate(new Map([...adopted, ...config]))));
    report = { baseline: null, best: null, sections: [], adopted, combined: null, notes: [], confirm: null };

    try {
        const [baseline] = await evaluate([new Map()]);
        report.baseline = baseline;
        report.best = baseline;
        renderReport();

        for (let pass = 1; pass <= MAX_PASSES && !stopped; pass++) {
            // Later passes only re-search abilities that have a number; a trigger without one has
            // nothing left to tune.
            const items = pass === 1 ? plan : plan.filter((item) => item.params.length > 0);
            if (items.length === 0) break;
            if (pass > 1) {
                maxTotal += (parallel && items.length >= 2 ? 1 : 0) + items.reduce((s, i) => s + i.maxSims, 0);
            }
            const passStart = report.best;
            const startFor = (item) => adopted.get(`${item.p}:${item.a}`) ?? drafts[item.p][item.a].triggers;
            const sections = items.map((item) => {
                const section = { p: item.p, a: item.a, pass, rows: [], result: null };
                report.sections.push(section);
                return section;
            });
            const settle = (section, found) => {
                const incumbent = (parallel ? passStart : report.best).encountersPerHour;
                const gain = found.bestMetrics ? found.bestMetrics.encountersPerHour - incumbent : 0;
                section.result = gain > MIN_GAIN
                    ? { adopted: true, triggers: found.bestTriggers, metrics: found.bestMetrics }
                    : { adopted: false };
            };

            if (parallel) {
                const found = await Promise.all(items.map((item, i) =>
                    searchAbility(item, evaluate, sections[i], startFor(item), pass)));
                items.forEach((item, i) => settle(sections[i], found[i]));
                const winners = items.map((item, i) => ({ item, section: sections[i] }))
                    .filter((x) => x.section.result.adopted);
                if (winners.length === 1) {
                    adopted.set(`${winners[0].item.p}:${winners[0].item.a}`, winners[0].section.result.triggers);
                    report.best = winners[0].section.result.metrics;
                } else if (winners.length >= 2) {
                    const bestSingle = winners.reduce((a, b) =>
                        b.section.result.metrics.encountersPerHour > a.section.result.metrics.encountersPerHour ? b : a);
                    const config = new Map(winners.map((x) => [`${x.item.p}:${x.item.a}`, x.section.result.triggers]));
                    const [combined] = await evaluate([config]);
                    report.combined = combined;
                    if (combined.encountersPerHour > bestSingle.section.result.metrics.encountersPerHour + MIN_GAIN) {
                        config.forEach((triggers, key) => adopted.set(key, triggers));
                        report.best = combined;
                    } else {
                        adopted.set(`${bestSingle.item.p}:${bestSingle.item.a}`, bestSingle.section.result.triggers);
                        report.best = bestSingle.section.result.metrics;
                        report.notes.push({ key: "trCombinedWorse", vars: { pass, combined: fmt(combined.encountersPerHour) } });
                    }
                }
            } else {
                for (let i = 0; i < items.length; i++) {
                    if (stopped) break;
                    const found = await searchAbility(items[i], evaluate, sections[i], startFor(items[i]), pass);
                    settle(sections[i], found);
                    if (sections[i].result.adopted) {
                        adopted.set(`${items[i].p}:${items[i].a}`, found.bestTriggers);
                        report.best = found.bestMetrics;
                    }
                    renderReport();
                }
            }
            renderReport();

            // One ability's change can move another's best value, so go round again. Pass 1 always
            // gets a second pass when two or more abilities are being tuned and something changed;
            // after that, stop once a pass gains less than STOP_GAIN EPH.
            const gain = report.best.encountersPerHour - passStart.encountersPerHour;
            if (stopped) break;
            if (plan.length < 2 || adopted.size === 0) break;
            if (pass > 1 && gain < STOP_GAIN) {
                report.notes.push({ key: "trPassStop", vars: { pass, gain: fmt(gain, 2), limit: STOP_GAIN } });
                break;
            }
            if (pass === MAX_PASSES) report.notes.push({ key: "trPassMax", vars: { pass } });
        }

        // Confirm at a much longer length: the search runs are short, so a small gain can be luck.
        // The baseline and the final recommended triggers run side by side.
        if (adopted.size > 0 && !stopped) {
            const confirmHours = confirmHoursSetting();
            const confirmSimulate = createSimulator(confirmHours, poolSizeSetting(), () => { simsDone++; setProgress(simsDone, maxTotal); });
            const [confirmBase, confirmBest] = await Promise.all([
                confirmSimulate(new Map()),
                confirmSimulate(new Map(adopted)),
            ]);
            report.confirm = { hours: confirmHours, baseline: confirmBase, best: confirmBest };
            renderReport();
        }
        el("progressText").textContent = t("trDone", { done: simsDone });
    } catch (e) {
        if (e.message === "stopped") {
            el("progressText").textContent = t("trStopped");
        } else {
            el("progressText").textContent = "";
            el("errorBox").textContent = t("trRunFailed", { message: e.message });
        }
    } finally {
        running = false;
        el("stopBtn").disabled = true;
        el("parallel").disabled = false;
        el("poolSize").disabled = false;
        el("confirmHours").disabled = false;
        renderPlan();
    }
}

// Stops the run at once. The pool cannot be relied on to report back: on cancel it terminates its
// simulation workers, whose pending runs then never settle, so it never posts "cancelled". Terminate
// the pool here and end the batch ourselves; queued requests and every later one reject as "stopped".
function stop() {
    if (!running) return;
    stopped = true;
    el("stopBtn").disabled = true;
    el("progressText").textContent = t("trStopping");
    if (worker) {
        worker.postMessage({ type: "cancel_optimization" });
    }
    if (stopBatch) stopBatch();
}

// ------------------------------------------------------------------ results

function renderReport() {
    const box = el("resultsBox");
    if (!report || !report.baseline) {
        box.textContent = t("trResultsEmpty");
        return;
    }
    const base = report.baseline;
    const pctOver = (m, ref) => ref.encountersPerHour
        ? ((m.encountersPerHour - ref.encountersPerHour) / ref.encountersPerHour) * 100 : 0;
    const delta = (m, ref = base) => {
        const pct = pctOver(m, ref);
        const d = m.encountersPerHour - ref.encountersPerHour;
        return `<span class="${d > 0 ? "good" : d < 0 ? "bad" : "dim"}">${d >= 0 ? "+" : ""}${fmt(pct, 1)}%</span>`;
    };
    const metricCells = (m, ref = base) => `<td>${fmt(m.encountersPerHour)}</td><td>${delta(m, ref)}</td>` +
        `<td>${fmt(m.avgFragsPerHour, 2)}</td>` +
        `<td>${fmt(PLAYER_HRIDS.reduce((s, h) => s + m.players[h].deathsPerHour, 0), 2)}</td>`;
    const head = `<tr><th class="left">${esc(t("trThSetup"))}</th><th>${esc(t("trThEph"))}</th><th>${esc(t("trThVs"))}</th>` +
        `<th>${esc(t("trThFrags"))}</th><th>${esc(t("trThDeaths"))}</th></tr>`;

    let recommended = "";
    if (report.adopted.size > 0) {
        recommended += `<h3 style="margin:16px 0 6px;font-size:13px">${esc(t("trRecommended"))}</h3><ul>` +
            [...report.adopted].map(([key, triggers]) => {
                const [p, a] = key.split(":").map(Number);
                return `<li><b>${esc(playerName(p))} · ${esc(abilityName(ctx.players[p].dto.abilities[a].hrid))}</b>: ` +
                    `${esc(describeAll(triggers))}</li>`;
            }).join("") + `</ul>`;
    }

    let confirmHtml = "";
    if (report.confirm) {
        const c = report.confirm;
        const pct = pctOver(c.best, c.baseline);
        const ok = c.best.encountersPerHour > c.baseline.encountersPerHour;
        confirmHtml = `<h3 style="margin:16px 0 6px;font-size:13px">${esc(t("trConfirmTitle", { hours: c.hours }))}</h3>` +
            `<table><thead>${head}</thead><tbody>` +
            `<tr class="base"><td class="left">${esc(t("trBaseline"))}</td>${metricCells(c.baseline, c.baseline)}</tr>` +
            `<tr class="best"><td class="left"><b>${esc(t("trConfirmRecommended"))}</b></td>${metricCells(c.best, c.baseline)}</tr></tbody></table>` +
            `<div class="${ok ? "good" : "bad"}" style="margin-top:6px">` +
            `${esc(t(ok ? "trConfirmOk" : "trConfirmFail", { hours: c.hours, pct: fmt(pct, 1) }))}</div>`;
    }

    let html = recommended + confirmHtml + `<table><thead>${head}</thead><tbody>
        <tr class="base"><td class="left">${esc(t("trBaseline"))}</td>${metricCells(base)}</tr>` +
        (report.combined ? `<tr><td class="left">${esc(t("trCombined"))}</td>${metricCells(report.combined)}</tr>` : "") +
        `<tr class="best"><td class="left"><b>${esc(t("trBest"))}</b></td>${metricCells(report.best)}</tr></tbody></table>`;

    for (const note of report.notes) {
        html += `<div class="hint">${esc(t(note.key, note.vars))}</div>`;
    }

    for (const section of report.sections) {
        if (section.rows.length === 0) continue;
        const ability = ctx.players[section.p].dto.abilities[section.a];
        const top = Math.max(...section.rows.map((r) => r.metrics.encountersPerHour));
        html += `<h3 style="margin:16px 0 6px;font-size:13px">${esc(playerName(section.p))} · ${esc(abilityName(ability.hrid))} <span class="dim">· ${esc(t("trPass", { n: section.pass }))}</span></h3>` +
            `<table><thead>${head}</thead><tbody>` +
            section.rows.map((row) => `<tr class="${row.metrics.encountersPerHour === top ? "best" : ""}">` +
                `<td class="left">${esc(describeAll(row.triggers))}</td>${metricCells(row.metrics)}</tr>`).join("") + `</tbody></table>`;
        if (section.result) {
            html += section.result.adopted
                ? `<div class="hint">${esc(t("trAdopted"))}<b>${esc(describeAll(section.result.triggers))}</b></div>`
                : `<div class="hint">${esc(t("trNoBetter"))}</div>`;
        }
    }

    box.innerHTML = html;
}

// ------------------------------------------------------------------ init

// Static markup carries its key in data-i18n-opt (text) or data-i18n-opt-title (tooltip).
function applyStaticText() {
    document.documentElement.lang = language() === "zh" ? "zh" : "en";
    document.title = t("trTitle");
    for (const node of document.querySelectorAll("[data-i18n-opt]")) {
        node.textContent = t(node.getAttribute("data-i18n-opt"));
    }
    for (const node of document.querySelectorAll("[data-i18n-opt-title]")) {
        node.title = t(node.getAttribute("data-i18n-opt-title"));
    }
    el("abilitiesHint").innerHTML = t("trAbilitiesHint");
    el("poolMax").textContent = t("trPoolMax", { max: maxPoolSize() });
    for (const button of document.querySelectorAll("#langToggle button")) {
        button.classList.toggle("active", button.dataset.lang === language());
    }
}

function renderAll() {
    applyStaticText();
    if (!ctx) return;
    el("contextLine").textContent = `${gameName("actionNames", ctx.zoneHrid, ctx.zoneName || ctx.zoneHrid)} · T${ctx.difficultyTier}`;
    renderPlayers();
    renderPlan();
    renderReport();
}

function init() {
    initLanguage();
    try {
        const raw = localStorage.getItem(CONTEXT_KEY);
        ctx = raw ? JSON.parse(raw) : null;
    } catch (e) {
        ctx = null;
    }

    el("langToggle").addEventListener("click", (event) => {
        const next = event.target.dataset.lang;
        if (next && next !== language()) {
            setLanguage(next);
            renderAll();
        }
    });
    // Game names arrive with the shared bundle, which initialises after this script runs.
    onSharedI18nReady(renderAll);

    if (!ctx || !Array.isArray(ctx.players) || ctx.players.length === 0) {
        ctx = null;
        applyStaticText();
        el("errorBox").textContent = t("trNoContext");
        return;
    }

    drafts = ctx.players.map((player) => player.dto.abilities.map((ability) => ({
        triggers: structuredClone(ability.triggers ?? []),
        sim: false,
    })));
    el("simHours").value = ctx.hours || 10;
    // Default, and the ceiling, is the most this browser can run at once.
    el("poolSize").max = maxPoolSize();
    el("poolSize").value = maxPoolSize();
    el("poolSize").addEventListener("change", () => { el("poolSize").value = poolSizeSetting(); });

    el("players").addEventListener("change", onEdit);
    el("players").addEventListener("click", onEdit);
    el("simHours").addEventListener("change", renderPlan);
    el("confirmHours").addEventListener("change", renderPlan);
    el("parallel").addEventListener("change", renderPlan);
    el("runBtn").addEventListener("click", optimize);
    el("stopBtn").addEventListener("click", stop);

    renderAll();
}

init();
