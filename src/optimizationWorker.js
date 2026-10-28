// Worker pool for the Optimization page. One condition = one party at one difficulty tier, and
// every condition is an independent simulation, so they are handed to a pool of simulation workers
// sized to the machine. Results stream back as each condition finishes rather than in one batch, so
// the table fills in while the sweep is still running.
//
// With `keepOpen`, the queue stays open after it drains: the page can push more conditions with
// `add_conditions` (`priority` puts them at the front) and ends the run with `close_queue`. A
// condition may carry its own `simulationTimeLimit`, which wins over the run's.

const MAX_POOL_SIZE = 16;

onmessage = async function (event) {
    if (event.data.type !== "run_optimization") {
        return;
    }

    const conditions = event.data.conditions ?? [];
    const extra = event.data.extra ?? {};
    const simulationTimeLimit = event.data.simulationTimeLimit;

    const hardwareWorkers = Number(navigator.hardwareConcurrency) || 4;
    // The most this browser can usefully run at once. A caller may ask for fewer (poolSize); it can
    // not ask for more.
    const maxPool = Math.min(hardwareWorkers, MAX_POOL_SIZE);
    const requested = Math.floor(Number(event.data.poolSize));
    const limit = requested > 0 ? Math.min(requested, maxPool) : maxPool;
    const keepOpen = !!event.data.keepOpen;
    // An open queue may grow, so it gets the whole pool rather than one worker per starting condition.
    const poolSize = Math.max(1, keepOpen ? limit : Math.min(limit, conditions.length));

    const queue = [...conditions];
    const outerWorker = this;
    let completed = 0;
    let total = conditions.length;
    let cancelled = false;
    let closed = !keepOpen;
    const activeWorkers = new Set();
    // Idle drain loops parked on an empty open queue; woken when work is added or the queue closes.
    let waiters = [];
    const wakeAll = () => {
        const woken = waiters;
        waiters = [];
        for (const wake of woken) wake();
    };

    // A stop request has to reach the simulation workers themselves: a queued condition is simply
    // never started, but one already running only ends when its worker is terminated.
    const abort = () => {
        cancelled = true;
        queue.length = 0;
        for (const worker of activeWorkers) {
            worker.terminate();
        }
        activeWorkers.clear();
        wakeAll();
    };
    this.addEventListener("message", (e) => {
        if (e.data?.type === "cancel_optimization") {
            abort();
        } else if (e.data?.type === "add_conditions" && !closed && !cancelled) {
            const added = e.data.conditions ?? [];
            total += added.length;
            if (e.data.priority) queue.unshift(...added); else queue.push(...added);
            wakeAll();
        } else if (e.data?.type === "close_queue") {
            closed = true;
            wakeAll();
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
                    simulationTimeLimit: condition.simulationTimeLimit ?? simulationTimeLimit,
                });
            });
        } finally {
            activeWorkers.delete(simulationWorker);
            simulationWorker.terminate();
        }
    };

    const drainQueue = async () => {
        while (!cancelled) {
            if (queue.length === 0) {
                if (closed) return;
                await new Promise((resolve) => waiters.push(resolve));
                continue;
            }
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
                    total,
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
                    total,
                });
            }
        }
    };

    try {
        await Promise.all(Array.from({ length: poolSize }, drainQueue));
        this.postMessage({
            type: cancelled ? "optimization_cancelled" : "optimization_done",
            completed,
            total,
        });
    } catch (e) {
        this.postMessage({ type: "optimization_error", error: e && e.message ? e.message : String(e) });
    }
};
