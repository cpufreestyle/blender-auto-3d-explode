const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');
const CompressionPlugin = require('compression-webpack-plugin');
const BundleAnalyzerPlugin = require('webpack-bundle-analyzer').BundleAnalyzerPlugin;

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';
  const isDevelopment = !isProduction;

  return {
    entry: {
      main: './main.js',
      quest3: './src/quest3-data.js',
      steps: './src/quest3-steps.js'
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: isProduction ? '[name].[contenthash].js' : '[name].js',
      clean: true,
      publicPath: '/'
    },
    resolve: {
      extensions: ['.js', '.mjs'],
      alias: {
        three: path.resolve(__dirname, 'vendor/three.module.js'),
        vendor: path.resolve(__dirname, 'vendor')
      }
    },
    module: {
      rules: [
        {
          test: /\.js$/,
          exclude: /node_modules/,
          use: {
            loader: 'babel-loader',
            options: {
              presets: ['@babel/preset-env']
            }
          }
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader']
        }
      ]
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: './index.html',
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
      ...(isProduction ? [new BundleAnalyzerPlugin()] : []),
      ...(isProduction ? [new CompressionPlugin()] : [])
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
        chunks: 'all',
        cacheGroups: {
          vendor: {
            test: /[\\/]node_modules[\\/]/,
            name: 'vendors',
            chunks: 'all'
          },
          three: {
            test: /[\\/]vendor[\\/]/,
            name: 'three',
            chunks: 'all'
          }
        }
      }
    },
    devtool: isProduction ? 'source-map' : 'eval-source-map',
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
      hints: isProduction ? 'warning' : false
    }
  };
};