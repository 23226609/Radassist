import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // Proxy /api → Node backend so the frontend can use relative URLs
      // in production builds too.
      "/api": {
        target: "http://127.0.0.1:5002",
        timeout: 180000,
        proxyTimeout: 180000,
      },
    },
  },
});
