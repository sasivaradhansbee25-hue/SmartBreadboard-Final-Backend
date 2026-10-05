import {
  API_BASE_URL,
  FRONTEND_BASE_URL,
  WS_BASE_URL,
  getMobileScannerUrl,
  getFrontendPort,
  getWebSocketBaseUrl,
  isLocalHost,
  isLanIp,
  isProduction,
  resolveApiBaseUrl,
  resolveFrontendBaseUrl
} from '../config/api.js';

export const API_BASE = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_BASE_URL)
  ? import.meta.env.VITE_API_BASE_URL
  : 'https://smartbreadboard-final-backend.onrender.com';

export {
  API_BASE_URL,
  FRONTEND_BASE_URL,
  WS_BASE_URL,
  getMobileScannerUrl,
  getFrontendPort,
  getWebSocketBaseUrl,
  isLocalHost,
  isLanIp,
  isProduction,
  resolveApiBaseUrl,
  resolveFrontendBaseUrl
};

export async function apiRequest(endpoint, method = 'GET', body = null) {
  try {
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const fullUrl = cleanEndpoint.startsWith('/api') 
      ? `${API_BASE_URL}${cleanEndpoint}`
      : `${API_BASE_URL}/api${cleanEndpoint}`;

    const response = await fetch(fullUrl, options);
    if (!response.ok) {
      throw new Error(`API HTTP Error ${response.status}`);
    }
    return await response.json();
  } catch (err) {
    // Fallback to local mock data response when backend server is offline
    return {
      status: 'offline_mock_fallback',
      source: 'mock',
      endpoint,
      timestamp: new Date().toISOString()
    };
  }
}
