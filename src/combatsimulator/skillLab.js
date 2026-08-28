// Skill Lab core — a DPS test bench for ability kits.
//
// Runs one fixed trial-group encounter and reports damage per *squad* (a group of
// identical players), so two squads on the same preset with different ability kits
// can be compared directly. A squad marked `support: true` fights normally — its
// attacks land, so its debuffs (armor shred, evasion cuts, Mana Spring's mana feed)
// benefit the raid — but the caller treats its damage as out-of-scope for the
// comparison. This is deliberately not a survival simulation: the point is to
// isolate damage output, so the caller can switch off player damage intake and,
// optionally, mana limits.
//
// Everything here mirrors the group-battle path (worker.js "start_battle"): real
// Player objects, zone buffs from /actions/combat/fly, GROUP_BATTLE_REGEN_BUFFS,
// and monsters rebuilt from the game data at a room level with party-size scaling.
// Kept free of DOM access so it runs in a worker, in node, or in a test.
import Player from "./player.js";
import Ability from "./ability.js";
import Zone from "./zone.js";
import CombatSimulator from "./combatSimulator.js";
import GroupBattleMonster from "./groupBattleMonster.js";
import groupBattleScaling from "./data/groupBattleScaling.js";
import GROUP_BATTLE_REGEN_BUFFS from "./data/groupBattleBuffs.js";
import itemDetailMap from "./data/itemDetailMap.json";
import abilityDetailMap from "./data/abilityDetailMap.json";
import monsterGroupsData from "./data/monsterGroups.json";

// ------------------------------------------------------------------- presets --

// Same auto-discovery as the group-battle page: every JSON under testPlayers is a
// solo export usable as a build. Adding a file adds a build with no code change.
const PRESET_CTX = require.context("./data/testPlayers", false, /\.json$/);

function prettyName(file) {
    return file
        .replace(/^\.\//, "").replace(/\.json$/, "")
        .split(/[_-]+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
}

// { id: { id, name, export } }, id = filename without extension.
export const PRESETS = PRESET_CTX.keys().reduce((acc, file) => {
    const id = file.replace(/^\.\//, "").replace(/\.json$/, "");
    acc[id] = { id, name: prettyName(file), export: PRESET_CTX(file) };
    return acc;
}, {});

export const PRESET_LIST = Object.values(PRESETS).sort((a, b) => a.name.localeCompare(b.name));

// ------------------------------------------------------- saved (custom) builds

// Besides the bundled presets, a build can come from an equipment set the user
// saved in the standard simulator (localStorage "equipmentSets"). Those are read
// at runtime, so they cannot be bundled: the page registers them here, and the
// worker registers the same list from the run config before the fight is built.
// Ids are prefixed so a saved set named "Wark" never shadows the wark preset.
export const CUSTOM_BUILD_PREFIX = "set:";

let CUSTOM_BUILDS = {};

export function setCustomBuilds(builds) {
    CUSTOM_BUILDS = {};
    for (const b of builds || []) {
        if (b && b.id && b.export && b.export.player) CUSTOM_BUILDS[b.id] = b;
    }
}

// [{ id, name, export }] in display order.
export function customBuildList() {
    return Object.values(CUSTOM_BUILDS).sort((a, b) => a.name.localeCompare(b.name));
}

// Resolve a build id: bundled preset first, then a saved equipment set.
export function getBuild(id) {
    return PRESETS[id] || CUSTOM_BUILDS[id] || null;
}

// Convert one equipment set (the shape main.js persists under "equipmentSets")
// into the solo-export shape everything else here consumes. The two differ:
// levels/equipment/abilities are keyed objects rather than arrays, the weapon
// lives in a single "weapon" slot (main_hand vs two_hand comes from the item's
// own type), and there is an extra "charm" slot.
export function equipmentSetToSoloExport(set) {
    const levels = set.levels || {};
    const lvl = (skill) => Number(levels[skill]) || 1;

    const equipment = [];
    const simpleSlots = [
        "head", "body", "legs", "feet", "hands",
        "off_hand", "pouch", "neck", "earrings", "ring", "back", "charm",
    ];
    for (const slot of simpleSlots) {
        const entry = (set.equipment || {})[slot];
        const itemHrid = entry && entry.equipment;
        if (!itemHrid || !itemDetailMap[itemHrid]) continue;
        equipment.push({
            itemLocationHrid: "/item_locations/" + slot,
            itemHrid,
            enhancementLevel: Number(entry.enhancementLevel) || 0,
        });
    }
    const weaponEntry = (set.equipment || {}).weapon;
    const weaponHrid = weaponEntry && weaponEntry.equipment;
    if (weaponHrid && itemDetailMap[weaponHrid]) {
        const type = itemDetailMap[weaponHrid].equipmentDetail
            && itemDetailMap[weaponHrid].equipmentDetail.type;
        const slot = type === "/equipment_types/two_hand" ? "two_hand" : "main_hand";
        equipment.push({
            itemLocationHrid: "/item_locations/" + slot,
            itemHrid: weaponHrid,
            enhancementLevel: Number(weaponEntry.enhancementLevel) || 0,
        });
    }

    // Kept index-aligned (nulls for empty slots) so slot 2 stays slot 2.
    const abilities = [0, 1, 2, 3, 4].map((i) => {
        const entry = (set.abilities || {})[i];
        const abilityHrid = entry && entry.ability;
        return abilityHrid && abilityDetailMap[abilityHrid]
            ? { abilityHrid, level: Number(entry.level) || 1 }
            : null;
    });

    return {
        player: {
            staminaLevel: lvl("stamina"),
            intelligenceLevel: lvl("intelligence"),
            attackLevel: lvl("attack"),
            meleeLevel: lvl("melee"),
            defenseLevel: lvl("defense"),
            rangedLevel: lvl("ranged"),
            magicLevel: lvl("magic"),
            equipment,
        },
        abilities,
        triggerMap: set.triggerMap || {},
        houseRooms: set.houseRooms || {},
        achievements: set.achievements || {},
    };
}

// A build's own ability list as a length-5 kit ({hrid, level}|null), so the UI
// can prefill a squad's slots with what the build actually runs.
export function presetKit(presetId) {
    const preset = getBuild(presetId);
    if (!preset) return [null, null, null, null, null];
    const kit = [0, 1, 2, 3, 4].map((i) => {
        const a = (preset.export.abilities || [])[i];
        return a && a.abilityHrid ? { hrid: a.abilityHrid, level: Number(a.level) || 1 } : null;
    });
    return kit;
}

// The DTO a squad's players are built from: the build's gear and levels with the
// squad's kit applied. The preview modal renders this, so what it shows is what
// the simulation runs.
export function squadDTO(presetId, kit, hrid = "preview") {
    const build = getBuild(presetId);
    if (!build) return null;
    // Mirrors runSkillLab: an array (even an all-empty one) is the squad's kit;
    // null/undefined means "run the build's own abilities".
    return soloExportToDTO(build.export, hrid, Array.isArray(kit) ? kit : undefined);
}

// ------------------------------------------------------------------ monsters --

export const MONSTER_GROUPS = monsterGroupsData.groups.map((g) => g.name);

export function monsterGroupMembers(name) {
    const g = monsterGroupsData.groups.find((x) => x.name === name);
    return g ? g.members : [];
}

// Party-scaled HP for the enemy preview. Goes through the real GroupBattleMonster
// so the page can never drift from what the simulation fights.
export function enemyPreview(groupName, level, partySize) {
    const enemies = buildEnemies(groupName, partySize, level).map((m) => {
        m.updateCombatDetails();
        return {
            name: m.name || m.dataHrid.split("/").pop(),
            maxHitpoints: m.combatDetails.maxHitpoints,
            armor: Math.round(m.combatDetails.totalArmor),
            evasion: {
                melee: Math.round(m.combatDetails.smashEvasionRating),
                ranged: Math.round(m.combatDetails.rangedEvasionRating),
                magic: Math.round(m.combatDetails.magicEvasionRating),
            },
        };
    });
    return { enemies, totalHp: enemies.reduce((s, e) => s + e.maxHitpoints, 0) };
}

// The combat style a build actually attacks with, from its equipped weapon. Used
// to warn when a kit slot's ability resolves on a different style's rating (a
// slash ability on a flail uses slash accuracy/damage, which the gear never buffs).
export function buildStyle(presetId) {
    const preset = getBuild(presetId);
    if (!preset) return "";
    const eq = preset.export.player.equipment || [];
    const weapon = eq.find((i) => i.itemLocationHrid === "/item_locations/main_hand")
        || eq.find((i) => i.itemLocationHrid === "/item_locations/two_hand");
    const stats = weapon && itemDetailMap[weapon.itemHrid]
        && itemDetailMap[weapon.itemHrid].equipmentDetail
        && itemDetailMap[weapon.itemHrid].equipmentDetail.combatStats;
    const styles = stats && stats.combatStyleHrids;
    return styles && styles.length ? styles[0] : "";
}

// ------------------------------------------------------------------ abilities --

// Ability metadata for kit pickers: style, cost and cooldown drive kit design, so
// the UI shows them next to each slot.
export const ABILITY_LIST = Object.values(abilityDetailMap)
    .map((a) => {
        const styles = [...new Set((a.abilityEffects || []).map((e) => e.combatStyleHrid).filter(Boolean))];
        const targets = [...new Set((a.abilityEffects || []).map((e) => e.targetType))];
        return {
            hrid: a.hrid,
            name: a.name,
            style: styles.map((s) => s.split("/").pop()).join("/") || "buff",
            targets: targets.join("/"),
            manaCost: a.manaCost,
            cooldown: a.cooldownDuration / 1e9,
            castDuration: a.castDuration / 1e9,
            isSpecial: !!a.isSpecialAbility,
            isAoe: targets.includes("allEnemies"),
        };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

const AURA_ABILITY_HRIDS = new Set([
    "/abilities/critical_aura", "/abilities/fierce_aura", "/abilities/guardian_aura",
    "/abilities/mystic_aura", "/abilities/speed_aura",
    "/abilities/insanity", "/abilities/invincible", "/abilities/revive",
]);

// Same five auras, same priority order and skill match as the group-battle page.
const AURA_ASSIGNMENTS = [
    { hrid: "/abilities/fierce_aura", skill: "meleeLevel" },
    { hrid: "/abilities/mystic_aura", skill: "magicLevel" },
    { hrid: "/abilities/critical_aura", skill: "rangedLevel" },
    { hrid: "/abilities/guardian_aura", skill: "defenseLevel" },
    { hrid: "/abilities/speed_aura", skill: "attackLevel" },
];

// ------------------------------------------------------------- DTO conversion --

function buildAbilityDTO(hrid, level, triggers) {
    const ability = new Ability(hrid, level, triggers);
    return { hrid: ability.hrid, level: ability.level, triggers: ability.triggers };
}

// One solo export + an optional kit override -> a Player.createFromDTO DTO.
// `kit` is a length-5 array of { hrid, level } | null. When omitted the preset's
// own ability list is used. Triggers come from the preset's triggerMap when it has
// an entry for that ability, otherwise from the ability's own defaults.
function soloExportToDTO(exp, hrid, kit) {
    const equipmentTypes = [
        "head", "body", "legs", "feet", "hands", "main_hand", "two_hand",
        "off_hand", "pouch", "neck", "earrings", "ring", "back",
    ];

    const equipment = {};
    for (const type of equipmentTypes) {
        const match = (exp.player.equipment || []).find(
            (item) => item.itemLocationHrid === "/item_locations/" + type
        );
        equipment["/equipment_types/" + type] =
            match && match.itemHrid && itemDetailMap[match.itemHrid]
                ? { hrid: match.itemHrid, enhancementLevel: Number(match.enhancementLevel) || 0 }
                : null;
    }

    const triggerMap = exp.triggerMap || {};
    const entries = kit
        ? kit.map((slot) => (slot && slot.hrid ? { hrid: slot.hrid, level: Number(slot.level) || 1 } : null))
        : (exp.abilities || []).map((a) =>
            a && a.abilityHrid ? { hrid: a.abilityHrid, level: Number(a.level) || 1 } : null);

    const abilities = [0, 1, 2, 3, 4].map((i) => {
        const e = entries[i];
        if (!e || !abilityDetailMap[e.hrid]) return null;
        return buildAbilityDTO(e.hrid, e.level, triggerMap[e.hrid]);
    });

    const p = exp.player;
    return {
        hrid,
        staminaLevel: Number(p.staminaLevel) || 1,
        intelligenceLevel: Number(p.intelligenceLevel) || 1,
        attackLevel: Number(p.attackLevel) || 1,
        meleeLevel: Number(p.meleeLevel) || 1,
        defenseLevel: Number(p.defenseLevel) || 1,
        rangedLevel: Number(p.rangedLevel) || 1,
        magicLevel: Number(p.magicLevel) || 1,
        equipment,
        food: [null, null, null],
        drinks: [null, null, null],
        abilities,
        houseRooms: exp.houseRooms || {},
        achievements: exp.achievements || {},
        debuffOnLevelGap: 0,
    };
}

function setPlayerAura(dto, auraHrid, level) {
    let auraDto;
    try {
        auraDto = buildAbilityDTO(auraHrid, level, undefined);
    } catch (e) {
        return;
    }
    let idx = dto.abilities.findIndex((a) => a && AURA_ABILITY_HRIDS.has(a.hrid));
    if (idx < 0) idx = dto.abilities.findIndex((a) => !a);
    if (idx < 0) idx = 0;
    dto.abilities[idx] = auraDto;
}

// Auras land on support-squad members when there are any — their damage is
// excluded from the analysis, so spending their slots costs the comparison
// nothing. With no support squads they fall back to the highest-skill damage
// dealers, which does cost those players an ability slot (exactly like the
// group-battle page's auto-assign).
function assignAuras(roster, level) {
    const pool = roster.some((r) => r.support)
        ? roster.map((r, i) => ({ r, i })).filter((x) => x.r.support)
        : roster.map((r, i) => ({ r, i }));
    const used = new Set();
    for (const aura of AURA_ASSIGNMENTS) {
        let best = null, bestSkill = -Infinity;
        for (const x of pool) {
            if (used.has(x.i)) continue;
            const s = Number(x.r.dto[aura.skill]) || 0;
            if (s > bestSkill) { bestSkill = s; best = x; }
        }
        if (!best) break;
        setPlayerAura(best.r.dto, aura.hrid, level);
        used.add(best.i);
    }
}

// -------------------------------------------------------------------- engine --

// Deterministic RNG so a config always produces the same numbers, and so two
// kits can be compared on identical rolls.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function buildEnemies(groupName, partySize, level) {
    const scaling = groupBattleScaling(partySize);
    const hrids = [];
    for (const m of monsterGroupMembers(groupName)) {
        for (let c = 0; c < (m.count || 1); c++) hrids.push(m.hrid);
    }
    return hrids.map((hrid, i) => new GroupBattleMonster(hrid, level, {
        ...scaling,
        uniqueHrid: hrid + "#" + (i + 1),
        displayName: hrid.split("/").pop(),
    }));
}

// Damage out of simResult.attacks for one player, split by ability and by target.
function collect(attacks, hrid) {
    let dmg = 0, hits = 0, misses = 0;
    const perAbility = {}, perTarget = {};
    for (const [target, abilities] of Object.entries(attacks[hrid] || {})) {
        for (const [ability, hitMap] of Object.entries(abilities)) {
            const a = (perAbility[ability] = perAbility[ability] || { dmg: 0, hits: 0, misses: 0 });
            for (const [hit, count] of Object.entries(hitMap)) {
                if (hit === "miss") { misses += count; a.misses += count; continue; }
                const d = Number(hit) * count;
                dmg += d; hits += count;
                a.dmg += d; a.hits += count;
                perTarget[target] = (perTarget[target] || 0) + d;
            }
        }
    }
    return { dmg, hits, misses, perAbility, perTarget };
}

function mergeInto(acc, part) {
    acc.dmg += part.dmg;
    acc.hits += part.hits;
    acc.misses += part.misses;
    for (const [k, v] of Object.entries(part.perAbility)) {
        const e = (acc.perAbility[k] = acc.perAbility[k] || { dmg: 0, hits: 0, misses: 0 });
        e.dmg += v.dmg; e.hits += v.hits; e.misses += v.misses;
    }
    for (const [k, v] of Object.entries(part.perTarget)) {
        acc.perTarget[k] = (acc.perTarget[k] || 0) + v;
    }
}

/**
 * Run one encounter.
 *
 * config = {
 *   groupName, level,
 *   squads:  [{ id, label, presetId, count, kit, support }], // kit = 5 × {hrid,level}|null
 *   supports:[{ presetId, count }],   // legacy shorthand: support squads on the preset's own kit
 *   options: { infiniteMana, noPlayerDamage, auras, auraLevel, timeCapSeconds },
 *   seed
 * }
 *
 * `support: true` squads fight normally (debuffs land, mana feeds flow) but are
 * flagged in the result so the caller can exclude their damage from the analysis.
 */
export async function runSkillLab(config) {
    const opts = config.options || {};
    const level = Number(config.level) || 100;
    const seed = Number(config.seed) || 1;

    const squads = (config.squads || []).slice();
    // Legacy shorthand: bare {presetId, count} supports become support squads
    // running the preset's own ability kit.
    for (const [i, sup] of (config.supports || []).entries()) {
        if (!getBuild(sup.presetId)) continue;
        squads.push({
            id: "support-" + i, label: getBuild(sup.presetId).name,
            presetId: sup.presetId, count: sup.count, kit: null, support: true,
        });
    }

    const roster = [];
    let n = 0;
    for (const squad of squads) {
        const preset = getBuild(squad.presetId);
        if (!preset) throw new Error("Unknown build: " + squad.presetId);
        const count = Math.max(0, Math.floor(Number(squad.count) || 0));
        for (let i = 0; i < count; i++) {
            roster.push({
                squadId: squad.id,
                support: !!squad.support,
                dto: soloExportToDTO(preset.export, "player" + ++n, squad.kit),
            });
        }
    }
    if (!roster.length) throw new Error("The roster is empty — give at least one squad a count above zero.");

    if (opts.auras) assignAuras(roster, Number(opts.auraLevel) || 25);

    const realRandom = Math.random;
    Math.random = mulberry32(seed);
    try {
        const zone = new Zone("/actions/combat/fly");
        const players = roster.map((r) => {
            const p = Player.createFromDTO(structuredClone(r.dto));
            p.zoneBuffs = zone.buffs;
            p.extraBuffs = GROUP_BATTLE_REGEN_BUFFS;
            if (opts.noPlayerDamage || opts.infiniteMana) {
                const base = p.updateCombatDetails.bind(p);
                p.updateCombatDetails = function () {
                    base();
                    // 1e9 stands in for "cannot die" / "never runs dry" without
                    // touching the engine's own formulas.
                    if (opts.noPlayerDamage) p.combatDetails.maxHitpoints = 1e9;
                    if (opts.infiniteMana) p.combatDetails.maxManapoints = 1e9;
                };
            }
            return p;
        });

        const enemies = buildEnemies(config.groupName, players.length, level);
        const sim = new CombatSimulator(players, zone, null, { logEvents: false, fixedEnemies: enemies });
        // simulateBattle() forces logEvents on, and a 20-minute fight with 50
        // players would build a battle log of millions of entries that nothing
        // here reads. Switch it back off on the fresh SimResult.
        const baseReset = sim.reset.bind(sim);
        sim.reset = function () {
            baseReset();
            sim.simResult.logEvents = false;
        };

        const timeCapNs = (Number(opts.timeCapSeconds) || 3600) * 1e9;
        // Awaited inside the try, so the seeded RNG stays installed for the whole
        // fight — simulateBattle yields on every event.
        const res = await sim.simulateBattle(timeCapNs);

        const seconds = res.battleDurationNs / 1e9;
        const totalHp = (res.enemyFinalState || []).reduce((s, e) => s + e.maxHitpoints, 0);

        const squadResults = squads.map((squad) => ({
            id: squad.id,
            label: squad.label,
            presetId: squad.presetId,
            support: !!squad.support,
            kit: (squad.kit || []).filter((s) => s && s.hrid),
            n: 0, dmg: 0, hits: 0, misses: 0, oom: 0,
            perAbility: {}, perTarget: {}, casts: {},
        }));
        const bySquad = new Map(squadResults.map((s) => [s.id, s]));

        for (const r of roster) {
            const bucket = bySquad.get(r.squadId);
            if (!bucket) continue;
            bucket.n += 1;
            mergeInto(bucket, collect(res.attacks, r.dto.hrid));
            bucket.oom += res.playerOomCastCount[r.dto.hrid] || 0;
            for (const [ab, count] of Object.entries(res.abilityCastCounts[r.dto.hrid] || {})) {
                bucket.casts[ab] = (bucket.casts[ab] || 0) + count;
            }
        }

        return {
            seed,
            outcome: res.battleOutcome,
            seconds,
            totalHp,
            partySize: players.length,
            survivors: (res.playerSurvivors || []).length,
            supportCount: roster.filter((r) => r.support).length,
            maxEnrage: res.maxEnrageStack,
            enemies: (res.enemyFinalState || []).map((e) => ({
                hrid: e.hrid,
                maxHitpoints: e.maxHitpoints,
                currentHitpoints: e.currentHitpoints,
            })),
            squads: squadResults,
        };
    } finally {
        Math.random = realRandom;
    }
}

// Mean of several seeds. Damage is summed and divided by the summed durations, so
// the average is a true rate rather than an average of rates.
export function aggregateRuns(runs) {
    if (!runs.length) return null;
    const first = runs[0];
    const totalSeconds = runs.reduce((s, r) => s + r.seconds, 0);
    const squads = first.squads.map((s0, idx) => {
        const parts = runs.map((r) => r.squads[idx]);
        const acc = {
            id: s0.id, label: s0.label, presetId: s0.presetId, support: !!s0.support,
            kit: s0.kit, n: s0.n,
            dmg: 0, hits: 0, misses: 0, oom: 0, perAbility: {}, perTarget: {}, casts: {},
        };
        for (const p of parts) {
            mergeInto(acc, p);
            acc.oom += p.oom;
            for (const [ab, c] of Object.entries(p.casts)) acc.casts[ab] = (acc.casts[ab] || 0) + c;
        }
        acc.dps = acc.n ? acc.dmg / acc.n / totalSeconds : 0;
        acc.pctPerMin = first.totalHp ? (acc.dmg / runs.length) / first.totalHp * 60 / (totalSeconds / runs.length) * 100 : 0;
        return acc;
    });
    return {
        runs: runs.length,
        seconds: totalSeconds / runs.length,
        secondsMin: Math.min(...runs.map((r) => r.seconds)),
        secondsMax: Math.max(...runs.map((r) => r.seconds)),
        outcomes: runs.map((r) => r.outcome),
        totalHp: first.totalHp,
        partySize: first.partySize,
        // Worst case across the seeds — one wipe out of three is the number worth seeing.
        survivors: Math.min(...runs.map((r) => r.survivors ?? r.partySize)),
        supportCount: first.supportCount,
        enemies: first.enemies,
        squads,
    };
}

export default runSkillLab;
