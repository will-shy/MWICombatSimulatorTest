const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: {
    bundle: './src/main.js',
    groupBattle: './src/groupBattle.js',
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
      ],
    }),
  ],
};
