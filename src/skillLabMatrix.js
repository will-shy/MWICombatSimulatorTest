// Boss Matrix rerun — batch driver for the Skill Lab core.
//
// The Skill Lab page (skill-lab.html) runs one roster against one boss at a time.
// The Arsenal guide's Boss Matrix is 8 builds x 5 bosses, so this entry point loops
// the *same* core (src/combatsimulator/skillLab.js) over every cell and writes the
// numbers to JSON. Nothing is reimplemented here: the roster, the kits and the score
// all go through runSkillLab/aggregateRuns, so a cell can be reproduced by hand in the
// page by entering the same squads.
//
// Built for target:node by webpack.matrix.config.js (skillLab.js uses require.context
// for preset auto-discovery, so it needs a bundler even outside the browser).
//
// Scenario, per the run brief:
//   - T6 = room level 150 (tier = (level-100)/10 + 1, docs/group_battle.md §5).
//   - 50-player group: 2 tanks, 5 nature supports, 2 mana spring supports, 41 mixed DPS.
//   - Every player's seven skills forced to 125, every house room at level 4
//     (+4 all combat skills, +2% attack speed, +0.02 cast speed, +0.12pp regen).
//   - Ability levels: aura 20, the three 0-cooldown mage spells 60, everything else 40.
//   - Players take no damage (no wipes) so the measurement is pure DPS.
//   - Kits are the Arsenal guide's recommended loadout for that boss.
//
// Score = per-player % of the enemy group's total HP dealt per minute, which is
// aggregateRuns' pctPerMin divided by the squad's player count.
import fs from "fs";
import path from "path";
import {
    PRESETS,
    setCustomBuilds,
    runSkillLab,
    aggregateRuns,
    enemyPreview,
} from "./combatsimulator/skillLab.js";

// --------------------------------------------------------------------- levels --

// "assume player all stats 125" — applied to every roster member, supports included,
// rather than by editing the preset files (which the group-battle page also reads).
const STAT_LEVEL = 125;

// "assume each player has 4 lvls of each house" — every room in the export is
// forced to this level (override with HOUSE_LEVEL=n; the gear files ship with 0).
const HOUSE_LEVEL = process.env.HOUSE_LEVEL !== undefined
    ? Number(process.env.HOUSE_LEVEL) : 4;

// Mana what-ifs. REGEN_ACC=1 swaps the three DPS mages' crit ring/earrings for
// Ring/Earrings of Regeneration at the same +4 (costs 4% crit rate, buys
// +0.4pp base MP regen before enhancement). MS_TRIGGER=1 gives the Mana Spring
// supports the in-game trigger "self / mana_spring / is_inactive" so a spring
// is only cast when no one else's is running — overlapping casts share
// /buff_uniques/mana_spring and just overwrite each other.
const REGEN_ACC = process.env.REGEN_ACC === "1";
const MS_TRIGGER = process.env.MS_TRIGGER === "1";

const MAGE_GEAR_IDS = new Set(["fire_T95", "water_T95", "nature_aoe_T95"]);

function swapRegenAccessories(exp) {
    for (const item of exp.player.equipment || []) {
        if (item.itemLocationHrid === "/item_locations/ring") {
            item.itemHrid = "/items/ring_of_regeneration";
        } else if (item.itemLocationHrid === "/item_locations/earrings") {
            item.itemHrid = "/items/earrings_of_regeneration";
        }
    }
}

// Ability levels: aura lvl25 (per the later brief; the original said 20), the
// three 0-cd mage spells lvl60, everything else lvl40. Keyed by ability, so a
// kit can name abilities and the level rule fills itself in.
const AURA_LEVEL = process.env.AURA_LEVEL !== undefined
    ? Number(process.env.AURA_LEVEL) : 25;
const ZERO_CD_SPELL_LEVEL = 60;
const DEFAULT_ABILITY_LEVEL = 40;

const AURAS = new Set([
    "insanity", "invincible", "revive",
    "fierce_aura", "mystic_aura", "critical_aura", "guardian_aura", "speed_aura",
]);
// The three spells the brief calls out: 0 cooldown, cast-time-gated fillers.
const ZERO_CD_SPELLS = new Set(["water_strike", "entangle", "fireball"]);

function abilityLevel(name) {
    if (AURAS.has(name)) return AURA_LEVEL;
    if (ZERO_CD_SPELLS.has(name)) return ZERO_CD_SPELL_LEVEL;
    return DEFAULT_ABILITY_LEVEL;
}

// A guide loadout ("frenzy→berserk→precision→maim") plus its aura becomes a length-5
// kit. Slot 0 is the aura, slots 1-4 the rotation, exactly like the bundled presets.
function kit(aura, ...abilities) {
    const slots = [aura, ...abilities].slice(0, 5);
    while (slots.length < 5) slots.push(null);
    return slots.map((name) =>
        name ? { hrid: "/abilities/" + name, level: abilityLevel(name) } : null
    );
}

// ---------------------------------------------------------------- build table --

// presetId -> the gear file under data/testPlayers. The five *_T95 files that were
// missing their .json extension are now named so the preset loader finds them.
const GEAR = {
    smash: "smash_T95",
    slash: "slash_T95",
    stab: "stab_T95",
    bow: "bow_T95",
    crossbow: "xbow_T95",
    fire: "fire_T95",
    water: "water_T95",
    nature: "nature_aoe_T95",
    tank: "wark",
    // No Mana Spring preset exists; the guide's Mana Spring Support is a Blooming
    // nature caster, so it runs on the healer's gear with the Mana Spring kit.
    healer: "nature_healer_revive",
    // Distinct id (same gear file) so the MS_TRIGGER dedup trigger can be
    // attached to the Mana Spring squad without touching the healers.
    manaspring: "manaspring",
};
const VIRTUAL_GEAR = { manaspring: "nature_healer_revive" };

const BOSSES = [
    { key: "badger", group: "Trial Badger" },
    { key: "chameleon", group: "Trial Chameleon" },
    { key: "jellyfish", group: "Trial Jellyfish" },
    { key: "hedgehog", group: "Trial Hedgehog" },
    { key: "swarm", group: "Trial Swarm" },
];

// The eight Boss Matrix DPS builds, with the guide's per-boss tweaks. `default` is
// the guide's Default loadout; a boss key overrides it where the guide lists a tweak.
const DPS_BUILDS = [
    {
        key: "smash", label: "Smash", gear: GEAR.smash, style: "melee",
        kits: { default: kit("insanity", "frenzy", "berserk", "precision", "fracturing_impact") },
    },
    {
        key: "slash", label: "Slash", gear: GEAR.slash, style: "melee",
        kits: { default: kit("insanity", "frenzy", "berserk", "precision", "maim") },
    },
    {
        key: "stab", label: "Stab", gear: GEAR.stab, style: "melee",
        kits: { default: kit("insanity", "frenzy", "berserk", "precision", "puncture") },
    },
    {
        key: "bow", label: "Bow", gear: GEAR.bow, style: "ranged",
        kits: {
            default: kit("insanity", "frenzy", "berserk", "precision", "pestilent_shot"),
            // High-accuracy setup — Steady Shot in place of Precision.
            chameleon: kit("insanity", "frenzy", "berserk", "pestilent_shot", "steady_shot"),
            jellyfish: kit("insanity", "frenzy", "berserk", "pestilent_shot", "steady_shot"),
            swarm: kit("insanity", "frenzy", "berserk", "penetrating_shot", "rain_of_arrows"),
        },
    },
    {
        key: "crossbow", label: "Crossbow", gear: GEAR.crossbow, style: "ranged",
        kits: {
            default: kit("insanity", "frenzy", "berserk", "precision", "pestilent_shot"),
            chameleon: kit("insanity", "frenzy", "berserk", "pestilent_shot", "steady_shot"),
            jellyfish: kit("insanity", "frenzy", "berserk", "pestilent_shot", "steady_shot"),
            swarm: kit("insanity", "frenzy", "berserk", "pestilent_shot", "rain_of_arrows"),
        },
    },
    {
        key: "fire", label: "Fire", gear: GEAR.fire, style: "magic",
        kits: {
            default: kit("insanity", "elemental_affinity", "smoke_burst", "life_drain", "fireball"),
            // Chameleon has high Magic Evasion — Precision instead of Elemental Affinity.
            chameleon: kit("insanity", "precision", "smoke_burst", "life_drain", "fireball"),
            swarm: kit("insanity", "elemental_affinity", "smoke_burst", "firestorm", "fireball"),
        },
    },
    {
        key: "water", label: "Water", gear: GEAR.water, style: "magic",
        kits: {
            default: kit("insanity", "elemental_affinity", "frost_surge", "ice_spear", "water_strike"),
            chameleon: kit("insanity", "precision", "frost_surge", "ice_spear", "water_strike"),
            jellyfish: kit("insanity", "elemental_affinity", "frost_surge", "life_drain", "water_strike"),
            hedgehog: kit("insanity", "elemental_affinity", "frost_surge", "smoke_burst", "water_strike"),
            swarm: kit("insanity", "elemental_affinity", "frost_surge", "firestorm", "water_strike"),
        },
    },
    {
        key: "nature", label: "Nature DPS", gear: GEAR.nature, style: "magic",
        kits: {
            default: kit("insanity", "elemental_affinity", "smoke_burst", "life_drain", "entangle"),
            chameleon: kit("insanity", "precision", "smoke_burst", "life_drain", "entangle"),
            swarm: kit("insanity", "elemental_affinity", "precision", "firestorm", "natures_veil"),
        },
    },
];

// Support squads. Their damage is excluded from the analysis but they fight normally,
// so their debuffs (Toxic Pollen's armor/resistance shred, Smoke Burst's evasion cut)
// and Mana Spring's mana feed reach the raid — that is the "we have all debuffs"
// assumption. 2 + 5 + 2 = 9 players.
const SUPPORT_SQUADS = [
    {
        key: "tank", label: "WarkTank", gear: GEAR.tank, count: 2,
        kits: {
            default: kit("invincible", "provoke", "taunt", "spike_shell", "retribution"),
            // Guide: Hedgehog's armor is too high to tank — run a DPS build instead.
            hedgehog: kit("insanity", "frenzy", "berserk", "precision", "shield_bash"),
        },
    },
    {
        key: "healer", label: "Nature Support", gear: GEAR.healer, count: 5,
        kits: {
            default: kit("revive", "rejuvenate", "smoke_burst", "toxic_pollen", "entangle"),
            chameleon: kit("insanity", "rejuvenate", "precision", "toxic_pollen", "entangle"),
            swarm: kit("insanity", "rejuvenate", "precision", "toxic_pollen", "entangle"),
        },
    },
    {
        key: "manaspring", label: "Mana Spring Support", gear: GEAR.manaspring, count: 2,
        kits: {
            default: kit("revive", "rejuvenate", "mana_spring", "life_drain", "entangle"),
            swarm: kit("insanity", "rejuvenate", "mana_spring", "toxic_pollen", "entangle"),
        },
    },
];

const PARTY_SIZE = 50;
const SUPPORT_TOTAL = SUPPORT_SQUADS.reduce((s, q) => s + q.count, 0);
const DPS_TOTAL = PARTY_SIZE - SUPPORT_TOTAL; // 41

// 41 DPS over 8 builds is 5 each with one left over. The spare goes to Smash, whose
// Fracturing Impact is the raid's only +damage-taken debuff on a 20s cooldown against
// a 12s duration — the extra body buys uptime the whole raid benefits from. Scores are
// reported per player, so the uneven squad does not bias its own number.
function dpsCounts() {
    const base = Math.floor(DPS_TOTAL / DPS_BUILDS.length);
    const counts = DPS_BUILDS.map(() => base);
    let spare = DPS_TOTAL - base * DPS_BUILDS.length;
    for (let i = 0; spare > 0; i++, spare--) counts[i % counts.length] += 1;
    return counts;
}

// ------------------------------------------------------------- custom builds --

// Register every gear file as a "set:"-prefixed custom build with all seven skills
// forced to 125. Going through setCustomBuilds (the hook the page uses for saved
// equipment sets) keeps the preset JSON on disk untouched.
function registerBuilds() {
    const ids = [...new Set(Object.values(GEAR))];
    const builds = ids.map((id) => {
        const preset = PRESETS[VIRTUAL_GEAR[id] || id];
        if (!preset) throw new Error("Missing gear preset: " + id + ".json");
        const exp = structuredClone(preset.export);
        if (REGEN_ACC && MAGE_GEAR_IDS.has(id)) swapRegenAccessories(exp);
        if (MS_TRIGGER && id === "manaspring") {
            exp.triggerMap = { ...(exp.triggerMap || {}) };
            exp.triggerMap["/abilities/mana_spring"] = [{
                dependencyHrid: "/combat_trigger_dependencies/self",
                conditionHrid: "/combat_trigger_conditions/mana_spring",
                comparatorHrid: "/combat_trigger_comparators/is_inactive",
                value: 0,
            }];
        }
        for (const skill of [
            "staminaLevel", "intelligenceLevel", "attackLevel",
            "meleeLevel", "defenseLevel", "rangedLevel", "magicLevel",
        ]) {
            exp.player[skill] = STAT_LEVEL;
        }
        exp.houseRooms = Object.fromEntries(
            Object.keys(exp.houseRooms || {}).map((room) => [room, HOUSE_LEVEL])
        );
        return { id: "set:" + id, name: preset.name + " (125)", export: exp };
    });
    setCustomBuilds(builds);
    return new Map(builds.map((b) => [b.id.slice(4), b.id]));
}

// ------------------------------------------------------------------ the run --

function kitFor(entry, bossKey) {
    return entry.kits[bossKey] || entry.kits.default;
}

function squadsFor(bossKey, buildId) {
    const counts = dpsCounts();
    const squads = DPS_BUILDS.map((b, i) => ({
        id: b.key,
        label: b.label,
        presetId: buildId.get(b.gear),
        count: counts[i],
        kit: kitFor(b, bossKey),
        support: false,
    }));
    for (const s of SUPPORT_SQUADS) {
        squads.push({
            id: s.key,
            label: s.label,
            presetId: buildId.get(s.gear),
            count: s.count,
            kit: kitFor(s, bossKey),
            support: true,
        });
    }
    return squads;
}

async function main() {
    const level = Number(process.env.LEVEL) || 150; // T6
    const seeds = Number(process.env.SEEDS) || 3;
    const timeCapSeconds = Number(process.env.TIME_CAP) || 3600;
    const outFile = process.env.OUT
        || path.join(process.cwd(), "matrix_T6.json");

    const buildId = registerBuilds();
    const results = {};

    for (const boss of BOSSES) {
        const squads = squadsFor(boss.key, buildId);
        const total = squads.reduce((s, q) => s + q.count, 0);
        if (total !== PARTY_SIZE) throw new Error("Roster is " + total + ", expected " + PARTY_SIZE);

        const runs = [];
        for (let seed = 1; seed <= seeds; seed++) {
            process.stderr.write(`${boss.group} L${level} seed ${seed}/${seeds} ... `);
            const t0 = Date.now();
            const res = await runSkillLab({
                groupName: boss.group,
                level,
                squads,
                seed,
                options: {
                    infiniteMana: process.env.INFINITE_MANA === "1",
                    noPlayerDamage: true,
                    auras: true,
                    auraLevel: AURA_LEVEL,
                    timeCapSeconds,
                },
            });
            process.stderr.write(
                `${res.outcome} in ${res.seconds.toFixed(0)}s (${((Date.now() - t0) / 1000).toFixed(1)}s wall)\n`
            );
            runs.push(res);
        }

        const agg = aggregateRuns(runs);
        results[boss.key] = {
            boss: boss.group,
            level,
            preview: enemyPreview(boss.group, level, PARTY_SIZE),
            outcomes: agg.outcomes,
            seconds: agg.seconds,
            secondsMin: agg.secondsMin,
            secondsMax: agg.secondsMax,
            totalHp: agg.totalHp,
            partySize: agg.partySize,
            enemies: agg.enemies,
            squads: agg.squads.map((s) => ({
                id: s.id,
                label: s.label,
                support: s.support,
                n: s.n,
                kit: s.kit.map((k) => ({ name: k.hrid.split("/").pop(), level: k.level })),
                dmg: s.dmg,
                hits: s.hits,
                misses: s.misses,
                hitRate: s.hits + s.misses ? s.hits / (s.hits + s.misses) : 0,
                oom: s.oom,
                dps: s.dps,                            // per player, damage/second
                squadPctPerMin: s.pctPerMin,           // whole squad
                score: s.n ? s.pctPerMin / s.n : 0,    // per player = the score
                perAbility: s.perAbility,
                perTarget: s.perTarget,
                casts: s.casts,
            })),
        };
    }

    const out = {
        generated: new Date().toISOString(),
        level,
        tier: (level - 100) / 10 + 1,
        seeds,
        partySize: PARTY_SIZE,
        statLevel: STAT_LEVEL,
        houseLevel: HOUSE_LEVEL,
        regenAccessories: REGEN_ACC,
        manaSpringTrigger: MS_TRIGGER,
        infiniteMana: process.env.INFINITE_MANA === "1",
        abilityLevels: { aura: AURA_LEVEL, zeroCdSpell: ZERO_CD_SPELL_LEVEL, other: DEFAULT_ABILITY_LEVEL },
        roster: {
            dps: DPS_BUILDS.map((b, i) => ({ key: b.key, label: b.label, count: dpsCounts()[i] })),
            support: SUPPORT_SQUADS.map((s) => ({ key: s.key, label: s.label, count: s.count })),
        },
        bosses: results,
    };
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
    process.stderr.write("wrote " + outFile + "\n");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
