'use strict';

const build = require('@microsoft/sp-build-web');
const gulp = require('gulp');

build.addSuppression(/Warning/gi);

gulp.task('serve', gulp.series('build', function (done) {
  build.serve(done);
}));

build.initialize(gulp);
