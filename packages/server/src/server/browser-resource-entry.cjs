const { pathToFileURL } = require("node:url");
// Electron needs a physical CommonJS entrypoint before it can import ESM from asar.
const [worker, directory, binary] = process.argv.slice(2);
import(pathToFileURL(worker).href)
  .then(({ runBrowserResourceWorker }) => runBrowserResourceWorker(directory, binary))
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
