// Trial Assignment page (trial-assign.html): upload the guild's combat-trial export, pick two of the
// five trial bosses and a team size, and the page finds the split that maximises the trial score.
//
//   1. Measure  every member alone in the last slot of one fixed reference raid, on the Build Guide's
//               bar for their build, against each chosen boss at one tier: damage and healing per second.
//   2. Calibrate the reference raid's ladder on each boss (tier times), plus a weaker-support copy of
//               it (survival vs healing).
//   3. Plan     with arithmetic on those numbers (trialAssignCore.js): roles, debuff coverage, auras,
//               the trade-off curve between the two bosses, then pairwise swaps.
//   4. Verify   the best few splits (and the export's own assignment, if it has one) on the full
//               ladder, and keep the best by simulated score.
//
// Every fight runs on the wasm kernel in worker.js ("start_skill_lab", see skillLabJob.js), which
// reduces each result to one player's numbers before it crosses back to the page.

import Player from "./combatsimulator/player.js";
import Zone from "./combatsimulator/zone.js";
import abilityDetailMap from "./combatsimulator/data/abilityDetailMap.json";
import itemDetailMap from "./combatsimulator/data/itemDetailMap.json";
import combatMonsterDetailMap from "./combatsimulator/data/combatMonsterDetailMap.json";
import monsterGroupsData from "./combatsimulator/data/monsterGroups.json";
import GROUP_BATTLE_REGEN_BUFFS from "./combatsimulator/data/groupBattleBuffs";
import { GUILD_BUILDINGS, guildBuildingBuffs } from "./combatsimulator/data/guildBuildings";
import Shrine from "./combatsimulator/shrine.js";
import { importSetToPlayerDTO } from "./combatsimulator/importSet.js";
import { parseGuildTrialRoster, guildTrialEntryToImportSet } from "./guildTrialImport.js";
import { raidClass } from "./combatClass.js";
import {
    BOSSES, BUILDS, CLASS_TO_BUILD, ROLE_BUILDS, PHYSICAL, MAGIC, SPECIAL_AURAS, AURA_SKILL,
    applyGuideBar, heldAura, auraPower, teamPower, teamHps, carriersFor, tierTimes, fitSurvival,
    plan, evaluate, scoreAt,
} from "./trialAssignCore.js";

const SETTINGS_KEY = "mwiTrialAssignV1";
const LS_GUILD_BUILDINGS_KEY = "mwiGuildBuildingLevels";
// Arsenal's guild, used when this browser has never set building levels.
const DEFAULT_BUILDINGS = { diningRoom: 0, library: 2, dojo: 4, armory: 1, gym: 1, archeryRange: 2, mysticalStudy: 1 };
// One fight per worker, as many at once as this browser reports cores (Settings → Max parallel can
// lower it on a small machine: each worker holds its own kernel and briefly a fight's full log).
const MAX_WORKERS = Math.max(1, navigator.hardwareConcurrency || 4);
const poolSize = () => Math.max(1, Math.min(MAX_WORKERS, Number(settings.workers) || MAX_WORKERS));
const SCORE_LEVEL = 180; // T9: deep enough that bosses hit hard, early enough that a raid survives it
const SCORE_CAP = 600;
const EFFORT = {
    quick: { label: "Quick", scoreSeeds: 2, calRuns: 8, verifyRuns: 10 },
    standard: { label: "Standard", scoreSeeds: 4, calRuns: 20, verifyRuns: 40 },
    thorough: { label: "Thorough", scoreSeeds: 6, calRuns: 40, verifyRuns: 100 },
};
const BUILDING_LABELS = { diningRoom: "Dining Room", library: "Library", dojo: "Dojo", armory: "Armory", gym: "Gym", archeryRange: "Archery Range", mysticalStudy: "Mystical Study" };
const BUILD_COLORS = {
    Wark: "#4bb3c4", "Cursed Bower": "#c77dff", "Mana Spring Support": "#a9cff7", "Nature Support": "#d4f0b0",
    Slash: "#e05a5a", Stab: "#e8d24c", Smash: "#e8963c", Ranged: "#5fbf6f", Fire: "#ff6b3d", Water: "#4c9be8", "Nature DPS": "#a3d44a",
};

const BOSS_GROUP = Object.fromEntries(BOSSES.map((b) => {
    const g = (monsterGroupsData.groups || []).find((x) => x.trialHrid === "/guild_combat/" + b.toLowerCase());
    return [b, g ? g.members.filter((m) => combatMonsterDetailMap[m.hrid]) : []];
}));

// ------------------------------------------------------------------ state

const defaultSettings = () => ({
    bosses: ["Badger", "Chameleon"],
    teamSize: 56,
    roles: { Wark: 2, "Nature Support": 6, "Mana Spring Support": 2 },
    floors: { Smash: 2, Slash: 2, Stab: 2, Water: 2, Ranged: 2, "Cursed Bower": 2 },
    budget: 3600,
    insanityHp: 50,
    tanksBringAuras: false,
    effort: "standard",
    workers: MAX_WORKERS,
});
let settings = loadSettings();
let buildings = loadBuildings();
let party = null;      // { sourceName, members: [...] }
let running = false;
let pool = [];
let lastResult = null;
let site = null;       // the guild site's assignment: { bosses, teams: {boss: [name]}, builds: {name: build}, carriers: {name: {aura, level}}, source }

function loadSettings() {
    try { return { ...defaultSettings(), ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) }; } catch (e) { return defaultSettings(); }
}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* session only */ } }
function loadBuildings() {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(LS_GUILD_BUILDINGS_KEY)); } catch (e) { stored = null; }
    const out = {};
    for (const b of GUILD_BUILDINGS) out[b.id] = Math.max(0, Number(stored ? stored[b.id] : DEFAULT_BUILDINGS[b.id]) || 0);
    return out;
}
function saveBuildings() { try { localStorage.setItem(LS_GUILD_BUILDINGS_KEY, JSON.stringify(buildings)); } catch (e) { /* session only */ } }

// ------------------------------------------------------------------ helpers

const el = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n, d = 0) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const tierText = (p) => `T${Math.floor(p + 1e-9) + 1} ${(100 * (p - Math.floor(p + 1e-9))).toFixed(0)}%`;
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

function showError(msg) {
    const box = el("errorBox");
    box.textContent = msg || "";
    box.style.display = msg ? "block" : "none";
}

// ------------------------------------------------------------------ members

// Effective skill levels and max HP with the same buff stack the worker gives a group-battle player.
function derive(dto) {
    try {
        const player = Player.createFromDTO(structuredClone(dto));
        player.zoneBuffs = new Zone("/actions/combat/fly").buffs;
        player.extraBuffs = GROUP_BATTLE_REGEN_BUFFS.concat(guildBuildingBuffs(buildings)).concat(Shrine.buffsFromLevels(dto.shrines));
        player.reset(0);
        player.generatePermanentBuffs();
        player.reset(0);
        const cd = player.combatDetails;
        return { maxHp: cd.maxHitpoints, levels: { attack: cd.attackLevel, melee: cd.meleeLevel, defense: cd.defenseLevel, ranged: cd.rangedLevel, magic: cd.magicLevel } };
    } catch (e) {
        return { maxHp: 0, levels: { attack: 1, melee: 1, defense: 1, ranged: 1, magic: 1 } };
    }
}

function dtoFrom(importSet, hrid) {
    const dto = importSetToPlayerDTO(importSet, hrid);
    while (dto.abilities.length < 5) dto.abilities.push(null);
    dto.debuffOnLevelGap = 0;
    return dto;
}

function memberFrom(m, index) {
    const importSet = guildTrialEntryToImportSet(m.entry);
    const dto = dtoFrom(importSet, "check"); // fail here, not mid-run
    const weapon = dto.equipment["/equipment_types/main_hand"] || dto.equipment["/equipment_types/two_hand"];
    const current = (importSet.abilities || []).map((a) => a?.abilityHrid || null);
    const cls = raidClass(weapon ? weapon.hrid : "", current.filter(Boolean));
    const lists = [m.entry.profile?.equippedAbilities, m.entry.combatLoadout?.equippedAbilities];
    const own = {};
    for (const list of lists) for (const e of list || []) if (e?.abilityHrid) own[e.abilityHrid] = Math.max(own[e.abilityHrid] || 0, Number(e.level) || 1);
    return {
        id: index, name: m.name, importSet, current, own,
        cls, build: CLASS_TO_BUILD[cls.key] || "",
        include: !!CLASS_TO_BUILD[cls.key],
        weapon: weapon ? (itemDetailMap[weapon.hrid]?.name || weapon.hrid) + (weapon.enhancementLevel ? " +" + weapon.enhancementLevel : "") : "",
        held: heldAura(lists),
        combatTrial: m.combatTrial || "",
        noLoadout: !m.hasLoadout,
    };
}

// The skill a build's damage scales with, for ordering members before anything is measured.
function mainStat(m) {
    const L = m.derived.levels;
    if (m.build === "Wark") return L.defense;
    if (PHYSICAL.has(m.build) && m.build !== "Ranged" && m.build !== "Cursed Bower") return L.melee;
    if (m.build === "Ranged" || m.build === "Cursed Bower") return L.ranged;
    return L.magic;
}

// One member's DTO for one boss: the guide's bar for their build, carrying `aura` in slot 1 if given.
// The level of `aura` in this member's hands: the site's, if it named one, else what they hold.
const auraLevelOf = (m, aura) => (!aura ? 0 : m.siteAura?.aura === aura ? m.siteAura.level : m.held?.aura === aura ? m.held.level : 0);

function memberDTO(m, boss, hrid, aura = null) {
    const g = applyGuideBar({
        boss, build: m.build, own: m.own, current: m.current, triggerMap: m.importSet.triggerMap || {},
        aura, auraLevel: auraLevelOf(m, aura),
        maxHp: m.derived.maxHp, insanityHp: settings.insanityHp / 100,
    });
    return dtoFrom({ ...m.importSet, abilities: g.abilities, triggerMap: g.triggerMap }, hrid);
}

// The member's export entry with the guide's bar written in, for the downloadable rosters. Both the
// loadout and the profile get it, since the importer reads the loadout field by field and falls
// back to the profile (docs/harness.md §5).
function memberEntry(m, boss, aura) {
    const g = applyGuideBar({
        boss, build: m.build, own: m.own, current: m.current, triggerMap: m.importSet.triggerMap || {},
        aura, auraLevel: auraLevelOf(m, aura),
        maxHp: m.derived.maxHp, insanityHp: settings.insanityHp / 100,
    });
    const entry = structuredClone(m.entry);
    entry.combatTrial = "/guild_combat/" + boss.toLowerCase();
    const equipped = g.abilities.map((a, i) => ({ abilityHrid: a.abilityHrid, level: Number(a.level), slotNumber: i + 1, experience: 0 }));
    entry.combatLoadout = entry.combatLoadout || {};
    for (const box of [entry.combatLoadout, entry.profile]) {
        if (!box) continue;
        box.equippedAbilities = equipped;
        box.abilityCombatTriggersMap = g.triggerMap;
    }
    entry.combatLoadout.hasLoadout = true;
    return entry;
}

// ------------------------------------------------------------------ worker pool

function getPool() {
    const n = poolSize();
    while (pool.length > n) pool.pop().terminate();
    while (pool.length < n) pool.push(new Worker(new URL("worker.js", import.meta.url)));
    return pool;
}
function killPool() { for (const w of pool) w.terminate(); pool = []; }

function runJobs(jobs, onProgress) {
    return new Promise((resolve, reject) => {
        if (!jobs.length) { resolve([]); return; }
        const results = new Array(jobs.length);
        let next = 0, done = 0;
        const workers = getPool().slice(0, Math.min(poolSize(), jobs.length));
        const feed = (w) => { if (next < jobs.length) { const id = next++; w.postMessage({ type: "start_skill_lab", id, job: jobs[id] }); } };
        for (const w of workers) {
            w.onmessage = (e) => {
                if (e.data.type === "skill_lab_result") {
                    results[e.data.id] = e.data.run;
                    done++;
                    onProgress?.(done, jobs.length);
                    if (done === jobs.length) resolve(results); else feed(w);
                } else if (e.data.type === "simulation_error") reject(new Error(e.data.error));
            };
            w.onerror = (e) => reject(new Error(e.message || "worker failed to start"));
            feed(w);
        }
    });
}

const enemiesFor = (boss) => BOSS_GROUP[boss].flatMap((mem) => Array.from({ length: mem.count }, () => mem.hrid))
    .map((hrid, i) => ({ trial: true, hrid, level: 100, name: combatMonsterDetailMap[hrid].name, uniqueHrid: hrid + "#" + (i + 1) }));
const withHrids = (dtos) => dtos.map((d, i) => ({ ...d, hrid: "player" + (i + 1) }));

// ------------------------------------------------------------------ the run

let stopRequested = false;
let runStart = null;

function step(text, cls = "") {
    const li = document.createElement("li");
    li.textContent = text;
    if (cls) li.className = cls;
    el("steps").append(li);
    return li;
}
let clock = null;
const mmss = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
function startClock(t0) {
    clearInterval(clock);
    el("runTimeNote").textContent = "elapsed";
    const tick = () => (el("runTime").textContent = mmss(performance.now() - t0));
    tick();
    clock = setInterval(tick, 500);
}
function stopClock(t0, note) {
    clearInterval(clock);
    clock = null;
    if (t0 != null) el("runTime").textContent = mmss(performance.now() - t0);
    el("runTimeNote").textContent = note;
}
function setBest(score, note) {
    el("runBest").textContent = score == null ? "–" : fmt(score);
    el("runBestNote").textContent = note;
}

function setProgress(frac, label) {
    el("progressBar").style.width = (100 * frac).toFixed(1) + "%";
    el("progressLabel").textContent = label;
}

async function run() {
    if (running) { stopRequested = true; killPool(); finish("Stopped."); return; }
    showError("");
    if (!party) { showError("Upload the guild's combat-trial export first."); return; }
    const [A, B] = settings.bosses;
    if (!A || !B || A === B) { showError("Pick two different trial bosses."); return; }
    const members = party.members.filter((m) => m.include && m.build);
    const cap = Math.max(10, Math.min(60, Number(settings.teamSize) || 56));
    if (members.length < cap + 10) { showError(`Only ${members.length} members are included; two teams need more than ${cap + 10}.`); return; }
    const effort = EFFORT[settings.effort] || EFFORT.standard;

    running = true; stopRequested = false;
    el("runBtn").textContent = "Stop";
    el("steps").replaceChildren();
    el("result").style.display = "none";
    const t0 = performance.now();
    runStart = t0;
    startClock(t0);
    setBest(null, "after planning");

    try {
        for (const m of members) { m.derived = derive(dtoFrom(m.importSet, "x")); m.mainStat = mainStat(m); }
        const holdersOf = (aura) => members.filter((m) => m.held?.aura === aura && (settings.tanksBringAuras || m.build !== "Wark"));
        const powerOf = (m) => (m.held ? auraPower(abilityDetailMap, m.held.aura, m.held.level, m.derived.levels[AURA_SKILL[m.held.aura]]) : 0);
        for (const m of members) m.auraPower = powerOf(m);

        // The reference raid every member is measured in: the best carrier of each aura, the role and
        // Cursed Bower quotas by main stat, the rest of the DPS by main stat. Same for both bosses.
        const refIds = new Set(), refCarriers = new Map();
        for (const aura of Object.keys(SPECIAL_AURAS)) {
            const best = holdersOf(aura).filter((m) => !refIds.has(m.id)).sort((x, y) => y.auraPower - x.auraPower)[0];
            if (best) { refIds.add(best.id); refCarriers.set(best.id, aura); }
        }
        const byStat = [...members].sort((x, y) => y.mainStat - x.mainStat);
        const quota = { ...settings.roles, "Cursed Bower": settings.floors["Cursed Bower"] || 2 };
        for (const [build, q] of Object.entries(quota))
            for (const m of byStat) if (m.build === build && [...refIds].filter((id) => members.find((x) => x.id === id).build === build).length < q) refIds.add(m.id);
        for (const m of byStat) if (refIds.size < cap - 1 && !ROLE_BUILDS.includes(m.build) && m.build !== "Cursed Bower") refIds.add(m.id);
        const ref = members.filter((m) => refIds.has(m.id));
        const extra = byStat.find((m) => !refIds.has(m.id) && !ROLE_BUILDS.includes(m.build));

        // 1. Measure.
        const seeds = Array.from({ length: effort.scoreSeeds }, (_, i) => 1000 + i * 7919);
        const scores = {};
        const s1 = step(`Measuring ${members.length} players on ${A} and ${B} (T${(SCORE_LEVEL - 100) / 10 + 1}, ${seeds.length} seeds each)…`);
        for (const [bi, boss] of [A, B].entries()) {
            const refDtos = ref.map((m) => memberDTO(m, boss, "r", refCarriers.get(m.id) || null));
            const jobs = [];
            for (const m of members) for (const seed of seeds)
                jobs.push({ players: withHrids([...refDtos, memberDTO(m, boss, "p")]), enemies: enemiesFor(boss), guildBuildingLevels: buildings, focusHrid: "player" + (refDtos.length + 1), mode: "single", level: SCORE_LEVEL, timeCapSeconds: SCORE_CAP, seed });
            const res = await runJobs(jobs, (d, n) => setProgress((bi + d / n) / 2 * 0.45, `Measuring on ${boss}: ${d} / ${n} fights`));
            if (stopRequested) return;
            scores[boss] = {};
            members.forEach((m, i) => {
                const rs = res.slice(i * seeds.length, (i + 1) * seeds.length);
                scores[boss][m.id] = { dps: mean(rs.map((r) => r.dmg / Math.max(1, r.seconds))), hps: mean(rs.map((r) => r.heal / Math.max(1, r.seconds))) };
            });
        }
        s1.textContent += " done.";
        const planPlayers = members.map((m) => ({
            id: m.id, name: m.name, build: m.build, mainStat: m.mainStat,
            dps: { [A]: scores[A][m.id].dps, [B]: scores[B][m.id].dps },
            hps: (scores[A][m.id].hps + scores[B][m.id].hps) / 2,
            aura: m.held && (settings.tanksBringAuras || m.build !== "Wark") ? m.held.aura : null, auraPower: m.auraPower,
        }));
        const P = new Map(planPlayers.map((p) => [p.id, p]));
        const refAuras = Object.fromEntries(Object.keys(SPECIAL_AURAS).map((a) => [a, 0]));
        for (const [id, aura] of refCarriers) refAuras[aura] = Math.max(refAuras[aura], members.find((m) => m.id === id).auraPower);

        // 2. Calibrate: the reference raid (plus the strongest member left out of it) on the ladder,
        // and the same raid with the weakest supports in place of its own.
        const calTeam = [...ref, ...(extra ? [extra] : [])];
        const supports = ["Nature Support", "Mana Spring Support"];
        const weakTeam = (() => {
            const out = calTeam.map((m) => m), outIds = new Set(out.map((m) => m.id));
            for (const build of supports) {
                const weak = members.filter((m) => m.build === build && !outIds.has(m.id)).sort((x, y) => P.get(x.id).hps - P.get(y.id).hps);
                let k = 0;
                out.forEach((m, i) => { if (m.build === build && !refCarriers.has(m.id) && weak[k]) { out[i] = weak[k++]; } });
            }
            return out;
        })();
        const s2 = step(`Calibrating the ladder on both bosses (${effort.calRuns} runs, normal and weaker supports)…`);
        const cal = {};
        for (const [bi, boss] of [A, B].entries()) {
            const ladder = (team) => Array.from({ length: effort.calRuns }, (_, i) => ({
                players: withHrids(team.map((m) => memberDTO(m, boss, "c", refCarriers.get(m.id) || null))), enemies: enemiesFor(boss),
                guildBuildingLevels: buildings, focusHrid: "player1", mode: "trial", timeCapSeconds: settings.budget, seed: 77 + i * 104729,
            }));
            const jobs = [...ladder(calTeam), ...ladder(weakTeam)];
            const res = await runJobs(jobs, (d, n) => setProgress(0.45 + (bi + d / n) / 2 * 0.2, `Calibrating ${boss}: ${d} / ${n} ladders`));
            if (stopRequested) return;
            const main = res.slice(0, effort.calRuns), weak = res.slice(effort.calRuns);
            const teamP = calTeam.map((m) => P.get(m.id)), weakP = weakTeam.map((m) => P.get(m.id));
            const carriers = new Map([...refCarriers].filter(([id]) => calTeam.some((m) => m.id === id)));
            const times = tierTimes(main);
            if (times.length < 2) throw new Error(`The reference raid clears fewer than two tiers of ${boss}; the ladder can't be calibrated.`);
            const H0 = teamHps(teamP);
            cal[boss] = {
                times, budget: settings.budget,
                power: teamPower(teamP, carriers, boss, refAuras),
                survival: fitSurvival([{ H: H0, runs: main }, { H: teamHps(weakP), runs: weak }], H0),
                refScore: mean(main.map((r) => scoreAt(r.progress))), refProgress: mean(main.map((r) => r.progress)),
            };
        }
        s2.textContent += " done.";

        // 3. Plan.
        const opts = { bosses: [A, B], cal, refAuras: { [A]: refAuras, [B]: refAuras }, teamSize: cap, roles: settings.roles, floors: settings.floors, tanksBringAuras: settings.tanksBringAuras, takenDps: {} };
        const planned = plan(planPlayers, opts);
        const cands = planned.candidates.slice(0, 3).map((c, i) => ({ ...c, label: i === 0 ? "Best predicted" : "Alternative " + i }));
        // The current assignment: the guild site's when it's loaded for these two bosses, else the
        // export's own (its members' combatTrial), when the export was made for them.
        const baseline = baselineFor(members, A, B, cap);
        if (baseline) cands.push({ ...evaluate(planPlayers, baseline.teams, opts, baseline.carriers), teams: baseline.teams, label: baseline.label, isCurrent: true });
        setBest(cands[0].total, "predicted, before verifying");
        step(`Planned: ${planned.candidates.length} distinct split${planned.candidates.length === 1 ? "" : "s"} from the trade-off curve.` + (planned.notes.length ? " " + planned.notes.join(" ") : ""));

        // 4. Verify on the full ladder.
        const s4 = step(`Verifying ${cands.length} split${cands.length === 1 ? "" : "s"} on the full ladder (${effort.verifyRuns} runs per boss)…`);
        // One candidate at a time (its two bosses' ladders in parallel), so the best simulated total
        // so far can be shown as each finishes.
        let bestSoFar = null;
        for (const [ci, c] of cands.entries()) {
            const jobs = [], index = [];
            for (const boss of [A, B]) {
                const team = c.teams[boss].map((id) => members.find((m) => m.id === id));
                const dtos = withHrids(team.map((m) => memberDTO(m, boss, "v", c.carriers[boss].get(m.id) || null)));
                for (let i = 0; i < effort.verifyRuns; i++) {
                    jobs.push({ players: dtos, enemies: enemiesFor(boss), guildBuildingLevels: buildings, focusHrid: "player1", mode: "trial", timeCapSeconds: settings.budget, seed: 4242 + i * 15485863 });
                    index.push(boss);
                }
            }
            const res = await runJobs(jobs, (d, n) => setProgress(0.65 + 0.35 * (ci + d / n) / cands.length, `Verifying ${c.label}: ${d} / ${n} ladders`));
            if (stopRequested) return;
            c.sim = { [A]: [], [B]: [] };
            res.forEach((r, i) => c.sim[index[i]].push(r));
            c.simProgress = {}; c.simScore = {}; c.simClear = {};
            for (const boss of [A, B]) {
                const rs = c.sim[boss];
                c.simProgress[boss] = mean(rs.map((r) => r.progress));
                c.simScore[boss] = mean(rs.map((r) => scoreAt(r.progress)));
                c.simClear[boss] = rs.map((r) => r.cleared);
            }
            c.simTotal = c.simScore[A] + c.simScore[B];
            if (!c.isCurrent && (!bestSoFar || c.simTotal > bestSoFar.simTotal)) bestSoFar = c;
            const cur = cands.find((x) => x.isCurrent && x.simTotal != null);
            if (bestSoFar) setBest(bestSoFar.simTotal, `simulated, ${bestSoFar.label.toLowerCase()}` + (cur ? ` · ${bestSoFar.simTotal >= cur.simTotal ? "+" : ""}${fmt(bestSoFar.simTotal - cur.simTotal)} vs current` : ""));
        }
        s4.textContent += " done.";
        setProgress(1, `Done in ${mmss(performance.now() - t0)}`);
        stopClock(t0, "to find the best assignment");

        const best = cands.filter((c) => !c.isCurrent).sort((x, y) => y.simTotal - x.simTotal)[0];
        lastResult = { A, B, cap, members, planPlayers, cands, best, bench: planned.bench, floors: planned.floors, cal, effort };
        renderResult();
        finish("");
    } catch (e) {
        if (!stopRequested) { showError(e.message || String(e)); finish("Failed."); }
    }
}

// The current assignment as { teams: {boss: [ids]}, carriers: {boss: Map} | {}, label }, or null.
function baselineFor(members, A, B, cap) {
    if (site && site.bosses.includes(A) && site.bosses.includes(B)) {
        const byName = new Map(members.map((m) => [m.name, m]));
        const teams = {}, carriers = {};
        for (const boss of [A, B]) {
            const ms = site.teams[boss].map((n) => byName.get(n)).filter(Boolean);
            teams[boss] = ms.map((m) => m.id);
            // The page text names every carrier; the API doesn't, and then the in-team rule decides.
            if (site.hasCarriers) carriers[boss] = new Map(ms.filter((m) => site.carriers[m.name]).map((m) => [m.id, site.carriers[m.name].aura]));
        }
        return { teams, carriers, label: "Site assignment" };
    }
    const trialOf = (m) => m.combatTrial.replace(/^.*\//, "");
    const onA = members.filter((m) => trialOf(m) === A.toLowerCase()), onB = members.filter((m) => trialOf(m) === B.toLowerCase());
    if (onA.length >= cap * 0.8 && onB.length >= cap * 0.8)
        return { teams: { [A]: onA.slice(0, cap).map((m) => m.id), [B]: onB.slice(0, cap).map((m) => m.id) }, carriers: {}, label: "Export's assignment" };
    return null;
}

// Simulates only the site's two teams on the full ladder: a quick look at the current assignment
// before (or instead of) a full search.
async function previewSite() {
    if (running) return;
    showError("");
    if (!party) { showError("Upload the guild's combat-trial export first."); return; }
    if (!site) { showError("Load the site's assignment first."); return; }
    const [A, B] = site.bosses;
    const members = party.members.filter((m) => m.build);
    for (const m of members) { m.derived = derive(dtoFrom(m.importSet, "x")); m.mainStat = mainStat(m); }
    const byName = new Map(members.map((m) => [m.name, m]));
    const effort = EFFORT[settings.effort] || EFFORT.standard;
    running = true; stopRequested = false;
    el("previewBtn").disabled = true;
    try {
        const jobs = [], index = [];
        const teams = {}, carriers = {};
        for (const boss of [A, B]) {
            const ms = site.teams[boss].map((n) => byName.get(n)).filter(Boolean);
            teams[boss] = ms;
            const fake = ms.map((m) => ({ id: m.id, build: m.build, dps: { [boss]: m.mainStat }, aura: m.held?.aura || null, auraPower: m.held ? auraPower(abilityDetailMap, m.held.aura, m.held.level, m.derived.levels[AURA_SKILL[m.held.aura]]) : 0 }));
            carriers[boss] = site.hasCarriers
                ? new Map(ms.filter((m) => site.carriers[m.name]).map((m) => [m.id, site.carriers[m.name].aura]))
                : carriersFor(fake, boss, { tanksBringAuras: settings.tanksBringAuras });
            const dtos = withHrids(ms.map((m) => memberDTO(m, boss, "v", carriers[boss].get(m.id) || null)));
            for (let i = 0; i < effort.verifyRuns; i++) {
                jobs.push({ players: dtos, enemies: enemiesFor(boss), guildBuildingLevels: buildings, focusHrid: "player1", mode: "trial", timeCapSeconds: settings.budget, seed: 4242 + i * 15485863 });
                index.push(boss);
            }
        }
        const res = await runJobs(jobs, (d, n) => (el("previewOut").textContent = `Simulating the site's teams: ${d} / ${n} ladders…`));
        const by = { [A]: [], [B]: [] };
        res.forEach((r, i) => by[index[i]].push(r));
        const line = (boss) => {
            const rs = by[boss], p = mean(rs.map((r) => r.progress)), sc = mean(rs.map((r) => scoreAt(r.progress)));
            const t = Math.floor(p + 1e-9), clr = rs.filter((r) => r.cleared >= t).length;
            return { boss, p, sc, clr, n: rs.length, t, size: teams[boss].length };
        };
        const a = line(A), b = line(B);
        const tile = (x) => `<div class="stat"><span>${esc(x.boss)}</span><b>${esc(tierText(x.p))}</b>
            <small><b class="pts">${fmt(x.sc)} pts</b> · ${x.clr}/${x.n} clear T${x.t} · ${x.size} players</small></div>`;
        el("previewOut").innerHTML = `<div class="stat-row">
            <div class="stat total"><span>Total score</span><b>${fmt(a.sc + b.sc)}</b><small>current assignment · ${effort.verifyRuns} ladders per boss</small></div>${tile(a)}${tile(b)}</div>
            <div class="dim small">Run <b>Find best assignment</b> to compare it with the best split.</div>`;
        site.preview = { [A]: a, [B]: b, total: a.sc + b.sc };
    } catch (e) {
        showError(e.message || String(e));
    } finally {
        running = false;
        el("previewBtn").disabled = false;
    }
}

// ------------------------------------------------------------------ the site's assignment

// The Combat Trials section's text, as the page renders it: a boss heading, then one row per player,
// "<name> <build> · bring <aura>" or "<name> <build> 🔮 brings <aura> <level>".
function parseSiteText(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const builds = [...BUILDS].sort((x, y) => y.length - x.length).map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const row = new RegExp(`^(\\S+)\\s+(${builds})\\s+(?:·\\s*bring\\s+(\\w+)|🔮\\s*brings\\s+(\\w+)\\s+(\\d+))`);
    const out = { teams: {}, builds: {}, carriers: {}, hasCarriers: true };
    let boss = null;
    for (const l of lines) {
        const head = BOSSES.find((b) => l === b || l.startsWith(b + " ") && /\d+\s*\/\s*\d+/.test(l));
        if (head) { boss = head; out.teams[boss] = []; continue; }
        if (/^🪑|^Bench/i.test(l)) { boss = null; continue; }
        const m = boss && row.exec(l);
        if (!m) continue;
        out.teams[boss].push(m[1]);
        out.builds[m[1]] = m[2];
        if (m[4]) out.carriers[m[1]] = { aura: m[4], level: Number(m[5]) };
    }
    out.bosses = Object.keys(out.teams).filter((b) => out.teams[b].length);
    return out;
}

// /api/g/<guild>/config: frozen.combat (name -> boss) and frozen.roster (builds). No carriers.
function parseSiteJson(cfg) {
    const f = cfg.frozen || cfg;
    if (!f.combat) throw new Error("no frozen.combat in that JSON");
    const out = { teams: {}, builds: {}, carriers: {}, hasCarriers: false };
    for (const [name, boss] of Object.entries(f.combat)) if (BOSSES.includes(boss)) (out.teams[boss] ??= []).push(name);
    for (const r of Object.values(f.roster || {})) if (r?.name && BUILDS.includes(r.build)) out.builds[r.name] = r.build;
    out.bosses = [f.a, f.b].filter((b) => out.teams[b]?.length);
    if (out.bosses.length < 2) out.bosses = Object.keys(out.teams).slice(0, 2);
    return out;
}

function applySite(parsed, source) {
    if (parsed.bosses.length < 2) { showError("Couldn't find two boss teams in that. Paste the whole Combat Trials section, from the first boss heading to the bench."); return; }
    site = { ...parsed, source };
    settings.bosses = site.bosses.slice(0, 2);
    saveSettings();
    renderSettings();
    syncSiteToParty();
}

// Builds and carriers from the site override the inferred ones, so a member plays what the officers
// assigned. Members the site doesn't place are left as they are.
function syncSiteToParty() {
    const out = el("siteStatus");
    if (!site) { out.textContent = ""; return; }
    const names = new Set(Object.values(site.teams).flat());
    let unmatched = [];
    if (party) {
        const byName = new Map(party.members.map((m) => [m.name, m]));
        for (const n of names) {
            const m = byName.get(n);
            if (!m) { unmatched.push(n); continue; }
            if (el("useSiteBuilds").checked && site.builds[n]) { m.build = site.builds[n]; m.include = true; }
            m.siteAura = site.carriers[n] || null;
        }
        renderParty();
    }
    out.innerHTML = `<b>${esc(site.source)}</b>: ${site.bosses.map((b) => `${esc(b)} ${site.teams[b].length}`).join(" · ")}`
        + (site.hasCarriers ? ` · ${Object.keys(site.carriers).length} special-aura carriers` : " · no carriers in the API, so each team's best holder carries")
        + (unmatched.length ? `<div class="warn-box">Not in the uploaded export: ${unmatched.map(esc).join(", ")}</div>` : "");
}

async function loadSiteFromApi() {
    const guild = el("siteGuild").value.trim() || "Arsenal";
    // The local dev server's proxy first (webpack.config.js, same origin, so no CORS), then the site
    // itself, which only works if the site ever allows other origins.
    const path = `/g/${encodeURIComponent(guild)}/config`;
    try {
        let cfg = null, last = null;
        for (const url of ["site-api" + path, "https://arsenal-trials-mwi.fly.dev/api" + path]) {
            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error("HTTP " + res.status);
                cfg = await res.json();
                break;
            } catch (e) { last = e; }
        }
        if (!cfg) throw last;
        applySite(parseSiteJson(cfg), `${guild} (site API)`);
        showError("");
    } catch (e) {
        el("sitePasteBox").open = true;
        const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
        showError((local
            ? `Couldn't reach the site through the local proxy (${e.message || e}). Restart the dev server, or paste instead.`
            : `This copy of the page can't load from the site: the site doesn't allow other websites to read it, and only the local dev server (npx webpack serve) can fetch it on the page's behalf.`)
            + ` To paste: open https://arsenal-trials-mwi.fly.dev/g/${guild}, select the Combat Trials section from the first boss heading down to the bench, copy it, and paste it below. The page text also says who carries which aura.`);
    }
}

function finish(msg) {
    running = false;
    if (clock) stopClock(runStart, msg ? msg.toLowerCase().replace(/\.$/, "") : "elapsed");
    el("runBtn").textContent = "Find best assignment";
    if (msg) setProgress(0, msg);
}

// ------------------------------------------------------------------ rendering

function chip(build) {
    return `<span class="class-chip" style="background:${BUILD_COLORS[build] || "#9aa0aa"}">${esc(build || "—")}</span>`;
}

function renderParty() {
    const box = el("partyRoster");
    if (!party) { box.innerHTML = ""; el("partyStatus").textContent = ""; return; }
    const inc = party.members.filter((m) => m.include && m.build);
    const counts = {};
    for (const m of inc) counts[m.build] = (counts[m.build] || 0) + 1;
    const noBuild = party.members.filter((m) => !CLASS_TO_BUILD[m.cls.key]).length;
    el("partyStatus").innerHTML = `<b>${esc(party.sourceName)}</b>: ${party.members.length} members, <b>${inc.length}</b> included. `
        + BUILDS.filter((b) => counts[b]).map((b) => `${esc(b)} ${counts[b]}`).join(" · ")
        + (noBuild ? `<div class="warn-box">${noBuild} member(s) have no guide build (no weapon, or a magic weapon with no element) and start excluded.</div>` : "");
    const rows = party.members.map((m) => `
        <tr class="${m.include ? "" : "excluded"}">
            <td><input type="checkbox" data-inc="${m.id}" ${m.include ? "checked" : ""} aria-label="Include ${esc(m.name)}"></td>
            <td>${esc(m.name)}${m.noLoadout ? ' <span class="dim" title="No saved trial loadout: their live gear is used">⚠</span>' : ""}</td>
            <td><select data-build="${m.id}">${["", ...BUILDS].map((b) => `<option value="${esc(b)}" ${b === m.build ? "selected" : ""}>${esc(b || "—")}</option>`).join("")}</select></td>
            <td class="dim">${esc(m.weapon)}</td>
            <td class="dim">${m.held ? esc(m.held.aura + " " + m.held.level) : ""}</td>
            <td class="dim">${esc(m.combatTrial.replace(/^.*\//, ""))}</td>
        </tr>`).join("");
    box.innerHTML = `<details class="roster"><summary>Members, builds and auras (edit a build or exclude someone here)</summary>
        <table><thead><tr><th></th><th>Player</th><th>Build</th><th>Weapon</th><th>Aura held</th><th>Exported for</th></tr></thead><tbody>${rows}</tbody></table></details>`;
    box.querySelectorAll("[data-inc]").forEach((cb) => cb.addEventListener("change", () => { party.members[+cb.dataset.inc].include = cb.checked; renderParty(); }));
    box.querySelectorAll("[data-build]").forEach((s) => s.addEventListener("change", () => { const m = party.members[+s.dataset.build]; m.build = s.value; m.include = !!s.value; renderParty(); }));
    box.querySelector("details").open = !!party.rosterOpen;
    box.querySelector("details").addEventListener("toggle", (e) => (party.rosterOpen = e.target.open));
}

function renderSettings() {
    for (const i of [0, 1]) {
        const s = el("boss" + i);
        s.innerHTML = BOSSES.filter((b) => BOSS_GROUP[b].length).map((b) => `<option ${settings.bosses[i] === b ? "selected" : ""}>${b}</option>`).join("");
        s.onchange = () => { settings.bosses[i] = s.value; saveSettings(); };
    }
    const num = (id, get, set) => { const x = el(id); x.value = get(); x.onchange = () => { set(Number(x.value)); saveSettings(); }; };
    num("teamSize", () => settings.teamSize, (v) => (settings.teamSize = v));
    num("budget", () => settings.budget, (v) => (settings.budget = v));
    num("workers", () => Math.min(settings.workers || MAX_WORKERS, MAX_WORKERS), (v) => (settings.workers = Math.max(1, Math.min(MAX_WORKERS, v || MAX_WORKERS))));
    el("workers").max = MAX_WORKERS;
    el("workersMax").textContent = `(max ${MAX_WORKERS})`;
    num("insanityHp", () => settings.insanityHp, (v) => (settings.insanityHp = v));
    num("roleWark", () => settings.roles.Wark, (v) => (settings.roles.Wark = v));
    num("roleNs", () => settings.roles["Nature Support"], (v) => (settings.roles["Nature Support"] = v));
    num("roleMs", () => settings.roles["Mana Spring Support"], (v) => (settings.roles["Mana Spring Support"] = v));
    const eff = el("effort");
    eff.innerHTML = Object.entries(EFFORT).map(([k, e]) => `<option value="${k}" ${settings.effort === k ? "selected" : ""}>${e.label} (${e.scoreSeeds} seeds, ${e.verifyRuns} verify runs)</option>`).join("");
    eff.onchange = () => { settings.effort = eff.value; saveSettings(); };
    const tba = el("tanksBringAuras"); tba.checked = settings.tanksBringAuras; tba.onchange = () => { settings.tanksBringAuras = tba.checked; saveSettings(); };
    el("floors").innerHTML = Object.entries(settings.floors).map(([b, f]) => `<label><span>${esc(b)}</span><input type="number" min="0" max="10" data-floor="${esc(b)}" value="${f}"></label>`).join("");
    el("floors").querySelectorAll("[data-floor]").forEach((x) => x.addEventListener("change", () => { settings.floors[x.dataset.floor] = Math.max(0, Number(x.value) || 0); saveSettings(); }));
    el("buildings").innerHTML = GUILD_BUILDINGS.map((b) => `<label><span>${BUILDING_LABELS[b.id] || b.id}</span><input type="number" min="0" max="20" data-bld="${b.id}" value="${buildings[b.id]}"></label>`).join("");
    el("buildings").querySelectorAll("[data-bld]").forEach((x) => x.addEventListener("change", () => { buildings[x.dataset.bld] = Math.max(0, Number(x.value) || 0); saveBuildings(); }));
}

function renderResult() {
    const R = lastResult;
    if (!R) return;
    const { A, B, best, cands } = R;
    const byId = new Map(R.members.map((m) => [m.id, m]));
    const P = new Map(R.planPlayers.map((p) => [p.id, p]));
    const current = cands.find((c) => c.isCurrent);
    const clears = (c, boss) => { const n = c.simClear[boss].length, t = Math.floor(c.simProgress[boss] + 1e-9); return `${c.simClear[boss].filter((x) => x >= t).length}/${n} clear T${t}`; };

    // Same tiles as the site preview: the total first and accented, then each boss.
    const bossTile = (boss) => `<div class="stat"><span>${esc(boss)}</span><b>${esc(tierText(best.simProgress[boss]))}</b>
        <small><b class="pts">${fmt(best.simScore[boss])} pts</b> · ${clears(best, boss)} · ${best.teams[boss].length} players</small></div>`;
    const delta = current ? best.simTotal - current.simTotal : null;
    el("summary").innerHTML = `<div class="stat total"><span>Total score</span><b>${fmt(best.simTotal)}</b>
        <small>${delta == null ? `best split · ${R.effort.verifyRuns} ladders per boss` : `<b class="pts">${delta >= 0 ? "+" : ""}${fmt(delta)}</b> vs the ${esc(current.label.toLowerCase())} (${fmt(current.simTotal)})`}</small></div>${bossTile(A)}${bossTile(B)}`;

    const candRows = cands.map((c) => `<tr class="${c === best ? "best" : ""}">
        <td>${esc(c.label)}${c === best ? ' <span class="tag best">picked</span>' : ""}</td>
        <td>${c.pred[A].toFixed(2)} / ${c.pred[B].toFixed(2)}</td>
        <td>${c.simProgress[A].toFixed(2)} / ${c.simProgress[B].toFixed(2)}</td>
        <td>${fmt(c.simScore[A])} + ${fmt(c.simScore[B])}</td>
        <td><b>${fmt(c.simTotal)}</b></td></tr>`).join("");
    el("candidates").innerHTML = `<table class="data"><thead><tr><th>Split</th><th>Predicted ${esc(A)} / ${esc(B)}</th><th>Simulated</th><th>Score</th><th>Total</th></tr></thead><tbody>${candRows}</tbody></table>`;

    const curOf = new Map();
    if (current) for (const boss of [A, B]) for (const id of current.teams[boss]) curOf.set(id, boss);
    const teamHtml = (boss) => {
        const ids = best.teams[boss];
        const ms = ids.map((id) => byId.get(id));
        const counts = {};
        for (const m of ms) counts[m.build] = (counts[m.build] || 0) + 1;
        const rows = ms.sort((x, y) => P.get(y.id).dps[boss] - P.get(x.id).dps[boss]).map((m) => {
            const aura = best.carriers[boss].get(m.id);
            const moved = current && curOf.get(m.id) && curOf.get(m.id) !== boss;
            return `<tr><td>${chip(m.build)}</td><td>${esc(m.name)}${moved ? ' <span class="tag moved" title="On the other boss in the current assignment">moved</span>' : ""}</td>
                <td>${aura ? `<span class="tag aura">${esc(aura)} ${m.held?.level ?? ""}</span>` : ""}</td>
                <td class="num">${fmt(P.get(m.id).dps[boss], 1)}</td><td class="num">${P.get(m.id).hps >= 1 ? fmt(P.get(m.id).hps) : ""}</td></tr>`;
        }).join("");
        return `<div class="team"><h3>${esc(boss)} <span class="dim">· ${ids.length} players</span></h3>
            <div class="dim small">${BUILDS.filter((b) => counts[b]).map((b) => `${esc(b)} ${counts[b]}`).join(" · ")}</div>
            <table class="data"><thead><tr><th>Build</th><th>Player</th><th>Aura</th><th class="num">dmg/s</th><th class="num">heal/s</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    };
    el("teams").innerHTML = teamHtml(A) + teamHtml(B);
    el("benchNote").textContent = R.bench.length ? "Bench: " + R.bench.map((id) => byId.get(id).name).join(", ") : "";
    el("result").style.display = "block";
}

// ------------------------------------------------------------------ downloads

function download(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function downloadRoster(boss) {
    const R = lastResult;
    const byId = new Map(R.members.map((m) => [m.id, m]));
    const entries = R.best.teams[boss].map((id) => memberEntry(byId.get(id), boss, R.best.carriers[boss].get(id) || null));
    const d = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    download(`${boss.toLowerCase()}_${d}_assigned.json`, JSON.stringify(entries));
}
function summaryText() {
    const R = lastResult, { A, B, best } = R;
    const byId = new Map(R.members.map((m) => [m.id, m]));
    const lines = [`Trial assignment: ${A} + ${B} (simulated ${tierText(best.simProgress[A])} / ${tierText(best.simProgress[B])}, score ${fmt(best.simTotal)})`];
    for (const boss of [A, B]) {
        lines.push("", `${boss} (${best.teams[boss].length})`);
        const by = {};
        for (const id of best.teams[boss]) { const m = byId.get(id); const aura = best.carriers[boss].get(id); (by[m.build] ??= []).push(m.name + (aura ? ` [${aura}]` : "")); }
        for (const b of BUILDS) if (by[b]) lines.push(`${b}: ${by[b].join(", ")}`);
    }
    return lines.join("\n");
}

// ------------------------------------------------------------------ import

function importParty(text, sourceName) {
    let roster;
    try { roster = parseGuildTrialRoster(text); } catch (e) { showError("Could not read the file as a guild trial export: " + e.message); return; }
    if (!roster.members.length) { showError("No members found in that file."); return; }
    const errors = [], members = [];
    roster.members.forEach((m) => {
        try { members.push(memberFrom(m, members.length)); m.entryRef = m.entry; members.at(-1).entry = m.entry; } catch (e) { errors.push(m.name + ": " + e.message); }
    });
    if (!members.length) { showError("No member could be imported:\n" + errors.join("\n")); return; }
    party = { sourceName, members };
    lastResult = null;
    el("result").style.display = "none";
    renderParty();
    syncSiteToParty();
    showError(errors.length ? `Imported with ${errors.length} error(s):\n` + errors.join("\n") : "");
}

function initImport() {
    const input = el("partyFile"), drop = el("partyDrop");
    const read = (file) => { if (!file) return; const r = new FileReader(); r.onload = () => importParty(String(r.result), file.name); r.readAsText(file); };
    drop.addEventListener("click", () => input.click());
    drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    input.addEventListener("change", () => { read(input.files[0]); input.value = ""; });
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dragging"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("dragging"); read(e.dataTransfer.files[0]); });
}

document.addEventListener("DOMContentLoaded", () => {
    initImport();
    renderSettings();
    el("runBtn").addEventListener("click", run);
    el("siteLoad").addEventListener("click", loadSiteFromApi);
    el("sitePasteApply").addEventListener("click", () => {
        const text = el("sitePaste").value.trim();
        if (!text) return;
        try {
            const parsed = text.startsWith("{") ? parseSiteJson(JSON.parse(text)) : parseSiteText(text);
            applySite(parsed, text.startsWith("{") ? "pasted site JSON" : "pasted page text");
            showError("");
        } catch (e) { showError("Couldn't read that: " + (e.message || e)); }
    });
    el("useSiteBuilds").addEventListener("change", syncSiteToParty);
    el("previewBtn").addEventListener("click", previewSite);
    el("dlA").addEventListener("click", () => lastResult && downloadRoster(lastResult.A));
    el("dlB").addEventListener("click", () => lastResult && downloadRoster(lastResult.B));
    el("copyText").addEventListener("click", async () => {
        if (!lastResult) return;
        const text = summaryText();
        try { await navigator.clipboard.writeText(text); el("copyText").textContent = "✓ Copied"; } catch (e) { el("copyOut").value = text; el("copyOut").style.display = "block"; }
        setTimeout(() => (el("copyText").textContent = "📋 Copy teams as text"), 1500);
    });
    // The download buttons are relabelled with the bosses once there's a result.
    new MutationObserver(() => { if (lastResult) { el("dlA").textContent = `Download ${lastResult.A} roster`; el("dlB").textContent = `Download ${lastResult.B} roster`; } })
        .observe(el("result"), { attributes: true, attributeFilter: ["style"] });
});

