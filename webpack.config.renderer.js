const path = require('path');
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const HtmlWebpackPlugin = require('html-webpack-plugin');
const webpack = require('webpack');

const mode = process.env.NODE_ENV || "development";
const staticPath =
  "'static'";

module.exports = {
  mode,
  target: 'web',
  devtool: 'cheap-module-source-map',
  entry: './src/Renderer/Renderer.js',
  output: {
    globalObject: 'this',
    filename: 'renderer-index.js',
    path: path.resolve(__dirname, 'build'),
    publicPath: './'
  },
  optimization: {
    minimize: false,
  },
  module: {
      rules: [
          {
              test: /\.js$/,
              include: path.resolve(__dirname, 'src/Renderer'),
              enforce: "pre",
              use: ["source-map-loader"],
          },
      {
        test: /\.(js|json|ts|tsx)$/,
        exclude: /(node_modules|bower_components)/,
        use: {
          loader: 'babel-loader'
        }
      },
      {
        test: /\.(sa|sc|c)ss$/,
        use: [
          MiniCssExtractPlugin.loader,
          { loader: "css-loader", options: { sourceMap: true } },
        ],
      },

      {
        test: /\.(png|jpe?g|gif|svg|eot|ttf|woff|woff2)$/,
        use: ['file-loader'],
      }
    ]
  },
  plugins: [
    new webpack.DefinePlugin({ '__static': staticPath }),
    new webpack.ProvidePlugin({
      process: path.resolve(__dirname, 'src/browser-shims/process.js'),
    }),
    new MiniCssExtractPlugin({
        filename: 'css/index.css'
    }),
    new HtmlWebpackPlugin({
      template: 'public/index.html',
    }),
  ],
  resolve: {
    alias: {
      '@electron/remote': path.resolve(__dirname, 'src/browser-shims/electron-remote.js'),
      child_process: path.resolve(__dirname, 'src/browser-shims/child-process.js'),
      electron: path.resolve(__dirname, 'src/browser-shims/electron.js'),
      fs: path.resolve(__dirname, 'src/browser-shims/fs.js'),
      path: path.resolve(__dirname, 'src/browser-shims/path.js'),
    },
    extensions: ['.ts', '.tsx', '.js'],
    fallback: {
      os: false,
      util: false,
    },
  }
};
