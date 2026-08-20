import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { copyFileSync, mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from 'fs'

// Content script entries that must be wrapped in IIFEs so their minified
// local variables never collide when multiple scripts run in the same page context.

function contentScriptIifePlugin() {
  return {
    name: 'content-script-iife-wrap',
    // Runs after Rollup writes each chunk to disk
    writeBundle(_opts: unknown, bundle: Record<string, { type: string; fileName: string; code?: string }>) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || !chunk.code) continue
        // Match by output file path (e.g. "content/linkedinScraper.js")
        const isContentScript = chunk.fileName.startsWith('content/')
        if (!isContentScript) continue
        const outPath = resolve(__dirname, 'dist', chunk.fileName)
        const wrapped = `;(function(){\n${chunk.code}\n})();\n`
        writeFileSync(outPath, wrapped)
      }
    },
  }
}

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
  plugins: [react(), chromeExtensionPlugin(), contentScriptIifePlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // Chrome extension pages (chrome-extension://, isolated worlds) log noisy
    // "preloaded but not used / cross-world resource mismatch" warnings for
    // Vite's <link rel="modulepreload"> hints. They don't help in an extension,
    // so disable them entirely to keep the console clean.
    modulePreload: false,
    rollupOptions: {
      input: {
        popup:         resolve(__dirname, 'src/popup/popup.html'),
        dashboard:     resolve(__dirname, 'src/dashboard/dashboard.html'),
        serviceWorker: resolve(__dirname, 'src/background/serviceWorker.ts'),
        mapsContent:     resolve(__dirname, 'src/content/mapsContent.ts'),
        linkedinProbe:   resolve(__dirname, 'src/content/linkedinProbe.ts'),
        linkedinScraper: resolve(__dirname, 'src/content/linkedinScraper.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'serviceWorker') return 'background/serviceWorker.js'
          if (chunkInfo.name === 'mapsContent')   return 'content/mapsContent.js'
          if (chunkInfo.name === 'linkedinProbe')   return 'content/linkedinProbe.js'
          if (chunkInfo.name === 'linkedinScraper') return 'content/linkedinScraper.js'
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
