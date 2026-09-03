import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.limen.mobile',
  appName: 'Limen',
  webDir: 'src',
  server: {
    androidScheme: 'https',
  },
};

export default config;
