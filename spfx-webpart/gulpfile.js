'use strict';

const build = require('@microsoft/sp-build-web');

build.addSuppression(/Warning/gi);
build.initialize(require('gulp'));
