/**
 * src/pages/MobileScanner.jsx
 * 
 * SMARTBREADBOARD 3D — MOBILE SINGLE-PHOTO SCANNER
 * 
 * Streamlined mobile web camera interface opened via desktop QR scan:
 * Route: /scanner-mobile?session=XXXX
 * 
 * Workflow:
 * 1. Opens phone camera interface.
 * 2. Connects to desktop session.
 * 3. User captures a circuit photo.
 * 4. Sends image to desktop scanner for analysis.
 */

import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Camera, CheckCircle2, AlertTriangle, RotateCcw, Send, RefreshCw, Smartphone, Wifi } from 'lucide-react';
import { API_BASE_URL, WS_BASE_URL } from '../services/api.js';

export default function MobileScanner() {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get('session') || 'DEMO_SESSION';

  const [isConnected, setIsConnected] = useState(false);
  const [sessionNotFound, setSessionNotFound] = useState(false);
  const [backendUnreachable, setBackendUnreachable] = useState(false);
  const [capturedPhoto, setCapturedPhoto] = useState(null);
  const [isSending, setIsSending] = useState(false);
  const [isSent, setIsSent] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [cameraError, setCameraError] = useState(null);

  const videoRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const wsRef = useRef(null);

  const checkHealthAndConnect = async () => {
    setBackendUnreachable(false);
    setSessionNotFound(false);

    // 1. Lightweight health check (Requirement 10)
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      const healthResp = await fetch(`${API_BASE_URL}/api/health`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!healthResp.ok) {
        setBackendUnreachable(true);
        return;
      }
    } catch (e) {
      console.warn("Backend health check unreachable:", e);
      setBackendUnreachable(true);
      return;
    }

    // 2. Connect to Desktop Session via HTTP
    try {
      const resp = await fetch(`${API_BASE_URL}/api/scanner/session/${sessionId}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (resp.status === 404) {
        setSessionNotFound(true);
        return;
      }

      if (resp.ok) {
        const data = await resp.json();
        if (data && data.success) {
          setIsConnected(true);
          setBackendUnreachable(false);
          setSessionNotFound(false);
        }
      } else {
        setBackendUnreachable(true);
      }
    } catch (err) {
      console.warn("Could not connect to session endpoint:", err);
      setBackendUnreachable(true);
    }
  };

  // 1. Establish connection to Desktop Session via WebSocket + HTTP
  useEffect(() => {
    checkHealthAndConnect();

    // Connect WebSocket (Requirement 11: ws://<LAN_IP>:8000/ws/camera/<SESSION_ID>?role=phone)
    try {
      const wsUrl = `${WS_BASE_URL}/ws/camera/${sessionId}?role=phone`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        setBackendUnreachable(false);
      };
      ws.onerror = (e) => {
        console.warn("WebSocket connection warning:", e);
      };
      ws.onclose = () => {
        // ws closed
      };
    } catch (e) {
      console.warn("WebSocket init error:", e);
    }

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [sessionId]);

  // 2. Start Live Phone Camera
  useEffect(() => {
    startCamera();
    return () => {
      stopCamera();
    };
  }, []);

  const startCamera = async () => {
    setCameraError(null);
    try {
      if (!navigator?.mediaDevices?.getUserMedia) {
        throw new Error("Camera API is not supported on this browser.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
      mediaStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
    } catch (err) {
      console.error("Camera access error:", err);
      let msg = err.message || "Failed to access phone camera.";
      if (err.name === 'NotAllowedError' || msg.includes('Permission denied')) {
        msg = "Camera permission was denied. Please allow camera access in browser settings.";
      } else if (err.name === 'NotFoundError') {
        msg = "No camera found on this device.";
      }
      setCameraError(msg);
    }
  };

  const stopCamera = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
  };

  // 3. Capture Single Circuit Photo
  const handleCapturePhoto = async () => {
    if (!videoRef.current) return;
    const canvas = document.createElement('canvas');
    canvas.width = videoRef.current.videoWidth || 1280;
    canvas.height = videoRef.current.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.88);

    setCapturedPhoto(dataUrl);
    setIsSent(false);
    stopCamera();

    // Immediately transmit captured photo to desktop
    await handleSendToDesktop(dataUrl);
  };

  // 4. Send Photo to Desktop
  const handleSendToDesktop = async (overridePhoto = null) => {
    const photoToSend = overridePhoto || capturedPhoto;
    if (!photoToSend) return;
    setIsSending(true);
    setSendError(null);

    const payload = {
      sessionId,
      photo: capturedPhoto,
      valid: true
    };

    let wsSent = false;
    let httpSent = false;

    // 1. Send via WebSocket if open
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({
          type: 'photo_received',
          photo: capturedPhoto,
          valid: true
        }));
        wsSent = true;
      } catch (e) {
        console.warn("WebSocket send error:", e);
      }
    }

    // 2. Send via HTTP POST to FastAPI backend
    try {
      const resp = await fetch(`${API_BASE_URL}/api/scanner/session/${sessionId}/photo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (resp.status === 404) {
        setSessionNotFound(true);
        throw new Error("SESSION NOT FOUND: Session expired or invalid.");
      }

      if (!resp.ok) {
        throw new Error(`Failed to transmit photo (HTTP ${resp.status})`);
      }

      httpSent = true;
      setIsSent(true);
    } catch (e) {
      console.warn("Direct upload error:", e);
      if (wsSent) {
        // WebSocket succeeded even if HTTP had a hiccup
        setIsSent(true);
      } else {
        setSendError(e.message || "Failed to transmit photo to backend.");
      }
    } finally {
      setIsSending(false);
    }
  };

  // 5. Recapture Photo
  const handleRecapture = () => {
    setCapturedPhoto(null);
    setIsSent(false);
    setSendError(null);
    startCamera();
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: '#090d16',
      color: '#f8fafc',
      fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
      padding: '1rem',
      display: 'flex',
      flexDirection: 'column',
      maxWidth: '480px',
      margin: '0 auto'
    }}>
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: '1rem', borderBottom: '1px solid #1e293b', paddingBottom: '0.75rem' }}>
        <h1 style={{ fontSize: '1.05rem', fontWeight: 800, margin: 0, letterSpacing: '0.04em', color: '#38bdf8' }}>
          SMARTBREADBOARD 3D
        </h1>
        <div style={{ fontSize: '0.85rem', color: '#94a3b8', marginTop: '0.2rem' }}>
          Mobile Circuit Scanner
        </div>

        {/* Connection status badge */}
        <div style={{
          marginTop: '0.45rem',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.35rem',
          fontSize: '0.75rem',
          fontWeight: 700,
          padding: '0.2rem 0.65rem',
          borderRadius: '12px',
          background: sessionNotFound
            ? 'rgba(239, 68, 68, 0.15)'
            : backendUnreachable
              ? 'rgba(239, 68, 68, 0.15)'
              : isConnected
                ? 'rgba(34, 197, 94, 0.15)'
                : 'rgba(234, 179, 8, 0.15)',
          color: sessionNotFound
            ? '#ef4444'
            : backendUnreachable
              ? '#ef4444'
              : isConnected
                ? '#4ade80'
                : '#facc15',
          border: sessionNotFound
            ? '1px solid #ef4444'
            : backendUnreachable
              ? '1px solid #ef4444'
              : isConnected
                ? '1px solid #22c55e'
                : '1px solid #eab308'
        }}>
          <span style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: (sessionNotFound || backendUnreachable) ? '#ef4444' : isConnected ? '#4ade80' : '#facc15'
          }} />
          <span>
            {sessionNotFound
              ? 'SESSION NOT FOUND'
              : backendUnreachable
                ? 'BACKEND UNREACHABLE'
                : isConnected
                  ? 'Connected to Desktop'
                  : 'Connecting to Desktop...'}
          </span>
        </div>
      </div>

      {/* Main Content Viewport */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {sessionNotFound ? (
          <div style={{
            padding: '1.5rem',
            borderRadius: '12px',
            background: 'rgba(239, 68, 68, 0.12)',
            border: '1px solid #ef4444',
            color: '#fca5a5',
            textAlign: 'center',
            margin: '2rem 0'
          }}>
            <AlertTriangle size={36} style={{ margin: '0 auto 0.75rem', color: '#ef4444' }} />
            <h2 style={{ fontSize: '1.1rem', fontWeight: 800, margin: '0 0 0.5rem 0', color: '#ef4444' }}>
              SESSION NOT FOUND
            </h2>
            <p style={{ fontSize: '0.85rem', color: '#cbd5e1', lineHeight: 1.5, margin: '0 0 1rem 0' }}>
              Scanner session <code style={{ color: '#fca5a5' }}>{sessionId}</code> has expired or does not exist on the server.
            </p>
            <p style={{ fontSize: '0.82rem', color: '#94a3b8', margin: 0 }}>
              Please scan the active QR code currently displayed on your computer screen.
            </p>
          </div>
        ) : backendUnreachable ? (
          <div style={{
            padding: '1.25rem',
            borderRadius: '12px',
            background: 'rgba(239, 68, 68, 0.12)',
            border: '1px solid #ef4444',
            color: '#fca5a5',
            margin: '1.5rem 0'
          }}>
            <AlertTriangle size={32} style={{ margin: '0 auto 0.5rem', color: '#ef4444', display: 'block' }} />
            <h2 style={{ fontSize: '1.05rem', fontWeight: 800, margin: '0 0 0.4rem 0', color: '#ef4444', textAlign: 'center' }}>
              BACKEND UNREACHABLE
            </h2>
            <p style={{ fontSize: '0.82rem', color: '#cbd5e1', margin: '0 0 0.75rem 0', textAlign: 'center' }}>
              Cannot reach the FastAPI backend at <code style={{ color: '#fca5a5', fontWeight: 'bold' }}>{API_BASE_URL}</code>.
            </p>
            <div style={{
              background: 'rgba(15, 23, 42, 0.6)',
              padding: '0.75rem',
              borderRadius: '8px',
              fontSize: '0.78rem',
              color: '#cbd5e1',
              lineHeight: 1.6,
              marginBottom: '1rem'
            }}>
              <div style={{ fontWeight: 700, color: '#f8fafc', marginBottom: '0.25rem' }}>Please check:</div>
              <div>• Phone and PC are on same Wi-Fi</div>
              <div>• Backend is running</div>
              <div>• Port 8000 is accessible</div>
              <div>• Windows Firewall allows Python/Uvicorn</div>
            </div>
            <button
              onClick={checkHealthAndConnect}
              style={{
                width: '100%',
                padding: '0.55rem 1rem',
                borderRadius: '8px',
                background: '#ef4444',
                color: '#fff',
                border: 'none',
                fontWeight: 700,
                fontSize: '0.85rem',
                cursor: 'pointer'
              }}
            >
              Retry Connection
            </button>
          </div>
        ) : cameraError ? (
          <div style={{ padding: '1rem', borderRadius: '8px', background: 'rgba(239, 68, 68, 0.15)', border: '1px solid #ef4444', color: '#fca5a5', fontSize: '0.85rem', textAlign: 'center', marginBottom: '1rem' }}>
            <AlertTriangle size={24} style={{ margin: '0 auto 0.5rem', display: 'block' }} />
            {cameraError}
            <button
              onClick={startCamera}
              style={{ marginTop: '0.75rem', padding: '0.4rem 0.9rem', borderRadius: '6px', background: '#ef4444', color: '#fff', border: 'none', fontWeight: 700, cursor: 'pointer' }}
            >
              Retry Camera
            </button>
          </div>
        ) : !capturedPhoto ? (
          <>
            {/* Camera Viewport */}
            <div style={{ position: 'relative', width: '100%', height: '360px', background: '#000', borderRadius: '12px', overflow: 'hidden', border: '1px solid #334155' }}>
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />

              {/* Camera Framing Guide */}
              <div style={{
                position: 'absolute',
                top: '12%',
                left: '10%',
                right: '10%',
                bottom: '12%',
                border: '2px dashed rgba(56, 189, 248, 0.6)',
                borderRadius: '10px',
                pointerEvents: 'none',
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'center',
                paddingTop: '0.5rem',
                color: '#38bdf8',
                fontSize: '0.72rem',
                fontWeight: 700,
                letterSpacing: '0.05em',
                textShadow: '0 1px 3px rgba(0,0,0,0.8)'
              }}>
                FRAME CIRCUIT IN CAMERA VIEW
              </div>
            </div>

            {/* Instructions */}
            <div style={{ margin: '0.9rem 0', background: 'rgba(15, 23, 42, 0.8)', padding: '0.85rem', borderRadius: '8px', border: '1px solid #1e293b' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 800, color: '#f8fafc', marginBottom: '0.35rem' }}>
                CAPTURE CIRCUIT
              </div>
              <div style={{ fontSize: '0.78rem', color: '#94a3b8', marginBottom: '0.4rem' }}>
                Position camera over the circuit board.
              </div>
              <div style={{ fontSize: '0.75rem', color: '#cbd5e1', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                <div>✓ Complete circuit visible</div>
                <div>✓ Circuit centered in frame</div>
              </div>
            </div>

            {/* Capture Button */}
            <button
              onClick={handleCapturePhoto}
              style={{
                width: '100%',
                padding: '0.85rem',
                borderRadius: '12px',
                background: '#10b981',
                color: '#ffffff',
                border: 'none',
                fontSize: '0.95rem',
                fontWeight: 800,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                boxShadow: '0 4px 14px rgba(16, 185, 129, 0.45)',
                marginTop: 'auto'
              }}
            >
              <Camera size={18} /> [ CAPTURE PHOTO ]
            </button>
          </>
        ) : (
          /* Captured Photo Preview & Validation Result */
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
            <div style={{ width: '100%', maxHeight: '280px', borderRadius: '10px', overflow: 'hidden', border: '1px solid #334155', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <img
                src={capturedPhoto}
                alt="Captured Circuit"
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
            </div>

            {isSent ? (
              <div style={{ textAlign: 'center', padding: '1.25rem', marginTop: '1rem', borderRadius: '10px', background: 'rgba(34, 197, 94, 0.15)', border: '1px solid #22c55e', color: '#4ade80' }}>
                <CheckCircle2 size={32} style={{ margin: '0 auto 0.4rem', display: 'block' }} />
                <div style={{ fontSize: '0.95rem', fontWeight: 800 }}>✓ SENT TO DESKTOP!</div>
                <div style={{ fontSize: '0.8rem', color: '#cbd5e1', marginTop: '0.35rem' }}>
                  Your circuit image has been received by your desktop scanner. Click Analyze Circuit on your desktop to view the 3D twin & AR simulation.
                </div>
                <button
                  onClick={handleRecapture}
                  style={{ marginTop: '0.9rem', padding: '0.45rem 1rem', borderRadius: '8px', background: 'rgba(255,255,255,0.08)', color: '#94a3b8', border: '1px solid #475569', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' }}
                >
                  Capture Another Photo
                </button>
              </div>
            ) : (
              /* Photo Actions */
              <div style={{ marginTop: '0.85rem' }}>
                <div style={{ display: 'flex', gap: '0.6rem' }}>
                  <button
                    onClick={() => handleSendToDesktop()}
                    disabled={isSending}
                    style={{
                      flex: 1,
                      padding: '0.65rem',
                      borderRadius: '8px',
                      background: '#10b981',
                      color: '#ffffff',
                      border: 'none',
                      fontWeight: 800,
                      fontSize: '0.85rem',
                      cursor: isSending ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '0.4rem',
                      boxShadow: '0 4px 12px rgba(16, 185, 129, 0.4)'
                    }}
                  >
                    <Send size={15} /> {isSending ? 'Sending...' : 'Send to Desktop'}
                  </button>
                  <button
                    onClick={handleRecapture}
                    style={{
                      padding: '0.65rem 0.9rem',
                      borderRadius: '8px',
                      background: 'rgba(255, 255, 255, 0.08)',
                      color: '#94a3b8',
                      border: '1px solid #475569',
                      fontWeight: 600,
                      fontSize: '0.82rem',
                      cursor: 'pointer'
                    }}
                  >
                    Recapture
                  </button>
                </div>

                {sendError && (
                  <div style={{ color: '#fca5a5', fontSize: '0.78rem', marginTop: '0.5rem', textAlign: 'center' }}>
                    ⚠ {sendError}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
