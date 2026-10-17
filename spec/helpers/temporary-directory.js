const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

module.exports = async function removeTemporaryDirectory(directory) {
  const temporary = fs.realpathSync.native(os.tmpdir());
  const target = fs.realpathSync.native(directory);
  if (path.dirname(target) !== temporary)
    throw new Error("Reference fixture cleanup escaped its private temporary root");
  await lumine.fileWatchClient.settlePendingTeardown();
  // Windows can retain a child handle after its owner's watcher has retired.
  // Yield between bounded retries so handle retirement can finish.
  await fs.promises.rm(target, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
};
