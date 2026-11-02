import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { existsSync, readFileSync } from 'node:fs'

// 只在构建配置中读取本地凭据，源码仓库不携带实际 Key。
const localKeyPath = resolve('.local/curseforge-api-key.txt')
const bundledCurseforgeKey = process.env.HCMCL_CURSEFORGE_BUILD_KEY?.trim()
  || (existsSync(localKeyPath) ? readFileSync(localKeyPath, 'utf8').trim() : '')

export default defineConfig({
  main: {
    define: {
      __HCMCL_BUNDLED_CURSEFORGE_KEY__: JSON.stringify(bundledCurseforgeKey)
    },
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      // 多入口：index.js = 后端/编排进程入口；network.js = 网络进程（utilityProcess.fork）入口。
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          network: resolve('src/main/network/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
