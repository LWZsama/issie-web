const path = require("path");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const webpack = require("webpack");

const rootDir = path.resolve(__dirname, "..");
const generatedDir = path.join(rootDir, ".web-generated", "renderer");
const mode = process.env.NODE_ENV || "development";

module.exports = {
  mode,
  target: "web",
  devtool: "cheap-module-source-map",
  entry: [
    path.join(rootDir, "src", "browser-shims", "issie-bridge.js"),
    path.join(rootDir, "src", "browser-shims", "wasm-sidecar.js"),
    path.join(generatedDir, "Renderer.js"),
  ],
  output: {
    globalObject: "this",
    filename: "renderer-index.js",
    path: path.join(__dirname, "build"),
    publicPath: "./",
  },
  optimization: {
    minimize: false,
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        include: generatedDir,
        enforce: "pre",
        use: ["source-map-loader"],
      },
      {
        test: /\.(js|json|ts|tsx)$/,
        exclude: /(node_modules|bower_components)/,
        use: {
          loader: "babel-loader",
        },
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
        use: ["file-loader"],
      },
    ],
  },
  plugins: [
    new webpack.DefinePlugin({ __static: "'static'" }),
    new webpack.ProvidePlugin({
      process: path.join(rootDir, "src", "browser-shims", "process.js"),
    }),
    new webpack.NormalModuleReplacementPlugin(
      /[\\/]UartFiles[\\/]IS-uart\.js$/,
      path.join(rootDir, "src", "Renderer", "UartFiles", "IS-uart-browser.js"),
    ),
    new webpack.NormalModuleReplacementPlugin(
      /[\\/]src[\\/]Renderer[\\/]scss[\\/]main\.css$/,
      path.join(generatedDir, "scss", "main.css"),
    ),
    new MiniCssExtractPlugin({ filename: "css/index.css" }),
    new HtmlWebpackPlugin({ template: path.join(__dirname, "index.html") }),
  ],
  resolve: {
    alias: {
      "@electron/remote": path.join(rootDir, "src", "browser-shims", "electron-remote.js"),
      child_process: path.join(rootDir, "src", "browser-shims", "child-process.js"),
      electron: path.join(rootDir, "src", "browser-shims", "electron.js"),
      fs: path.join(rootDir, "src", "browser-shims", "fs.js"),
      path: path.join(rootDir, "src", "browser-shims", "path.js"),
    },
    extensions: [".ts", ".tsx", ".js"],
    modules: [path.join(__dirname, "node_modules"), "node_modules"],
    fallback: {
      os: false,
      util: false,
    },
  },
};
