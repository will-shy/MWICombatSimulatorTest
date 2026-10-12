// Trial Assignment: the logic behind trial-assign.html that needs no DOM and no kernel, so it can be
// tested in Node. The page (trialAssign.js) measures players on the wasm kernel and feeds the
// numbers in here.
//
//   guide bars      the Build Guide's ability bar per build and boss, and the guide's triggers
//   aura power      how strong an aura is in a carrier's hands
//   ladder model    clear time and survival time per tier, from a calibrated team, and the trial score
//   planner         the split between two bosses that maximises the expected trial score
//
// The model and the search are the ones docs/harness.md describes under "Assigning players to two
// bosses": scores are measured, not looked up, so every player's damage on each boss is direct.

// ------------------------------------------------------------------ guide bars

// Slot 1 is the build's aura (Insanity for DPS, Invincible for Wark, Revive for supports); a
// special-aura carrier puts their aura there instead. From the Build Guide on the guild page,
// as recorded in ~/work/mwi/data/skills.md.
const DEFAULT_BARS = {
    Wark: ["Invincible", "Provoke", "Taunt", "Spike Shell", "Retribution"],
    Slash: ["Insanity", "Frenzy", "Berserk", "Precision", "Maim"],
    Smash: ["Insanity", "Frenzy", "Berserk", "Precision", "Fracturing Impact"],
    Stab: ["Insanity", "Frenzy", "Berserk", "Precision", "Puncture"],
    "Cursed Bower": ["Insanity", "Frenzy", "Berserk", "Precision", "Pestilent Shot"],
    Ranged: ["Insanity", "Frenzy", "Berserk", "Pestilent Shot", "Steady Shot"],
    Fire: ["Insanity", "Elemental Affinity", "Smoke Burst", "Life Drain", "Fireball"],
    Water: ["Insanity", "Precision", "Frost Surge", "Ice Spear", "Water Strike"],
    "Nature DPS": ["Insanity", "Elemental Affinity", "Smoke Burst", "Life Drain", "Entangle"],
    "Nature Support": ["Revive", "Rejuvenate", "Smoke Burst", "Toxic Pollen", "Entangle"],
    "Mana Spring Support": ["Revive", "Rejuvenate", "Mana Spring", "Life Drain", "Entangle"],
};
const BOSS_TWEAKS = {
    Badger: {
        "Cursed Bower": ["Insanity", "Frenzy", "Berserk", "Penetrating Shot", "Rain of Arrows"],
        Fire: ["Insanity", "Elemental Affinity", "Smoke Burst", "Firestorm", "Fireball"],
    },
    Chameleon: {},
    Jellyfish: {},
    // Hedgehog's armor is too high to tank: Wark drops threat and runs a DPS bar.
    Hedgehog: {
        Wark: ["Insanity", "Frenzy", "Berserk", "Precision", "Shield Bash"],
        "Nature Support": ["Revive", "Rejuvenate", "Quick Aid", "Smoke Burst", "Toxic Pollen"],
        "Mana Spring Support": ["Revive", "Rejuvenate", "Quick Aid", "Mana Spring", "Toxic Pollen"],
    },
    Swarm: {
        "Cursed Bower": ["Insanity", "Frenzy", "Berserk", "Penetrating Shot", "Rain of Arrows"],
        Ranged: ["Insanity", "Frenzy", "Berserk", "Pestilent Shot", "Rain of Arrows"],
        Fire: ["Insanity", "Elemental Affinity", "Smoke Burst", "Firestorm", "Fireball"],
        Water: ["Insanity", "Precision", "Frost Surge", "Firestorm", "Water Strike"],
        "Nature DPS": ["Insanity", "Elemental Affinity", "Frost Surge", "Nature's Veil", "Firestorm"],
        "Mana Spring Support": ["Revive", "Rejuvenate", "Mana Spring", "Toxic Pollen", "Entangle"],
    },
};
export const BOSSES = ["Badger", "Chameleon", "Jellyfish", "Hedgehog", "Swarm"];
export const BUILDS = Object.keys(DEFAULT_BARS);

const hridOf = (name) => "/abilities/" + name.toLowerCase().replace(/'/g, "").replace(/ /g, "_");
export const guideBar = (boss, build) => ((BOSS_TWEAKS[boss] || {})[build] || DEFAULT_BARS[build] || []).map(hridOf);

// combatClass.js key -> guide build. Magic with no element and no weapon have no guide bar.
export const CLASS_TO_BUILD = {
    wark: "Wark", cursedBow: "Cursed Bower", manaSupport: "Mana Spring Support", natureSupport: "Nature Support",
    slash: "Slash", stab: "Stab", smash: "Smash", ranged: "Ranged", fire: "Fire", water: "Water", natureDps: "Nature DPS",
};

export const ROLE_BUILDS = ["Wark", "Nature Support", "Mana Spring Support"];
export const PHYSICAL = new Set(["Smash", "Slash", "Stab", "Ranged", "Cursed Bower"]);
export const MAGIC = new Set(["Fire", "Water", "Nature DPS"]);

export const SPECIAL_AURAS = {
    Fierce: "/abilities/fierce_aura", Mystic: "/abilities/mystic_aura", Crit: "/abilities/critical_aura",
    Speed: "/abilities/speed_aura", Guardian: "/abilities/guardian_aura",
};
export const AURA_SKILL = { Fierce: "melee", Crit: "ranged", Guardian: "defense", Mystic: "magic", Speed: "attack" };
const AURA_OF_HRID = Object.fromEntries(Object.entries(SPECIAL_AURAS).map(([k, v]) => [v, k]));
const BAR_AURAS = new Set(["/abilities/insanity", "/abilities/invincible", "/abilities/revive", ...Object.values(SPECIAL_AURAS)]);

const trig = (dep, cond, cmp, value) => ({
    dependencyHrid: "/combat_trigger_dependencies/" + dep,
    conditionHrid: "/combat_trigger_conditions/" + cond,
    comparatorHrid: "/combat_trigger_comparators/" + cmp,
    value,
});

/**
 * The guide's bar for one member on one boss, as { abilities: [{abilityHrid, level}] x5, triggerMap }.
 *
 *   own        { hrid: level } of every ability the member has equipped, profile or loadout (the higher)
 *   current    the member's bar as imported, slot order, [hrid]
 *   aura       a special aura name to carry in slot 1, or null; auraLevel its level
 *   maxHp      the member's max HP, for Insanity's HP guard
 *
 * Levels follow the guide: an ability the member has keeps their level; one they don't takes the
 * level of an ability leaving their bar, aura for aura and the rest in slot order. Triggers: Insanity
 * only while HP >= insanityHp x max HP, Rejuvenate at the lowest ally <= 60%, Quick Aid at <= 50%
 * (the game's "less than" is <=); every other ability keeps the member's own trigger if it has one.
 */
export function applyGuideBar({ boss, build, own, current, triggerMap, aura, auraLevel, maxHp, insanityHp }) {
    const bar = guideBar(boss, build);
    if (!bar.length) return null;
    if (aura) bar[0] = SPECIAL_AURAS[aura];
    const leaving = current.filter((h) => h && !bar.includes(h));
    const pools = { aura: leaving.filter((h) => BAR_AURAS.has(h)), other: leaving.filter((h) => !BAR_AURAS.has(h)) };
    const abilities = bar.map((h, i) => {
        let level = own[h];
        if (i === 0 && aura && auraLevel) level = Math.max(level || 0, auraLevel);
        if (!level) {
            const from = pools[BAR_AURAS.has(h) ? "aura" : "other"].shift();
            level = from ? own[from] || 1 : 1;
        }
        return { abilityHrid: h, level: String(level) };
    });
    const triggers = {};
    for (const h of bar) if (triggerMap[h]) triggers[h] = triggerMap[h];
    if (bar.includes("/abilities/insanity")) {
        const t = [trig("self", "insanity", "is_inactive", 0)];
        if (maxHp > 0 && insanityHp > 0) t.push(trig("self", "current_hp", "greater_than_equal", Math.ceil(insanityHp * maxHp)));
        triggers["/abilities/insanity"] = t;
    }
    if (bar.includes("/abilities/rejuvenate")) triggers["/abilities/rejuvenate"] = [trig("all_allies", "lowest_hp_percentage", "less_than_equal", 60)];
    if (bar.includes("/abilities/quick_aid")) triggers["/abilities/quick_aid"] = [trig("all_allies", "lowest_hp_percentage", "less_than_equal", 50)];
    return { abilities, triggerMap: triggers };
}

// The special aura a member holds (on either bar) and its level, or null. A member with two keeps
// the higher-level one.
export function heldAura(equippedLists) {
    let best = null;
    for (const list of equippedLists) for (const e of list || []) {
        const aura = AURA_OF_HRID[e?.abilityHrid];
        if (aura && (!best || Number(e.level) > best.level)) best = { aura, level: Number(e.level) || 1 };
    }
    return best;
}

// ------------------------------------------------------------------ aura power

// buff = (base + (level - 1) x perLevel) x (1 + casterSkill x perSkill), from the game data
// (docs/group_battle.md §4.5). One number per aura is enough: every buff on an aura scales the same.
export function auraPower(abilityDetailMap, aura, level, skill) {
    const buff = abilityDetailMap[SPECIAL_AURAS[aura]]?.abilityEffects?.flatMap((e) => e.buffs || [])[0];
    if (!buff) return 0;
    const base = buff.flatBoost || buff.ratioBoost || 0;
    const per = buff.flatBoost ? buff.flatBoostLevelBonus || 0 : buff.ratioBoostLevelBonus || 0;
    const perSkill = buff.multiplierPerSkillLevel ?? 0.005;
    return (base + (level - 1) * per) * (1 + skill * perSkill);
}

// ------------------------------------------------------------------ ladder model

export const CONSTANTS = {
    ALPHA: 1.2,   // tier time ~ (1 / power)^ALPHA
    KAPPA: 0.7,   // a DPS carrier's own damage (they give up Insanity)
    SIGMA: 0.15,  // prediction noise in tiers, for the expected score
    WIPE: 0.85,   // a wiping raid gets the boss this far of what its clear rate implies
    MIN_AURA: 0.005,
    BETA: 10,     // healing exponent of survival time when a boss's calibration can't fit one
};

export const scoreAt = (p) => { const t = Math.floor(p + 1e-9); return 200 * t + 100 * (p - t); };
const Z = [-2.5, -1.875, -1.25, -0.625, 0, 0.625, 1.25, 1.875, 2.5].map((z) => [z, Math.exp(-z * z / 2)]);
const ZW = Z.reduce((s, [, w]) => s + w, 0);
const expScore = (p, sigma) => Z.reduce((s, [z, w]) => s + w * scoreAt(p + z * sigma), 0) / ZW;

const critFactor = (c) => 1 + (0.05 + c) * (0.5 + c);

// Players here: { id, build, dps: {boss: number}, hps, aura, auraPower }.
export function carriersFor(team, boss, opts = {}) {
    const minAura = opts.minAura ?? CONSTANTS.MIN_AURA;
    const dmg = (set) => team.filter((p) => !ROLE_BUILDS.includes(p.build) && (!set || set.has(p.build))).reduce((s, p) => s + p.dps[boss], 0);
    const total = dmg() || 1;
    const w = { Fierce: dmg(PHYSICAL) / total, Mystic: dmg(MAGIC) / total, Crit: 1, Speed: 1, Guardian: 0.5 };
    const out = new Map();
    for (const aura of Object.keys(SPECIAL_AURAS)) {
        const c = team.filter((p) => p.aura === aura && (opts.tanksBringAuras || p.build !== "Wark") && !out.has(p.id))
            .sort((x, y) => y.auraPower - x.auraPower)[0];
        if (c && c.auraPower * w[aura] >= minAura) out.set(c.id, aura);
    }
    return out;
}

const auraTotals = (team, carriers) => {
    const o = { Fierce: 0, Mystic: 0, Crit: 0, Speed: 0, Guardian: 0 };
    for (const p of team) { const a = carriers.get(p.id); if (a) o[a] = Math.max(o[a], p.auraPower); }
    return o;
};

// The team's damage on a boss, relative to the auras the scores were measured under.
export function teamPower(team, carriers, boss, refAuras, kappa = CONSTANTS.KAPPA) {
    const cur = auraTotals(team, carriers), ref = refAuras;
    const all = ((1 + cur.Speed) / (1 + ref.Speed)) * (critFactor(cur.Crit) / critFactor(ref.Crit));
    const fierce = (1 + cur.Fierce) / (1 + ref.Fierce), mystic = (1 + cur.Mystic) / (1 + ref.Mystic);
    let total = 0;
    for (const p of team) {
        let v = p.dps[boss] * all;
        if (PHYSICAL.has(p.build)) v *= fierce;
        if (MAGIC.has(p.build)) v *= mystic;
        if (carriers.has(p.id) && !ROLE_BUILDS.includes(p.build)) v *= kappa;
        total += v;
    }
    return total;
}
export const teamHps = (team) => team.reduce((s, p) => s + (p.hps || 0), 0);

/**
 * cal = { times: [mean clear time per tier], power, survival: {a, g, beta, s, H0} | null, budget }
 * Progress of a team with damage `pw` and healing `H`, at survival noise z.
 */
export function progress(cal, pw, H, z = 0, c = CONSTANTS) {
    const n = cal.times.length;
    const scale = Math.pow(cal.power / pw, c.ALPHA);
    const growth = n >= 2 ? Math.log(cal.times[n - 1] / cal.times[Math.max(0, n - 5)]) / Math.min(4, n - 1) : 0.17;
    const T = (t) => (t <= n ? cal.times[t - 1] : cal.times[n - 1] * Math.exp(growth * (t - n))) * scale;
    const sv = cal.survival;
    let left = cal.budget;
    for (let t = 1; t <= 21; t++) {
        const clear = T(t);
        const die = sv ? Math.exp(sv.a - sv.g * (t - 9) + sv.beta * Math.log(H / sv.H0) + sv.s * z) : Infinity;
        if (die < clear && die < left) return t - 1 + c.WIPE * die / clear;
        if (clear > left) return t - 1 + left / clear;
        left -= clear;
    }
    return 21;
}
export function expectedScore(cal, pw, H, c = CONSTANTS) {
    if (!cal.survival) return expScore(progress(cal, pw, H, 0, c), c.SIGMA);
    return Z.reduce((s, [z, w]) => s + w * expScore(progress(cal, pw, H, z, c), c.SIGMA), 0) / ZW;
}

// ------------------------------------------------------------------ calibration fits

// Mean clear time per tier over the runs that cleared it, from ladder runs ({tiers: [{tier, outcome, seconds}]}).
export function tierTimes(runs) {
    const by = {};
    for (const r of runs) for (const t of r.tiers) if (t.outcome === "victory") (by[t.tier] ??= []).push(t.seconds);
    const out = [];
    for (let t = 1; by[t]; t++) out.push(by[t].reduce((s, x) => s + x, 0) / by[t].length);
    return out;
}

const normCdf = (x) => 0.5 * (1 + Math.sign(x) * Math.sqrt(1 - Math.exp(-x * x * (4 / Math.PI + 0.147 * x * x) / (1 + 0.147 * x * x))));
function nelderMead(f, x0, steps, iters = 1500) {
    let pts = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + steps[i] : v)))].map((x) => ({ x, f: f(x) }));
    const n = x0.length;
    for (let k = 0; k < iters; k++) {
        pts.sort((p, q) => p.f - q.f);
        const c = x0.map((_, j) => pts.slice(0, n).reduce((s, p) => s + p.x[j], 0) / n);
        const at = (t) => c.map((v, j) => v + t * (pts[n].x[j] - v));
        const r = { x: at(-1) }; r.f = f(r.x);
        if (r.f < pts[0].f) { const e = { x: at(-2) }; e.f = f(e.x); pts[n] = e.f < r.f ? e : r; }
        else if (r.f < pts[n - 1].f) pts[n] = r;
        else {
            const k2 = { x: at(0.5) }; k2.f = f(k2.x);
            if (k2.f < pts[n].f) pts[n] = k2;
            else pts = pts.map((p, i) => { if (i === 0) return p; const x = p.x.map((v, j) => (v + pts[0].x[j]) / 2); return { x, f: f(x) }; });
        }
    }
    pts.sort((p, q) => p.f - q.f);
    return pts[0].x;
}

/**
 * Survival time per tier: ln tau(t) = a - g (t - 9) + beta ln(H / H0) + s z. Censored log-normal
 * maximum likelihood over every tier fought: a wipe at d observes tau = d, a clear or a timeout at d
 * says tau > d. sets: [{ H, runs }]. Returns null when no run ever wiped (time decides that boss).
 * With one healing level beta can't be fitted and is fixed at `fixedBeta`.
 */
export function fitSurvival(sets, H0, fixedBeta = CONSTANTS.BETA) {
    const obs = sets.flatMap((set) => set.runs.flatMap((r) => r.tiers.filter((t) => t.tier >= 5).map((t) => ({ tier: t.tier, d: Math.max(1, t.seconds), wipe: t.outcome === "defeat", h: Math.log(set.H / H0) }))));
    if (!obs.some((o) => o.wipe)) return null;
    const twoLevels = new Set(sets.map((s) => Math.round(s.H))).size > 1;
    const nll = ([a, g, beta, ls]) => {
        const s = Math.exp(ls), b = twoLevels ? beta : fixedBeta;
        let L = 0;
        for (const o of obs) {
            const z = (Math.log(o.d) - (a - g * (o.tier - 9) + b * o.h)) / s;
            L -= o.wipe ? -0.5 * z * z - ls - Math.log(o.d) : Math.log(Math.max(1e-12, 1 - normCdf(z)));
        }
        return L;
    };
    const [a, g, beta, ls] = nelderMead(nll, [6.2, 0.6, fixedBeta, Math.log(0.3)], [0.5, 0.2, 2, 0.3]);
    return { a, g, beta: twoLevels ? Math.max(0, beta) : fixedBeta, s: Math.exp(ls), H0 };
}

// ------------------------------------------------------------------ planner

/**
 * players: [{ id, name, build, dps: {A, B}, hps, mainStat, aura, auraPower }]
 * opts: { bosses: [A, B], cal: {A, B}, refAuras: {A, B}, teamSize, roles: {build: n}, floors: {build: n},
 *         tanksBringAuras, takenDps: {A, B}, constants }
 *
 * Returns { candidates: [{ teams: {A: [ids], B: [ids]}, carriers: {A: Map, B: Map}, pred: {A, B}, score: {A, B}, total }],
 *           bench: [ids], floors, notes }
 * candidates[0] is the best by predicted expected score; the rest are distinct good alternatives
 * from other parts of the trade-off curve, for the page to verify on the simulator.
 */
export function plan(players, opts) {
    const [A, B] = opts.bosses;
    const c = { ...CONSTANTS, ...(opts.constants || {}) };
    const cap = opts.teamSize;
    const notes = [];
    const byId = new Map(players.map((p) => [p.id, p]));

    // 1. Roles: the top 2 x quota of each role, snake-drafted; the harder-hitting boss picks first.
    const firstPick = (opts.takenDps?.[B] ?? 0) > (opts.takenDps?.[A] ?? 0) ? B : A;
    const other = (b) => (b === A ? B : A);
    const fixed = { [A]: [], [B]: [] };
    const used = new Set();
    for (const [build, q] of Object.entries(opts.roles)) {
        const key = build === "Wark" ? (p) => p.mainStat : (p) => p.hps;
        const have = players.filter((p) => p.build === build).sort((x, y) => key(y) - key(x));
        if (have.length < 2 * q) notes.push(`Only ${have.length} ${build} for ${2 * q} slots; both bosses get what there is.`);
        have.slice(0, 2 * q).forEach((p, i) => {
            const round = Math.floor(i / 2), first = round % 2 === 0 ? firstPick : other(firstPick);
            let b = i % 2 === 0 ? first : other(first);
            if (fixed[b].filter((x) => x.build === build).length >= q) b = other(b);
            fixed[b].push(p); used.add(p.id);
        });
    }

    // 2. The DPS pool, benching the weakest when it's over the open slots.
    let pool = players.filter((p) => !used.has(p.id));
    const openA = cap - fixed[A].length, openB = cap - fixed[B].length;
    const strength = (p) => Math.max(p.dps[A] / opts.cal[A].power, p.dps[B] / opts.cal[B].power);
    pool.sort((x, y) => strength(y) - strength(x));
    const bench = pool.slice(openA + openB).map((p) => p.id);
    pool = pool.slice(0, openA + openB);
    // With fewer players than two full teams, split the shortfall evenly.
    const nA = Math.min(openA, Math.ceil((pool.length + fixed[B].length - fixed[A].length) / 2));

    // 3. Coverage floors: every debuff build on both bosses, as far as the guild has them.
    const floors = {};
    for (const [build, target] of Object.entries(opts.floors)) {
        const n = pool.filter((p) => p.build === build).length;
        const f = Math.min(target, Math.floor(n / 2));
        if (f > 0) floors[build] = f;
    }
    const okFloors = (team) => Object.entries(floors).every(([b, f]) => team.filter((p) => p.build === b).length >= f);

    const evalTeam = (team, boss) => {
        const carriers = carriersFor(team, boss, { tanksBringAuras: opts.tanksBringAuras, minAura: c.MIN_AURA });
        const pw = teamPower(team, carriers, boss, opts.refAuras[boss], c.KAPPA), H = teamHps(team);
        return { carriers, pred: progress(opts.cal[boss], pw, H, 0, c), score: expectedScore(opts.cal[boss], pw, H, c), power: pw, H };
    };
    const evalSplit = (fA, fB, toA, toB) => {
        const a = evalTeam([...fA, ...toA], A), b = evalTeam([...fB, ...toB], B);
        return { fA, fB, toA, toB, a, b, total: a.score + b.score };
    };

    // Starts: the Lagrangian frontier (rank on share(A) - lambda x share(B)).
    function split(lam) {
        const v = (p) => p.dps[A] / opts.cal[A].power - lam * p.dps[B] / opts.cal[B].power;
        const sorted = [...pool].sort((x, y) => v(y) - v(x));
        const toA = [], toB = [], taken = new Set();
        for (const [build, f] of Object.entries(floors)) {
            const cand = sorted.filter((p) => p.build === build);
            cand.slice(0, f).forEach((p) => { toA.push(p); taken.add(p.id); });
            cand.slice(-f).forEach((p) => { if (!taken.has(p.id)) { toB.push(p); taken.add(p.id); } });
        }
        for (const p of sorted) if (!taken.has(p.id)) (toA.length < nA ? toA : toB).push(p);
        return { toA, toB };
    }
    const starts = [];
    for (let t = -3; t <= 3 + 1e-9; t += 0.05) {
        const s = split(Math.exp(t));
        if (okFloors(s.toA) && okFloors(s.toB)) starts.push({ lam: Math.exp(t), ...evalSplit(fixed[A], fixed[B], s.toA, s.toB) });
    }
    if (!starts.length) throw new Error("No split satisfies the coverage floors.");

    // Local search: DPS for DPS of another build, role for role of the same build (moves healing).
    function improve(cur) {
        for (let iter = 0; iter < 300; iter++) {
            let best = null;
            const consider = (r) => { if (r.total > (best?.total ?? cur.total) + 1e-6) best = r; };
            for (let i = 0; i < cur.toA.length; i++) for (let j = 0; j < cur.toB.length; j++) {
                if (cur.toA[i].build === cur.toB[j].build) continue;
                const toA = [...cur.toA], toB = [...cur.toB];
                [toA[i], toB[j]] = [toB[j], toA[i]];
                if (okFloors(toA) && okFloors(toB)) consider(evalSplit(cur.fA, cur.fB, toA, toB));
            }
            for (let i = 0; i < cur.fA.length; i++) for (let j = 0; j < cur.fB.length; j++) {
                if (cur.fA[i].build !== cur.fB[j].build) continue;
                const fA = [...cur.fA], fB = [...cur.fB];
                [fA[i], fB[j]] = [fB[j], fA[i]];
                consider(evalSplit(fA, fB, cur.toA, cur.toB));
            }
            if (!best) return cur;
            cur = best;
        }
        return cur;
    }

    // Improve the best start, and the best starts from the A-leaning and B-leaning halves of the
    // curve, so the alternatives the page verifies aren't all the same split.
    const key = (r) => [...r.fA, ...r.toA].map((p) => p.id).sort().join(",");
    const bestOf = (xs) => xs.reduce((m, r) => (!m || r.total > m.total ? r : m), null);
    const half = Math.floor(starts.length / 2);
    const seeds = [bestOf(starts), bestOf(starts.slice(0, half)), bestOf(starts.slice(half))].filter(Boolean);
    const seen = new Set(), results = [];
    for (const s of seeds) {
        const r = improve(s);
        if (seen.has(key(r))) continue;
        seen.add(key(r)); results.push(r);
    }
    results.sort((x, y) => y.total - x.total);

    const candidates = results.map((r) => ({
        teams: { [A]: [...r.fA, ...r.toA].map((p) => p.id), [B]: [...r.fB, ...r.toB].map((p) => p.id) },
        carriers: { [A]: r.a.carriers, [B]: r.b.carriers },
        pred: { [A]: r.a.pred, [B]: r.b.pred },
        score: { [A]: r.a.score, [B]: r.b.score },
        hps: { [A]: r.a.H, [B]: r.b.H },
        total: r.total,
    }));
    return { candidates, bench, floors, notes, byId };
}

/**
 * Predicted numbers for a split someone made, e.g. the site's assignment. teams: {A: [ids], B: [ids]}.
 * carriers: {A: Map(id -> aura), B: ...} to use as given; a boss without one gets the in-team rule.
 */
export function evaluate(players, teams, opts, carriersGiven = {}) {
    const c = { ...CONSTANTS, ...(opts.constants || {}) };
    const byId = new Map(players.map((p) => [p.id, p]));
    const out = { pred: {}, score: {}, carriers: {}, hps: {}, total: 0 };
    for (const boss of opts.bosses) {
        const team = teams[boss].map((id) => byId.get(id)).filter(Boolean);
        const carriers = carriersGiven[boss] || carriersFor(team, boss, { tanksBringAuras: opts.tanksBringAuras, minAura: c.MIN_AURA });
        const pw = teamPower(team, carriers, boss, opts.refAuras[boss], c.KAPPA), H = teamHps(team);
        out.carriers[boss] = carriers;
        out.pred[boss] = progress(opts.cal[boss], pw, H, 0, c);
        out.score[boss] = expectedScore(opts.cal[boss], pw, H, c);
        out.hps[boss] = H;
        out.total += out.score[boss];
    }
    return out;
}
