import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // needed to test via Telegram's mobile client during dev (ngrok etc.)
    port: 5173,
  },
});
