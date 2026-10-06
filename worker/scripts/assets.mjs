import {copyFile, mkdir} from 'node:fs/promises';
await mkdir('public/vendor', {recursive: true});
await copyFile('node_modules/webex/umd/meetings.min.js', 'public/vendor/meetings.min.js');
