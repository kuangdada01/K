import { Capacitor } from '@capacitor/core';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || '';

export function getApiBaseUrl(): string {
  if (Capacitor.isNativePlatform() && SERVER_URL) {
    return `${SERVER_URL}/api`;
  }
  return '/api';
}

export function getServerUrl(): string {
  return SERVER_URL;
}

export function resolveMediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (Capacitor.isNativePlatform() && SERVER_URL) {
    return `${SERVER_URL}${url}`;
  }
  return url;
}