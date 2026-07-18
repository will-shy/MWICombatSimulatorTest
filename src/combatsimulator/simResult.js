import combatStyleDetailMap from "./data/combatStyleDetailMap.json"

class SimResult {
    constructor(zone, labyrinth, numberOfPlayers) {
        this.deaths = {};
        this.experienceGained = {};
        this.encounters = 0;
        this.attacks = {};
        this.consumablesUsed = {};
        // Per-cast counter for every ability use (damaging or not), keyed by
        // caster hrid then ability hrid. Unlike `attacks` (which only records
        // damaging hits/misses) this counts a cast exactly once regardless of
        // how many effects/targets it has, so buffs and heals are included too.
        this.abilityCastCounts = {};
        this.hitpointsGained = {};
        this.manapointsGained = {};
        this.debuffOnLevelGap = {};
        this.dropRateMultiplier = {};
        this.rareFindMultiplier = {};
        this.combatDropQuantity = {};
        this.playerRanOutOfMana = {
            "player1": false,
            "player2": false,
            "player3": false,
            "player4": false,
            "player5": false
        };
        this.playerRanOutOfManaTime = {};
        // Count of ability casts blocked because the player lacked mana (OOM),
        // keyed by player hrid. Surfaced per tier in the Group Battle UI.
        this.playerOomCastCount = {};
        this.manaUsed = {};
        this.timeSpentAlive = [];
        this.bossSpawns = [];
        this.hitpointsSpent = {};
        this.zoneName = zone?.hrid;
        this.difficultyTier = zone?.difficultyTier;
        this.labyrinthName = labyrinth?.monsterHrid;
        this.roomLevel = labyrinth?.roomLevel;
        this.isDungeon = false;
        this.isLabyrinth = labyrinth ? true : false;
        this.dungeonsCompleted = 0;
        this.dungeonsFailed = 0;
        this.maxWaveReached = 0;
        this.numberOfPlayers = numberOfPlayers;
        this.maxEnrageStack = 0;
        this.minDungenonTime = 0;
        this.maxDungenonTime = 0;
        this.lastDungeonFinishTime = 0;
        this.lastEncounterFinishTime = 0;
        this.labyAttemptCount = 0;

        this.wipeEvents = [];

        // 时间序列数据用于图表显示
        this.timeSeriesData = {
            timestamps: [],
            players: {}
        };

        // Battle-mode detailed combat log. Only populated when logEvents is enabled.
        this.logEvents = false;
        this.battleLog = [];
        this.currentTime = 0;
    }

    logEvent(entry) {
        if (!this.logEvents) {
            return;
        }
        this.battleLog.push({ time: this.currentTime, ...entry });
    }

    addWipeEvent(logs, simulationTime, wave) {
        this.wipeEvents.push({
            simulationTime: simulationTime,
            logs: logs,
            wave: wave,
            timestamp: new Date().toISOString()
        });
    }
    
    addDeath(unit) {
        if (!this.deaths[unit.hrid]) {
            this.deaths[unit.hrid] = 0;
        }

        this.deaths[unit.hrid] += 1;

        this.logEvent({
            kind: "death",
            unit: unit.hrid,
            isPlayer: !!unit.isPlayer,
        });
    }

    updateTimeSpentAlive(name, alive, time) {
        const i = this.timeSpentAlive.findIndex(e => e.name === name);
        if (alive) {
            if (i !== -1) {
                this.timeSpentAlive[i].alive = true;
                this.timeSpentAlive[i].spawnedAt = time;
            } else {
                this.timeSpentAlive.push({ name: name, timeSpentAlive: 0, spawnedAt: time, alive: true, count: 0 });
            }
        } else {
            const timeAlive = time - this.timeSpentAlive[i].spawnedAt;
            this.timeSpentAlive[i].alive = false;
            this.timeSpentAlive[i].timeSpentAlive += timeAlive;
            this.timeSpentAlive[i].count += 1;
        }
    }

    updateDungenonFinish(beginFlag, finishTime) {
        const i = this.timeSpentAlive.findIndex(e => e.name === beginFlag); 
        if (i == -1) {
            return;
        }

        const currentDungenonTime = finishTime - this.timeSpentAlive[i].spawnedAt;

        if (this.minDungenonTime == 0 || this.minDungenonTime > currentDungenonTime) {
            this.minDungenonTime = currentDungenonTime;
        }

        if (this.maxDungenonTime < currentDungenonTime) {
            this.maxDungenonTime = currentDungenonTime;
        }
    }

    addExperienceGain(unit, experience) {
        if (!unit.isPlayer) {
            return;
        }

        if (!this.experienceGained[unit.hrid]) {
            this.experienceGained[unit.hrid] = {
                stamina: 0,
                intelligence: 0,
                attack: 0,
                melee: 0,
                defense: 0,
                ranged: 0,
                magic: 0,
            };
        }

        let experienceGainedRate = {
            "stamina": 0,
            "intelligence": 0,
            "attack": 0,
            "melee": 0,
            "defense": 0,
            "ranged": 0,
            "magic": 0,
        };

        const primaryTraining = unit.combatDetails.combatStats.primaryTraining;
        experienceGainedRate[primaryTraining.split("/")[2]] = .3;

        const skillExpMap = combatStyleDetailMap[unit.combatDetails.combatStats.combatStyleHrid].skillExpMap;
        const skillExpMapLength = Object.keys(skillExpMap).length;

        const focusTraining = unit.combatDetails.combatStats.focusTraining;
        if (focusTraining && skillExpMap[focusTraining]) {
            experienceGainedRate[focusTraining.split("/")[2]] += .7;
        } else {
            Object.keys(skillExpMap).forEach(skillHrid => {
                experienceGainedRate[skillHrid.split("/")[2]] += .7 / skillExpMapLength;
            });
        }

        for (const [type, rate] of Object.entries(experienceGainedRate)) {
            if (rate <= 0) continue;

            const skillExperience = rate * (1 + unit.combatDetails.combatStats[type + "Experience"]);

            this.experienceGained[unit.hrid][type] += (
                experience
                * (1 + unit.combatDetails.combatStats.combatExperience)
                * skillExperience
                * (1 + unit.debuffOnLevelGap)

            );
        }
    }

    addEncounterEnd() {
        this.encounters++;
    }

    // Records one cast of `ability` by `unit`, regardless of whether it deals
    // damage. Call exactly once per successful cast (see tryUseAbility) so
    // buffs/heals get a real per-cast count instead of being invisible to the
    // Damage Done table.
    addAbilityCast(unit, ability) {
        const abilityHrid = ability.hrid ?? ability;
        if (!this.abilityCastCounts[unit.hrid]) {
            this.abilityCastCounts[unit.hrid] = {};
        }
        if (!this.abilityCastCounts[unit.hrid][abilityHrid]) {
            this.abilityCastCounts[unit.hrid][abilityHrid] = 0;
        }
        this.abilityCastCounts[unit.hrid][abilityHrid] += 1;
    }

    addAttack(source, target, ability, hit) {
        if (!this.attacks[source.hrid]) {
            this.attacks[source.hrid] = {};
        }
        if (!this.attacks[source.hrid][target.hrid]) {
            this.attacks[source.hrid][target.hrid] = {};
        }
        if (!this.attacks[source.hrid][target.hrid][ability]) {
            this.attacks[source.hrid][target.hrid][ability] = {};
        }

        if (!this.attacks[source.hrid][target.hrid][ability][hit]) {
            this.attacks[source.hrid][target.hrid][ability][hit] = 0;
        }

        this.attacks[source.hrid][target.hrid][ability][hit] += 1;

        this.logEvent({
            kind: "attack",
            source: source.hrid,
            sourceIsPlayer: !!source.isPlayer,
            target: target.hrid,
            targetIsPlayer: !!target.isPlayer,
            ability: ability,
            hit: hit, // number = damage, "miss" = missed
            targetHpAfter: target.combatDetails.currentHitpoints,
            targetMaxHp: target.combatDetails.maxHitpoints,
        });
    }

    addConsumableUse(unit, consumable) {
        if (!this.consumablesUsed[unit.hrid]) {
            this.consumablesUsed[unit.hrid] = {};
        }
        if (!this.consumablesUsed[unit.hrid][consumable.hrid]) {
            this.consumablesUsed[unit.hrid][consumable.hrid] = 0;
        }

        this.consumablesUsed[unit.hrid][consumable.hrid] += 1;

        this.logEvent({
            kind: "consumable",
            unit: unit.hrid,
            isPlayer: !!unit.isPlayer,
            consumable: consumable.hrid,
        });
    }

    // Buff-only ability casts (e.g. Provoke, Fierce Aura) never deal damage, so
    // they never appear in the "attack" log entries addAttack() produces. This
    // is the only trace of them in the combat log, mirroring addConsumableUse's
    // shape so the log/UI can treat both as "unit used X" events.
    addBuffCast(unit, ability, target) {
        this.logEvent({
            kind: "buffCast",
            unit: unit.hrid,
            isPlayer: !!unit.isPlayer,
            ability: ability.hrid,
            target: target.hrid,
            targetIsPlayer: !!target.isPlayer,
        });
    }

    addEnrageStack(unit, stack) {
        this.logEvent({
            kind: "enrage",
            unit: unit.hrid,
            isPlayer: !!unit.isPlayer,
            stack: stack,
        });
    }

    // `healer` is the unit that produced the heal (the caster of an ability that
    // heals an ally). Omit it for self-heals (regen, lifesteal, consumables,
    // self-cast) - it then defaults to the healed unit itself.
    addHitpointsGained(unit, source, amount, healer = null) {
        if (!this.hitpointsGained[unit.hrid]) {
            this.hitpointsGained[unit.hrid] = {};
        }
        if (!this.hitpointsGained[unit.hrid][source]) {
            this.hitpointsGained[unit.hrid][source] = 0;
        }

        this.hitpointsGained[unit.hrid][source] += amount;

        if (amount > 0) {
            let healerUnit = healer || unit;
            this.logEvent({
                kind: "heal",
                unit: unit.hrid,
                isPlayer: !!unit.isPlayer,
                healer: healerUnit.hrid,
                healerIsPlayer: !!healerUnit.isPlayer,
                healSource: source,
                amount: amount,
                targetHpAfter: unit.combatDetails.currentHitpoints,
                targetMaxHp: unit.combatDetails.maxHitpoints,
            });
        }
    }

    addManapointsGained(unit, source, amount) {
        if (!this.manapointsGained[unit.hrid]) {
            this.manapointsGained[unit.hrid] = {};
        }
        if (!this.manapointsGained[unit.hrid][source]) {
            this.manapointsGained[unit.hrid][source] = 0;
        }

        this.manapointsGained[unit.hrid][source] += amount;

        if (amount > 0) {
            this.logEvent({
                kind: "manaGain",
                unit: unit.hrid,
                isPlayer: !!unit.isPlayer,
                manaSource: source,
                amount: amount,
                targetMpAfter: unit.combatDetails.currentManapoints,
                targetMaxMp: unit.combatDetails.maxManapoints,
            });
        }
    }

    setDropRateMultipliers(unit) {
        if (!this.dropRateMultiplier[unit.hrid]) {
            this.dropRateMultiplier[unit.hrid] = {};
        }
        this.dropRateMultiplier[unit.hrid] = 1 + unit.combatDetails.combatStats.combatDropRate;

        if (!this.rareFindMultiplier[unit.hrid]) {
            this.rareFindMultiplier[unit.hrid] = {};
        }
        this.rareFindMultiplier[unit.hrid] = 1 + unit.combatDetails.combatStats.combatRareFind;

        if (!this.combatDropQuantity[unit.hrid]) {
            this.combatDropQuantity[unit.hrid] = {};
        }
        this.combatDropQuantity[unit.hrid] = unit.combatDetails.combatStats.combatDropQuantity;

        if (!this.debuffOnLevelGap[unit.hrid]) {
            this.debuffOnLevelGap[unit.hrid] = {};
        }
        this.debuffOnLevelGap[unit.hrid] = unit.debuffOnLevelGap;
    }

    setManaUsed(unit) {
        this.manaUsed[unit.hrid] = {};
        for (let [key, value] of unit.abilityManaCosts.entries()) {
            this.manaUsed[unit.hrid][key] = value;
        }
    }

    addHitpointsSpent(unit, source, amount) {
        if (!this.hitpointsSpent[unit.hrid]) {
            this.hitpointsSpent[unit.hrid] = {};
        }
        if (!this.hitpointsSpent[unit.hrid][source]) {
            this.hitpointsSpent[unit.hrid][source] = 0;
        }

        this.hitpointsSpent[unit.hrid][source] += amount;
    }

    addRanOutOfManaCount(unit, isOutOfMana, time) {
        if (isOutOfMana) {
            this.playerRanOutOfMana[unit.hrid] = true;
            // Each blocked cast attempt increments the OOM cast counter.
            this.playerOomCastCount[unit.hrid] = (this.playerOomCastCount[unit.hrid] || 0) + 1;
        }

        if (!this.playerRanOutOfManaTime[unit.hrid]) {
            this.playerRanOutOfManaTime[unit.hrid] = {isOutOfMana: false, startTimeForOutOfMana:0, totalTimeForOutOfMana:0};
        }

        if (isOutOfMana) {
            if (!this.playerRanOutOfManaTime[unit.hrid].isOutOfMana) {
                this.playerRanOutOfManaTime[unit.hrid].isOutOfMana = true;
                this.playerRanOutOfManaTime[unit.hrid].startTimeForOutOfMana = time;
            }
        } else {
            if (this.playerRanOutOfManaTime[unit.hrid].isOutOfMana) {
                this.playerRanOutOfManaTime[unit.hrid].isOutOfMana = false;
                this.playerRanOutOfManaTime[unit.hrid].totalTimeForOutOfMana += time - this.playerRanOutOfManaTime[unit.hrid].startTimeForOutOfMana;
            }
        }
    }

    // 添加时间序列数据点
    addTimeSeriesSnapshot(time, players) {
        this.timeSeriesData.timestamps.push(time);
        
        players.forEach(player => {
            if (!this.timeSeriesData.players[player.hrid]) {
                this.timeSeriesData.players[player.hrid] = {
                    hp: [],
                    mp: [],
                    maxHp: [],
                    maxMp: []
                };
            }
            
            const playerData = this.timeSeriesData.players[player.hrid];
            playerData.hp.push(player.combatDetails.currentHitpoints);
            playerData.mp.push(player.combatDetails.currentManapoints);
            playerData.maxHp.push(player.combatDetails.maxHitpoints);
            playerData.maxMp.push(player.combatDetails.maxManapoints);
        });
    }
}

export default SimResult;
