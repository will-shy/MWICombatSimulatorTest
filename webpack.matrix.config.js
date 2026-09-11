// Node build for the Boss Matrix batch driver (src/skillLabMatrix.js).
//
// The Skill Lab core discovers its gear presets with require.context, so it needs a
// bundler even to run headlessly. This config produces a single CommonJS file that
// `node` can execute, letting the whole 8-build x 5-boss matrix run unattended off
// exactly the same code the skill-lab page uses.
const path = require("path");

module.exports = {
    entry: { skillLabMatrix: "./src/skillLabMatrix.js" },
    target: "node",
    mode: "production",
    devtool: false,
    optimization: { minimize: false },
    output: {
        path: path.resolve(__dirname, "dist-node"),
        filename: "[name].cjs",
        clean: true,
    },
};
