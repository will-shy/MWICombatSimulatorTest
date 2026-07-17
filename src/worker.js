import CombatSimulator from "./combatsimulator/combatSimulator";
import Player from "./combatsimulator/player";
import Zone from "./combatsimulator/zone";
import Labyrinth from "./combatsimulator/labyrinth";
import Monster from "./combatsimulator/monster";
import GroupBattleMonster from "./combatsimulator/groupBattleMonster";
import GROUP_BATTLE_REGEN_BUFFS from "./combatsimulator/data/groupBattleBuffs";


class SimulationManager {
    constructor() {
        this.simulations = [];
        this.simResults;
    }

    addSimulation(sim) {
        this.simulations.push(sim);
    }

    async startSimulations(simulationTimeLimit) {
        const simulationPromises = this.simulations.map(simulation => simulation.simulate(simulationTimeLimit));
        const results = await Promise.all(simulationPromises);
        return results;
    }
}

onmessage = async function (event) {
    switch (event.data.type) {
        case "start_simulation":
            let extraBuffs = [];
            if (event.data.extra.mooPass) {
                const mooPassBuff = {
                    "uniqueHrid": "/buff_uniques/experience_moo_pass_buff",
                    "typeHrid": "/buff_types/wisdom",
                    "ratioBoost": 0,
                    "ratioBoostLevelBonus": 0,
                    "flatBoost": 0.05,
                    "flatBoostLevelBonus": 0,
                    "startTime": "0001-01-01T00:00:00Z",
                    "duration": 0
                };
                extraBuffs.push(mooPassBuff);
            }
            if (event.data.extra.comExp > 0) {
                const comExpBuff = {
                    "uniqueHrid": "/buff_uniques/experience_community_buff",
                    "typeHrid": "/buff_types/wisdom",
                    "ratioBoost": 0,
                    "ratioBoostLevelBonus": 0,
                    "flatBoost": 0.005 * (event.data.extra.comExp - 1) + 0.2,
                    "flatBoostLevelBonus": 0,
                    "startTime": "0001-01-01T00:00:00Z",
                    "duration": 0
                };
                extraBuffs.push(comExpBuff);
            }
            if (event.data.extra.comDrop > 0) {
                const comDropBuff = {
                    "uniqueHrid": "/buff_uniques/combat_community_buff",
                    "typeHrid": "/buff_types/combat_drop_quantity",
                    "ratioBoost": 0,
                    "ratioBoostLevelBonus": 0,
                    "flatBoost": 0.005 * (event.data.extra.comDrop - 1) + 0.2,
                    "flatBoostLevelBonus": 0,
                    "startTime": "0001-01-01T00:00:00Z",
                    "duration": 0
                };
                extraBuffs.push(comDropBuff);
            }
            if (event.data.extra.personalBuffs) {
                const personalBuffs = {
                    "/items/seal_of_attack_speed": {
                        "uniqueHrid": "/buff_uniques/personal_attack_speed",
                        "typeHrid": "/buff_types/attack_speed",
                        "ratioBoost": 0.15,
                        "ratioBoostLevelBonus": 0,
                        "flatBoost": 0,
                        "flatBoostLevelBonus": 0,
                        "startTime": "0001-01-01T00:00:00Z",
                        "duration": 0
                    },
                    "/items/seal_of_cast_speed": {
                        "uniqueHrid": "/buff_uniques/personal_cast_speed",
                        "typeHrid": "/buff_types/cast_speed",
                        "ratioBoost": 0,
                        "ratioBoostLevelBonus": 0,
                        "flatBoost": 0.15,
                        "flatBoostLevelBonus": 0,
                        "startTime": "0001-01-01T00:00:00Z",
                        "duration": 0
                    },
                    "/items/seal_of_combat_drop": {
                        "uniqueHrid": "/buff_uniques/personal_combat_drop",
                        "typeHrid": "/buff_types/combat_drop_quantity",
                        "ratioBoost": 0,
                        "ratioBoostLevelBonus": 0,
                        "flatBoost": 0.15,
                        "flatBoostLevelBonus": 0,
                        "startTime": "0001-01-01T00:00:00Z",
                        "duration": 0
                    },
                    "/items/seal_of_critical_rate": {
                        "uniqueHrid": "/buff_uniques/personal_critical_rate",
                        "typeHrid": "/buff_types/critical_rate",
                        "ratioBoost": 0,
                        "ratioBoostLevelBonus": 0,
                        "flatBoost": 0.1,
                        "flatBoostLevelBonus": 0,
                        "startTime": "0001-01-01T00:00:00Z",
                        "duration": 0
                    },
                    "/items/seal_of_damage": {
                        "uniqueHrid": "/buff_uniques/personal_damage",
                        "typeHrid": "/buff_types/damage",
                        "ratioBoost": 0.08,
                        "ratioBoostLevelBonus": 0,
                        "flatBoost": 0,
                        "flatBoostLevelBonus": 0,
                        "startTime": "0001-01-01T00:00:00Z",
                        "duration": 0
                    },
                    "/items/seal_of_rare_find": {
                        "uniqueHrid": "/buff_uniques/personal_rare_find",
                        "typeHrid": "/buff_types/rare_find",
                        "ratioBoost": 0,
                        "ratioBoostLevelBonus": 0,
                        "flatBoost": 0.6,
                        "flatBoostLevelBonus": 0,
                        "startTime": "0001-01-01T00:00:00Z",
                        "duration": 0
                    },
                    "/items/seal_of_wisdom": {
                        "uniqueHrid": "/buff_uniques/personal_wisdom",
                        "typeHrid": "/buff_types/wisdom",
                        "ratioBoost": 0,
                        "ratioBoostLevelBonus": 0,
                        "flatBoost": 0.2,
                        "flatBoostLevelBonus": 0,
                        "startTime": "0001-01-01T00:00:00Z",
                        "duration": 0
                    }
                };
                for (let buff of event.data.extra.personalBuffs) {
                    if (personalBuffs[buff]) {
                        extraBuffs.push(personalBuffs[buff]);
                    }
                }
            }

            let playersData = event.data.players;
            let players = [];
            let zone = null;
            if (event.data.zone) {
                zone = new Zone(event.data.zone.zoneHrid, event.data.zone.difficultyTier);
            }
            let labyrinth = null;
            if (event.data.labyrinth) {
                labyrinth = new Labyrinth(event.data.labyrinth.labyrinthHrid, event.data.labyrinth.roomLevel, event.data.labyrinth.crates);
            }
            for (let i = 0; i < playersData.length; i++) {
                let currentPlayer = Player.createFromDTO(structuredClone(playersData[i]));
                currentPlayer.zoneBuffs = zone?.buffs || labyrinth?.buffs || [];
                currentPlayer.extraBuffs = extraBuffs;
                players.push(currentPlayer);
            }
            let simulationTimeLimit = event.data.simulationTimeLimit;
            let enableHpMpVisualization = event.data.extra.enableHpMpVisualization || false;
            let combatSimulator = new CombatSimulator(players, zone, labyrinth, { enableHpMpVisualization });
            combatSimulator.addEventListener("progress", (event) => {
                this.postMessage({ 
                    type: "simulation_progress", 
                    progress: event.detail.progress, 
                    zone: event.detail.zone, 
                    difficultyTier: event.detail.difficultyTier,
                    labyrinth: event.detail.labyrinth,
                    roomLevel: event.detail.roomLevel,
                    timeSeriesData: event.detail.timeSeriesData
                });
            });

            try {
                let simResult = await combatSimulator.simulate(simulationTimeLimit);
                this.postMessage({ type: "simulation_result", simResult: simResult });
            } catch (e) {
                console.log(e);
                this.postMessage({ type: "simulation_error", error: e });
            }
            break;
        case "start_battle": {
            // Single fixed encounter fought to completion, with a detailed combat log.
            // A real zone is still needed for zone buffs; default to a harmless combat zone.
            const battleZoneHrid = event.data.zoneHrid || "/actions/combat/fly";
            let battleZone = new Zone(battleZoneHrid);

            let battlePlayers = [];
            let battlePlayersData = event.data.players;
            for (let i = 0; i < battlePlayersData.length; i++) {
                let currentPlayer = Player.createFromDTO(structuredClone(battlePlayersData[i]));
                currentPlayer.zoneBuffs = battleZone.buffs;
                currentPlayer.extraBuffs = GROUP_BATTLE_REGEN_BUFFS;
                battlePlayers.push(currentPlayer);
            }

            // Monster HP scales +1% per player in the group (see group-battle.html banner).
            const hpMultiplier = 1 + 0.01 * battlePlayers.length;

            let fixedEnemies = event.data.enemies.map((enemy) => {
                if (enemy.trial) {
                    // Trial enemy: real game monster, scaled by roomLevel = its trial
                    // level (100..300). uniqueHrid keeps duplicates (e.g. 2x Trial
                    // Badger) as separate rows in the per-enemy result breakdown.
                    return new GroupBattleMonster(enemy.hrid, enemy.level || 100, {
                        hpMultiplier,
                        uniqueHrid: enemy.uniqueHrid,
                        displayName: enemy.name,
                    });
                }
                return new Monster(enemy.hrid, enemy.eliteTier || 0);
            });

            let timeCapNs = (event.data.timeCapSeconds || 3600) * 1e9;

            let battleSimulator = new CombatSimulator(battlePlayers, battleZone, null, {
                logEvents: true,
                fixedEnemies: fixedEnemies,
            });

            try {
                let battleResult = await battleSimulator.simulateBattle(timeCapNs);
                this.postMessage({ type: "battle_result", simResult: battleResult });
            } catch (e) {
                console.log(e);
                this.postMessage({ type: "simulation_error", error: e.toString() });
            }
            break;
        }
        case "start_simulation_all_zones": {
            const simManager = new SimulationManager();
            const zoneHrids = event.data.zones;
            for (let i = 0; i < zoneHrids.length; i++) {
                const zoneInstance = new Zone(zoneHrids[i]);
                if (zoneInstance.monsterSpawnInfo.randomSpawnInfo.spawns) {
                    let players = [];
                    let playersData = event.data.players;
                    for (let i = 0; i < playersData.length; i++) {
                        let currentPlayer = Player.createFromDTO(structuredClone(playersData[i]));
                        currentPlayer.zoneBuffs = zoneInstance.buffs;
                        currentPlayer.extraBuffs = [];
                        players.push(currentPlayer);
                    }
                    let simulation = new CombatSimulator(players, zoneInstance, null);
                    if (i == 0) {
                        simulation.addEventListener("progress", (event) => {
                            this.postMessage({ type: "simulation_progress", progress: event.detail });
                        });
                    }
                    simManager.addSimulation(simulation);
                }
            }
            try {
                const simResults = await simManager.startSimulations(event.data.simulationTimeLimit);
                this.postMessage({ type: "simulation_result_allZones", simResults: simResults });
            } catch (e) {
                console.log(e);
                this.postMessage({ type: "simulation_error", error: e });
            }
            break;
        }
    }
};
