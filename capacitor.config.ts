import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.bankshotai.app',
  appName: 'BankShotAI',
  webDir: 'src',
  server: {
    androidScheme: 'https'
  },
  plugins: {
    Camera: {
      // Use web implementation for camera access
    }
  }
};

export default config;
