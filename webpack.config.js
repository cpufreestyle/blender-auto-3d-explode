import path from "node:path";
import HtmlWebpackPlugin from "html-webpack-plugin";
import TerserPlugin from "terser-webpack-plugin";
import CssMinimizerPlugin from "css-minimizer-webpack-plugin";
import CompressionPlugin from "compression-webpack-plugin";
import CopyPlugin from "copy-webpack-plugin";
import { BundleAnalyzerPlugin } from "webpack-bundle-analyzer";

// 剥离 index.html 中的源码开发脚本标签（dist 中由 HtmlWebpackPlugin 注入带 hash 的产物）
const stripDevScriptPlugin = {
  apply(compiler) {
    compiler.hooks.compilation.tap("StripDevScript", compilation => {
      HtmlWebpackPlugin.getHooks(compilation).beforeEmit.tap("StripDevScript", data => {
        data.html = data.html.replace(/<script[^>]*src="[^"]*main\.js[^"]*"[^>]*><\/script>/g, "");
        return data;
      });
    });
  }
};

export default (env = {}, argv) => {
  const isProduction = argv.mode === "production";
  const isAnalyze = Boolean(env.ANALYZE);

  return {
    entry: {
      main: "./main.js"
    },
    output: {
      path: path.resolve(import.meta.dirname, "dist"),
      filename: isProduction ? "[name].[contenthash].js" : "[name].js",
      clean: true,
      publicPath: "/"
    },
    resolve: {
      extensions: [".js", ".mjs"]
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: "./index.html",
        minify: isProduction ? {
          removeComments: true,
          collapseWhitespace: true,
          removeRedundantAttributes: true,
          useShortDoctype: true,
          removeEmptyAttributes: true,
          removeStyleLinkTypeAttributes: true,
          keepClosingSlash: true,
          minifyJS: true,
          minifyCSS: true,
          minifyURLs: true
        } : false
      }),
      stripDevScriptPlugin,
      // index.html 直接引用的静态资源（CSS 为 <link> 引用，不经 webpack 模块图）
      new CopyPlugin({
        patterns: [
          { from: "style.css", to: "style.css" },
          { from: "ai-config.html", to: "ai-config.html" }
        ]
      }),
      ...(isProduction ? [new CompressionPlugin()] : []),
      ...(isAnalyze
        ? [new BundleAnalyzerPlugin({
            analyzerMode: "static",
            openAnalyzer: false,
            reportFilename: "report.html"
          })]
        : [])
    ],
    optimization: {
      minimize: isProduction,
      minimizer: [
        new TerserPlugin({
          terserOptions: {
            format: {
              comments: false
            }
          },
          extractComments: false
        }),
        new CssMinimizerPlugin()
      ],
      splitChunks: {
        chunks: "all",
        cacheGroups: {
          three: {
            test: /[\\/]node_modules[\\/]three[\\/]/,
            name: "three",
            chunks: "all",
            priority: 10
          }
        }
      }
    },
    devtool: isProduction ? "nosources-source-map" : "eval-source-map",
    devServer: {
      port: 3000,
      open: true,
      hot: true,
      historyApiFallback: true,
      compress: true
    },
    performance: {
      maxAssetSize: 1024 * 1024,
      maxEntrypointSize: 1024 * 1024,
      hints: isProduction ? "warning" : false
    }
  };
};
