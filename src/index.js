import { loadConfig } from './config.js';
import { VERSION } from './version.js';
import { createServer } from './app.js';

const config = loadConfig();
if (config.modelResponseTimezoneInvalid) {
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(), level: 'warn', event: 'model_response_timezone_invalid',
    env: 'MODEL_RESPONSE_TIMEZONE', fallback: 'system_local',
  })}\n`);
}
const server = createServer(config);
server.listen(config.port, config.host, () => {
  process.stderr.write(`${JSON.stringify({ level: 'info', event: 'server_started', host: config.host, port: config.port, version: VERSION })}\n`);
});
