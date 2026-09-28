import { importSetToPlayerDTO } from "./combatsimulator/importSet.js";

// A guild combat-trial export is a JSON array with one entry per guild member, straight from the
// game's guild API:
//
//   { characterId, characterName, role, combatTrial, trialCombatLevel, profile, combatLoadout }
//
// `profile` is whatever the member has equipped right now; `combatLoadout` is the loadout they
// saved for this trial. The loadout is what they intend to fight with, so it wins wherever it has
// something to say, and a member who never saved one falls back to their live profile. The
// simulator only ever sees the merged result — `hasLoadout` is carried alongside so the UI can
// flag the members whose numbers are a guess rather than a declared setup.

const SKILL_LEVEL_FIELDS = {
    "/skills/attack": "attackLevel",
    "/skills/magic": "magicLevel",
    "/skills/melee": "meleeLevel",
    "/skills/ranged": "rangedLevel",
    "/skills/defense": "defenseLevel",
    "/skills/stamina": "staminaLevel",
    "/skills/intelligence": "intelligenceLevel",
};

// The four combat shrines, as the guild buff map names them. Everything else in that map is a
// skilling shrine the combat sim has no use for.
const COMBAT_SHRINES = ["force", "tempo", "spirit", "scholar"];

const ABILITY_SLOTS = 5;

function combatLevelsFrom(characterSkills) {
    let levels = {
        attackLevel: 1, magicLevel: 1, meleeLevel: 1, rangedLevel: 1,
        defenseLevel: 1, staminaLevel: 1, intelligenceLevel: 1,
    };
    for (const skill of characterSkills ?? []) {
        const field = SKILL_LEVEL_FIELDS[skill?.skillHrid];
        if (field) {
            levels[field] = Number(skill.level) || 1;
        }
    }
    return levels;
}

// wearableItemMap is keyed by item location and holds every worn item, tools included. Only the
// combat slots survive importSetToPlayerDTO, so the skilling tools that ride along in a
// "whatever I had on" loadout drop out on their own.
function equipmentFrom(wearableItemMap) {
    return Object.entries(wearableItemMap ?? {})
        .filter(([, item]) => item?.itemHrid)
        .map(([location, item]) => ({
            itemLocationHrid: item.itemLocationHrid || location,
            itemHrid: item.itemHrid,
            enhancementLevel: Number(item.enhancementLevel) || 0,
        }));
}

// Equipped abilities carry their own slotNumber (1..5). Honour it so an ability keeps the bar
// position the player put it in; entries without a usable slot fill the list in order.
function abilitiesFrom(equippedAbilities) {
    let slots = Array.from({ length: ABILITY_SLOTS }, () => ({ abilityHrid: "", level: "1" }));
    (equippedAbilities ?? []).forEach((ability, index) => {
        if (!ability?.abilityHrid) {
            return;
        }
        const slotNumber = Number(ability.slotNumber) - 1;
        const slot = slotNumber >= 0 && slotNumber < ABILITY_SLOTS ? slotNumber : index;
        if (slot < 0 || slot >= ABILITY_SLOTS) {
            return;
        }
        slots[slot] = { abilityHrid: ability.abilityHrid, level: String(Number(ability.level) || 1) };
    });
    return slots;
}

function houseRoomsFrom(characterHouseRoomMap) {
    let rooms = {};
    for (const [hrid, room] of Object.entries(characterHouseRoomMap ?? {})) {
        rooms[hrid] = Number(room?.level) || 0;
    }
    return rooms;
}

function achievementsFrom(characterAchievements) {
    let achievements = {};
    for (const achievement of characterAchievements ?? []) {
        if (achievement?.achievementHrid) {
            achievements[achievement.achievementHrid] = !!achievement.isCompleted;
        }
    }
    return achievements;
}

// guildBuffLevelMap keys look like "/guild_buffs/force_combat" (and "_skilling" for the shrines
// the sim ignores). Reduce it to the { force, tempo, spirit, scholar } shape importSet.js expects,
// always emitting all four so a shrine the guild never built reads as level 0 rather than missing.
function guildShrineFrom(guildBuffLevelMap) {
    let shrine = {};
    for (const name of COMBAT_SHRINES) {
        shrine[name] = 0;
    }
    for (const [key, level] of Object.entries(guildBuffLevelMap ?? {})) {
        const match = /^\/guild_buffs\/(.+?)_combat$/.exec(key);
        if (match && COMBAT_SHRINES.includes(match[1])) {
            shrine[match[1]] = Number(level) || 0;
        }
    }
    return shrine;
}

// An empty map/array on the loadout means "the loadout says nothing here", not "equip nothing" —
// see ATE8890 in the sample export, whose loadout holds gear but no abilities at all.
function preferLoadout(fromLoadout, fromProfile) {
    const size = (value) => (Array.isArray(value) ? value.length : Object.keys(value ?? {}).length);
    return size(fromLoadout) > 0 ? fromLoadout : fromProfile;
}

// One roster entry as an "import set" — the same JSON shape the standard simulator's Solo import
// accepts, so it can go straight through importSetToPlayerDTO.
export function guildTrialEntryToImportSet(entry) {
    const profile = entry?.profile ?? {};
    const loadout = entry?.combatLoadout ?? {};

    const wearableItemMap = preferLoadout(loadout.wearableItemMap, profile.wearableItemMap);
    const equippedAbilities = preferLoadout(loadout.equippedAbilities, profile.equippedAbilities);
    // Triggers are per-ability, so merging rather than picking a side keeps a trigger the member
    // configured on their live bar for an ability the loadout also uses.
    const triggerMap = {
        ...(profile.abilityCombatTriggersMap ?? {}),
        ...(loadout.abilityCombatTriggersMap ?? {}),
    };

    return {
        player: {
            ...combatLevelsFrom(profile.characterSkills),
            equipment: equipmentFrom(wearableItemMap),
        },
        // Group battles never eat or drink, so the consumable slots stay empty by construction
        // and the exported combatConsumables are ignored.
        food: { "/action_types/combat": [] },
        drinks: { "/action_types/combat": [] },
        abilities: abilitiesFrom(equippedAbilities),
        triggerMap,
        houseRooms: houseRoomsFrom(profile.characterHouseRoomMap),
        achievements: achievementsFrom(profile.characterAchievements),
        guildShrine: guildShrineFrom(profile.guildBuffLevelMap),
        characterName: entry?.characterName || profile.sharableCharacter?.name || "",
    };
}

export function guildTrialEntryToPlayerDTO(entry, hrid) {
    let dto = importSetToPlayerDTO(guildTrialEntryToImportSet(entry), hrid);
    // importSetToPlayerDTO compacts the ability list; the roster's aura assignment and detail view
    // both expect the fixed five-slot array, so pad the tail back out.
    while (dto.abilities.length < ABILITY_SLOTS) {
        dto.abilities.push(null);
    }
    // Only drops and experience read this, neither of which a group battle reports.
    dto.debuffOnLevelGap = 0;
    return dto;
}

// Parses a guild trial export into { members, trials, primaryTrial }. `members` keeps the file's
// order; `trials` counts how many members each combatTrial claims, most common first, so the UI
// can warn when a roster was not exported for a single trial.
export function parseGuildTrialRoster(text) {
    const parsed = JSON.parse(text);
    const entries = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.members) ? parsed.members : [parsed];

    let members = entries
        .filter((entry) => entry && (entry.profile || entry.combatLoadout))
        .map((entry, index) => ({
            entry,
            name: entry.characterName || entry.profile?.sharableCharacter?.name || "Player " + (index + 1),
            characterId: String(entry.characterId ?? ""),
            role: entry.role || "",
            combatTrial: entry.combatTrial || "",
            combatLevel: Number(entry.trialCombatLevel) || Number(entry.profile?.combatLevel) || 0,
            hasLoadout: !!entry.combatLoadout?.hasLoadout,
        }));

    let counts = new Map();
    for (const member of members) {
        if (member.combatTrial) {
            counts.set(member.combatTrial, (counts.get(member.combatTrial) ?? 0) + 1);
        }
    }
    const trials = [...counts.entries()]
        .map(([hrid, count]) => ({ hrid, count }))
        .sort((a, b) => b.count - a.count);

    return { members, trials, primaryTrial: trials[0]?.hrid ?? "" };
}
