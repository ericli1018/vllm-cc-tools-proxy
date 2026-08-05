import { loadConfig } from './config.js';
import { createServer } from './app.js';

const config = loadConfig();
const server = createServer(config);
server.listen(config.port, config.host, () => {
  process.stderr.write(`${JSON.stringify({ level: 'info', event: 'server_started', host: config.host, port: config.port, version: '0.2.5' })}\n`);
});
