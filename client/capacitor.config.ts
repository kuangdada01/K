import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.k.app',
  appName: 'K',
  webDir: 'dist',
  server: {
    androidScheme: 'http',
  },
  android: {
    // 关闭 Capacitor 自动为状态栏加的 WebView 边距：网页全屏（语音共享舞台）
    // 时需要页面真正铺满，状态栏避让改由 CSS env(safe-area-inset-top) 承担
    adjustMarginsForEdgeToEdge: 'disable',
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    SplashScreen: {
      launchShowDuration: 2000,
      backgroundColor: '#0f0f0f',
      showSpinner: false,
      androidScaleType: 'CENTER_CROP',
    },
    StatusBar: {
      overlaysWebView: true,
    },
  },
};

export default config;
