// Worker pool for the Optimization page. One condition = one party at one difficulty tier, and
// every condition is an independent simulation, so they are handed to a pool of simulation workers
// sized to the machine. Results stream back as each condition finishes rather than in one batch, so
// the table fills in while the sweep is still running.

const MAX_POOL_SIZE = 16;

onmessage = async function (event) {
    if (event.data.type !== "run_optimization") {
        return;
    }

    const conditions = event.data.conditions ?? [];
    const extra = event.data.extra ?? {};
    const simulationTimeLimit = event.data.simulationTimeLimit;

    const hardwareWorkers = Number(navigator.hardwareConcurrency) || 4;
    const poolSize = Math.max(1, Math.min(hardwareWorkers, MAX_POOL_SIZE, conditions.length));

    const queue = [...conditions];
    const outerWorker = this;
    let completed = 0;
    let cancelled = false;
    const activeWorkers = new Set();

    // A stop request has to reach the simulation workers themselves: a queued condition is simply
    // never started, but one already running only ends when its worker is terminated.
    const abort = () => {
        cancelled = true;
        queue.length = 0;
        for (const worker of activeWorkers) {
            worker.terminate();
        }
        activeWorkers.clear();
    };
    this.addEventListener("message", (e) => {
        if (e.data?.type === "cancel_optimization") {
            abort();
        }
    });

    const runCondition = async (condition) => {
        const simulationWorker = new Worker(new URL("worker.js", import.meta.url));
        activeWorkers.add(simulationWorker);
        try {
            return await new Promise((resolve, reject) => {
                simulationWorker.onmessage = (e) => {
                    if (e.data.type === "simulation_result") {
                        resolve(e.data.simResult);
                    } else if (e.data.type === "simulation_error") {
                        reject(e.data.error);
                    }
                };
                simulationWorker.onerror = (e) => reject(e.message || "worker error");
                simulationWorker.postMessage({
                    type: "start_simulation",
                    players: condition.players,
                    zone: { zoneHrid: condition.zoneHrid, difficultyTier: condition.difficultyTier },
                    extra,
                    simulationTimeLimit,
                });
            });
        } finally {
            activeWorkers.delete(simulationWorker);
            simulationWorker.terminate();
        }
    };

    const drainQueue = async () => {
        while (queue.length > 0 && !cancelled) {
            const condition = queue.shift();
            try {
                const simResult = await runCondition(condition);
                if (cancelled) {
                    return;
                }
                completed++;
                outerWorker.postMessage({
                    type: "optimization_condition_result",
                    conditionId: condition.id,
                    simResult,
                    completed,
                    total: conditions.length,
                });
            } catch (e) {
                if (cancelled) {
                    return;
                }
                completed++;
                outerWorker.postMessage({
                    type: "optimization_condition_error",
                    conditionId: condition.id,
                    error: e && e.message ? e.message : String(e),
                    completed,
                    total: conditions.length,
                });
            }
        }
    };

    try {
        await Promise.all(Array.from({ length: poolSize }, drainQueue));
        this.postMessage({
            type: cancelled ? "optimization_cancelled" : "optimization_done",
            completed,
            total: conditions.length,
        });
    } catch (e) {
        this.postMessage({ type: "optimization_error", error: e && e.message ? e.message : String(e) });
    }
};
