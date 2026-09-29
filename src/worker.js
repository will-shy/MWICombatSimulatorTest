// Simulation worker, backed by the wasm combat kernel (src/wasm/, see its README).
//
// Every page that simulates goes through this worker: the standard simulator (main.js and
// multiWorker.js), the group battle page (groupBattle.js) and the optimizer (optimizationWorker.js).
// The message protocol is unchanged:
//   start_simulation           → simulation_progress, simulation_result      (planets, dungeons, labyrinths)
//   start_simulation_all_zones → simulation_progress, simulation_result_allZones
//   start_battle               → battle_result                               (group battle)
//   any failure                → simulation_error
//
// The kernel reproduces src/combatsimulator/ exactly, with two by-design differences:
//   - Each job is seeded. Pass `seed` on the message to reproduce a run; otherwise a random seed is
//     drawn and returned on the result as `simResult.seed`.
//   - Progress is reported once, at the end: a job runs to completion inside the kernel (and is fast).
// The HP/MP time series (`extra.enableHpMpVisualization`, `simResult.timeSeriesData`) is not produced.

import init, { CombatKernel } from "./wasm/mwi_wasm.js";

import abilityDetailMap from "./combatsimulator/data/abilityDetailMap.json";
import itemDetailMap from "./combatsimulator/data/itemDetailMap.json";
import enhancementLevelTotalBonusMultiplierTable from "./combatsimulator/data/enhancementLevelTotalBonusMultiplierTable.json";
import combatMonsterDetailMap from "./combatsimulator/data/combatMonsterDetailMap.json";
import actionDetailMap from "./combatsimulator/data/actionDetailMap.json";
import houseRoomDetailMap from "./combatsimulator/data/houseRoomDetailMap.json";
import achievementDetailMap from "./combatsimulator/data/achievementDetailMap.json";
import achievementTierDetailMap from "./combatsimulator/data/achievementTierDetailMap.json";
import shrineDetailMap from "./combatsimulator/data/shrineDetailMap.json";
import labyrinthUpgradeDetailMap from "./combatsimulator/data/labyrinthUpgradeDetailMap.json";
import labyrinthCrateDetailMap from "./combatsimulator/data/labyrinthCrateDetailMap.json";
import combatTriggerDependencyDetailMap from "./combatsimulator/data/combatTriggerDependencyDetailMap.json";
import combatStyleDetailMap from "./combatsimulator/data/combatStyleDetailMap.json";

const kernelReady = init().then(
    () =>
        new CombatKernel(
            JSON.stringify({
                abilityDetailMap,
                itemDetailMap,
                enhancementLevelTotalBonusMultiplierTable,
                combatMonsterDetailMap,
                actionDetailMap,
                houseRoomDetailMap,
                achievementDetailMap,
                achievementTierDetailMap,
                shrineDetailMap,
                labyrinthUpgradeDetailMap,
                labyrinthCrateDetailMap,
                combatTriggerDependencyDetailMap,
                combatStyleDetailMap,
            }),
        ),
);

function randomSeed() {
    return crypto.getRandomValues(new Uint32Array(1))[0] || 1;
}

function simulate(kernel, job) {
    const seed = job.seed ?? randomSeed();
    const simResult = JSON.parse(kernel.simulate(JSON.stringify({ ...job, seed })));
    simResult.seed = seed;
    return simResult;
}

function errorMessage(e) {
    return String(e?.message ?? e);
}

onmessage = async function (event) {
    const data = event.data;
    let kernel;
    try {
        kernel = await kernelReady;
    } catch (e) {
        this.postMessage({ type: "simulation_error", error: "Could not start the combat kernel: " + errorMessage(e) });
        return;
    }

    try {
        switch (data.type) {
            case "start_simulation": {
                const simResult = simulate(kernel, data);
                this.postMessage({
                    type: "simulation_progress",
                    progress: 1,
                    zone: data.zone?.zoneHrid,
                    difficultyTier: data.zone?.difficultyTier,
                    labyrinth: data.labyrinth?.labyrinthHrid,
                    roomLevel: data.labyrinth?.roomLevel,
                    timeSeriesData: null,
                });
                this.postMessage({ type: "simulation_result", simResult });
                break;
            }
            case "start_simulation_all_zones": {
                // One ordinary start_simulation per zone, in order (the same jobs multiWorker.js
                // fans out). Zones may be { zoneHrid, difficultyTier } objects or bare hrids.
                const zones = data.zones || [];
                const simResults = [];
                for (let i = 0; i < zones.length; i++) {
                    const zone = typeof zones[i] === "string" ? { zoneHrid: zones[i], difficultyTier: 0 } : zones[i];
                    simResults.push(
                        simulate(kernel, {
                            players: data.players,
                            zone,
                            labyrinth: null,
                            simulationTimeLimit: data.simulationTimeLimit,
                            extra: data.extra,
                            seed: data.seed == null ? undefined : (data.seed + i) >>> 0,
                        }),
                    );
                    this.postMessage({ type: "simulation_progress", progress: (i + 1) / zones.length });
                }
                this.postMessage({ type: "simulation_result_allZones", simResults });
                break;
            }
            case "start_battle": {
                const seed = data.seed ?? randomSeed();
                const simResult = JSON.parse(kernel.battle(JSON.stringify({ ...data, seed })));
                simResult.seed = seed;
                this.postMessage({ type: "battle_result", simResult });
                break;
            }
            default:
                this.postMessage({ type: "simulation_error", error: `Unsupported worker message: ${data.type}` });
        }
    } catch (e) {
        this.postMessage({ type: "simulation_error", error: errorMessage(e) });
    }
};
