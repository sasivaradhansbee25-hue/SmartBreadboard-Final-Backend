// Centralized Frontend Network & API Configuration
// Resolves production base URL or dynamic local/LAN development URLs

const metaEnv = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : {};

export const DEFAULT_PRODUCTION_API_BASE_URL = 'https://smartbreadboard-final-backend.onrender.com';
export const DEFAULT_PRODUCTION_FRONTEND_BASE_URL = 'https://smartbreadboard-3d.vercel.app';

export function getHostname() {
  if (typeof window !== 'undefined' && window.location.hostname) {
    return window.location.hostname;
  }
  return 'localhost';
}

export function getProtocol() {
  if (typeof window !== 'undefined' && window.location.protocol) {
    return window.location.protocol;
  }
  return 'http:';
}

export function checkIsLocalHost() {
  const h = getHostname();
  return ['localhost', '127.0.0.1', '0.0.0.0'].includes(h);
}

export function checkIsLanIp() {
  const h = getHostname();
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(h) && !['127.0.0.1', '0.0.0.0'].includes(h);
}

// Production is strictly a deployed domain (e.g. *.vercel.app, *.onrender.com, or HTTPS custom domain)
// NEVER production if running on localhost or on a LAN IP
export function checkIsProduction() {
  const h = getHostname();
  const p = getProtocol();
  if (checkIsLocalHost() || checkIsLanIp()) return false;
  return h.endsWith('.vercel.app') || h.endsWith('.onrender.com') || (p === 'https:' && !h.endsWith('.local'));
}

export const isLocalHost = checkIsLocalHost();
export const isLanIp = checkIsLanIp();
export const isProduction = checkIsProduction();

/**
 * Detects the actual frontend port from the current browser origin.
 * Vite automatically assigns 5173, 5174, 5175, etc.
 */
export function getFrontendPort() {
  if (typeof window !== 'undefined' && window.location.port) {
    return window.location.port;
  }
  return '5173';
}

/**
 * Resolves the backend FastAPI API base URL.
 * In local development, uses the PC LAN IP so both desktop and mobile connect to the same backend.
 */
export function resolveApiBaseUrl(customLanIp = null) {
  // 1. Explicit window runtime override
  if (typeof window !== 'undefined' && window.__API_BASE_URL__) {
    const custom = String(window.__API_BASE_URL__).trim().replace(/\/+$/, '');
    if (custom) return custom;
  }

  const envApiUrl = metaEnv.VITE_API_BASE_URL ? String(metaEnv.VITE_API_BASE_URL).trim().replace(/\/+$/, '') : '';

  // 2. Production deployment (Vercel, custom domain)
  if (checkIsProduction()) {
    if (envApiUrl && !envApiUrl.includes('localhost') && !envApiUrl.includes('127.0.0.1') && !envApiUrl.includes('0.0.0.0')) {
      return envApiUrl;
    }
    return DEFAULT_PRODUCTION_API_BASE_URL;
  }

  // 3. If accessed on LAN directly (e.g. phone at http://10.25.181.107:5175)
  if (checkIsLanIp()) {
    return `http://${getHostname()}:8000`;
  }

  // 4. If desktop provided/resolved LAN IP:
  const effectiveLan = (customLanIp && !['localhost', '127.0.0.1', '0.0.0.0'].includes(customLanIp)) ? customLanIp : null;
  if (effectiveLan) {
    return `http://${effectiveLan}:8000`;
  }

  // 5. Local desktop fallback before LAN IP is resolved
  if (envApiUrl && !envApiUrl.includes('localhost') && !envApiUrl.includes('127.0.0.1')) {
    return envApiUrl;
  }
  return 'http://localhost:8000';
}

/**
 * Resolves the frontend base URL for mobile QR code links in production.
 */
export function resolveFrontendBaseUrl() {
  const envFrontendUrl = metaEnv.VITE_FRONTEND_BASE_URL ? String(metaEnv.VITE_FRONTEND_BASE_URL).trim().replace(/\/+$/, '') : '';

  if (checkIsProduction()) {
    if (envFrontendUrl && !envFrontendUrl.includes('localhost') && !envFrontendUrl.includes('127.0.0.1') && !envFrontendUrl.includes('0.0.0.0')) {
      return envFrontendUrl;
    }
    if (typeof window !== 'undefined' && window.location.origin && !window.location.origin.includes('localhost') && !window.location.origin.includes('127.0.0.1')) {
      return window.location.origin;
    }
    return DEFAULT_PRODUCTION_FRONTEND_BASE_URL;
  }

  return (typeof window !== 'undefined' && window.location.origin) || 'http://localhost:5173';
}

/**
 * Constructs the mobile scanner URL for QR code generation.
 * 
 * Development / LAN:
 *   http://<PC_LAN_IP>:<ACTUAL_VITE_PORT>/scanner-mobile?session=<SESSION_ID>
 * 
 * Production:
 *   https://<DEPLOYED_FRONTEND_DOMAIN>/scanner-mobile?session=<SESSION_ID>
 * 
 * Guarantees that localhost / 127.0.0.1 / 0.0.0.0 / https:// NEVER appear in dev QR URLs.
 * 
 * @param {string} sessionId
 * @param {string|null} lanIp - LAN IP fetched from backend or user-configured
 * @returns {{ url: string|null, error: string|null }}
 */
export function getMobileScannerUrl(sessionId, lanIp = null) {
  if (!sessionId) return { url: null, error: "Missing session ID" };

  // Case 1: In production (e.g. deployed on Vercel)
  if (checkIsProduction()) {
    let base = resolveFrontendBaseUrl();
    if (base.includes('localhost') || base.includes('127.0.0.1') || base.includes('0.0.0.0')) {
      base = DEFAULT_PRODUCTION_FRONTEND_BASE_URL;
    }
    return {
      url: `${base.replace(/\/+$/, '')}/scanner-mobile?session=${sessionId}`,
      error: null
    };
  }

  // Case 2: Development / LAN
  const port = getFrontendPort();
  const portStr = port ? `:${port}` : '';
  const currentHost = getHostname();
  const isDirectLan = checkIsLanIp();

  // If accessed directly via LAN address (e.g. http://10.25.181.107:5175/scanner)
  if (isDirectLan) {
    const url = `http://${currentHost}${portStr}/scanner-mobile?session=${sessionId}`;
    return { url, error: null };
  }

  // If accessed via localhost / 127.0.0.1, use detected machine LAN IP
  const effectiveLan = (lanIp && !['localhost', '127.0.0.1', '0.0.0.0'].includes(lanIp)) ? lanIp : null;
  if (effectiveLan) {
    const url = `http://${effectiveLan}${portStr}/scanner-mobile?session=${sessionId}`;
    return { url, error: null };
  }

  return {
    url: null,
    error: "Acquiring PC LAN IP so your phone can reach the scanner..."
  };
}

export function getWebSocketBaseUrl(backendUrl) {
  return backendUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
}

export const API_BASE_URL = resolveApiBaseUrl();
export const FRONTEND_BASE_URL = resolveFrontendBaseUrl();
export const WS_BASE_URL = getWebSocketBaseUrl(API_BASE_URL);
