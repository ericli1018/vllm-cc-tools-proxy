import { createProxyServer } from './services/proxy-server.js';
export function createServer(config, dependencies) { return createProxyServer(config, dependencies); }
