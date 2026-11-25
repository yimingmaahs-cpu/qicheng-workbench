import { build } from 'esbuild';
import {copyFile} from 'node:fs/promises';
await build({ entryPoints: ['src/main.ts'], outfile: 'dist-electron/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true });
await build({ entryPoints: ['src/preload.ts'], outfile: 'dist-electron/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
await build({ entryPoints: ['src/ai-worker.ts'], outfile: 'dist-electron/ai-worker.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true });
await copyFile('docs/燕云背景资料·第一批·少东家与陈慎.md','dist-electron/ai-lore.md');
