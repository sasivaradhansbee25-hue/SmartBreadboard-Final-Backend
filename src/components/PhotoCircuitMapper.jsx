import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Upload,
  Camera,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  ArrowRight,
  RefreshCw,
  Eye,
  Sliders,
  Sparkles,
  Layers,
  Cpu,
  Zap,
  Box,
  Smartphone,
  Play,
  Pause,
  RotateCcw
} from 'lucide-react';
import { useCircuit } from '../context/CircuitContext';
import {
  mapPhotoToCircuitApi,
  resolveAmbiguousTerminal,
  formatPipelineResultForCircuitContext
} from '../services/photoCircuitService';
import SupplyConfigurationPanel from './SupplyConfigurationPanel';
import SimulationWaveformPanel from './SimulationWaveformPanel';
import Breadboard3DCanvas from './Breadboard3DCanvas';
import ARCameraOverlay from './ARCameraOverlay';
import { formatVoltage, formatCurrent, formatPower } from '../utils/electricalFormatter';

export default function PhotoCircuitMapper({ onComplete = null }) {
  const navigate = useNavigate();
  const {
    activeCircuit,
    setRealCircuitData,
    uploadedImage,
    setUploadedImage,
    simulationStatus,
    simulationResult,
    simulationError,
    simulationSignature,
    currentTransientSample,
    currentTimeIndex,
    supplyConfiguration,
    configureSupply,
    clearSupply,
    simulateCircuit,
    resetSimulation,
    invalidateSimulation,
    selectedComponent,
    setSelectedComponent
  } = useCircuit();

  const [imagePreview, setImagePreview] = useState(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);
  const [pipelineResult, setPipelineResult] = useState(null);

  // Single-Photo State
  const [capturedImage, setCapturedImage] = useState(null);
  const [acceptedCircuitImage, setAcceptedCircuitImage] = useState(null);
  const [detectionConfidenceError, setDetectionConfidenceError] = useState(null);

  // View Mode: 'photo' | '3d' | 'ar' (Requirement 8)
  const [viewMode, setViewMode] = useState('photo');

  // Sub-tabs for circuit data inspector: 'components' | 'nodes' | 'connections'
  const [dataTab, setDataTab] = useState('components');

  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const arContainerRef = useRef(null);
  const arImageRef = useRef(null);

  // Sync uploaded image from context if populated by QR or Scanner
  useEffect(() => {
    if (uploadedImage && !imagePreview) {
      setImagePreview(uploadedImage);
      setCapturedImage(uploadedImage);
    }
  }, [uploadedImage, imagePreview]);

  // Cleanup camera stream on unmount
  useEffect(() => {
    return () => {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  // Requirement 8: When simulation starts or is solved, automatically switch to 3D TWIN
  useEffect(() => {
    if (simulationStatus === 'SOLVED' || simulationStatus === 'RUNNING') {
      setViewMode('3d');
    }
  }, [simulationStatus]);

  // Sync verified circuit to CircuitContext for Phase 24.2 / 24.3 / 24.4 supply & solver pipelines
  useEffect(() => {
    if (pipelineResult && pipelineResult.status === 'READY') {
      const contextPayload = formatPipelineResultForCircuitContext(pipelineResult, imagePreview);
      if (contextPayload) {
        setRealCircuitData(contextPayload);
      }
    }
  }, [pipelineResult, imagePreview, setRealCircuitData]);

  // 1. File Upload Handler with Immediate Backend Processing
  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = async (evt) => {
        const dataUrl = evt.target?.result;
        setCapturedImage(dataUrl);
        setImagePreview(dataUrl);
        setAcceptedCircuitImage(dataUrl);
        setUploadedImage(dataUrl);
        setValidationResult(null);
        setDetectionConfidenceError(null);
        setPipelineResult(null);
        setErrorMessage(null);
        stopCamera();

        // Immediately send image to backend analysis pipeline
        await processImage(dataUrl);
      };
      reader.readAsDataURL(file);
    }
  };

  // 2. Open Live Camera with Resilient Error Handling
  const startCamera = async () => {
    try {
      setErrorMessage(null);
      setIsCameraActive(true);
      if (!navigator?.mediaDevices?.getUserMedia) {
        throw new Error("Camera API is not supported by your browser or environment.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' }
      });
      mediaStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
    } catch (err) {
      setIsCameraActive(false);
      let userFriendlyMsg = err.message || "Failed to open camera";
      if (err.name === 'NotAllowedError' || userFriendlyMsg.includes('Permission denied')) {
        userFriendlyMsg = "Camera access was denied. Please allow camera permissions in your browser or use 'Upload Photo'.";
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        userFriendlyMsg = "No camera found on this device. Please connect a camera or use 'Upload Photo'.";
      } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
        userFriendlyMsg = "Camera is currently in use by another program. Please close other camera apps and try again.";
      }
      setErrorMessage(userFriendlyMsg);
    }
  };

  const stopCamera = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    setIsCameraActive(false);
  };

  // 3. Capture Frame from Live Camera with Immediate Backend Processing
  const captureCameraFrame = async () => {
    if (!videoRef.current) return;
    const canvas = document.createElement('canvas');
    canvas.width = videoRef.current.videoWidth || 1280;
    canvas.height = videoRef.current.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');

    setCapturedImage(dataUrl);
    setImagePreview(dataUrl);
    setAcceptedCircuitImage(dataUrl);
    setUploadedImage(dataUrl);
    setValidationResult(null);
    setDetectionConfidenceError(null);
    setPipelineResult(null);
    setErrorMessage(null);
    stopCamera();

    // Immediately send captured photo to backend analysis pipeline
    await processImage(dataUrl);
  };

  // Reset photo selection
  const handleClearImage = () => {
    setCapturedImage(null);
    setAcceptedCircuitImage(null);
    setDetectionConfidenceError(null);
    setImagePreview(null);
    setPipelineResult(null);
    setErrorMessage(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    // Reopen live camera capture
    startCamera();
  };

  // 4. Sample Benchmark Photo Loader
  const loadSampleBenchmark = (scenarioKey) => {
    stopCamera();
    setErrorMessage(null);
    setDetectionConfidenceError(null);

    let mockDets = [];
    if (scenarioKey === 'single_resistor') {
      mockDets = [
        { id: 'R1', type: 'resistor', confidence: 0.96, start_hole: 'A10', end_hole: 'A15', bbox: [300, 200, 460, 250] }
      ];
    } else if (scenarioKey === 'resistor_led_series') {
      mockDets = [
        { id: 'R1', type: 'resistor', confidence: 0.95, start_hole: 'A10', end_hole: 'E15', bbox: [300, 200, 450, 240] },
        { id: 'LED1', type: 'led', confidence: 0.92, start_hole: 'C15', end_hole: 'E20', bbox: [460, 200, 600, 250] }
      ];
    } else if (scenarioKey === 'resistor_led_parallel') {
      mockDets = [
        { id: 'R1', type: 'resistor', confidence: 0.95, start_hole: 'A10', end_hole: 'A15', bbox: [300, 180, 450, 210] },
        { id: 'LED1', type: 'led', confidence: 0.93, start_hole: 'C10', end_hole: 'C15', bbox: [300, 240, 450, 270] }
      ];
    } else if (scenarioKey === 'rlc_circuit') {
      mockDets = [
        { id: 'R1', type: 'resistor', confidence: 0.96, start_hole: 'A10', end_hole: 'B15', bbox: [200, 200, 320, 230], value: 100, unit: 'Ω' },
        { id: 'L1', type: 'inductor', confidence: 0.90, start_hole: 'C15', end_hole: 'D20', bbox: [340, 200, 460, 230], value: 0.01, unit: 'H' },
        { id: 'C1', type: 'capacitor', confidence: 0.94, start_hole: 'E20', end_hole: 'A25', bbox: [480, 200, 600, 230], value: 1e-5, unit: 'F' }
      ];
    } else if (scenarioKey === 'jumper_wire_merge') {
      mockDets = [
        { id: 'R1', type: 'resistor', confidence: 0.95, start_hole: 'A10', end_hole: 'E15', bbox: [200, 200, 320, 230] },
        { id: 'W1', type: 'wire', confidence: 0.98, start_hole: 'D15', end_hole: 'D25', bbox: [330, 200, 520, 230] },
        { id: 'R2', type: 'resistor', confidence: 0.94, start_hole: 'E25', end_hole: 'A30', bbox: [530, 200, 650, 230] }
      ];
    } else if (scenarioKey === 'ambiguous_review') {
      mockDets = [
        {
          id: 'R1',
          type: 'resistor',
          confidence: 0.88,
          start_hole: 'A10',
          end_hole: 'E15',
          status: 'AMBIGUOUS',
          ambiguous_terminal: 'terminal_b',
          possible_holes: ['E15', 'E16'],
          bbox: [300, 200, 450, 250]
        }
      ];
    }

    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = '#38bdf8';
    ctx.font = '16px monospace';
    ctx.fillText(`SmartBreadboard 3D — ${scenarioKey}`, 20, 40);
    const fakeImgUrl = canvas.toDataURL('image/png');

    setImagePreview(fakeImgUrl);
    processImage(fakeImgUrl, mockDets);
  };

  // Section 9: Deterministic RLC Demonstration Circuit Loader
  const loadDeterministicRLCDemo = async () => {
    stopCamera();
    setErrorMessage(null);

    const rlcDets = [
      { id: 'R1', type: 'resistor', value: 220, unit: 'Ω', displayValue: '220 Ω', formatted_value: '220 Ω', confidence: 0.98, start_hole: 'A10', end_hole: 'B15', bbox: [200, 200, 320, 240] },
      { id: 'L1', type: 'inductor', value: 0.01, unit: 'H', displayValue: '10 mH', formatted_value: '10 mH', confidence: 0.96, start_hole: 'C15', end_hole: 'D20', bbox: [340, 200, 460, 240] },
      { id: 'C1', type: 'capacitor', value: 0.0001, unit: 'F', displayValue: '100 µF', formatted_value: '100 µF', confidence: 0.97, start_hole: 'E20', end_hole: 'A25', bbox: [480, 200, 600, 240] }
    ];

    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0b0f19';
    ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 15px Inter, monospace';
    ctx.fillText('Deterministic RLC Demo: R1(220Ω) + L1(10mH) + C1(100µF) — DC 5V', 20, 45);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '13px monospace';
    ctx.fillText('Series topology: A10-B15 (R1) → C15-D20 (L1) → E20-A25 (C1)', 20, 80);
    const fakeImgUrl = canvas.toDataURL('image/png');

    setImagePreview(fakeImgUrl);
    setIsProcessing(true);

    try {
      const res = await mapPhotoToCircuitApi(fakeImgUrl, rlcDets);
      setPipelineResult(res);

      const contextPayload = formatPipelineResultForCircuitContext(res, fakeImgUrl);
      if (contextPayload) {
        setRealCircuitData(contextPayload);
        // Automatically configure verified supply: NODE_1 (+5V) and NODE_GND (Reference)
        await configureSupply('NODE_1', 'NODE_GND', 5.0);
        // Dispatch transient simulation immediately
        await simulateCircuit({ duration: 0.05, timestep: 0.0005, simulation_mode: 'transient' });
        setViewMode('3d');
        if (res.components && res.components.length > 0) {
          setSelectedComponent(res.components[2] || res.components[0]); // Select C1 to view charging
        }
      }
    } catch (err) {
      setErrorMessage(err.message || 'Failed to load RLC demonstration circuit.');
    } finally {
      setIsProcessing(false);
    }
  };

  // Section 10: Complete Reset Demo
  const handleResetDemo = async () => {
    stopCamera();
    if (resetSimulation) {
      resetSimulation();
    }
    if (clearSupply) {
      await clearSupply();
    } else if (invalidateSimulation) {
      invalidateSimulation();
    }
    setSelectedComponent(null);
    setImagePreview(null);
    setPipelineResult(null);
    setErrorMessage(null);
    setViewMode('photo');
  };

  // 5. Send Image to Phase 24.1 Mapping Pipeline
  const processImage = async (imgData, mockDets = null) => {
    setIsProcessing(true);
    setErrorMessage(null);
    setDetectionConfidenceError(null);
    try {
      const res = await mapPhotoToCircuitApi(imgData, mockDets);
      setPipelineResult(res);
      if (!res.components || res.components.length === 0) {
        setDetectionConfidenceError('No supported electronic components detected.');
      }
    } catch (err) {
      setErrorMessage(err.message || 'Mapping pipeline encountered an error.');
    } finally {
      setIsProcessing(false);
    }
  };

  // 6. User Resolves Ambiguous Terminal
  const handleResolveAmbiguity = (componentId, terminalName, selectedHole) => {
    const updated = resolveAmbiguousTerminal(pipelineResult, componentId, terminalName, selectedHole);
    setPipelineResult(updated);
  };

  const components = pipelineResult?.components || activeCircuit?.components || [];
  const nodes = pipelineResult?.nodes || activeCircuit?.nodes || [];
  const connections = pipelineResult?.connections || [];
  const verifiedCount = components.filter(c => c.status === 'VERIFIED').length;
  const ambiguousCount = components.filter(c => c.status === 'AMBIGUOUS').length;

  const unverifiedComponents = useMemo(() => {
    return components.filter(c => c.status === 'UNVERIFIED' || c.status === 'UNKNOWN');
  }, [components]);

  const isConnectionsUnverified = useMemo(() => {
    return (
      pipelineResult?.status === 'UNVERIFIED' ||
      pipelineResult?.simulation_readiness_reason === 'CIRCUIT_CONNECTIONS_NOT_VERIFIED' ||
      unverifiedComponents.length > 0
    );
  }, [pipelineResult, unverifiedComponents]);

  // Section 14: Lifecycle Stages & Failed State Identification
  const currentPipelineStage = useMemo(() => {
    if (errorMessage) return { text: 'ERROR', isError: true, desc: errorMessage };
    if (isConnectionsUnverified) return { text: 'CIRCUIT CONNECTIONS NOT VERIFIED', isError: true, desc: 'Component terminal mapping could not be reliably verified.' };
    if (detectionConfidenceError) return { text: 'NO COMPONENTS DETECTED', isError: true, desc: detectionConfidenceError };
    if (simulationStatus === 'SOLVED') return { text: '10. SIMULATION READY', isError: false, desc: 'Real circuit electrical simulation solved' };
    if (viewMode === 'ar') return { text: '9. AR READY', isError: false, desc: 'AR overlay active over physical photo reference' };
    if (simulationStatus === 'RUNNING') return { text: '8. STARTING SIMULATION', isError: false, desc: 'Calculating node voltages & currents' };
    if (viewMode === '3d' || (pipelineResult?.status === 'READY' && activeCircuit)) return { text: '7. BUILDING 3D MODEL', isError: false, desc: 'Rendering digital twin on canonical breadboard' };
    if (isProcessing) return { text: '4. DETECTING COMPONENTS & 5. MAPPING CONNECTIONS', isError: false, desc: 'AI object detection & pin-to-hole registration' };
    if (acceptedCircuitImage) return { text: '3. IMAGE RECEIVED', isError: false, desc: 'Circuit photo loaded' };
    return { text: '1. WAITING FOR IMAGE', isError: false, desc: 'Ready for breadboard photo' };
  }, [errorMessage, isConnectionsUnverified, detectionConfidenceError, simulationStatus, viewMode, activeCircuit, pipelineResult, isProcessing, acceptedCircuitImage]);

  // Selected Component for Instantaneous Readout (Requirement 9)
  const inspectedComp = useMemo(() => {
    if (selectedComponent) return selectedComponent;
    return components[0] || null;
  }, [selectedComponent, components]);

  const inspectedElectrical = useMemo(() => {
    if (!inspectedComp) return null;
    const cid = (inspectedComp.id || '').toUpperCase();
    const cdes = (inspectedComp.designator || '').toUpperCase();

    if (currentTransientSample) {
      const tCurr = currentTransientSample.componentCurrents?.[cdes] ?? currentTransientSample.componentCurrents?.[cid] ?? currentTransientSample.componentCurrents?.[inspectedComp.id];
      const tVolt = currentTransientSample.componentVoltages?.[cdes] ?? currentTransientSample.componentVoltages?.[cid] ?? currentTransientSample.componentVoltages?.[inspectedComp.id];
      const tPow = currentTransientSample.componentPower?.[cdes] ?? currentTransientSample.componentPower?.[cid] ?? currentTransientSample.componentPower?.[inspectedComp.id];
      if (tCurr !== undefined || tVolt !== undefined || tPow !== undefined) {
        const cCurr = typeof tCurr === 'number' ? tCurr : 0;
        const cVolt = typeof tVolt === 'number' ? tVolt : 0;
        const cPow = typeof tPow === 'number' ? tPow : Math.abs(cVolt * cCurr);
        return { voltage: Math.abs(cVolt), current: cCurr, power: cPow };
      }
    }
    return inspectedComp.electrical || null;
  }, [inspectedComp, currentTransientSample]);

  // Visual Grounding State for ARCameraOverlay (Requirement 7)
  const currentVisualGroundingState = useMemo(() => {
    const comps = (activeCircuit?.components || pipelineResult?.components || []).map(c => {
      const cid = c.id || c.designator;
      const tA = c.terminals?.terminal_a || c.terminals?.[0] || {};
      const tB = c.terminals?.terminal_b || c.terminals?.[1] || {};
      const h1 = c.hole1 || c.start_hole || tA.hole;
      const h2 = c.hole2 || c.end_hole || tB.hole;
      return {
        id: cid,
        designator: cid,
        type: c.type || 'resistor',
        value: c.value,
        unit: c.unit || 'Ω',
        display_value: c.displayValue || c.formatted_value || `${c.value || ''} ${c.unit || 'Ω'}`.trim(),
        status: c.status || 'VERIFIED',
        source: c.source || 'ai',
        verified: c.status === 'VERIFIED',
        terminals: {
          terminal_a: {
            name: 'terminal_a',
            hole: h1,
            status: 'VERIFIED',
            electrical_node: c.node1 || (h1 ? `NODE_${h1}` : 'N/A')
          },
          terminal_b: {
            name: 'terminal_b',
            hole: h2,
            status: 'VERIFIED',
            electrical_node: c.node2 || (h2 ? `NODE_${h2}` : 'N/A')
          }
        },
        image_geometry: {
          bbox: c.bbox || [200, 200, 350, 250],
          center: [275, 225]
        }
      };
    });

    return {
      schema_version: '22.1',
      circuit_signature: activeCircuit?.circuit_signature || pipelineResult?.circuit_signature || 'SIG_PHOTO_001',
      overall_status: 'VERIFIED',
      summary: {
        component_count: comps.length,
        verified_components: comps.filter(c => c.verified).length,
        wires_count: 0,
        simulation_status: simulationStatus === 'SOLVED' ? 'SOLVED' : 'NOT_RUN'
      },
      components: comps,
      wires: activeCircuit?.wires || [],
      nodes: activeCircuit?.nodes || pipelineResult?.nodes || [],
      simulation: {
        status: simulationStatus === 'SOLVED' ? 'SOLVED' : 'NOT_RUN',
        voltages: simulationResult?.node_voltages || {}
      }
    };
  }, [activeCircuit, pipelineResult, simulationStatus, simulationResult]);

  // Section 1: Single Submission Workflow Steps
  const WORKFLOW_STEPS = [
    { num: 1, label: 'Upload / Camera' },
    { num: 2, label: 'Detect Circuit' },
    { num: 3, label: 'Review Mapping' },
    { num: 4, label: 'Configure Supply' },
    { num: 5, label: 'Run Simulation' },
    { num: 6, label: '3D + AR + Graph' }
  ];

  const activeStep = useMemo(() => {
    if (simulationStatus === 'SOLVED' && (viewMode === '3d' || viewMode === 'ar')) return 6;
    if (simulationStatus === 'RUNNING' || (supplyConfiguration?.status === 'VALID' && simulationStatus === 'READY')) return 5;
    if (components.length > 0 && ambiguousCount === 0 && (!supplyConfiguration?.positive_node || !supplyConfiguration?.ground_node)) return 4;
    if (components.length > 0 && ambiguousCount > 0) return 3;
    if (isProcessing || pipelineResult?.status === 'READY') return 2;
    return 1;
  }, [simulationStatus, viewMode, supplyConfiguration, components.length, ambiguousCount, isProcessing, pipelineResult]);

  return (
    <div style={{
      maxWidth: '1440px',
      margin: '0 auto',
      padding: '1.25rem 1.5rem',
      color: '#f8fafc',
      fontFamily: 'Inter, system-ui, -apple-system, sans-serif'
    }}>

      {/* Header Bar with Submission Workflow & Action Controls */}
      <div style={{
        background: 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%)',
        border: '1px solid #312e81',
        borderRadius: '14px',
        padding: '1.25rem 1.5rem',
        marginBottom: '1.25rem',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.45)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', marginBottom: '0.4rem' }}>
              <div style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.2rem 0.6rem',
                borderRadius: '6px',
                background: 'rgba(99, 102, 241, 0.2)',
                border: '1px solid rgba(99, 102, 241, 0.4)',
                color: '#a5b4fc',
                fontSize: '0.72rem',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.05em'
              }}>
                <Sparkles size={13} /> Final Submission Integration • Phase 24.4
              </div>

              {/* Requirement 16: Physical Hardware Validation Notice */}
              <div style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.2rem 0.6rem',
                borderRadius: '6px',
                background: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid rgba(239, 68, 68, 0.4)',
                color: '#fca5a5',
                fontSize: '0.72rem',
                fontWeight: 700,
                letterSpacing: '0.04em'
              }}>
                ⚠ PHYSICAL VALIDATION NOT PERFORMED
              </div>

              {/* Section 14: Lifecycle Stage Badge */}
              <div style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.2rem 0.6rem',
                borderRadius: '6px',
                background: currentPipelineStage.isError ? 'rgba(239, 68, 68, 0.2)' : 'rgba(56, 189, 248, 0.2)',
                border: currentPipelineStage.isError ? '1px solid #ef4444' : '1px solid #38bdf8',
                color: currentPipelineStage.isError ? '#fca5a5' : '#7dd3fc',
                fontSize: '0.72rem',
                fontWeight: 800,
                letterSpacing: '0.04em'
              }}>
                <span>STAGE: {currentPipelineStage.text}</span>
              </div>
            </div>

            <h1 style={{ margin: 0, fontSize: '1.45rem', fontWeight: 800, color: '#f8fafc', letterSpacing: '-0.02em' }}>
              SmartBreadboard 3D — Autonomous Breadboard Digitizer & Simulation Platform
            </h1>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.84rem', color: '#94a3b8' }}>
              One integrated workflow: Photo → Verified Circuit → Manual Supply → Real Simulation → 3D Twin ↔ AR ↔ Analog Graph.
            </p>
          </div>

          {/* Action Buttons: 1-Click RLC Demo + Clear/Reset Demo (Section 9 & 10) */}
          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={loadDeterministicRLCDemo}
              disabled={isProcessing}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.5rem',
                background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
                color: '#ffffff',
                border: '1px solid #3b82f6',
                padding: '0.55rem 1.1rem',
                borderRadius: '8px',
                fontSize: '0.82rem',
                fontWeight: 700,
                cursor: isProcessing ? 'not-allowed' : 'pointer',
                boxShadow: '0 4px 14px rgba(37, 99, 235, 0.35)',
                transition: 'all 0.15s ease'
              }}
            >
              <Zap size={15} color="#facc15" />
              <span>⚡ LOAD RLC DEMO</span>
            </button>

            <button
              onClick={handleResetDemo}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.45rem',
                background: 'rgba(239, 68, 68, 0.15)',
                color: '#fca5a5',
                border: '1px solid rgba(239, 68, 68, 0.4)',
                padding: '0.55rem 1rem',
                borderRadius: '8px',
                fontSize: '0.82rem',
                fontWeight: 700,
                cursor: 'pointer',
                transition: 'all 0.15s ease'
              }}
            >
              <RotateCcw size={14} />
              <span>↺ RESET DEMO</span>
            </button>
          </div>
        </div>

        {/* Section 1: Single Submission Workflow Step Indicator Bar */}
        <div style={{
          marginTop: '1.1rem',
          paddingTop: '0.9rem',
          borderTop: '1px solid rgba(255, 255, 255, 0.1)',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '0.5rem'
        }}>
          {WORKFLOW_STEPS.map(step => {
            const isDone = activeStep > step.num;
            const isCurrent = activeStep === step.num;

            return (
              <div
                key={step.num}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.4rem 0.65rem',
                  borderRadius: '6px',
                  background: isCurrent ? 'rgba(56, 189, 248, 0.18)' : (isDone ? 'rgba(34, 197, 94, 0.12)' : 'rgba(15, 23, 42, 0.6)'),
                  border: isCurrent ? '1px solid #38bdf8' : (isDone ? '1px solid rgba(34, 197, 94, 0.3)' : '1px solid rgba(255, 255, 255, 0.05)'),
                  transition: 'all 0.2s ease'
                }}
              >
                <div style={{
                  width: '20px',
                  height: '20px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.72rem',
                  fontWeight: 800,
                  background: isCurrent ? '#38bdf8' : (isDone ? '#22c55e' : '#334155'),
                  color: isCurrent || isDone ? '#0f172a' : '#94a3b8'
                }}>
                  {isDone ? '✓' : step.num}
                </div>
                <div style={{
                  fontSize: '0.74rem',
                  fontWeight: isCurrent ? 700 : 500,
                  color: isCurrent ? '#38bdf8' : (isDone ? '#86efac' : '#64748b'),
                  whiteSpace: 'nowrap'
                }}>
                  {step.label}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Section 8 & 14: Circuit Connections Not Verified Banner */}
      {isConnectionsUnverified && (
        <div style={{
          background: 'rgba(239, 68, 68, 0.15)',
          border: '1px solid #ef4444',
          color: '#fca5a5',
          padding: '0.85rem 1.25rem',
          borderRadius: '10px',
          marginBottom: '1.25rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
          fontSize: '0.85rem',
          boxShadow: '0 4px 14px rgba(239, 68, 68, 0.15)'
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
            <AlertTriangle size={20} color="#ef4444" style={{ flexShrink: 0, marginTop: '2px' }} />
            <div>
              <div style={{ fontWeight: 800, fontSize: '0.95rem', color: '#f87171', marginBottom: '0.25rem' }}>
                CIRCUIT CONNECTIONS NOT VERIFIED
              </div>
              <div style={{ color: '#fecaca', fontSize: '0.82rem' }}>
                {pipelineResult?.message || (unverifiedComponents.length > 0
                  ? `Component(s) ${unverifiedComponents.map(c => c.id || c.designator).join(', ')} could not be confidently mapped to breadboard holes or have conflicting connections.`
                  : 'Physical breadboard connections could not be verified from this photo angle.')}
              </div>
            </div>
          </div>
          <button
            onClick={() => setImagePreview(null)}
            className="btn btn-secondary"
            style={{
              padding: '0.45rem 0.85rem',
              fontSize: '0.8rem',
              flexShrink: 0
            }}
          >
            Clear Image
          </button>
        </div>
      )}

      {/* Requirement 9: Scanner UX Status States Banner */}
      {isProcessing ? (
        <div style={{
          background: 'rgba(56, 189, 248, 0.12)',
          border: '1px solid #38bdf8',
          color: '#bae6fd',
          padding: '0.65rem 1rem',
          borderRadius: '8px',
          marginBottom: '1.25rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          fontSize: '0.85rem',
          fontWeight: 700
        }}>
          <RefreshCw size={18} className="animate-spin" color="#38bdf8" />
          <span>Analysing image...</span>
        </div>
      ) : pipelineResult ? (
        <div style={{
          background: pipelineResult.status === 'READY'
            ? 'rgba(34, 197, 94, 0.12)'
            : (pipelineResult.status === 'POOR_QUALITY' || pipelineResult.status === 'NO_COMPONENTS_DETECTED'
              ? 'rgba(239, 68, 68, 0.12)'
              : 'rgba(245, 158, 11, 0.12)'),
          border: `1px solid ${pipelineResult.status === 'READY' ? '#22c55e' : (pipelineResult.status === 'POOR_QUALITY' || pipelineResult.status === 'NO_COMPONENTS_DETECTED' ? '#ef4444' : '#f59e0b')}`,
          color: pipelineResult.status === 'READY' ? '#4ade80' : (pipelineResult.status === 'POOR_QUALITY' || pipelineResult.status === 'NO_COMPONENTS_DETECTED' ? '#fca5a5' : '#fde68a'),
          padding: '0.65rem 1rem',
          borderRadius: '8px',
          marginBottom: '1.25rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          fontSize: '0.85rem',
          fontWeight: 700
        }}>
          {pipelineResult.status === 'READY' ? (
            <CheckCircle2 size={18} color="#4ade80" />
          ) : (pipelineResult.status === 'POOR_QUALITY' || pipelineResult.status === 'NO_COMPONENTS_DETECTED' ? (
            <XCircle size={18} color="#ef4444" />
          ) : (
            <AlertTriangle size={18} color="#f59e0b" />
          ))}
          <span>
            {pipelineResult.status_message || (
              pipelineResult.status === 'READY'
                ? "Analysis complete"
                : (pipelineResult.status === 'POOR_QUALITY'
                  ? "Image quality is insufficient for reliable analysis."
                  : (pipelineResult.status === 'NO_COMPONENTS_DETECTED'
                    ? "No reliable electronic circuit components detected."
                    : "Partial analysis completed — some components could not be identified reliably."))
            )}
          </span>
        </div>
      ) : null}

      {/* Requirement 12: Clear Error Handling Banners */}
      {simulationStatus === 'BLOCKED' && (
        <div style={{
          background: 'rgba(239, 68, 68, 0.12)',
          border: '1px solid #ef4444',
          color: '#fca5a5',
          padding: '0.65rem 1rem',
          borderRadius: '8px',
          marginBottom: '1.25rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          fontSize: '0.82rem'
        }}>
          <AlertTriangle size={16} color="#ef4444" style={{ flexShrink: 0 }} />
          <span><strong>Simulation blocked:</strong> Please configure a valid positive supply and ground node with positive voltage.</span>
        </div>
      )}

      {simulationStatus === 'STALE' && (
        <div style={{
          background: 'rgba(245, 158, 11, 0.12)',
          border: '1px solid #f59e0b',
          color: '#fde68a',
          padding: '0.65rem 1rem',
          borderRadius: '8px',
          marginBottom: '1.25rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          fontSize: '0.82rem'
        }}>
          <AlertTriangle size={16} color="#f59e0b" style={{ flexShrink: 0 }} />
          <span><strong>Simulation is stale:</strong> Circuit topology or component values modified after simulation. Run simulation again.</span>
        </div>
      )}

      {errorMessage && (
        <div style={{
          background: 'rgba(239, 68, 68, 0.12)',
          border: '1px solid rgba(239, 68, 68, 0.3)',
          color: '#f87171',
          padding: '0.65rem 1rem',
          borderRadius: '8px',
          marginBottom: '1.25rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          fontSize: '0.82rem'
        }}>
          <XCircle size={16} color="#ef4444" style={{ flexShrink: 0 }} />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* ==================================================
          SECTION 11: SUBMISSION DASHBOARD (2-COLUMN GRID)
          LEFT: PHOTO / CAMERA / 3D DIGITAL TWIN
          RIGHT TOP: CIRCUIT + SUPPLY + SIMULATION
          RIGHT BOTTOM: LIVE ANALOG GRAPH
          ================================================== */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(480px, 1.15fr) minmax(420px, 0.85fr)',
        gap: '1.25rem',
        alignItems: 'start'
      }}>

        {/* ----------------------------------------------------
            LEFT COLUMN: PHOTO / CAMERA / 3D DIGITAL TWIN
            ---------------------------------------------------- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>

          {/* View Container Card */}
          <div style={{
            background: '#0a0e17',
            border: '1px solid #1e293b',
            borderRadius: '12px',
            padding: '1.1rem',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)'
          }}>
            {/* View Mode Selector Tabs */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.9rem', flexWrap: 'wrap', gap: '0.75rem' }}>
              <div style={{ display: 'flex', gap: '0.45rem' }}>
                <button
                  onClick={() => setViewMode('photo')}
                  style={{
                    padding: '0.45rem 0.9rem',
                    borderRadius: '8px',
                    background: viewMode === 'photo' ? 'rgba(56, 189, 248, 0.18)' : 'rgba(15, 23, 42, 0.8)',
                    border: viewMode === 'photo' ? '1px solid #38bdf8' : '1px solid #334155',
                    color: viewMode === 'photo' ? '#38bdf8' : '#94a3b8',
                    fontSize: '0.82rem',
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    transition: 'all 0.15s ease'
                  }}
                >
                  <Camera size={15} />
                  <span>[ 📷 PHOTO ]</span>
                </button>

                <button
                  onClick={() => setViewMode('3d')}
                  style={{
                    padding: '0.45rem 0.9rem',
                    borderRadius: '8px',
                    background: viewMode === '3d' ? 'rgba(56, 189, 248, 0.18)' : 'rgba(15, 23, 42, 0.8)',
                    border: viewMode === '3d' ? '1px solid #38bdf8' : '1px solid #334155',
                    color: viewMode === '3d' ? '#38bdf8' : '#94a3b8',
                    fontSize: '0.82rem',
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    transition: 'all 0.15s ease'
                  }}
                >
                  <Box size={15} />
                  <span>[ 🧊 3D TWIN ]</span>
                  {simulationStatus === 'SOLVED' && (
                    <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#34d399' }} />
                  )}
                </button>

                <button
                  onClick={() => setViewMode('ar')}
                  style={{
                    padding: '0.45rem 0.9rem',
                    borderRadius: '8px',
                    background: viewMode === 'ar' ? 'rgba(56, 189, 248, 0.18)' : 'rgba(15, 23, 42, 0.8)',
                    border: viewMode === 'ar' ? '1px solid #38bdf8' : '1px solid #334155',
                    color: viewMode === 'ar' ? '#38bdf8' : '#94a3b8',
                    fontSize: '0.82rem',
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    transition: 'all 0.15s ease'
                  }}
                >
                  <Smartphone size={15} />
                  <span>[ 📱 AR ]</span>
                  {isCameraActive && (
                    <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#10b981' }} />
                  )}
                </button>
              </div>

              {/* Upload & Camera Action Controls */}
              <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center' }}>
                {viewMode === 'photo' && (
                  <>
                    <input
                      type="file"
                      accept="image/*"
                      ref={fileInputRef}
                      style={{ display: 'none' }}
                      onChange={handleFileUpload}
                    />
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isProcessing}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.4rem',
                        padding: '0.4rem 0.8rem',
                        borderRadius: '6px',
                        background: '#2563eb',
                        color: '#ffffff',
                        border: 'none',
                        fontSize: '0.78rem',
                        fontWeight: 600,
                        cursor: isProcessing ? 'not-allowed' : 'pointer'
                      }}
                    >
                      <Upload size={14} />
                      Upload Photo
                    </button>
                    {!isCameraActive ? (
                      <button
                        onClick={startCamera}
                        disabled={isProcessing}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.4rem',
                          padding: '0.4rem 0.8rem',
                          borderRadius: '6px',
                          background: '#1e293b',
                          color: '#f8fafc',
                          border: '1px solid #334155',
                          fontSize: '0.78rem',
                          fontWeight: 600,
                          cursor: isProcessing ? 'not-allowed' : 'pointer'
                        }}
                      >
                        <Camera size={14} />
                        Camera
                      </button>
                    ) : (
                      <button
                        onClick={stopCamera}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.4rem',
                          padding: '0.4rem 0.8rem',
                          borderRadius: '6px',
                          background: '#dc2626',
                          color: '#ffffff',
                          border: 'none',
                          fontSize: '0.78rem',
                          fontWeight: 600,
                          cursor: 'pointer'
                        }}
                      >
                        Stop Camera
                      </button>
                    )}
                  </>
                )}

                {isProcessing && (
                  <span style={{ fontSize: '0.76rem', color: '#60a5fa', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <RefreshCw size={13} className="animate-spin" />
                    Analyzing...
                  </span>
                )}
              </div>
            </div>

            {/* Viewport Viewers (520px) */}
            <div style={{ position: 'relative', width: '100%', minHeight: '520px', borderRadius: '10px', overflow: 'hidden', border: '1px solid #1e293b', background: '#020617' }}>

              {/* 1. PHOTO VIEW & CAPTURE */}
              <div style={{ display: viewMode === 'photo' ? 'block' : 'none', width: '100%', height: '100%', minHeight: '520px' }}>
                {isCameraActive ? (
                  <div style={{ position: 'relative', width: '100%', height: '520px', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <video
                      ref={videoRef}
                      autoPlay
                      playsInline
                      style={{ maxWidth: '100%', maxHeight: '520px', objectFit: 'contain' }}
                    />
                    {/* Camera framing guide */}
                    <div style={{
                      position: 'absolute',
                      top: '12%',
                      left: '12%',
                      right: '12%',
                      bottom: '22%',
                      border: '2px dashed rgba(56, 189, 248, 0.45)',
                      borderRadius: '12px',
                      pointerEvents: 'none',
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'center',
                      paddingTop: '0.5rem',
                      color: 'rgba(56, 189, 248, 0.85)',
                      fontSize: '0.78rem',
                      fontWeight: 700,
                      letterSpacing: '0.05em',
                      textShadow: '0 1px 3px rgba(0,0,0,0.8)'
                    }}>
                      FRAME CIRCUIT IN CAMERA VIEW
                    </div>
                    <button
                      onClick={captureCameraFrame}
                      style={{
                        position: 'absolute',
                        bottom: '1.25rem',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        background: '#10b981',
                        color: '#fff',
                        border: 'none',
                        padding: '0.65rem 1.8rem',
                        borderRadius: '24px',
                        fontWeight: 700,
                        fontSize: '0.88rem',
                        cursor: 'pointer',
                        boxShadow: '0 4px 14px rgba(16, 185, 129, 0.5)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem'
                      }}
                    >
                      <Camera size={16} /> Capture Photo
                    </button>
                  </div>
                ) : imagePreview ? (
                  <div style={{ width: '100%', minHeight: '520px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#020617', padding: '1rem' }}>
                    <img
                      src={imagePreview}
                      alt="Captured Breadboard Preview"
                      style={{ maxWidth: '100%', maxHeight: '480px', objectFit: 'contain', borderRadius: '8px', border: '1px solid #1e293b' }}
                    />

                    {/* Backend Detection Result Banner when 0 components found */}
                    {detectionConfidenceError && (
                      <div style={{
                        marginTop: '0.85rem',
                        width: '100%',
                        maxWidth: '560px',
                        padding: '0.85rem 1rem',
                        borderRadius: '8px',
                        background: 'rgba(234, 179, 8, 0.12)',
                        border: '1px solid #eab308',
                        color: '#fef08a'
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontWeight: 700, marginBottom: '0.35rem', fontSize: '0.9rem' }}>
                          <AlertTriangle size={16} color="#eab308" />
                          <span>No supported electronic components detected.</span>
                        </div>
                        <div style={{ fontSize: '0.8rem', color: '#fde047' }}>
                          The backend analyzed the image but found no recognizable circuit components.
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '520px', color: '#64748b', gap: '0.75rem' }}>
                    <Camera size={44} style={{ opacity: 0.4 }} />
                    <p style={{ margin: 0, fontSize: '0.88rem' }}>Upload a breadboard photo or click ⚡ LOAD RLC DEMO above to begin.</p>
                  </div>
                )}
              </div>

              {/* 2. 3D DIGITAL TWIN VIEW */}
              <div style={{ display: viewMode === '3d' ? 'block' : 'none', width: '100%', height: '100%', minHeight: '520px' }}>
                {pipelineResult?.status === 'READY' || activeCircuit ? (
                  <Breadboard3DCanvas circuit={activeCircuit || formatPipelineResultForCircuitContext(pipelineResult, imagePreview)} />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '520px', color: '#64748b', gap: '0.75rem' }}>
                    <Box size={44} style={{ opacity: 0.4 }} />
                    <p style={{ margin: 0, fontSize: '0.88rem' }}>No verified circuit mapped yet. Upload photo or load RLC demo to view the 3D Digital Twin.</p>
                  </div>
                )}
              </div>

              {/* 3. AR CAMERA & REAL PHOTO OVERLAY VIEW */}
              <div style={{ display: viewMode === 'ar' ? 'block' : 'none', width: '100%', height: '520px', position: 'relative' }} ref={arContainerRef}>
                {isCameraActive ? (
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'contain',
                      display: 'block'
                    }}
                  />
                ) : (imagePreview || uploadedImage) ? (
                  <img
                    ref={arImageRef}
                    src={imagePreview || uploadedImage}
                    alt="AR Real Circuit Reference"
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'contain',
                      display: 'block',
                      background: '#020617'
                    }}
                  />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '1rem', color: '#94a3b8' }}>
                    <Smartphone size={38} color="#38bdf8" />
                    <span style={{ fontSize: '0.88rem' }}>Upload a circuit photo or start the live camera for AR overlay.</span>
                    <button
                      onClick={startCamera}
                      style={{
                        background: '#2563eb',
                        color: '#ffffff',
                        border: 'none',
                        padding: '0.55rem 1.25rem',
                        borderRadius: '8px',
                        fontSize: '0.85rem',
                        fontWeight: 700,
                        cursor: 'pointer'
                      }}
                    >
                      Start AR Camera
                    </button>
                  </div>
                )}
                <ARCameraOverlay
                  videoRef={isCameraActive ? videoRef : null}
                  imageRef={!isCameraActive ? arImageRef : null}
                  containerRef={arContainerRef}
                  trackedComponents={activeCircuit?.components || pipelineResult?.components || []}
                  visualGroundingState={currentVisualGroundingState}
                  isActive={viewMode === 'ar'}
                  videoWidth={1280}
                  videoHeight={720}
                />
              </div>
            </div>

            {/* Instantaneous Selected Component Readout Bar */}
            <div style={{
              marginTop: '0.85rem',
              padding: '0.75rem 1rem',
              background: '#090d16',
              border: '1px solid #1e293b',
              borderRadius: '8px',
              fontSize: '0.8rem'
            }}>
              {inspectedComp ? (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.6rem' }}>
                  <div>
                    <span style={{ fontWeight: 800, color: '#38bdf8', fontSize: '0.85rem' }}>
                      {inspectedComp.id || inspectedComp.designator}
                    </span>
                    <span style={{ color: '#94a3b8', marginLeft: '0.4rem', textTransform: 'capitalize' }}>
                      ({inspectedComp.type})
                    </span>
                    <span style={{ color: '#cbd5e1', marginLeft: '0.6rem' }}>
                      Value: <strong>{inspectedComp.displayValue || inspectedComp.formatted_value || `${inspectedComp.value || 0} ${inspectedComp.unit || ''}`}</strong>
                    </span>
                    <span style={{ color: '#64748b', marginLeft: '0.6rem' }}>
                      Holes: <strong style={{ color: '#94a3b8' }}>{inspectedComp.node1 || inspectedComp.start_hole || 'N/A'}</strong> → <strong style={{ color: '#94a3b8' }}>{inspectedComp.node2 || inspectedComp.end_hole || 'N/A'}</strong>
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: '0.9rem', alignItems: 'center' }}>
                    <span style={{ color: '#94a3b8', fontSize: '0.72rem', textTransform: 'uppercase', fontWeight: 600 }}>Sample:</span>
                    <span>V: <strong style={{ color: '#4ade80' }}>{formatVoltage(inspectedElectrical?.voltage ?? 0)}</strong></span>
                    <span>I: <strong style={{ color: '#fbbf24' }}>{formatCurrent(inspectedElectrical?.current ?? 0)}</strong></span>
                    <span>P: <strong style={{ color: '#f43f5e' }}>{formatPower(inspectedElectrical?.power ?? 0)}</strong></span>
                  </div>
                </div>
              ) : (
                <span style={{ color: '#64748b', fontSize: '0.76rem' }}>
                  🔍 Click any component in the 3D digital twin or table to inspect instantaneous electrical metrics.
                </span>
              )}
            </div>
          </div>
        </div>

        {/* ----------------------------------------------------
            RIGHT COLUMN:
            RIGHT TOP: CIRCUIT + SUPPLY + SIMULATION
            RIGHT BOTTOM: LIVE ANALOG GRAPH
            ---------------------------------------------------- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

          {/* RIGHT TOP: CIRCUIT + SUPPLY + SIMULATION */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

            {/* Verified Circuit Overview Card */}
            <div style={{
              background: '#0f172a',
              border: '1px solid #1e293b',
              borderRadius: '12px',
              padding: '1.1rem',
              boxShadow: '0 4px 16px rgba(0, 0, 0, 0.3)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #1e293b', paddingBottom: '0.6rem', marginBottom: '0.85rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Layers size={17} color="#60a5fa" />
                  <span style={{ fontSize: '0.85rem', fontWeight: 800, color: '#f8fafc', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Verified Circuit Map
                  </span>
                </div>

                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  <button
                    onClick={() => setDataTab('components')}
                    style={{
                      background: 'none',
                      border: 'none',
                      borderBottom: dataTab === 'components' ? '2px solid #38bdf8' : '2px solid transparent',
                      color: dataTab === 'components' ? '#38bdf8' : '#94a3b8',
                      padding: '0.25rem 0.55rem',
                      fontSize: '0.76rem',
                      fontWeight: 700,
                      cursor: 'pointer'
                    }}
                  >
                    Components ({components.length})
                  </button>
                  <button
                    onClick={() => setDataTab('nodes')}
                    style={{
                      background: 'none',
                      border: 'none',
                      borderBottom: dataTab === 'nodes' ? '2px solid #38bdf8' : '2px solid transparent',
                      color: dataTab === 'nodes' ? '#38bdf8' : '#94a3b8',
                      padding: '0.25rem 0.55rem',
                      fontSize: '0.76rem',
                      fontWeight: 700,
                      cursor: 'pointer'
                    }}
                  >
                    Nodes ({nodes.length})
                  </button>
                </div>
              </div>

              {/* Ambiguity Resolution Banner if present */}
              {ambiguousCount > 0 && (
                <div style={{
                  padding: '0.75rem 0.9rem',
                  borderRadius: '8px',
                  background: 'rgba(245, 158, 11, 0.1)',
                  border: '1px solid rgba(245, 158, 11, 0.4)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.5rem',
                  marginBottom: '0.85rem'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#fbbf24', fontWeight: 700, fontSize: '0.8rem' }}>
                    <AlertTriangle size={15} />
                    <span>MAPPING AMBIGUITY — Lead Placement Review Required</span>
                  </div>
                  <p style={{ margin: 0, fontSize: '0.75rem', color: '#fde68a' }}>
                    Select the physical breadboard hole to verify component mapping before running simulation:
                  </p>

                  {components.filter(c => c.status === 'AMBIGUOUS').map(comp => (
                    <div key={comp.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', padding: '0.45rem', background: '#090d16', borderRadius: '6px' }}>
                      {(comp.terminals || []).filter(t => t.status === 'AMBIGUOUS').map(term => (
                        <div key={term.terminal} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
                          <span style={{ fontSize: '0.76rem', fontWeight: 600, color: '#f1f5f9' }}>
                            {comp.id} ({comp.type}) lead: <strong style={{ color: '#38bdf8' }}>{term.terminal}</strong>
                          </span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>Select:</span>
                            {(term.alternate_holes || ['E15', 'E16']).map(hole => (
                              <button
                                key={hole}
                                onClick={() => handleResolveAmbiguity(comp.id, term.terminal, hole)}
                                style={{
                                  padding: '0.2rem 0.5rem',
                                  borderRadius: '4px',
                                  background: '#2563eb',
                                  color: '#ffffff',
                                  border: 'none',
                                  fontSize: '0.72rem',
                                  fontWeight: 700,
                                  cursor: 'pointer'
                                }}
                              >
                                [ {hole} ]
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}

              {/* Sub-Tab 1: Components Table */}
              {dataTab === 'components' && (
                <div style={{ overflowX: 'auto', maxHeight: '200px', overflowY: 'auto' }}>
                  {components.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '1.25rem', color: '#64748b', fontSize: '0.78rem' }}>
                      No components mapped. Upload photo or click ⚡ LOAD RLC DEMO.
                    </div>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.76rem', textAlign: 'left' }}>
                      <thead>
                        <tr style={{ color: '#94a3b8', borderBottom: '1px solid #1e293b' }}>
                          <th style={{ padding: '0.4rem 0.3rem' }}>ID</th>
                          <th style={{ padding: '0.4rem 0.3rem' }}>Type</th>
                          <th style={{ padding: '0.4rem 0.3rem' }}>Value</th>
                          <th style={{ padding: '0.4rem 0.3rem' }}>Holes</th>
                          <th style={{ padding: '0.4rem 0.3rem' }}>Confidence</th>
                          <th style={{ padding: '0.4rem 0.3rem' }}>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {components.map(comp => {
                          const t1 = comp.terminals?.[0];
                          const t2 = comp.terminals?.[1];
                          const isOk = comp.status === 'VERIFIED';
                          const isSelected = inspectedComp?.id === comp.id;

                          const confVal = typeof comp.confidence === 'number' ? comp.confidence : 0.85;
                          const confPct = Math.round(confVal > 1 ? confVal : confVal * 100);
                          const confCat = comp.confidenceCategory || (comp.isUncertain || confVal < 0.45 ? 'UNCERTAIN' : (confVal >= 0.75 ? 'CONFIRMED' : 'PROBABLE'));

                          const badgeStyle = confCat === 'CONFIRMED'
                            ? { bg: 'rgba(34, 197, 94, 0.15)', color: '#4ade80', border: 'rgba(34, 197, 94, 0.3)' }
                            : confCat === 'PROBABLE'
                              ? { bg: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8', border: 'rgba(56, 189, 248, 0.3)' }
                              : { bg: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24', border: 'rgba(245, 158, 11, 0.3)' };

                          return (
                            <tr
                              key={comp.id}
                              onClick={() => setSelectedComponent(comp)}
                              style={{
                                borderBottom: '1px solid #0f172a',
                                background: isSelected ? 'rgba(56, 189, 248, 0.12)' : 'transparent',
                                cursor: 'pointer',
                                transition: 'background 0.1s ease'
                              }}
                            >
                              <td style={{ padding: '0.4rem 0.3rem', fontWeight: 700, color: '#f8fafc' }}>
                                {comp.id}
                              </td>
                              <td style={{ padding: '0.4rem 0.3rem', color: '#cbd5e1', textTransform: 'capitalize' }}>
                                {comp.type}
                              </td>
                              <td style={{ padding: '0.4rem 0.3rem', color: comp.isUncertain ? '#f59e0b' : '#facc15', fontWeight: 600 }}>
                                {comp.isUncertain ? 'UNCERTAIN' : (comp.displayValue || comp.formatted_value || `${comp.value || ''} ${comp.unit || ''}`)}
                              </td>
                              <td style={{ padding: '0.4rem 0.3rem', color: '#38bdf8', fontFamily: 'monospace' }}>
                                {comp.start_hole || t1?.hole || '?'} → {comp.end_hole || t2?.hole || '?'}
                              </td>
                              <td style={{ padding: '0.4rem 0.3rem' }}>
                                <span style={{
                                  padding: '0.12rem 0.45rem',
                                  borderRadius: '4px',
                                  fontSize: '0.64rem',
                                  fontWeight: 800,
                                  background: badgeStyle.bg,
                                  color: badgeStyle.color,
                                  border: `1px solid ${badgeStyle.border}`
                                }}>
                                  {confCat} ({confPct}%)
                                </span>
                              </td>
                              <td style={{ padding: '0.4rem 0.3rem' }}>
                                <span style={{
                                  padding: '0.12rem 0.4rem',
                                  borderRadius: '4px',
                                  fontSize: '0.66rem',
                                  fontWeight: 700,
                                  background: isOk ? 'rgba(34, 197, 94, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                                  color: isOk ? '#4ade80' : '#fbbf24',
                                  border: `1px solid ${isOk ? 'rgba(34, 197, 94, 0.3)' : 'rgba(245, 158, 11, 0.3)'}`
                                }}>
                                  {isOk ? '✓ VERIFIED' : comp.status}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {/* Sub-Tab 2: Electrical Nodes */}
              {dataTab === 'nodes' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '200px', overflowY: 'auto' }}>
                  {nodes.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '1.25rem', color: '#64748b', fontSize: '0.78rem' }}>
                      No nodes derived yet.
                    </div>
                  ) : (
                    nodes.map(n => (
                      <div key={n.node_id} style={{
                        padding: '0.45rem 0.65rem',
                        background: '#090d16',
                        border: '1px solid #1e293b',
                        borderRadius: '6px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between'
                      }}>
                        <span style={{ fontWeight: 800, color: '#38bdf8', fontFamily: 'monospace', fontSize: '0.78rem' }}>
                          {n.node_id}
                        </span>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                          {(n.members || []).map(m => (
                            <span key={m} style={{
                              padding: '0.1rem 0.35rem',
                              borderRadius: '4px',
                              background: '#1e293b',
                              color: '#e2e8f0',
                              fontSize: '0.68rem',
                              fontFamily: 'monospace'
                            }}>
                              {m}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Manual Supply Configuration & Simulation Control */}
            <SupplyConfigurationPanel />
          </div>

          {/* RIGHT BOTTOM: LIVE ANALOG GRAPH (VOLTAGE / CURRENT / POWER) */}
          <div style={{ width: '100%' }}>
            <SimulationWaveformPanel />
          </div>

        </div>
      </div>
    </div>
  );
}
