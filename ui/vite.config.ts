import react from "@vitejs/plugin-react-swc";
import { resolve } from "node:path";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";
import dts from "vite-plugin-dts";
import { defineConfig } from "vitest/config";

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
  const isLibraryBuild = command === 'build';
  const isTest = mode === "test";

  return {
    base: "./",
    build: isLibraryBuild ? {
      chunkSizeWarningLimit: 1600,
      lib: {
        entry: resolve("src", "main.tsx"),
        fileName: 'main',
        formats: ['umd'],
        name: 'AirflowPlugin',
      },
      rollupOptions: {
        external: ["react", "react-dom", "react-router-dom", "react/jsx-runtime"],
        output: {
          globals: {
            react: "React",
            "react-dom": "ReactDOM",
            "react-router-dom": "ReactRouterDOM",
            "react/jsx-runtime": "ReactJSXRuntime",
          },
        },
      },
    } : {
      // Development build configuration
      chunkSizeWarningLimit: 1600
    },
    define: {
      // Baked into the bundle so the desktop can tell you when the JavaScript you are
      // running was built. Compared against the server's copy in System Properties,
      // which is the only reliable way to spot a browser serving a cached bundle.
      __AOS_BUILD__: JSON.stringify(new Date().toISOString().replace("T", " ").slice(0, 19)),
      global: "globalThis",
      "process.env": "{}",
      // Define process.env for browser compatibility. Not under vitest: React's
      // jsx-dev-runtime exports nothing in production, and tests compile to jsxDEV.
      ...(isTest ? {} : { "process.env.NODE_ENV": JSON.stringify("production") }),
    },
    plugins: [
      react(),
      cssInjectedByJsPlugin(),
      ...(isLibraryBuild ? [dts({
        include: ["src/main.tsx"],
        insertTypesEntry: true,
        outDir: "dist"
      })] : [])
    ],
    resolve: { alias: { src: "/src" } },
    server: {
      cors: true, // Only used by the dev server.
      // `pnpm dev` renders the desktop standalone on :5173, but it still needs real
      // Airflow data. Proxy both backends to a running api-server so the same code
      // paths work in dev and inside the plugin. Override the target with
      // AIRFLOW_OS_API_URL if your api-server is not on :28080.
      proxy: {
        "/airflow-os": {
          changeOrigin: true,
          target: process.env.AIRFLOW_OS_API_URL ?? "http://localhost:28080",
        },
        "/api/v2": {
          changeOrigin: true,
          target: process.env.AIRFLOW_OS_API_URL ?? "http://localhost:28080",
        },
        "/auth": {
          changeOrigin: true,
          target: process.env.AIRFLOW_OS_API_URL ?? "http://localhost:28080",
        },
      },
    },
    test: {
      coverage: {
        include: ["src/**/*.ts", "src/**/*.tsx"],
      },
      css: true,
      environment: "happy-dom",
      globals: true,
      mockReset: true,
      passWithNoTests: true,
      restoreMocks: true,
      setupFiles: "./testsSetup.ts",
    },
  };
});
