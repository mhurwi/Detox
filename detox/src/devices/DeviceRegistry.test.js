const fs = require('fs-extra');
const tempfile = require('tempfile');
const environment = require('../utils/environment');

describe('DeviceRegistry instance', () => {
  let DeviceRegistry;
  let lockfilePath;
  let registry;

  beforeEach(() => {
    lockfilePath = tempfile('.test');
    DeviceRegistry = require('./DeviceRegistry');
    registry = new DeviceRegistry({ lockfilePath });
  });

  afterEach(async () => {
    await fs.remove(lockfilePath);
  });

  it('should throw on attempt to checking if device is busy outside of allocation/disposal context', async () => {
    const deviceId = 'emulator-5554';

    const assertForbiddenOutOfContext = () =>
      expect(() => registry.isDeviceBusy(deviceId)).toThrowError();

    assertForbiddenOutOfContext();
    const result = await registry.allocateDevice(() => {
      expect(registry.isDeviceBusy(deviceId)).toBe(false);
      return deviceId;
    });

    expect(result).toBe(deviceId);

    assertForbiddenOutOfContext();
    await registry.disposeDevice(() => {
      expect(registry.isDeviceBusy(deviceId)).toBe(true);
      return deviceId;
    });

    assertForbiddenOutOfContext();
    await registry.allocateDevice(() => {
      expect(registry.isDeviceBusy(deviceId)).toBe(false);
      throw new Error();
    }).catch(() => {});

    assertForbiddenOutOfContext();
  });

  describe('.reset() method', () => {
    it('should create a lock file with an empty array if it does not exist', async () => {
      expect(await fs.exists(lockfilePath)).toBe(false);
      await registry.reset();
      expect(await fs.readFile(lockfilePath, 'utf8')).toBe('[]');
    });

    it('should overwrite a lock file contents with an empty array if it exists', async () => {
      await fs.writeFile(lockfilePath, '{ something }');
      await registry.reset();
      expect(await fs.readFile(lockfilePath, 'utf8')).toBe('[]');
    });
  })
});

describe('DeviceRegistry static methods', () => {
  let ExclusiveLockFile;
  let DeviceRegistry;

  beforeEach(() => {
    jest.mock('../utils/ExclusiveLockFile');

    ExclusiveLockFile = require('../utils/ExclusiveLockfile');
    DeviceRegistry = require('./DeviceRegistry');
  });

  it('should expose static convenience method DeviceRegistry.ios()', () => {
    expect(DeviceRegistry.ios()).toBeInstanceOf(DeviceRegistry);
    expect(ExclusiveLockFile).toHaveBeenCalledWith(
      environment.getDeviceLockFilePathIOS(),
      expect.anything(),
    );
  });

  it('should expose static convenience method DeviceRegistry.android()', async () => {
    expect(DeviceRegistry.android()).toBeInstanceOf(DeviceRegistry);
    expect(ExclusiveLockFile).toHaveBeenCalledWith(
      environment.getDeviceLockFilePathAndroid(),
      expect.anything(),
    );
  });
});
