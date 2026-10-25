import { join } from 'node:path';
import { startApplication } from '../../api/src/application.js';
import { createStaticHandler } from './static.js';
import { createOfflineServer } from './offline-server.js';

const [resources, dataDirectory] = process.argv.slice(2);
const origin = 'http://127.0.0.1:4175';

try {
  if (!resources || !dataDirectory || !process.parentPort) throw new Error('arguments');
  let close: () => Promise<void>;
  try {
    const application = await startApplication({
      modelsPath: join(resources, 'models.yaml'),
      lexiconPath: join(resources, 'a1_a2.yaml'),
      dataDirectory,
      port: 4175,
      origins: [origin],
      handlePage: createStaticHandler(join(resources, 'web')),
    });
    close = application.close;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') throw error;
    const server = createOfflineServer(join(resources, 'web'));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(4175, '127.0.0.1', resolve);
    });
    close = () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
  process.parentPort.on('message', (event) => {
    if (event.data === 'shutdown') void close().finally(() => process.exit(0));
  });
  process.parentPort.postMessage({ type: 'ready' });
} catch (error) {
  process.parentPort?.postMessage({
    type: 'failed',
    code: error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE' ? 'port-in-use' : 'startup',
  });
  process.exitCode = 1;
}
