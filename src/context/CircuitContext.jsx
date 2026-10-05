import React, { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { mockCircuits } from '../data/mockCircuits';
import { demoCircuits } from '../data/demoCircuits';
import { requestDcSimulation } from '../services/analysisService';
import { requestTransientAnalysis } from '../services/transientAnalysisService';
import { parseComponentValue, formatEngineeringValue } from '../utils/valueParser';
import { analyzeCircuitIntelligence } from '../intelligence/index.js';
import {
  configureSupplyAPI,
  clearSupplyAPI,
  simulateCircuitAPI,
  SUPPLY_STATUS,
  SIMULATION_STATUS
} from '../services/supplyConfigurationService.js';

const CircuitContext = createContext(null);
const MAX_HISTORY_LENGTH = 20;

export function CircuitProvider({ children }) {
  const [activeCircuit, setActiveCircuit] = useState(mockCircuits[0]);
  const [originalScannedCircuit, setOriginalScannedCircuit] = useState(null);
  const [uploadedImage, setUploadedImage] = useState(null);
  const [imageMeta, setImageMeta] = useState(null);
  const [isAnalyzingReal, setIsAnalyzingReal] = useState(false);
  const [realAnalysisError, setRealAnalysisError] = useState(null);

  // View vs Edit Mode State
  const [isEditMode, setIsEditMode] = useState(false);

  // Electrical Solver & Simulation Extensions
  const [simulation, setSimulation] = useState({
    mode: 'dc',
    running: false,
    time: 0,
    timestep: 0.001,
    speed: 1.0
  });

  // User-supplied simulation power source state
  const [simulationSource, setSimulationSource] = useState(null); // { type, value, unit, positiveNode, negativeNode, source: 'user_simulated' }

  // Normalized electrical simulation result & 3D Digital Twin payload
  const [simulationResult, setSimulationResult] = useState(null);
  const [measurements, setMeasurements] = useState({});
  const [solverStatus, setSolverStatus] = useState('IDLE'); // 'IDLE', 'SOLVED', 'ERROR', 'NOT_RUN', 'POWER_REQUIRED'
  const [solverError, setSolverError] = useState(null);

  // Phase 24.2 Manual Supply Configuration & Simulation Control
  const [supplyConfiguration, setSupplyConfiguration] = useState({
    enabled: false,
    source_id: 'V1',
    positive_node: null,
    ground_node: null,
    voltage: 5.0,
    reference: 'GROUND',
    status: 'NOT_CONFIGURED'
  });
  const [simulationStatus, setSimulationStatus] = useState('READY');
  const [simulationError, setSimulationError] = useState(null);
  const [simulationSignature, setSimulationSignature] = useState(null);
  const [currentTimeIndex, setCurrentTimeIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  // ESP32 Real-Time Hardware Telemetry State
  const [hardwareTelemetry, setHardwareTelemetry] = useState({
    status: 'DISCONNECTED', // 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR'
    connected: false,
    device: 'ESP32_WROOM_32',
    voltage: 0,
    current_ma: 0,
    power_mw: 0,
    adc_raw: 0,
    adc_voltage: 0,
    digital_pins: { GPIO2: 0, GPIO4: 0, SW1: 0, SW2: 0 },
    timestamp: null,
    last_received: null
  });

  const invalidateSimulation = useCallback((reason = null) => {
    setSimulationResult(null);
    setSimulationStatus('READY');
    setSimulationSignature(null);
    setSimulationError(reason);
    setMeasurements({});
    setCurrentTimeIndex(0);
    setIsPlaying(false);
  }, []);

  // Phase 24.4: Authoritative instantaneous transient sample synced to timeline cursor
  const currentTransientSample = useMemo(() => {
    if (!simulationResult || !Array.isArray(simulationResult.time) || simulationResult.time.length === 0) {
      return null;
    }
    const totalPoints = simulationResult.time.length;
    const idx = Math.min(Math.max(0, currentTimeIndex), totalPoints - 1);
    const t = simulationResult.time[idx];

    const nodeVoltages = {};
    if (simulationResult.node_voltages) {
      Object.entries(simulationResult.node_voltages).forEach(([k, arr]) => {
        nodeVoltages[k] = Array.isArray(arr) ? arr[idx] : arr;
      });
    }

    const componentVoltages = {};
    if (simulationResult.component_voltages) {
      Object.entries(simulationResult.component_voltages).forEach(([k, arr]) => {
        componentVoltages[k] = Array.isArray(arr) ? arr[idx] : arr;
      });
    }

    const componentCurrents = {};
    if (simulationResult.component_currents) {
      Object.entries(simulationResult.component_currents).forEach(([k, arr]) => {
        componentCurrents[k] = Array.isArray(arr) ? arr[idx] : arr;
      });
    }

    const componentPower = {};
    if (simulationResult.component_power) {
      Object.entries(simulationResult.component_power).forEach(([k, arr]) => {
        componentPower[k] = Array.isArray(arr) ? arr[idx] : arr;
      });
    }

    return {
      time: t,
      timeIndex: idx,
      totalPoints,
      duration: simulationResult.duration || simulationResult.time[totalPoints - 1] || 0.01,
      timestep: simulationResult.timestep || 0.0001,
      nodeVoltages,
      componentVoltages,
      componentCurrents,
      componentPower
    };
  }, [simulationResult, currentTimeIndex]);

  // Phase 24.4: Playback Animation Loop
  useEffect(() => {
    if (!isPlaying) return;

    if (!simulationResult?.time || simulationResult.time.length <= 1) {
      setIsPlaying(false);
      return;
    }

    const totalSteps = simulationResult.time.length;
    const interval = setInterval(() => {
      setCurrentTimeIndex(prevIdx => {
        if (prevIdx >= totalSteps - 1) {
          setIsPlaying(false);
          setSimulationStatus('SOLVED');
          return prevIdx;
        }
        return prevIdx + 1;
      });
    }, Math.max(16, Math.round(33 / playbackSpeed)));

    return () => clearInterval(interval);
  }, [isPlaying, simulationResult, playbackSpeed]);

  const playSimulation = useCallback(() => {
    if (!simulationResult?.time || simulationResult.time.length === 0) return;
    if (currentTimeIndex >= simulationResult.time.length - 1) {
      setCurrentTimeIndex(0);
    }
    setIsPlaying(true);
    setSimulationStatus('RUNNING');
  }, [simulationResult, currentTimeIndex]);

  const pauseSimulation = useCallback(() => {
    setIsPlaying(false);
    setSimulationStatus('PAUSED');
  }, []);

  const restartSimulation = useCallback(() => {
    if (!simulationResult?.time || simulationResult.time.length === 0) return;
    setCurrentTimeIndex(0);
    setIsPlaying(true);
    setSimulationStatus('RUNNING');
  }, [simulationResult]);

  const seekSimulation = useCallback((targetIndexOrRatio) => {
    if (!simulationResult?.time || simulationResult.time.length === 0) return;
    const total = simulationResult.time.length;
    let targetIdx = 0;
    if (typeof targetIndexOrRatio === 'number') {
      if (targetIndexOrRatio <= 1.0 && targetIndexOrRatio >= 0.0 && !Number.isInteger(targetIndexOrRatio)) {
        targetIdx = Math.round(targetIndexOrRatio * (total - 1));
      } else {
        targetIdx = Math.round(targetIndexOrRatio);
      }
    }
    setCurrentTimeIndex(Math.min(Math.max(0, targetIdx), total - 1));
  }, [simulationResult]);

  const resetSimulation = useCallback(() => {
    setIsPlaying(false);
    setCurrentTimeIndex(0);
    setSimulationResult(null);
    setSimulationSignature(null);
    setSimulationStatus('READY');
    setSimulationError(null);
    setMeasurements({});
  }, []);

  // Phase 29: Transient Circuit Analysis State
  const [transientAnalysis, setTransientAnalysis] = useState(null);
  const [transientConfig, setTransientConfig] = useState({
    tStart: 0.0,
    tStop: 0.01,
    dt: 0.0001,
    method: 'backward_euler',
    source: null,
    initialConditions: {}
  });

  // Selection & Net Highlight State (Single Source of Truth)

  const [selectedComponent, setSelectedComponent] = useState(null);
  const [selectedNet, setSelectedNet] = useState(null);
  const [timeSeriesData, setTimeSeriesData] = useState([]);

  // Digital Circuit Modification History Stack (Undo / Redo)
  const [historyStack, setHistoryStack] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const isUndoRedoActionRef = useRef(false);

  // What-If Simulation State
  const [whatIfState, setWhatIfState] = useState({
    active: false,
    targetComponent: null,
    originalValue: '',
    candidateValue: '',
    originalSimulationResult: null,
    whatIfSimulationResult: null
  });

  // Phase 25: Reactive Context-Aware Circuit Intelligence & Topology Classification
  const circuitIntelligence = useMemo(() => {
    return analyzeCircuitIntelligence(activeCircuit, simulationResult);
  }, [activeCircuit, simulationResult]);

  // 1. Solve circuit whenever activeCircuit or simulationSource changes
  useEffect(() => {
    let isMounted = true;
    async function runSolver() {
      if (!activeCircuit) return;

      // Construct combined netlist with active or simulated power source
      const currentSources = [...(activeCircuit.power_sources || [])];
      if (simulationSource) {
        currentSources.push({
          id: "V_SIMULATED",
          type: simulationSource.type || "dc_voltage",
          voltage: parseFloat(simulationSource.value || 12.0),
          positive_node: simulationSource.positiveNode,
          negative_node: simulationSource.negativeNode,
          source: simulationSource.source || "user_simulated"
        });
      }

      const netlistToSolve = {
        ...activeCircuit,
        power_sources: currentSources
      };

      const res = await requestDcSimulation(netlistToSolve);
      if (isMounted && res) {
        setSimulationResult(res);
        if (res.status === 'SOLVED' || res.solver_status === 'SOLVED' || res.success) {
          setMeasurements(res.measurements || {});
          setSolverStatus('SOLVED');
          setSolverError(null);
        } else if (res.solver_status === 'NOT_RUN' || res.status === 'NOT_RUN') {
          setMeasurements(res.measurements || {});
          setSolverStatus(res.error?.code === 'POWER_SOURCE_REQUIRED' ? 'POWER_REQUIRED' : 'NOT_RUN');
          setSolverError(res.error || { message: res.reason || 'Simulation not run' });
        } else if (res.error) {
          setSolverStatus(res.error.code === 'POWER_SOURCE_REQUIRED' ? 'POWER_REQUIRED' : 'ERROR');
          setSolverError(res.error);
        }
      }
    }
    runSolver();
    return () => { isMounted = false; };
  }, [activeCircuit, simulationSource]);

  // Push snapshot to undo history
  const pushHistorySnapshot = useCallback((circuitSnapshot) => {
    if (isUndoRedoActionRef.current) {
      isUndoRedoActionRef.current = false;
      return;
    }

    setHistoryStack(prevStack => {
      const nextStack = prevStack.slice(0, historyIndex + 1);
      nextStack.push(JSON.parse(JSON.stringify(circuitSnapshot)));
      if (nextStack.length > MAX_HISTORY_LENGTH) {
        nextStack.shift();
      }
      return nextStack;
    });

    setHistoryIndex(prev => Math.min(prev + 1, MAX_HISTORY_LENGTH - 1));
  }, [historyIndex]);

  // Set real circuit data from AI scanning
  const setRealCircuitData = (realData) => {
    if (realData.imageMeta) {
      setImageMeta(realData.imageMeta);
    }
    if (realData.originalImage) {
      setUploadedImage(realData.originalImage);
    }

    const netlist = realData.netlist || {};
    const components = netlist.components || realData.mapped_components || [];
    
    const formattedCircuit = {
      id: netlist.circuit_id || 'circ_real_detected',
      name: 'Real AI Scanned Circuit',
      source: 'real',
      metadata: netlist.metadata || { source: 'real', created_at: new Date().toISOString() },
      nodes: netlist.nodes || [],
      nets: netlist.nets || [],
      nets_summary: netlist.nets_summary || [],
      components: components,
      wires: netlist.wires || [],
      power_sources: netlist.power_sources || [],
      validity: netlist.validity || { status: 'PASS', warnings: [] },
      solver_status: netlist.solver_status,
      solver_reason: netlist.solver_reason,
      detections: realData.detections || []
    };

    setActiveCircuit(formattedCircuit);
    setOriginalScannedCircuit(JSON.parse(JSON.stringify(formattedCircuit)));
    setHistoryStack([JSON.parse(JSON.stringify(formattedCircuit))]);
    setHistoryIndex(0);
    setSimulationSource(null);
    if (realData.electrical_analysis || realData.simulationResult || netlist.electrical_analysis) {
      setSimulationResult(realData.electrical_analysis || realData.simulationResult || netlist.electrical_analysis);
    }
  };

  const setMockCircuitData = (mockCirc) => {
    setActiveCircuit(mockCirc);
    setOriginalScannedCircuit(JSON.parse(JSON.stringify(mockCirc)));
    setHistoryStack([JSON.parse(JSON.stringify(mockCirc))]);
    setHistoryIndex(0);
    setUploadedImage(null);
    setImageMeta(null);
    setRealAnalysisError(null);
    setSimulationSource(null);
    setSimulationResult(null);
  };

  const loadDemoCircuit = (demoIndex = 0) => {
    const demo = demoCircuits[demoIndex] || demoCircuits[0];
    setActiveCircuit(demo);
    setOriginalScannedCircuit(JSON.parse(JSON.stringify(demo)));
    setHistoryStack([JSON.parse(JSON.stringify(demo))]);
    setHistoryIndex(0);
    setUploadedImage(null);
    setImageMeta(null);
    setRealAnalysisError(null);
    setSimulationSource(null);
    setSimulationResult(null);
  };

  // 2. Component Value Editing & Digital Modification
  const applyDigitalComponentValue = (compId, rawValue, rawUnit = 'Ω') => {
    if (!activeCircuit) return { success: false, error: 'No active circuit' };

    const targetComp = activeCircuit.components?.find(c => (c.id === compId || c.designator === compId));
    if (!targetComp) return { success: false, error: `Component ${compId} not found` };

    // Strict value parsing and validation
    const parsed = parseComponentValue(rawValue, targetComp.type || 'resistor');
    if (!parsed.isValid) {
      return { success: false, error: parsed.error || 'Invalid component value' };
    }

    const updatedComponents = activeCircuit.components.map(c => {
      if (c.id === compId || c.designator === compId) {
        return {
          ...c,
          value: parsed.siValue,
          unit: parsed.unit,
          displayValue: parsed.formatted,
          formatted_value: parsed.formatted,
          user_override_value: parsed.formatted,
          valueSource: 'user_confirmed',
          needsConfirmation: false,
          confidence: 1.0
        };
      }
      return c;
    });

    const newCircuit = {
      ...activeCircuit,
      components: updatedComponents
    };

    pushHistorySnapshot(newCircuit);
    setActiveCircuit(newCircuit);
    invalidateSimulation();

    // Update selectedComponent if it matches
    if (selectedComponent && (selectedComponent.id === compId || selectedComponent.designator === compId)) {
      setSelectedComponent(prev => ({
        ...prev,
        value: parsed.siValue,
        unit: parsed.unit,
        displayValue: parsed.formatted,
        formatted_value: parsed.formatted,
        user_override_value: parsed.formatted
      }));
    }

    return { success: true, formatted: parsed.formatted };
  };

  // Phase 17: Manual Component Recovery & Definition Layer
  const addManualResistor = ({ id, value, unit = 'Ω', hole1, hole2, replacingId = null }) => {
    if (!activeCircuit) return { success: false, error: 'No active circuit' };

    const parsed = parseComponentValue(value, 'resistor');
    if (!parsed.isValid) {
      return { success: false, error: parsed.error || 'Invalid resistance value' };
    }

    const h1 = (hole1 || 'A1').toUpperCase().trim();
    const h2 = (hole2 || 'A5').toUpperCase().trim();

    const compId = id || (replacingId ? replacingId : `R_MANUAL_${Date.now().toString().slice(-4)}`);
    const designator = compId;

    const manualComponent = {
      id: compId,
      designator: designator,
      name: `Manual Resistor (${parsed.formatted})`,
      type: 'resistor',
      value: parsed.siValue,
      unit: parsed.unit || 'Ω',
      displayValue: parsed.formatted,
      formatted_value: parsed.formatted,
      user_override_value: parsed.formatted,
      hole1: h1,
      hole2: h2,
      start_hole: h1,
      end_hole: h2,
      node1: `NODE_HOLE_${h1}`,
      node2: `NODE_HOLE_${h2}`,
      source: 'manual',
      verified: true,
      confidence: 1.0,
      needsConfirmation: false,
      valueSource: 'user_confirmed'
    };

    let updatedComponents = [];
    if (replacingId) {
      updatedComponents = (activeCircuit.components || []).map(c => {
        if (c.id === replacingId || c.designator === replacingId) {
          return manualComponent;
        }
        return c;
      });
    } else {
      const existingIdx = (activeCircuit.components || []).findIndex(c => c.id === compId || c.designator === compId);
      if (existingIdx >= 0) {
        updatedComponents = (activeCircuit.components || []).map((c, idx) => idx === existingIdx ? manualComponent : c);
      } else {
        updatedComponents = [...(activeCircuit.components || []), manualComponent];
      }
    }

    const newCircuit = {
      ...activeCircuit,
      components: updatedComponents
    };

    pushHistorySnapshot(newCircuit);
    setActiveCircuit(newCircuit);
    invalidateSimulation();

    return { success: true, component: manualComponent };
  };

  // 3. Digital Wire Manipulation (Add / Remove Digital Jumper Wires)
  const addDigitalWire = (hole1, hole2) => {
    if (!activeCircuit || !hole1 || !hole2) return;

    const wireId = `W_DIGITAL_${Date.now().toString().slice(-4)}`;
    const newWire = {
      id: wireId,
      designator: wireId,
      type: 'wire',
      is_digital: true,
      hole1: hole1,
      hole2: hole2,
      start_hole: hole1,
      end_hole: hole2,
      node1: `NODE_HOLE_${hole1}`,
      node2: `NODE_HOLE_${hole2}`
    };

    const newWires = [...(activeCircuit.wires || []), newWire];
    const newCircuit = {
      ...activeCircuit,
      wires: newWires
    };

    pushHistorySnapshot(newCircuit);
    setActiveCircuit(newCircuit);
    invalidateSimulation();
  };

  const removeDigitalWire = (wireId) => {
    if (!activeCircuit || !wireId) return;

    const newWires = (activeCircuit.wires || []).filter(w => w.id !== wireId && w.designator !== wireId);
    const newCircuit = {
      ...activeCircuit,
      wires: newWires
    };

    pushHistorySnapshot(newCircuit);
    setActiveCircuit(newCircuit);
    invalidateSimulation();
  };

  // 4. Undo / Redo / Reset Functions
  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < historyStack.length - 1;

  const undoDigitalEdit = () => {
    if (!canUndo) return;
    const targetIdx = historyIndex - 1;
    const snapshot = historyStack[targetIdx];
    if (snapshot) {
      isUndoRedoActionRef.current = true;
      setHistoryIndex(targetIdx);
      setActiveCircuit(JSON.parse(JSON.stringify(snapshot)));
    }
  };

  const redoDigitalEdit = () => {
    if (!canRedo) return;
    const targetIdx = historyIndex + 1;
    const snapshot = historyStack[targetIdx];
    if (snapshot) {
      isUndoRedoActionRef.current = true;
      setHistoryIndex(targetIdx);
      setActiveCircuit(JSON.parse(JSON.stringify(snapshot)));
    }
  };

  const resetDigitalChanges = () => {
    if (originalScannedCircuit) {
      const resetSnapshot = JSON.parse(JSON.stringify(originalScannedCircuit));
      pushHistorySnapshot(resetSnapshot);
      setActiveCircuit(resetSnapshot);
      setSelectedComponent(null);
      setSelectedNet(null);
    }
  };

  const applyBackendCorrection = useCallback((correctionResult) => {
    if (!correctionResult || correctionResult.status !== 'APPLIED') return false;

    const newCircuit = correctionResult.circuit || activeCircuit;
    
    // Invalidate stale simulation results immediately per Phase 21.1 Rule 8
    setSimulationResult(null);
    setMeasurements({});
    setSolverStatus('NOT_RUN');
    setSolverError(null);

    setActiveCircuit(newCircuit);
    pushHistorySnapshot(newCircuit);
    return true;
  }, [activeCircuit, pushHistorySnapshot]);

  const updateComponentTerminals = useCallback((componentId, hole1, hole2) => {
    if (!activeCircuit) return;

    const updatedComponents = (activeCircuit.components || []).map(comp => {
      const cid = comp.id || comp.designator;
      if (cid === componentId) {
        return {
          ...comp,
          start_hole: hole1,
          end_hole: hole2,
          hole1: hole1,
          hole2: hole2,
          node1: hole1,
          node2: hole2,
          terminals: {
            terminal_a: { hole: hole1, node_id: hole1, ambiguous: false },
            terminal_b: { hole: hole2, node_id: hole2, ambiguous: false }
          },
          verified: true,
          verification: 'VERIFIED',
          user_override_terminals: true
        };
      }
      return comp;
    });

    const updatedCircuit = {
      ...activeCircuit,
      components: updatedComponents
    };

    // Invalidate simulation on manual terminal update
    invalidateSimulation();
    setSolverStatus('NOT_RUN');

    setActiveCircuit(updatedCircuit);
    pushHistorySnapshot(updatedCircuit);
  }, [activeCircuit, pushHistorySnapshot, invalidateSimulation]);

  // Phase 24.2 Manual Supply Actions
  const configureSupply = useCallback(async (posNode, gndNode, voltageVal) => {
    const res = await configureSupplyAPI(posNode, gndNode, voltageVal, activeCircuit);
    if (res && res.supply) {
      setSupplyConfiguration(res.supply);
    }
    invalidateSimulation();
    if (activeCircuit) {
      setActiveCircuit(prev => ({
        ...prev,
        supply: res?.supply,
        circuit_signature: res?.circuit_signature || prev.circuit_signature
      }));
    }
    return res;
  }, [activeCircuit, invalidateSimulation]);

  const clearSupply = useCallback(async () => {
    const res = await clearSupplyAPI(activeCircuit);
    setSupplyConfiguration({
      enabled: false,
      source_id: 'V1',
      positive_node: null,
      ground_node: null,
      voltage: 5.0,
      reference: 'GROUND',
      status: 'NOT_CONFIGURED'
    });
    invalidateSimulation();
    if (activeCircuit) {
      setActiveCircuit(prev => ({
        ...prev,
        supply: null,
        circuit_signature: res?.circuit_signature || prev.circuit_signature
      }));
    }
    return res;
  }, [activeCircuit, invalidateSimulation]);

  const simulateCircuit = useCallback(async (options = {}) => {
    if (!activeCircuit) {
      setSimulationStatus('BLOCKED');
      setSimulationError('AMBIGUOUS_CIRCUIT');
      return null;
    }

    setSimulationStatus('RUNNING');
    setSimulationError(null);

    const simRes = await simulateCircuitAPI(activeCircuit, supplyConfiguration, activeCircuit.circuit_signature, options);

    if (simRes && simRes.status === 'SOLVED') {
      setSimulationResult(simRes);
      setSimulationStatus('SOLVED');
      setSimulationSignature(simRes.circuit_signature || activeCircuit.circuit_signature);
      setSimulationError(null);
      setCurrentTimeIndex(0);
      setIsPlaying(false);
      if (simRes.results?.measurements) {
        setMeasurements(simRes.results.measurements);
      }
      return simRes;
    } else {
      setSimulationResult(null);
      setSimulationStatus('BLOCKED');
      setSimulationSignature(null);
      setSimulationError(simRes?.reason || 'SOLVER_ERROR');
      return simRes;
    }
  }, [activeCircuit, supplyConfiguration]);

  // 5. What-If Simulation Engine
  const startWhatIf = async (targetComp, candidateVal) => {
    if (!activeCircuit || !targetComp) return;

    const parsed = parseComponentValue(candidateVal, targetComp.type || 'resistor');
    if (!parsed.isValid) return;

    const originalVal = targetComp.user_override_value || targetComp.displayValue || targetComp.formatted_value || `${targetComp.value} ${targetComp.unit || 'Ω'}`;

    // Clone circuit and apply candidate value for What-If
    const whatIfComponents = activeCircuit.components.map(c => {
      if (c.id === targetComp.id || c.designator === targetComp.designator) {
        return {
          ...c,
          value: parsed.siValue,
          unit: parsed.unit,
          displayValue: parsed.formatted,
          formatted_value: parsed.formatted,
          user_override_value: parsed.formatted
        };
      }
      return c;
    });

    const whatIfCircuit = {
      ...activeCircuit,
      components: whatIfComponents
    };

    // Run simulation for What-If without overwriting authoritative simulationResult
    const whatIfRes = await requestDcSimulation(whatIfCircuit);

    setWhatIfState({
      active: true,
      targetComponent: targetComp,
      originalValue: originalVal,
      candidateValue: parsed.formatted,
      originalSimulationResult: simulationResult,
      whatIfSimulationResult: whatIfRes
    });
  };

  const applyWhatIfToCircuit = () => {
    if (!whatIfState.active || !whatIfState.targetComponent) return;

    applyDigitalComponentValue(
      whatIfState.targetComponent.id || whatIfState.targetComponent.designator,
      whatIfState.candidateValue
    );

    setWhatIfState({
      active: false,
      targetComponent: null,
      originalValue: '',
      candidateValue: '',
      originalSimulationResult: null,
      whatIfSimulationResult: null
    });
  };

  const cancelWhatIf = () => {
    setWhatIfState({
      active: false,
      targetComponent: null,
      originalValue: '',
      candidateValue: '',
      originalSimulationResult: null,
      whatIfSimulationResult: null
    });
  };

  // 6. Net Selection & Highlighting
  const selectNet = (netId) => {
    setSelectedNet(prev => (prev === netId ? null : netId));
  };

  // 7. Versioned Save / Load Digital Circuit Schema
  const exportDigitalCircuitJson = () => {
    if (!activeCircuit) return null;

    const schema = {
      schema_version: 1,
      project: "SmartBreadboard3D",
      created_at: new Date().toISOString(),
      circuit_id: activeCircuit.id || 'circ_custom',
      metadata: activeCircuit.metadata || { source: 'digital_export' },
      power_sources: activeCircuit.power_sources || [],
      simulation_source: simulationSource,
      components: (activeCircuit.components || []).map(c => ({
        id: c.id,
        designator: c.designator,
        type: c.type,
        value: c.value,
        unit: c.unit,
        formatted_value: c.formatted_value || c.displayValue,
        user_override_value: c.user_override_value,
        hole1: c.hole1 || c.start_hole,
        hole2: c.hole2 || c.end_hole,
        node1: c.node1,
        node2: c.node2,
        is_digital: c.is_digital || false
      })),
      wires: activeCircuit.wires || []
    };

    return JSON.stringify(schema, null, 2);
  };

  const importDigitalCircuitJson = (jsonStringOrObj) => {
    try {
      const data = typeof jsonStringOrObj === 'string' ? JSON.parse(jsonStringOrObj) : jsonStringOrObj;
      if (!data || !data.components) {
        return { success: false, error: 'Invalid circuit file format: missing components' };
      }

      const importedCircuit = {
        id: data.circuit_id || 'circ_imported',
        name: data.project ? `Imported (${data.project})` : 'Imported Circuit',
        source: 'imported',
        metadata: data.metadata || { source: 'imported', created_at: new Date().toISOString() },
        nodes: data.nodes || [],
        nets: data.nets || [],
        components: data.components || [],
        wires: data.wires || [],
        power_sources: data.power_sources || [],
        validity: { status: 'PASS', warnings: [] }
      };

      setActiveCircuit(importedCircuit);
      setOriginalScannedCircuit(JSON.parse(JSON.stringify(importedCircuit)));
      pushHistorySnapshot(importedCircuit);
      if (data.simulation_source) {
        setSimulationSource(data.simulation_source);
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  };

  const applySimulationPower = (sourceObj) => {
    setSimulationSource({
      type: sourceObj.type || "dc_voltage",
      value: parseFloat(sourceObj.voltage || sourceObj.value || 12.0),
      unit: sourceObj.unit || "V",
      positiveNode: sourceObj.positiveNode,
      negativeNode: sourceObj.negativeNode,
      source: "user_simulated"
    });
  };

  const resetSimulationPower = () => {
    setSimulationSource(null);
    setSimulation(prev => ({ ...prev, running: false, time: 0 }));
    setTimeSeriesData([]);
    setTransientAnalysis(null);
  };

  // Phase 29: Run Transient Analysis Action
  const runTransientAnalysis = useCallback(async (customOptions = {}) => {
    if (!activeCircuit) return null;
    const currentSources = [...(activeCircuit.power_sources || [])];
    if (simulationSource) {
      currentSources.push({
        id: "V_SIMULATED",
        type: simulationSource.type || "step",
        voltage: parseFloat(simulationSource.value || 5.0),
        positive_node: simulationSource.positiveNode,
        negative_node: simulationSource.negativeNode,
        source: simulationSource.source || "user_simulated"
      });
    }

    const netlistToSolve = {
      ...activeCircuit,
      power_sources: currentSources
    };

    const mergedOptions = {
      ...transientConfig,
      ...customOptions,
      powerSource: simulationSource
    };

    const res = await requestTransientAnalysis(netlistToSolve, mergedOptions);
    setTransientAnalysis(res);
    return res;
  }, [activeCircuit, simulationSource, transientConfig]);

  const clearTransientAnalysis = useCallback(() => {
    setTransientAnalysis(null);
  }, []);

  return (
    <CircuitContext.Provider value={{
      activeCircuit,
      setActiveCircuit,
      originalScannedCircuit,
      uploadedImage,
      setUploadedImage,
      imageMeta,
      setImageMeta,
      isAnalyzingReal,
      setIsAnalyzingReal,
      realAnalysisError,
      setRealAnalysisError,
      setRealCircuitData,
      setMockCircuitData,
      loadDemoCircuit,
      isEditMode,
      setIsEditMode,
      applyDigitalComponentValue,
      addManualResistor,
      updateComponentTerminals,
      applyBackendCorrection,
      addDigitalWire,
      removeDigitalWire,
      undoDigitalEdit,
      redoDigitalEdit,
      resetDigitalChanges,
      canUndo,
      canRedo,
      whatIfState,
      startWhatIf,
      applyWhatIfToCircuit,
      cancelWhatIf,
      selectedNet,
      selectNet,
      exportDigitalCircuitJson,
      importDigitalCircuitJson,
      simulationSource,
      applySimulationPower,
      resetSimulationPower,
      simulation,
      setSimulation,
      simulationResult,
      setSimulationResult,
      measurements,
      setMeasurements,
      solverStatus,
      setSolverStatus,
      solverError,
      setSolverError,
      selectedComponent,
      setSelectedComponent,
      timeSeriesData,
      setTimeSeriesData,
      circuitIntelligence,
      transientAnalysis,
      setTransientAnalysis,
      transientConfig,
      setTransientConfig,
      runTransientAnalysis,
      clearTransientAnalysis,
      // Phase 24.2 Manual Supply Configuration & Simulation Control
      supplyConfiguration,
      configureSupply,
      clearSupply,
      simulateCircuit,
      simulationStatus,
      simulationError,
      simulationSignature,
      // Phase 24.4 Real RLC Transient Simulation Controls & Timeline
      currentTimeIndex,
      setCurrentTimeIndex,
      isPlaying,
      playbackSpeed,
      setPlaybackSpeed,
      currentTransientSample,
      playSimulation,
      pauseSimulation,
      restartSimulation,
      seekSimulation,
      resetSimulation,
      // Real-Time ESP32 Hardware Telemetry
      hardwareTelemetry,
      setHardwareTelemetry
    }}>
      {children}
    </CircuitContext.Provider>
  );

}

export function useCircuit() {
  const context = useContext(CircuitContext);
  if (!context) {
    throw new Error('useCircuit must be used within a CircuitProvider');
  }
  return context;
}
