# MWICombatSimulator

### How to run locally for development purposes

Install dependencies: 

```bash
npm install
```

Build webpack bundle:

```bash
npm run build
```

Run locally:

```bash
npm start
```

### Combat kernel

Simulations run on a WebAssembly build of the combat kernel (`src/wasm/`, loaded by `src/worker.js`). It
reproduces the JS kernel in `src/combatsimulator/` bit for bit. `src/wasm/README.md` explains how it is
built and checked, and what to do after a change to the combat logic.
