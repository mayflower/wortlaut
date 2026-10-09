import {defineConfig} from 'vite';

export default defineConfig({publicDir: false, build: {
  target: 'es2022', outDir: 'dist/meet',
  lib: {entry: 'src/meet-page.ts', formats: ['iife'], name: 'WortlautMeet', fileName: () => 'capture.js'},
}});
