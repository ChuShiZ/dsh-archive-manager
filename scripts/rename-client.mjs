import { renameSync } from 'node:fs';
renameSync(new URL('../lib/index.iife.js', import.meta.url), new URL('../lib/client.js', import.meta.url));
console.log('renamed lib/index.iife.js -> lib/client.js');
