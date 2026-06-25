import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { copyFileSync, mkdirSync, renameSync, existsSync, rmSync } from 'fs'

// Copies manifest + moves HTML files to correct Chrome Extension paths after build
function chromeExtensionPlugin() {
  return {
    name: 'chrome-extension-post-build',
    closeBundle() {
      // 1. Copy manifest from public/ → dist/
      mkdirSync('dist', { recursive: true })
      copyFileSync('public/manifest.json', 'dist/manifest.json')

      // 2. Move HTML pages: dist/src/popup/popup.html → dist/popup/popup.html
      const pairs: [string, string][] = [
        ['dist/src/popup/popup.html',     'dist/popup/popup.html'],
        ['dist/src/dashboard/dashboard.html', 'dist/dashboard/dashboard.html'],
      ]
      for (const [src, dest] of pairs) {
        if (existsSync(src)) {
          mkdirSync(resolve(dest, '..'), { recursive: true })
          // Copy (rename doesn't work across devices, use copy+delete)
          copyFileSync(src, dest)
        }
      }

      // 3. Clean up empty src/ subtree in dist
      if (existsSync('dist/src')) {
        rmSync('dist/src', { recursive: true, force: true })
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), chromeExtensionPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        popup:         resolve(__dirname, 'src/popup/popup.html'),
        dashboard:     resolve(__dirname, 'src/dashboard/dashboard.html'),
        serviceWorker: resolve(__dirname, 'src/background/serviceWorker.ts'),
        mapsContent:   resolve(__dirname, 'src/content/mapsContent.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'serviceWorker') return 'background/serviceWorker.js'
          if (chunkInfo.name === 'mapsContent')   return 'content/mapsContent.js'
          return 'assets/[name]-[hash].js'
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
})
