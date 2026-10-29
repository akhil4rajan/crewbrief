import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 3000, strictPort: true, host: true },
  preview: { port: 3000, strictPort: true },
  build: { sourcemap: true, target: "es2022" },
});
