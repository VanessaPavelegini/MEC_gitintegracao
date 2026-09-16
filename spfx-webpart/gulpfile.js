'use strict';

const build = require('@microsoft/sp-build-web');

build.addSuppression(/Warning/gi);

// Workaround for SPFx 1.18 + Node 18:
//   1) `.module.scss` imports from node_modules/@microsoft/sp-* (uncompiled SCSS) fail to
//      resolve because the generated webpack config does not include `.scss` in
//      `resolve.extensions`. We add it and route through @microsoft/sp-css-loader.
//   2) `terser-webpack-plugin@1.x` (used by webpack 4 production mode) crashes on Node 18
//      with `Cannot set properties of undefined (setting 'asyncChunks')`. We force
//      `optimization.minimize = false` so the package still produces a working bundle.
build.configureWebpack.setConfig({
  additionalConfiguration: (config) => {
    config.resolve = config.resolve || {};
    config.resolve.extensions = (config.resolve.extensions || []).concat(['.scss']);
    config.module = config.module || { rules: [] };
    config.module.rules = (config.module.rules || []).concat([
      {
        test: /\.module\.scss$/,
        use: [
          {
            loader: require.resolve('@microsoft/sp-css-loader'),
            options: {
              async: true,
              generateCssClassName: (name, filename) => {
                const crypto = require('crypto');
                const hash = crypto.createHash('md5').update(`${filename}--${name}`).digest('hex').slice(0, 8);
                return `ms-${hash}`;
              }
            }
          }
        ]
      }
    ]);
    config.optimization = config.optimization || {};
    config.optimization.minimize = false;
    return config;
  }
});

build.initialize(require('gulp'));
