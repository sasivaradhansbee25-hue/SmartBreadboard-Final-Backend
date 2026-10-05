/**
 * SmartBreadboard 3D — Manual Supply Configuration & Simulation Control Service (Phase 24.2)
 *
 * Provides client-side validation, API communication with FastAPI backend,
 * and deterministic state management between Photo-to-Circuit Mapping and MNA solver.
 *
 * Rules:
 * 1. User explicitly selects VCC and GND nodes.
 * 2. Node dropdowns populated ONLY from verified circuit nodes.
 * 3. Positive and ground cannot be the same node.
 * 4. Voltage must be numeric and > 0.
 * 5. Changes to supply invalidate previous simulation results.
 * 6. Stale simulations are rejected.
 * 7. Scientific integrity: physical validation status is strictly "NOT PERFORMED".
 */

import { apiRequest } from './api.js';

export const SUPPLY_STATUS = {
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  INVALID_NODE: 'INVALID_NODE',
  SAME_NODE: 'SAME_NODE',
  INVALID_VOLTAGE: 'INVALID_VOLTAGE',
  VALID: 'VALID',
  BLOCKED: 'BLOCKED'
};

export const SIMULATION_STATUS = {
  NOT_RUN: 'NOT_RUN',
  RUNNING: 'RUNNING',
  SOLVED: 'SOLVED',
  BLOCKED: 'BLOCKED',
  ERROR: 'ERROR'
};

export const REASON_CODES = {
  SUPPLY_REQUIRED: 'SUPPLY_CONFIGURATION_REQUIRED',
  AMBIGUOUS_CIRCUIT: 'AMBIGUOUS_CIRCUIT',
  UNKNOWN_COMPONENT: 'UNKNOWN_COMPONENT',
  INVALID_SUPPLY_NODE: 'INVALID_SUPPLY_NODE',
  SAME_SUPPLY_REFERENCE: 'SAME_SUPPLY_REFERENCE',
  INVALID_VOLTAGE: 'INVALID_VOLTAGE',
  STALE_CIRCUIT: 'STALE_CIRCUIT',
  SOLVER_ERROR: 'SOLVER_ERROR'
};

/**
 * Extracts a list of unique verified node IDs from a circuit state.
 * Returns only valid, resolved electrical nodes.
 */
export function extractVerifiedNodes(circuitState) {
  if (!circuitState) return [];

  const nodeSet = new Set();

  // 1. From nodes array
  if (Array.isArray(circuitState.nodes)) {
    for (const n of circuitState.nodes) {
      const nid = typeof n === 'object' && n !== null ? (n.node_id || n.id) : n;
      if (nid && nid !== 'UNRESOLVED') {
        nodeSet.add(String(nid));
      }
    }
  }

  // 2. From connections
  if (Array.isArray(circuitState.connections)) {
    for (const c of circuitState.connections) {
      if (c && c.node_id && c.node_id !== 'UNRESOLVED') {
        nodeSet.add(String(c.node_id));
      }
    }
  }

  // 3. From component terminals
  if (Array.isArray(circuitState.components)) {
    for (const comp of circuitState.components) {
      if (Array.isArray(comp.terminals)) {
        for (const term of comp.terminals) {
          if (term && term.node && term.node !== 'UNRESOLVED') {
            nodeSet.add(String(term.node));
          }
        }
      }
      if (comp.node1 && comp.node1 !== 'UNRESOLVED') nodeSet.add(String(comp.node1));
      if (comp.node2 && comp.node2 !== 'UNRESOLVED') nodeSet.add(String(comp.node2));
    }
  }

  return Array.from(nodeSet).sort();
}

/**
 * Validates power supply parameters locally before submission.
 */
export function validateSupply(circuitState, positiveNode, groundNode, voltage) {
  if (!circuitState) {
    return {
      valid: false,
      status: SUPPLY_STATUS.BLOCKED,
      reason: REASON_CODES.AMBIGUOUS_CIRCUIT,
      message: 'No circuit loaded.'
    };
  }

  // Circuit-level ambiguity / verification check
  if (circuitState.status === 'AMBIGUOUS' || circuitState.status === 'UNVERIFIED' || circuitState.simulation_readiness_reason === 'AMBIGUOUS_TERMINAL_MAPPING' || circuitState.simulation_readiness_reason === 'CIRCUIT_CONNECTIONS_NOT_VERIFIED') {
    return {
      valid: false,
      status: SUPPLY_STATUS.BLOCKED,
      reason: REASON_CODES.AMBIGUOUS_CIRCUIT,
      message: 'Circuit connections not verified. Reconstruct or re-upload photo before configuring power.'
    };
  }

  // Unknown or unverified component check
  const components = circuitState.components || [];
  for (const c of components) {
    const type = String(c.type || c.class || '').toUpperCase();
    const status = String(c.status || '').toUpperCase();
    if (type === 'UNKNOWN' || status === 'UNKNOWN' || status === 'AMBIGUOUS' || status === 'UNVERIFIED') {
      return {
        valid: false,
        status: SUPPLY_STATUS.BLOCKED,
        reason: REASON_CODES.UNKNOWN_COMPONENT,
        message: `Circuit component ${c.id || 'unnamed'} has unverified connections. Cannot simulate.`
      };
    }
    // Check terminals
    if (Array.isArray(c.terminals)) {
      for (const t of c.terminals) {
        if (!t.hole || t.node === 'UNRESOLVED' || t.status === 'UNVERIFIED') {
          return {
            valid: false,
            status: SUPPLY_STATUS.BLOCKED,
            reason: REASON_CODES.AMBIGUOUS_CIRCUIT,
            message: `Component ${c.id} has unmapped or unverified terminal ${t.terminal || t.pin}.`
          };
        }
      }
    }
  }

  // Positive supply node selection
  if (!positiveNode) {
    return {
      valid: false,
      status: SUPPLY_STATUS.NOT_CONFIGURED,
      reason: REASON_CODES.SUPPLY_REQUIRED,
      message: 'Please select a positive supply node (VCC).'
    };
  }

  // Ground node selection
  if (!groundNode) {
    return {
      valid: false,
      status: SUPPLY_STATUS.NOT_CONFIGURED,
      reason: REASON_CODES.SUPPLY_REQUIRED,
      message: 'Please select a ground reference node (GND).'
    };
  }

  const validNodes = extractVerifiedNodes(circuitState);

  if (!validNodes.includes(String(positiveNode))) {
    return {
      valid: false,
      status: SUPPLY_STATUS.INVALID_NODE,
      reason: REASON_CODES.INVALID_SUPPLY_NODE,
      message: `Selected positive node '${positiveNode}' is not in verified circuit.`
    };
  }

  if (!validNodes.includes(String(groundNode))) {
    return {
      valid: false,
      status: SUPPLY_STATUS.INVALID_NODE,
      reason: REASON_CODES.INVALID_SUPPLY_NODE,
      message: `Selected ground node '${groundNode}' is not in verified circuit.`
    };
  }

  if (String(positiveNode) === String(groundNode)) {
    return {
      valid: false,
      status: SUPPLY_STATUS.SAME_NODE,
      reason: REASON_CODES.SAME_SUPPLY_REFERENCE,
      message: 'Positive supply and ground cannot be connected to the same node.'
    };
  }

  // Voltage numeric check
  const numVoltage = typeof voltage === 'number' ? voltage : parseFloat(voltage);
  if (isNaN(numVoltage) || typeof voltage === 'boolean') {
    return {
      valid: false,
      status: SUPPLY_STATUS.INVALID_VOLTAGE,
      reason: REASON_CODES.INVALID_VOLTAGE,
      message: 'Supply voltage must be a valid number.'
    };
  }

  if (numVoltage <= 0) {
    return {
      valid: false,
      status: SUPPLY_STATUS.INVALID_VOLTAGE,
      reason: REASON_CODES.INVALID_VOLTAGE,
      message: 'Supply voltage must be strictly greater than 0V.'
    };
  }

  return {
    valid: true,
    status: SUPPLY_STATUS.VALID,
    reason: null,
    voltage: numVoltage,
    message: `Supply configuration valid: ${numVoltage.toFixed(2)} V (${positiveNode} -> ${groundNode})`
  };
}

/**
 * Sends supply configuration to backend.
 */
export async function configureSupplyAPI(positiveNode, groundNode, voltage, circuitState = null) {
  try {
    const res = await apiRequest('/circuit/supply/configure', 'POST', {
      positive_node: positiveNode,
      ground_node: groundNode,
      voltage: typeof voltage === 'number' ? voltage : parseFloat(voltage),
      source_id: 'V1',
      circuit_state: circuitState
    });

    if (res && res.supply) {
      return res;
    }
  } catch (err) {
    console.warn('[supplyConfigurationService] configureSupplyAPI failed:', err);
  }

  // Fallback deterministic local config
  const val = validateSupply(circuitState, positiveNode, groundNode, voltage);
  return {
    status: val.status,
    supply: {
      enabled: val.valid,
      source_id: 'V1',
      positive_node: positiveNode,
      ground_node: groundNode,
      voltage: typeof voltage === 'number' ? voltage : parseFloat(voltage),
      reference: 'GROUND',
      status: val.status
    },
    circuit_signature: circuitState?.circuit_signature || 'LOCAL_SIG',
    simulation_ready: val.valid,
    simulation_readiness_reason: val.reason
  };
}

/**
 * Clears supply configuration in backend.
 */
export async function clearSupplyAPI(circuitState = null) {
  try {
    const res = await apiRequest('/circuit/supply/clear', 'POST', {
      circuit_state: circuitState
    });
    if (res && res.supply) {
      return res;
    }
  } catch (err) {
    console.warn('[supplyConfigurationService] clearSupplyAPI failed:', err);
  }

  return {
    status: SUPPLY_STATUS.NOT_CONFIGURED,
    supply: {
      enabled: false,
      source_id: 'V1',
      positive_node: null,
      ground_node: null,
      voltage: 0.0,
      reference: 'GROUND',
      status: SUPPLY_STATUS.NOT_CONFIGURED
    },
    circuit_signature: circuitState?.circuit_signature || 'LOCAL_SIG',
    simulation_ready: false
  };
}

/**
 * Fetches active supply configuration.
 */
export async function getSupplyAPI() {
  try {
    const res = await apiRequest('/circuit/supply', 'GET');
    if (res && res.supply) {
      return res;
    }
  } catch (err) {
    console.warn('[supplyConfigurationService] getSupplyAPI failed:', err);
  }

  return {
    supply: {
      enabled: false,
      source_id: 'V1',
      positive_node: null,
      ground_node: null,
      voltage: 0.0,
      reference: 'GROUND',
      status: SUPPLY_STATUS.NOT_CONFIGURED
    },
    circuit_signature: null,
    simulation_ready: false
  };
}

/**
 * Dispatches simulation request to deterministic MNA solver.
 */
export async function simulateCircuitAPI(circuitState, supply = null, expectedSignature = null, options = {}) {
  // Pre-validate locally
  const activeSupply = supply || circuitState?.supply;
  const val = validateSupply(
    circuitState,
    activeSupply?.positive_node,
    activeSupply?.ground_node,
    activeSupply?.voltage
  );

  if (!val.valid) {
    return {
      status: SIMULATION_STATUS.BLOCKED,
      circuit_signature: circuitState?.circuit_signature || '',
      reason: val.reason,
      detail: val.message
    };
  }

  // Detect dynamic/reactive elements (inductor, capacitor)
  const components = circuitState?.components || [];
  const hasReactive = components.some(c => {
    const t = String(c.type || c.class || '').toLowerCase();
    return t.includes('cap') || t.includes('ind');
  });

  const mode = options.simulation_mode || (hasReactive ? 'transient' : 'transient');

  try {
    const payload = {
      circuit_state: circuitState,
      supply: activeSupply,
      expected_signature: expectedSignature || circuitState?.circuit_signature,
      simulation_mode: mode,
      duration: options.duration || 0.01,
      timestep: options.timestep || 0.0001
    };

    const res = await apiRequest('/circuit/simulate', 'POST', payload);

    if (res && (res.status === SIMULATION_STATUS.SOLVED || res.status === SIMULATION_STATUS.BLOCKED)) {
      return res;
    }
  } catch (err) {
    console.warn('[supplyConfigurationService] simulateCircuitAPI backend call failed:', err);
  }

  return {
    status: SIMULATION_STATUS.BLOCKED,
    circuit_signature: circuitState?.circuit_signature || '',
    reason: REASON_CODES.SOLVER_ERROR,
    detail: 'Backend MNA solver offline or unreachable.'
  };
}

/**
 * Checks if a simulation result is stale relative to current circuit state.
 */
export function isSignatureStale(currentSignature, simulationSignature) {
  if (!simulationSignature) return true;
  if (!currentSignature) return false;
  return currentSignature !== simulationSignature;
}

/**
 * Extracts electrical metrics (V, I, P) for a specific component from simulation results.
 * Returns null if simulation is stale or unperformed.
 */
export function extractComponentMetrics(simulationResult, componentId, currentCircuitSignature = null) {
  if (!simulationResult || simulationResult.status !== SIMULATION_STATUS.SOLVED) {
    return null;
  }

  // Reject stale simulation results
  if (currentCircuitSignature && isSignatureStale(currentCircuitSignature, simulationResult.simulation_signature)) {
    return null;
  }

  const results = simulationResult.results || {};
  const currents = results.branch_currents || simulationResult.component_currents || {};
  const powers = results.component_power || simulationResult.component_power || {};
  const voltages = simulationResult.component_voltages || {};
  const measurements = results.measurements || {};

  const meas = measurements[componentId] || {};
  const currentA = currents[componentId] !== undefined ? currents[componentId] : (meas.current || 0.0);
  const powerW = powers[componentId] !== undefined ? powers[componentId] : (meas.power || 0.0);
  const voltageDrop = meas.voltage_drop !== undefined ? meas.voltage_drop : (voltages[componentId] !== undefined ? voltages[componentId] : 0.0);

  return {
    componentId,
    voltageDrop,
    currentA,
    currentMA: currentA * 1000.0,
    powerW,
    powerMW: powerW * 1000.0,
    state: meas.state || (currentA > 0.001 ? 'ACTIVE' : 'OFF'),
    direction: meas.direction || 'unknown'
  };
}

export default {
  SUPPLY_STATUS,
  SIMULATION_STATUS,
  REASON_CODES,
  extractVerifiedNodes,
  validateSupply,
  configureSupplyAPI,
  clearSupplyAPI,
  getSupplyAPI,
  simulateCircuitAPI,
  isSignatureStale,
  extractComponentMetrics
};
