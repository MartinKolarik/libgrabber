var vfs = require('vinyl-fs');
var path = require('path');
var jsonfile = require('jsonfile');
var concat = require('concat-stream');
var async = require('async');
var _ = require('lodash');
var semver = require('semver');
var gift = require('gift');
var remove = require('remove');

var config = require('./config');
var logger = require('./logger');
var util = require('./util');
var packageManagers = require('./packageManagers');

function check(metadataPath, callback) {
  metadata(metadataPath, function (err, metadata) {
    if (err) {
      logger.warn('Failed to read metadata', { metadataPath: metadataPath, error: err });
      return callback(err);
    }
    var localFs = _(metadata.localVersions).last();
    var localBranch = _(metadata.branchVersions).last();
    var local = localFs && localBranch ?
      semver.gt(localFs, localBranch)
        ? localFs
        : localBranch
      : localFs || localBranch;

    var remote = _(metadata.remoteVersions).last();

    var result;
    if (local === undefined || semver.gt(remote, local)) {
      result = {
        metadata: metadata,
        version: remote
      };
    } else {
      result = {
        metadata: metadata
      };
    }

    callback(null, result);
  });
}

function update(updateInfo, callback) {
  var metadata = updateInfo.metadata;
  var version = updateInfo.version;
  var projectPath = metadata.path;

  if (version) {
    logger.info('Updating %s to %s', metadata.name, version);

    var cleanVersion = semver.clean(version);
    var pm = packageManagers.get(metadata.packageManager);
    var packageId = metadata.packageManager == 'github' ? metadata.repo : metadata.name;

    var packagesTempPath = path.join(config.get('tmp'));

    var from = path.join(packagesTempPath, metadata.name, cleanVersion);
    var to = path.join(projectPath, cleanVersion);

    pm.install(packageId, version, from, function (err) {
      if (err) {
        logger.warn('Failed to download and install package', { name: metadata.name, version: version, error: err});

        callback(err);
        return;
      }

      util.copy(from, to, metadata.files, function (files) {
        logger.info('Copied %d files', files.length, {name: metadata.name, version: version, files: _.pluck(files, 'path')});

        if (files.length === 0) {
          logger.warn('Something might be wrong with update.json', { name: metadata.name, version: version });

          remove(to, _.noop);
          callback(null, _.extend(updateInfo, { updated: false }));
        } else {
          callback(null, _.extend(updateInfo, { updated: true, updatePath: to }));
        }

      });
    });
  } else {
    logger.debug('Skipping project %s update, already at latest version', metadata.name);

    callback(null, _.extend(updateInfo, { updated: false }));
  }
}

function metadata(metadataFile, callback) {
  jsonfile.readFile(metadataFile, function (err, metadata) {
    if (err) {
      logger.error('Error in reading metadata file %s', metadataFile, { error: err });
      callback(err);
      return;
    }

    var projectPath = path.dirname(metadataFile);
    _.extend(metadata, { path: projectPath });

    async.series({
      localVersions: async.apply(localVersions, metadata),
      remoteVersions: async.apply(remoteVersions, metadata),
      branchVersions: async.apply(branchVersions, metadata)
    }, function (err, versions) {
      if (err) {
        logger.error('Error in getting package versions', { error: err, metadata: metadata });

        callback(err);
        return;
      }

      logger.debug('Read metadata', { metadata: metadata, versions: versions });
      callback(null, _.extend(metadata, versions));
    });
  });
}

function localVersions(metadata, callback) {
  vfs.src(['*'], { cwd: metadata.path})
    .pipe(util.vinyl.dirs())
    .pipe(util.vinyl.semver())
    .pipe(concat({ encoding: 'object'}, function (versions) {
      versions = _(versions)
        .filter(semver.valid)
        .sort(semver.compare)
        .value();
      callback(null, versions);
    }));
}

function remoteVersions(metadata, callback) {
  var pmId = metadata.packageManager;
  var pm = packageManagers.get(pmId);
  var packageId = pmId === 'github' ? metadata.repo : metadata.name;

  pm.versions(packageId, function (err, versions) {
    if (err) {
      return callback(err);
    }

    versions = _(versions)
      .filter(semver.valid)
      .sort(semver.compare)
      .value();

    callback(null, versions);
  });
}

function branchVersions(metadata, callback) {
  var repo = gift(config.get('jsDelivrPath'));
  repo.git.cmd('ls-remote', {}, ['--heads', 'origin'], function (err, res) {
    if (err) {
      logger.error('Error in getting branches', { error: err, metadata: metadata });

      callback(err);
      return;
    }

    var regex = /refs\/heads\/([^\s]+)/;
    var lines = res.split('\n');
    var versions = _(lines)
      .map(function (line) {
        var match = regex.exec(line);

        return match ? match[1] : null;
      })
      .compact()
      .map(function (branch) {
        var nameVersion = branch.split('/');
        return nameVersion.length == 2 ? { name: nameVersion[0], version: nameVersion[1]} : null;
      })
      .compact()
      .filter(function (nameVersion) {
        return nameVersion.name === metadata.name
      })
      .pluck('version')
      .filter(semver.valid)
      .sort(semver.compare)
      .value();

    callback(null, versions);
  });
}

function commit(cdnGitPath, updateInfo, callback) {
  if (updateInfo.updated) {
    var commitDir = path.resolve(updateInfo.updatePath);
    var repo = gift(cdnGitPath);
    var branchName = updateInfo.metadata.name + '/' + updateInfo.version;

    async.series([
      async.apply(repo.checkout.bind(repo), 'master'),
      async.apply(repo.create_branch.bind(repo), branchName),
      async.apply(repo.checkout.bind(repo), branchName)
    ], function (err, res) {
      repo.add(path.resolve(commitDir), function (err) {
        if (err) {
          logger.error('Git add path %s to repo %s failed. ', cdnGitPath, commitDir);

          callback(err);
          return;
        }

        var options = {
          message: '"Update project ' + updateInfo.metadata.name + ' to ' + updateInfo.version + '"'
        };
        var args = ['--', commitDir];
        repo.git.cmd('commit', options, args, function (err) {
          if (err) {
            logger.error('Git commit of path %s failed ', commitDir, {
              name: updateInfo.metadata.name,
              version: updateInfo.version
            });

            callback(err);
            return;
          }

          if (config.get('push')) {
            repo.git.cmd('push', {}, ['origin', branchName], function (err) {
              if (err) {
                logger.error('Git push has failed ', {
                  name: updateInfo.metadata.name,
                  version: updateInfo.version
                });

                return callback(err);
              }

              logger.info('Git commit and push %s %s success', updateInfo.metadata.name, updateInfo.version);

              repo.checkout('master', function () {
                repo.git.cmd('branch', {}, ['-D', branchName], function () {
                  callback(null, updateInfo);
                });
              });
            });
          } else {
            callback(null, updateInfo);
          }
        });
      })
    });
  } else {
    callback(null, updateInfo);
  }
}

module.exports = {
  check: check,
  metadata: metadata,
  update: update,
  commit: commit
};