const _ = require('lodash');
const path = require('path');
const cp = require('child_process');
const unparse = require('yargs-unparser');
const DetoxRuntimeError = require('../src/errors/DetoxRuntimeError');
const DeviceRegistry = require('../src/devices/DeviceRegistry');
const { loadLastFailedTests } = require('../src/utils/lastFailedTests');
const { composeDetoxConfig } = require('../src/configuration');
const log = require('../src/utils/logger').child({ __filename });
const shellQuote = require('./utils/shellQuote');
const splitArgv = require('./utils/splitArgv');
const { getPlatformSpecificString, printEnvironmentVariables } = require('./utils/misc');

module.exports.command = 'test';
module.exports.desc = 'Run your test suite with the test runner specified in package.json';
module.exports.builder = require('./utils/testCommandArgs');
module.exports.handler = async function test(argv) {
  const { detoxArgs, runnerArgs } = splitArgv.detox(argv);
  const { cliConfig, deviceConfig, runnerConfig } = await composeDetoxConfig({ argv: detoxArgs });
  const [ platform ] = deviceConfig.type.split('.');

  const prepareArgs = choosePrepareArgs({
    cliConfig,
    runner: deduceTestRunner(runnerConfig.testRunner),
    platform,
  })

  const forwardedArgs = prepareArgs({
    cliConfig,
    runnerConfig,
    runnerArgs,
    platform,
  });

  if (detoxArgs.inspectBrk) {
    forwardedArgs.argv.$0 = `node --inspect-brk ${runnerConfig.testRunner}`;
  } else {
    forwardedArgs.argv.$0 = runnerConfig.testRunner;
  }

  if (!cliConfig.keepLockFile) {
    await resetLockFile({ platform });
  }

  await runTestRunnerWithRetries(forwardedArgs, detoxArgs.retries);
};

function choosePrepareArgs({ cliConfig, runner, platform }) {
  if (runner === 'mocha') {
    if (hasMultipleWorkers(cliConfig)) {
      log.warn('Can not use -w, --workers. Parallel test execution is only supported with iOS and Jest');
    }

    return prepareMochaArgs;
  }

  if (runner === 'jest') {
    if (platform === 'android' && hasMultipleWorkers(cliConfig)) {
      log.warn('Multiple workers is an experimental feature on Android and requires an emulator binary of version 28.0.16 or higher. ' +
        'Check your version by running: $ANDROID_HOME/tools/bin/sdkmanager --list');
    }

    return prepareJestArgs;
  }

  throw new DetoxRuntimeError({
    message: `"${runner}" is not supported in Detox CLI tools.`,
    hint: `You can still run your tests with the runner's own CLI tool`
  });
}

function deduceTestRunner(command) {
  if (command.includes('mocha')) {
    return 'mocha';
  }

  if (command.includes('jest')) {
    return 'jest';
  }

  return command;
}

function prepareMochaArgs({ cliConfig, runnerArgs, runnerConfig, platform }) {
  const { specs, passthrough } = splitArgv.mocha(runnerArgs);
  const configParam = path.extname(runnerConfig.runnerConfig) === '.opts'
    ? 'opts'
    : 'config';

  return {
    argv: {
      [configParam]: runnerConfig.runnerConfig || undefined,
      cleanup: Boolean(cliConfig.cleanup) || undefined,
      colors: !cliConfig.noColor && undefined,
      configuration: cliConfig.configuration || undefined,
      gpu: cliConfig.gpu || undefined,
      // TODO: check if we can --grep from user
      grep: platform ? getPlatformSpecificString(platform) : undefined,
      invert: Boolean(platform) || undefined,
      headless: Boolean(cliConfig.headless) || undefined,
      loglevel: cliConfig.loglevel || undefined,
      reuse: cliConfig.reuse || undefined,
      'artifacts-location': cliConfig.artifactsLocation || undefined,
      'config-path': cliConfig.configPath || undefined,
      'debug-synchronization': isFinite(cliConfig.debugSynchronization) ? cliConfig.debugSynchronization : undefined,
      'device-name': cliConfig.deviceName || undefined,
      'force-adb-install': platform === 'android' && cliConfig.forceAdbInstall || undefined,
      'record-logs': cliConfig.recordLogs || undefined,
      'record-performance': cliConfig.recordPerformance || undefined,
      'record-videos': cliConfig.recordVideos || undefined,
      'take-screenshots': cliConfig.takeScreenshots || undefined,
      'use-custom-logger': cliConfig.useCustomLogger && 'true' || undefined,

      ...passthrough,
    },
    env: _.pick(cliConfig, ['deviceLaunchArgs']),
    specs: _.isEmpty(specs) ? [runnerConfig.specs] : specs,
  };
}

function prepareJestArgs({ cliConfig, runnerArgs, runnerConfig, platform }) {
  const { specs, passthrough } = splitArgv.jest(runnerArgs);

  return {
    argv: {
      color: !cliConfig.noColor && undefined,
      config: runnerConfig.runnerConfig || undefined,
      testNamePattern: platform ? shellQuote(`^((?!${getPlatformSpecificString(platform)}).)*$`) : undefined,
      maxWorkers: cliConfig.workers,

      ...passthrough,
    },

    env: _.omitBy({
      DETOX_START_TIMESTAMP: Date.now(),
      ..._.pick(cliConfig, [
        'configPath',
        'configuration',
        'loglevel',
        'cleanup',
        'reuse',
        'debugSynchronization',
        'gpu',
        'headless',
        'artifactsLocation',
        'recordLogs',
        'takeScreenshots',
        'recordVideos',
        'recordPerformance',
        'recordTimeline',
        'deviceName',
        'deviceLaunchArgs',
        'useCustomLogger',
        'forceAdbInstall',
      ]),
      readOnlyEmu: platform === 'android' ? hasMultipleWorkers(cliConfig) : undefined,
      reportSpecs: _.isUndefined(cliConfig.jestReportSpecs)
        ? !hasMultipleWorkers(cliConfig)
        : `${cliConfig.jestReportSpecs}` === 'true',
    }, _.isUndefined),

    specs: _.isEmpty(specs) ? [runnerConfig.specs] : specs,
  };
}

async function resetLockFile({ platform }) {
  if (platform === 'ios') {
    await DeviceRegistry.ios().reset();
  }

  if (platform === 'android') {
    await DeviceRegistry.android().reset();
  }
}

function launchTestRunner({ argv, env, specs }) {
  const { $0: command, ...restArgv } = argv;
  const fullCommand = [command, ...unparse(restArgv), ...specs].join(' ');

  log.info(printEnvironmentVariables(env) + fullCommand);
  cp.execSync(fullCommand, {
    cwd: path.join('node_modules', '.bin'),
    stdio: 'inherit',
    env: {
      ...process.env,
      ...env,
    }
  });
}

function hasMultipleWorkers(cliConfig) {
  return cliConfig.workers != 1;
}

async function runTestRunnerWithRetries(forwardedArgs, retries) {
  let runsLeft = 1 + retries;
  let launchError;

  do {
    try {
      if (launchError) {
        log.error('Re-running tests for the failed specs...');
      }

      launchTestRunner(forwardedArgs);
      launchError = null;
    } catch (e) {
      launchError = e;

      const lastFailedTests = await loadLastFailedTests();
      if (!lastFailedTests) {
        throw e;
      }

      forwardedArgs.specs = lastFailedTests;
      log.error('Test run has failed for the following specs:\n' + lastFailedTests.join('\n'));
    }
  } while (launchError && --runsLeft > 0);

  if (launchError) {
    throw launchError;
  }
}
