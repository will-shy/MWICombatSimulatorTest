# Combat kernel (wasm)

`mwi_wasm.js` and `mwi_wasm_bg.wasm` are the combat kernel compiled from the Rust port in
[`willshy-combat-simulator`](../../../willshy-combat-simulator). `src/worker.js` runs every simulation
through them. Do not edit these files by hand.

Given the same game data, message and seed, the port reproduces `src/combatsimulator/` (the JS kernel)
bit for bit. The parity harness in the Rust repo checks that against this repo's own code. The game data
is not compiled in: `worker.js` passes `src/combatsimulator/data/*.json` at start-up, so a game-data
update needs no rebuild here.

To update after a kernel change, from the Rust repo:

```sh
./build-wasm.sh
cp pkg/web/mwi_wasm.js pkg/web/mwi_wasm_bg.wasm ../MWICombatSimulatorTest/src/wasm/
cd parity && node run.mjs && node run.mjs --engine wasm   # both must report all scenarios identical
```

Rebuild and re-run parity if the combat logic in `src/combatsimulator/` changes too: the wasm kernel
does not pick up JS edits. The parity harness uses `src/jsWorker.js` as its JS reference. That file is the
JS-kernel worker `worker.js` used to be; no page loads it.

`node parity/browser.mjs` in the Rust repo checks the built `dist/` in Chrome. It runs the worker against
the JS kernel, then completes a run on each of `index.html`, `group-battle.html` and `optimization.html`.
