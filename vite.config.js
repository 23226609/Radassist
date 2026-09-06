import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // Proxy /api → Node backend so the frontend can use relative URLs
      // in production builds too.
      "/api": "http://localhost:5002",
    },
  },
});
