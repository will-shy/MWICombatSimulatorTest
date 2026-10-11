const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: {
    bundle: './src/main.js',
    groupBattle: './src/groupBattle.js',
    skillLab: './src/skillLab.js',
    optimization: './src/optimization.js',
    triggerOptimization: './src/triggerOptimization.js',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
  },
  mode: 'development',
  devtool: 'source-map',
  devServer: {
    static: {
      directory: path.join(__dirname, 'dist'),
    },
    compress: true,
    port: 9000,
    open: true,
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        { from: path.resolve(__dirname, 'patchNote.json'), to: 'patchNote.json' },
        { from: path.resolve(__dirname, 'index.html'), to: 'index.html' }, // Correctly copy to dist/index.html
        { from: path.resolve(__dirname, 'js'), to: 'js' },
        { from: path.resolve(__dirname, 'locales'), to: 'locales' },
        { from: path.resolve(__dirname, 'group-battle.html'), to: 'group-battle.html' },
        { from: path.resolve(__dirname, 'skill-lab.html'), to: 'skill-lab.html' },
        { from: path.resolve(__dirname, 'optimization.html'), to: 'optimization.html' },
        { from: path.resolve(__dirname, 'trigger-optimization.html'), to: 'trigger-optimization.html' },
        { from: path.resolve(__dirname, 'pages'), to: 'pages' },
        // Item icon sprite (symbol id = item hrid without "/items/"), used with <use href="items_sprite.svg#id">.
        { from: path.resolve(__dirname, 'assets/items_sprite.svg'), to: 'items_sprite.svg' },
      ],
    }),
  ],
};
