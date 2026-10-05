/**
 * SmartBreadboard 3D — Photo Circuit Mapping Service (Phase 24.1)
 *
 * Provides API communication and deterministic client-side helpers to transform
 * breadboard photos into verified circuit models ready for manual supply configuration (Phase 24.2).
 */

import { API_BASE_URL } from './api.js';

/**
 * Standard 830 tie-point hole mapping to internal node ID helper.
 */
export function getCanonicalNodeForHole(holeId) {
  if (!holeId || typeof holeId !== 'string') return 'NODE_DISCONNECTED';
  const hUpper = holeId.trim().toUpperCase();

  if (hUpper.startsWith('VCC_TOP') || hUpper.startsWith('VCC_1') || hUpper === 'VCC') {
    return 'NODE_VCC';
  } else if (hUpper.startsWith('GND_TOP') || hUpper.startsWith('GND_1') || hUpper === 'GND') {
    return 'NODE_GND';
  } else if (hUpper.startsWith('VCC_BOT') || hUpper.startsWith('VCC_2')) {
    return 'NODE_VCC_BOT';
  } else if (hUpper.startsWith('GND_BOT') || hUpper.startsWith('GND_2')) {
    return 'NODE_GND_BOT';
  }

  const match = hUpper.match(/^([A-J])(\d+)$/);
  if (match) {
    const row = match[1];
    const col = parseInt(match[2], 10);
    if (['A', 'B', 'C', 'D', 'E'].includes(row)) {
      return `NODE_COL_${col}_TOP`;
    } else {
      return `NODE_COL_${col}_BOT`;
    }
  }

  return `NODE_HOLE_${hUpper}`;
}

/**
 * Disjoint Set Union helper to merge connected breadboard pins and jumper wires.
 */
export class ClientDisjointSetUnion {
  constructor() {
    this.parent = {};
  }

  find(i) {
    if (!(i in this.parent)) {
      this.parent[i] = i;
      return i;
    }
    if (this.parent[i] === i) return i;
    this.parent[i] = this.find(this.parent[i]);
    return this.parent[i];
  }

  union(i, j) {
    const rootI = this.find(i);
    const rootJ = this.find(j);
    if (rootI !== rootJ) {
      const isPwrI = rootI.includes('POWER') || rootI.includes('VCC');
      const isGndI = rootI.includes('GROUND') || rootI.includes('GND');
      const isPwrJ = rootJ.includes('POWER') || rootJ.includes('VCC');
      const isGndJ = rootJ.includes('GROUND') || rootJ.includes('GND');

      if ((isPwrI || isGndI) && !(isPwrJ || isGndJ)) {
        this.parent[rootJ] = rootI;
      } else if ((isPwrJ || isGndJ) && !(isPwrI || isGndI)) {
        this.parent[rootI] = rootJ;
      } else {
        if (rootI < rootJ) {
          this.parent[rootJ] = rootI;
        } else {
          this.parent[rootI] = rootJ;
        }
      }
    }
  }
}

/**
 * Recomputes electrical nodes and connections from a list of components and resolved holes.
 */
export function buildElectricalGraphFromComponents(components) {
  const dsu = new ClientDisjointSetUnion();

  // Register all mapped holes
  components.forEach(c => {
    (c.terminals || []).forEach(t => {
      if (t.hole && (t.status === 'VERIFIED' || t.status === 'AMBIGUOUS')) {
        const base = getCanonicalNodeForHole(t.hole);
        dsu.find(base);
      }
    });
  });

  // Merge nodes for jumper wires
  components.forEach(c => {
    if (c.type === 'wire' && c.terminals && c.terminals.length >= 2) {
      const h1 = c.terminals[0].hole;
      const h2 = c.terminals[1].hole;
      if (h1 && h2) {
        const b1 = getCanonicalNodeForHole(h1);
        const b2 = getCanonicalNodeForHole(h2);
        dsu.union(b1, b2);
      }
    }
  });

  // Assign clean human-readable node IDs
  const allRoots = Array.from(new Set(Object.keys(dsu.parent).map(n => dsu.find(n)))).sort();
  const rootToCleanId = {};
  let nodeCounter = 1;

  allRoots.forEach(root => {
    if (root.includes('VCC') || root.includes('POWER')) {
      rootToCleanId[root] = 'NODE_VCC';
    } else if (root.includes('GND') || root.includes('GROUND')) {
      rootToCleanId[root] = 'NODE_GND';
    } else {
      rootToCleanId[root] = `NODE_${nodeCounter++}`;
    }
  });

  const resolvedNodesDict = {};
  const connections = [];

  const updatedComponents = components.map(c => {
    const updatedTerminals = (c.terminals || []).map(t => {
      if (t.hole) {
        const base = getCanonicalNodeForHole(t.hole);
        const root = dsu.find(base);
        const cleanNid = rootToCleanId[root] || `NODE_${root}`;
        if (!resolvedNodesDict[cleanNid]) {
          resolvedNodesDict[cleanNid] = new Set();
        }
        resolvedNodesDict[cleanNid].add(`${c.id}.${t.terminal}`);
        connections.push({
          component_id: c.id,
          terminal: t.terminal,
          node_id: cleanNid,
          hole: t.hole
        });
        return { ...t, node: cleanNid };
      }
      return { ...t, node: 'UNRESOLVED' };
    });

    return { ...c, terminals: updatedTerminals };
  });

  const nodesList = Object.keys(resolvedNodesDict).sort().map(nid => ({
    node_id: nid,
    members: Array.from(resolvedNodesDict[nid]).sort()
  }));

  return {
    components: updatedComponents,
    connections,
    nodes: nodesList
  };
}

/**
 * Resolves an ambiguous terminal with explicit user selection.
 */
export function resolveAmbiguousTerminal(pipelineResult, componentId, terminalName, selectedHole) {
  if (!pipelineResult || !pipelineResult.components) return pipelineResult;

  const newComponents = pipelineResult.components.map(comp => {
    if (comp.id !== componentId) return comp;

    const newTerminals = (comp.terminals || []).map(term => {
      if (term.terminal === terminalName) {
        return {
          ...term,
          hole: selectedHole,
          status: 'VERIFIED',
          reason: `Resolved by user to ${selectedHole}`,
          alternate_holes: null
        };
      }
      return term;
    });

    const isAllVerified = newTerminals.every(t => t.status === 'VERIFIED');
    return {
      ...comp,
      terminals: newTerminals,
      status: isAllVerified ? 'VERIFIED' : comp.status
    };
  });

  const graph = buildElectricalGraphFromComponents(newComponents);

  const hasAnyAmbiguous = graph.components.some(c =>
    (c.terminals || []).some(t => t.status === 'AMBIGUOUS')
  );
  const allVerified = graph.components.every(c => c.status === 'VERIFIED');

  let newStatus = 'READY';
  let simReady = false;
  let simReason = 'SUPPLY_CONFIGURATION_REQUIRED';

  if (hasAnyAmbiguous) {
    newStatus = 'AMBIGUOUS';
    simReason = 'AMBIGUOUS_TERMINAL_MAPPING';
  } else if (!allVerified) {
    newStatus = 'PARTIAL';
    simReason = 'PARTIAL_CIRCUIT_MAPPED';
  }

  return {
    ...pipelineResult,
    status: newStatus,
    components: graph.components,
    connections: graph.connections,
    nodes: graph.nodes,
    simulation_ready: simReady,
    simulation_readiness_reason: simReason
  };
}

/**
 * Converts Phase 24.1 pipeline result into CircuitContext format.
 */
export function formatPipelineResultForCircuitContext(pipelineResult, originalImage = null) {
  if (!pipelineResult) return null;

  const comps = (pipelineResult.components || []).map((c, idx) => {
    const term1 = c.terminals?.[0] || {};
    const term2 = c.terminals?.[1] || {};
    const tA = c.start_hole || c.hole1 || term1.hole || null;
    const tB = c.end_hole || c.hole2 || term2.hole || null;
    const nA = term1.node || c.node1 || (tA ? 'NODE_1' : 'UNRESOLVED');
    const nB = term2.node || c.node2 || (tB ? 'NODE_2' : 'UNRESOLVED');

    const isVerified = Boolean(tA && tB && c.status !== 'UNVERIFIED' && c.status !== 'UNRESOLVED' && c.status !== 'UNKNOWN');
    const compStatus = isVerified ? (c.status || 'VERIFIED') : (c.status || 'UNVERIFIED');

    const confVal = c.confidence || 0.95;
    const isUncertain = c.is_uncertain || confVal < 0.45 || compStatus === 'UNVERIFIED';
    const confCat = c.confidence_category || (isUncertain ? 'UNCERTAIN' : (confVal >= 0.75 ? 'CONFIRMED' : 'PROBABLE'));

    const bbox = c.bbox || c.boundingBox || [0, 0, 100, 100];
    const center = c.center || {
      x: Math.round(((bbox[0] || 0) + (bbox[2] || 0)) / 2),
      y: Math.round(((bbox[1] || 0) + (bbox[3] || 0)) / 2)
    };

    return {
      id: c.id,
      component_id: c.id,
      designator: c.id,
      type: c.type,
      class: c.type,
      terminal_a: tA,
      terminal_b: tB,
      hole_mapping: { terminal_a: tA, terminal_b: tB },
      start_hole: tA,
      end_hole: tB,
      hole1: tA,
      hole2: tB,
      node1: nA,
      node2: nB,
      value: isUncertain ? 'UNCERTAIN' : (c.value !== undefined ? c.value : (c.nominal_value !== undefined ? c.nominal_value : (c.type === 'resistor' ? 220.0 : (c.type === 'inductor' ? 0.01 : (c.type === 'capacitor' ? 1e-5 : (c.type === 'led' ? 2.0 : (c.type === 'motor' ? 1.0 : 0.001))))))),
      unit: c.unit || (c.type === 'resistor' ? 'Ω' : (c.type === 'inductor' ? 'H' : (c.type === 'capacitor' ? 'F' : (c.type === 'led' ? 'V' : (c.type === 'motor' ? 'HP' : 'Ω'))))),
      displayValue: isUncertain ? 'UNCERTAIN' : (c.displayValue || c.formatted_value || `${c.value ?? c.nominal_value ?? ''} ${c.unit || ''}`.trim()),
      formatted_value: isUncertain ? 'UNCERTAIN' : (c.formatted_value || c.displayValue || `${c.value ?? c.nominal_value ?? ''} ${c.unit || ''}`.trim()),
      status: compStatus,
      confidence: confVal,
      confidenceCategory: confCat,
      isUncertain: isUncertain,
      bbox: bbox,
      boundingBox: bbox,
      center: center,
      position: c.position || { u: 0.5, v: 0.5 },
      orientation: c.orientation || 0.0,
      terminals: c.terminals || [
        { pin: 1, terminal: 'terminal_a', name: 'terminal_a', hole: tA, node: nA, status: tA ? 'VERIFIED' : 'UNVERIFIED' },
        { pin: 2, terminal: 'terminal_b', name: 'terminal_b', hole: tB, node: nB, status: tB ? 'VERIFIED' : 'UNVERIFIED' }
      ]
    };
  });

  const wires = comps.filter(c => c.type === 'wire');
  const signature = pipelineResult.circuit_signature || `sig_scanned_${Date.now()}`;

  return {
    id: `circ_${signature}`,
    name: 'User Scanned Physical Circuit',
    circuit_signature: signature,
    signature: signature,
    source: pipelineResult.source || 'real',
    circuit_source: 'REAL_SCANNED_CIRCUIT',
    is_scanned: true,
    isRealScanned: true,
    netlist: pipelineResult.netlist ? {
      ...pipelineResult.netlist,
      components: pipelineResult.netlist.components || comps,
      nodes: pipelineResult.netlist.nodes || pipelineResult.nodes || []
    } : {
      circuit_id: `circ_${signature}`,
      name: 'User Scanned Physical Circuit',
      source: pipelineResult.source || 'real',
      metadata: {
        status: pipelineResult.status || 'VERIFIED',
        signature: signature,
        created_at: new Date().toISOString()
      },
      nodes: pipelineResult.nodes || [],
      components: comps,
      wires: wires,
      power_sources: [],
      solver_status: pipelineResult.solver_status || 'POWER_REQUIRED',
      solver_reason: null
    },
    originalImage: originalImage,
    imageMeta: {
      width: pipelineResult.breadboard?.width || 1280,
      height: pipelineResult.breadboard?.height || 850
    },
    detections: pipelineResult.components || [],
    components: comps,
    nodes: pipelineResult.nodes || [],
    connections: pipelineResult.connections || []
  };
}

/**
/**
 * Sends one or three breadboard photos to the backend mapping pipeline.
 * Supports single image, 3-view array [top, left, right], or { top, left, right }.
 */
export async function mapPhotoToCircuitApi(imageInput, mockDetections = null) {
  try {
    let response;

    // Check if input is multi-view array or object
    const isMultiView = Array.isArray(imageInput) || (imageInput && typeof imageInput === 'object' && ('top' in imageInput || 'views' in imageInput));

    if (isMultiView) {
      let viewsList = [];
      if (Array.isArray(imageInput)) {
        viewsList = imageInput;
      } else if (imageInput.views) {
        viewsList = imageInput.views;
      } else {
        viewsList = [imageInput.top, imageInput.left, imageInput.right].filter(Boolean);
      }

      // Check if items are Files/Blobs or base64 strings
      const hasFiles = viewsList.some(v => v instanceof File || v instanceof Blob);

      if (hasFiles) {
        const formData = new FormData();
        const vKeys = ['top_view', 'left_view', 'right_view'];
        viewsList.forEach((v, idx) => {
          if (v) formData.append(vKeys[idx] || `view_${idx + 1}`, v);
        });
        if (mockDetections) {
          formData.append('mock_detections', JSON.stringify(mockDetections));
        }
        response = await fetch(`${API_BASE_URL}/api/circuit/photo-map`, {
          method: 'POST',
          body: formData
        });
      } else {
        response = await fetch(`${API_BASE_URL}/api/circuit/photo-map`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            views: viewsList,
            mock_detections: mockDetections
          })
        });
      }
    } else if (imageInput instanceof File || imageInput instanceof Blob) {
      const formData = new FormData();
      formData.append('file', imageInput);
      if (mockDetections) {
        formData.append('mock_detections', JSON.stringify(mockDetections));
      }
      response = await fetch(`${API_BASE_URL}/api/circuit/photo-map`, {
        method: 'POST',
        body: formData
      });
    } else {
      let b64 = imageInput;
      if (typeof imageInput === 'object' && imageInput?.image_base64) {
        b64 = imageInput.image_base64;
      }
      response = await fetch(`${API_BASE_URL}/api/circuit/photo-map`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_base64: b64,
          mock_detections: mockDetections
        })
      });
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Pipeline API error (${response.status}): ${errText}`);
    }

    const data = await response.json();
    if (data && data.status === 'BLOCKED' && mockDetections && Array.isArray(mockDetections)) {
      throw new Error(`Backend decode blocked on mock data: ${data.reason || 'BLOCKED'}`);
    }
    return data;
  } catch (err) {
    console.warn('[PhotoCircuitService] Backend unavailable or returned error, evaluating client-side:', err.message);

    // Deterministic client fallback if mockDetections was provided
    if (mockDetections && Array.isArray(mockDetections)) {
      const processedComps = mockDetections.map((m, idx) => {
        const h1 = m.start_hole || m.hole1 || 'A10';
        const h2 = m.end_hole || m.hole2 || 'A15';
        const isAmb = m.status === 'AMBIGUOUS' || m.ambiguous_terminal;
        const ambTerm = m.ambiguous_terminal || 'terminal_b';
        const p1 = m.type === 'led' ? 'anode' : (m.type === 'wire' ? 'start' : 'terminal_a');
        const p2 = m.type === 'led' ? 'cathode' : (m.type === 'wire' ? 'end' : 'terminal_b');

        const alt1 = m.possible_holes || [h1, `${h1.charAt(0)}${Math.min(63, parseInt(h1.slice(1), 10) + 1)}`];
        const alt2 = m.possible_holes || [h2, `${h2.charAt(0)}${Math.min(63, parseInt(h2.slice(1), 10) + 1)}`];

        return {
          id: m.id || `C${idx + 1}`,
          type: m.type || 'resistor',
          confidence: m.confidence || 0.95,
          bbox: m.bbox || [200, 200, 350, 250],
          center: { x: 275, y: 225 },
          orientation: 0.0,
          source: 'AI',
          status: isAmb ? 'AMBIGUOUS' : 'VERIFIED',
          terminals: [
            {
              terminal: p1,
              name: p1,
              hole: h1,
              status: (isAmb && ambTerm === p1) ? 'AMBIGUOUS' : 'VERIFIED',
              candidates: (isAmb && ambTerm === p1) ? alt1 : [h1],
              alternate_holes: (isAmb && ambTerm === p1) ? alt1 : null,
              pixel_position: { x: 200, y: 225 },
              reason: 'Mapped hole'
            },
            {
              terminal: p2,
              name: p2,
              hole: h2,
              status: (isAmb && ambTerm === p2) ? 'AMBIGUOUS' : 'VERIFIED',
              candidates: (isAmb && ambTerm === p2) ? alt2 : [h2],
              alternate_holes: (isAmb && ambTerm === p2) ? alt2 : null,
              pixel_position: { x: 350, y: 225 },
              reason: 'Mapped hole'
            }
          ]
        };
      });

      if (processedComps.length === 0) {
        return {
          status: 'BLOCKED',
          components: [],
          connections: [],
          nodes: [],
          breadboard: { detected: true, status: 'CALIBRATED', total_tie_points: 830, columns: 63 },
          diagnostics: ['No components detected on breadboard.'],
          circuit_signature: '',
          simulation_ready: false,
          simulation_readiness_reason: 'NO_COMPONENTS_DETECTED'
        };
      }

      const graph = buildElectricalGraphFromComponents(processedComps);
      const hasAmb = graph.components.some(c => c.status === 'AMBIGUOUS');

      return {
        status: hasAmb ? 'AMBIGUOUS' : 'READY',
        components: graph.components,
        connections: graph.connections,
        nodes: graph.nodes,
        breadboard: { detected: true, status: 'CALIBRATED', total_tie_points: 830, columns: 63 },
        diagnostics: hasAmb ? ['Ambiguous terminal detected'] : [],
        circuit_signature: `client_${Date.now()}`,
        simulation_ready: false,
        simulation_readiness_reason: hasAmb ? 'AMBIGUOUS_TERMINAL_MAPPING' : 'SUPPLY_CONFIGURATION_REQUIRED'
      };
    }

    return {
      status: 'BLOCKED',
      components: [],
      connections: [],
      nodes: [],
      breadboard: { detected: false, status: 'NOT_DETECTED' },
      diagnostics: [err.message],
      circuit_signature: '',
      simulation_ready: false,
      simulation_readiness_reason: 'NETWORK_OR_SERVER_ERROR'
    };
  }
}
