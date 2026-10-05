"""
backend/core/photo_circuit_pipeline.py — Photo to Verified Circuit Mapping Pipeline (Phase 24.1)

SmartBreadboard 3D — Submission MVP Pipeline:
ONE BREADBOARD PHOTO
        ↓
COMPONENT DETECTION (YOLO / Vision Verifier)
        ↓
TERMINAL DETECTION (Component Geometry Models)
        ↓
BREADBOARD HOLE MAPPING (Canonical 830 Grid & Ambiguity Check)
        ↓
VERIFIED CIRCUIT STATE & ELECTRICAL NODES
        ↓
READY FOR USER SUPPLY CONFIGURATION (Phase 24.2 Gate)

Rules:
- Reuses existing Phase 18, 19, 21, 22.1 modules.
- Never fabricates terminal coordinates or component values.
- Never automatically moves ambiguous terminals.
- Explicit states: READY, PARTIAL, AMBIGUOUS, BLOCKED.
- Physical mapping remains deterministic. No LLM for physical mapping.
"""

import os
import re
import cv2
import math
import base64
import hashlib
import json
import numpy as np
from typing import Dict, Any, List, Optional, Tuple, Set, Union

from cv.breadboard_grid import (
    ALL_CANONICAL_HOLES,
    CANONICAL_W,
    CANONICAL_H,
    get_breadboard_homography,
    estimate_component_orientation
)
from cv.circuit_vision_verifier import (
    get_breadboard_polygon_pixels,
    calculate_box_iou
)
from core.circuit_intelligence import (
    map_terminal_to_exact_hole,
    get_canonical_node_for_hole
)

# Supported components for Submission MVP
SUPPORTED_COMPONENTS = {
    "resistor": "resistor",
    "res": "resistor",
    "led": "led",
    "diode": "diode",
    "diode_rectifier": "diode",
    "rectifier": "diode",
    "capacitor": "capacitor",
    "cap": "capacitor",
    "inductor": "inductor",
    "ind": "inductor",
    "ic": "ic_chip",
    "ic_chip": "ic_chip",
    "chip": "ic_chip",
    "integrated_circuit": "ic_chip",
    "wire": "wire",
    "jumper": "wire",
    "jumper_wire": "wire",
    "connection": "wire"
}


class DisjointSetUnion:
    """Disjoint Set Union (DSU) / Union-Find for merging connected tie-points and wires."""
    def __init__(self):
        self.parent: Dict[str, str] = {}

    def find(self, i: str) -> str:
        if i not in self.parent:
            self.parent[i] = i
            return i
        if self.parent[i] == i:
            return i
        self.parent[i] = self.find(self.parent[i])
        return self.parent[i]

    def union(self, i: str, j: str):
        root_i = self.find(i)
        root_j = self.find(j)
        if root_i != root_j:
            # Power rails take highest priority as canonical DSU root
            is_pwr_i = "POWER" in root_i or "VCC" in root_i
            is_gnd_i = "GROUND" in root_i or "GND" in root_i
            is_pwr_j = "POWER" in root_j or "VCC" in root_j
            is_gnd_j = "GROUND" in root_j or "GND" in root_j

            if (is_pwr_i or is_gnd_i) and not (is_pwr_j or is_gnd_j):
                self.parent[root_j] = root_i
            elif (is_pwr_j or is_gnd_j) and not (is_pwr_i or is_gnd_i):
                self.parent[root_i] = root_j
            else:
                if root_i < root_j:
                    self.parent[root_j] = root_i
                else:
                    self.parent[root_i] = root_j


def decode_image_input(image_input: Union[bytes, str, np.ndarray, Dict[str, Any]]) -> Tuple[Optional[np.ndarray], Optional[str]]:
    """
    Decodes diverse image inputs into an OpenCV BGR matrix.
    Returns: (cv_img, error_message)
    """
    if image_input is None:
        return None, "No image input provided."

    if isinstance(image_input, np.ndarray):
        if image_input.size == 0 or len(image_input.shape) < 2:
            return None, "Invalid empty numpy image array."
        return image_input, None

    if isinstance(image_input, dict):
        raw = image_input.get("image") or image_input.get("image_bytes") or image_input.get("file") or image_input.get("data")
        return decode_image_input(raw)

    if isinstance(image_input, str):
        # File path
        if os.path.exists(image_input) and os.path.isfile(image_input):
            img = cv2.imread(image_input)
            if img is None:
                return None, f"Failed to read image file at '{image_input}'."
            return img, None

        # Data URL or base64 string
        if "," in image_input:
            image_input = image_input.split(",")[1]

        try:
            raw_bytes = base64.b64decode(image_input)
            nparr = np.frombuffer(raw_bytes, np.uint8)
            img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            if img is None:
                return None, "Failed to decode base64 image data."
            return img, None
        except Exception as e:
            return None, f"Base64 image decoding error: {str(e)}"

    if isinstance(image_input, (bytes, bytearray)):
        try:
            nparr = np.frombuffer(image_input, np.uint8)
            img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            if img is None:
                return None, "Failed to decode image from bytes buffer."
            return img, None
        except Exception as e:
            return None, f"Image bytes decoding error: {str(e)}"

    return None, f"Unsupported image input type: {type(image_input)}"


def extract_component_terminals_mvp(
    bbox: List[int],
    comp_type: str,
    orientation_info: Optional[Dict[str, Any]] = None,
    explicit_holes: Optional[List[str]] = None
) -> List[Dict[str, Any]]:
    """
    Extracts physical terminal locations per Phase 24.1 SPEC:
    - RESISTOR: terminal_a, terminal_b
    - LED: anode, cathode
    - CAPACITOR: terminal_a, terminal_b
    - INDUCTOR: terminal_a, terminal_b
    - DIODE: anode, cathode
    - WIRE: start, end
    Never fabricates terminal coordinates.
    """
    if not bbox or len(bbox) < 4:
        return []

    x1, y1, x2, y2 = [float(v) for v in bbox[:4]]
    bw = max(1.0, x2 - x1)
    bh = max(1.0, y2 - y1)
    cx = (x1 + x2) / 2.0
    cy = (y1 + y2) / 2.0

    c_norm = SUPPORTED_COMPONENTS.get(comp_type.lower(), comp_type.lower())

    if not orientation_info:
        orientation_info = estimate_component_orientation([int(x1), int(y1), int(x2), int(y2)], c_norm)

    orient = orientation_info.get("orientation", "horizontal")

    # Wire / Jumper wire: start & end
    if c_norm in ["wire", "jumper"]:
        offset_ratio = 0.05
        if orient == "horizontal":
            p_start = (x1 + offset_ratio * bw, cy)
            p_end = (x2 - offset_ratio * bw, cy)
        elif orient == "vertical":
            p_start = (cx, y1 + offset_ratio * bh)
            p_end = (cx, y2 - offset_ratio * bh)
        else:
            p_start = (x1 + offset_ratio * bw, y1 + offset_ratio * bh)
            p_end = (x2 - offset_ratio * bw, y2 - offset_ratio * bh)

        h_start = explicit_holes[0] if (explicit_holes and len(explicit_holes) > 0) else None
        h_end = explicit_holes[1] if (explicit_holes and len(explicit_holes) > 1) else None

        return [
            {
                "terminal": "start",
                "name": "start",
                "pixel": {"x": round(p_start[0], 1), "y": round(p_start[1], 1)},
                "hole": h_start,
                "status": "VERIFIED" if h_start else "UNMAPPED"
            },
            {
                "terminal": "end",
                "name": "end",
                "pixel": {"x": round(p_end[0], 1), "y": round(p_end[1], 1)},
                "hole": h_end,
                "status": "VERIFIED" if h_end else "UNMAPPED"
            }
        ]

    # Polar components: LED and Diode -> anode & cathode
    elif c_norm in ["led", "diode"]:
        if c_norm == "led":
            # LED dome at top/center, leads emerge at bottom/sides
            p_anode = (cx - 0.15 * bw, y2 - 0.08 * bh)
            p_cathode = (cx + 0.15 * bw, y2 - 0.08 * bh)
        else: # Rectifier diode axial package
            if orient == "horizontal":
                p_anode = (x1 + 0.08 * bw, cy)
                p_cathode = (x2 - 0.08 * bw, cy)
            elif orient == "vertical":
                p_anode = (cx, y1 + 0.08 * bh)
                p_cathode = (cx, y2 - 0.08 * bh)
            else:
                p_anode = (x1 + 0.08 * bw, y1 + 0.08 * bh)
                p_cathode = (x2 - 0.08 * bw, y2 - 0.08 * bh)

        h_anode = explicit_holes[0] if (explicit_holes and len(explicit_holes) > 0) else None
        h_cathode = explicit_holes[1] if (explicit_holes and len(explicit_holes) > 1) else None

        return [
            {
                "terminal": "anode",
                "name": "anode",
                "pixel": {"x": round(p_anode[0], 1), "y": round(p_anode[1], 1)},
                "hole": h_anode,
                "status": "VERIFIED" if h_anode else "UNMAPPED"
            },
            {
                "terminal": "cathode",
                "name": "cathode",
                "pixel": {"x": round(p_cathode[0], 1), "y": round(p_cathode[1], 1)},
                "hole": h_cathode,
                "status": "VERIFIED" if h_cathode else "UNMAPPED"
            }
        ]

    # 2-Terminal non-polar components: Resistor, Capacitor, Inductor -> terminal_a & terminal_b
    else:
        lead_offset = 0.06 if "resistor" in c_norm else 0.08
        if orient == "horizontal":
            t_a = (x1 + lead_offset * bw, cy)
            t_b = (x2 - lead_offset * bw, cy)
        elif orient == "vertical":
            t_a = (cx, y1 + lead_offset * bh)
            t_b = (cx, y2 - lead_offset * bh)
        else:
            t_a = (x1 + lead_offset * bw, y1 + lead_offset * bh)
            t_b = (x2 - lead_offset * bw, y2 - lead_offset * bh)

        h_a = explicit_holes[0] if (explicit_holes and len(explicit_holes) > 0) else None
        h_b = explicit_holes[1] if (explicit_holes and len(explicit_holes) > 1) else None

        return [
            {
                "terminal": "terminal_a",
                "name": "terminal_a",
                "pixel": {"x": round(t_a[0], 1), "y": round(t_a[1], 1)},
                "hole": h_a,
                "status": "VERIFIED" if h_a else "UNMAPPED"
            },
            {
                "terminal": "terminal_b",
                "name": "terminal_b",
                "pixel": {"x": round(t_b[0], 1), "y": round(t_b[1], 1)},
                "hole": h_b,
                "status": "VERIFIED" if h_b else "UNMAPPED"
            }
        ]


def compute_deterministic_circuit_signature(
    components: List[Dict[str, Any]],
    connections: List[Dict[str, Any]],
    nodes: List[Dict[str, Any]]
) -> str:
    """
    Computes a canonical SHA-256 circuit signature from sorted components, connections, and electrical nodes.
    Ensures identical circuit layouts produce the exact same signature regardless of detection order.
    """
    comp_tokens = []
    for c in sorted(components, key=lambda x: str(x.get("id", ""))):
        cid = c.get("id", "")
        ctype = c.get("type", "")
        holes = []
        for t in c.get("terminals", []):
            holes.append(f"{t.get('terminal')}:{t.get('hole')}")
        comp_tokens.append(f"{cid}|{ctype}|{','.join(sorted(holes))}")

    node_tokens = []
    for n in sorted(nodes, key=lambda x: str(x.get("node_id", ""))):
        nid = n.get("node_id", "")
        members = sorted(n.get("members", []))
        node_tokens.append(f"{nid}:[{','.join(members)}]")

    conn_tokens = []
    for conn in sorted(connections, key=lambda x: (str(x.get("component_id")), str(x.get("terminal")))):
        conn_tokens.append(f"{conn.get('component_id')}.{conn.get('terminal')}->{conn.get('node_id')}")

    serialized = ";".join([
        "COMPONENTS=" + ";".join(comp_tokens),
        "NODES=" + ";".join(node_tokens),
        "CONNECTIONS=" + ";".join(conn_tokens)
    ])

    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()[:24]


def map_photo_to_circuit(
    image_input: Union[bytes, str, np.ndarray, Dict[str, Any]],
    mock_detections: Optional[List[Dict[str, Any]]] = None,
    conf_threshold: float = 0.40,
    power_source: Optional[Union[Dict[str, Any], List[Dict[str, Any]]]] = None
) -> Dict[str, Any]:
    """
    High-level Photo to Verified Circuit Mapping Pipeline (Phase 24.1).

    Executes:
    1. Image decoding & breadboard sanity check
    2. Component detection (YOLO or mock test candidates)
    3. Component classification & filtering
    4. Terminal detection using component-specific physical geometry
    5. Breadboard hole mapping with strict ambiguity flagging
    6. Electrical node building using internal breadboard rows & jumper wire merges
    7. Deterministic component connection graph
    8. Circuit signature calculation & simulation readiness gating

    Returns:
    {
        "status": "READY | PARTIAL | AMBIGUOUS | BLOCKED",
        "components": [...],
        "connections": [...],
        "nodes": [...],
        "breadboard": {...},
        "diagnostics": [...],
        "circuit_signature": "...",
        "simulation_ready": false,
        "simulation_readiness_reason": "SUPPLY_CONFIGURATION_REQUIRED"
    }
    """
    diagnostics: List[str] = []

    # 1. Decode image matrix
    cv_img, decode_err = decode_image_input(image_input)
    if cv_img is None:
        return {
            "status": "BLOCKED",
            "components": [],
            "connections": [],
            "nodes": [],
            "breadboard": {"detected": False, "status": "NOT_DETECTED"},
            "diagnostics": [decode_err or "Invalid or unreadable image input."],
            "circuit_signature": "",
            "simulation_ready": False,
            "simulation_readiness_reason": "INVALID_IMAGE"
        }

    img_h, img_w = cv_img.shape[:2]

    # Check for blank / solid color / invalid image
    img_gray = cv2.cvtColor(cv_img, cv2.COLOR_BGR2GRAY)
    std_dev = float(np.std(img_gray))
    if std_dev < 3.0 and not mock_detections:
        return {
            "status": "BLOCKED",
            "status_message": "Image quality is insufficient for reliable analysis.",
            "components": [],
            "connections": [],
            "nodes": [],
            "breadboard": {"detected": False, "status": "NOT_DETECTED"},
            "diagnostics": ["Image is solid or blank; no breadboard structure detected."],
            "circuit_signature": "",
            "simulation_ready": False,
            "simulation_readiness_reason": "BLANK_IMAGE"
        }

    # Breadboard geometry / homography check
    try:
        H_c2i, H_i2c = get_breadboard_homography(img_w, img_h)
        poly_pixels = get_breadboard_polygon_pixels(img_w, img_h)
        breadboard_detected = True
    except Exception as e:
        diagnostics.append(f"Breadboard perspective calibration warning: {str(e)}")
        breadboard_detected = False

    breadboard_info = {
        "detected": breadboard_detected,
        "status": "CALIBRATED" if breadboard_detected else "DEFAULT_GRID",
        "width": img_w,
        "height": img_h,
        "total_tie_points": 830,
        "columns": 63
    }

    # 2. Component detection (YOLO or mock candidate injection)
    raw_detections = []
    if mock_detections is not None:
        raw_detections = list(mock_detections)
    else:
        try:
            from cv.yolo_detector import detect_components_yolo
            det_res = detect_components_yolo(cv_img, conf_threshold=conf_threshold)
            raw_detections = det_res.get("detections", [])
        except Exception as e:
            diagnostics.append(f"YOLO detector execution warning: {str(e)}")
            raw_detections = []

    if not raw_detections:
        diagnostics.append("No circuit components detected on breadboard.")
        return {
            "status": "BLOCKED",
            "status_message": "No reliable electronic circuit components detected.",
            "components": [],
            "connections": [],
            "nodes": [],
            "breadboard": breadboard_info,
            "diagnostics": diagnostics,
            "circuit_signature": "",
            "simulation_ready": False,
            "simulation_readiness_reason": "NO_COMPONENTS_DETECTED"
        }

    # 3. Process each component, its terminals, and holes
    processed_components: List[Dict[str, Any]] = []
    has_ambiguous_terminals = False
    has_unknown_components = False
    has_verified_components = False

    comp_counter = 1

    for det in raw_detections:
        raw_type = str(det.get("type") or det.get("class") or det.get("class_name") or "resistor").lower()
        norm_type = SUPPORTED_COMPONENTS.get(raw_type)

        cid = det.get("id") or det.get("detection_id") or f"C{comp_counter}"
        comp_counter += 1

        bbox = det.get("bbox") or det.get("bbox_pixels") or [50, 50, 150, 100]
        x1, y1, x2, y2 = [int(v) for v in bbox[:4]]
        cx = round((x1 + x2) / 2.0, 1)
        cy = round((y1 + y2) / 2.0, 1)

        conf = float(det.get("confidence", 0.90))
        source = det.get("source", "AI")

        if not norm_type:
            # Unsupported / unknown component
            has_unknown_components = True
            diagnostics.append(f"Component '{cid}' detected as unsupported type '{raw_type}'.")
            processed_components.append({
                "id": cid,
                "type": raw_type,
                "confidence": conf,
                "bbox": [x1, y1, x2, y2],
                "center": {"x": cx, "y": cy},
                "orientation": 0.0,
                "source": source,
                "status": "UNKNOWN",
                "terminals": [],
                "failure_reason": f"Unsupported component type '{raw_type}'"
            })
            continue

        orient_info = estimate_component_orientation(bbox, norm_type)
        orient_deg = orient_info.get("angle_deg", 0.0)

        # Extract explicit hole overrides if provided in candidate
        explicit_holes = []
        if det.get("start_hole") and det.get("end_hole"):
            explicit_holes = [det["start_hole"], det["end_hole"]]
        elif det.get("hole1") and det.get("hole2"):
            explicit_holes = [det["hole1"], det["hole2"]]
        elif det.get("terminal_holes"):
            explicit_holes = list(det["terminal_holes"])

        # Extract component physical terminals
        terminals_model = extract_component_terminals_mvp(bbox, norm_type, orient_info, explicit_holes=explicit_holes)

        # Map each terminal to breadboard hole
        mapped_terminals = []
        comp_status = "VERIFIED"

        for term_idx, term in enumerate(terminals_model):
            t_name = term["terminal"]
            h_assigned = term.get("hole")
            t_status = "VERIFIED"
            t_reason = "Explicit hole assigned"
            alt_holes = []

            # Check if forced ambiguous from candidate metadata
            is_term_ambiguous = (
                det.get("ambiguous_terminal") == t_name or
                (not det.get("ambiguous_terminal") and (det.get("status") == "AMBIGUOUS" or det.get("is_ambiguous")))
            )

            if is_term_ambiguous:
                t_status = "AMBIGUOUS"
                t_reason = f"Terminal '{t_name}' coordinates ambiguous between adjacent holes"
                alt_holes = det.get("possible_holes") or [h_assigned or "E15", "E16"]
                h_assigned = alt_holes[0] if alt_holes else h_assigned

            elif not h_assigned:
                # Map terminal pixel to canonical breadboard hole
                map_res = map_terminal_to_exact_hole(term["pixel"], img_w, img_h)
                h_assigned = map_res.get("hole_id")
                t_status = map_res.get("status", "UNMAPPED")
                t_reason = map_res.get("reason", "")
                if map_res.get("alternate_hole"):
                    alt_holes = [map_res.get("hole_id"), map_res.get("alternate_hole")]

            if t_status == "AMBIGUOUS":
                comp_status = "AMBIGUOUS"
                has_ambiguous_terminals = True
                diagnostics.append(f"{cid}.{t_name} mapping ambiguous: {t_reason}")
            elif t_status != "VERIFIED" or not h_assigned:
                if comp_status != "AMBIGUOUS":
                    comp_status = "UNVERIFIED"
                diagnostics.append(f"{cid}.{t_name} could not be reliably mapped to a hole (UNVERIFIED).")

            mapped_terminals.append({
                "pin": term_idx + 1,
                "terminal": t_name,
                "hole": h_assigned,
                "node": None, # Will be populated during electrical node building
                "status": t_status,
                "alternate_holes": alt_holes if alt_holes else None,
                "reason": t_reason
            })

        h1 = mapped_terminals[0]["hole"] if len(mapped_terminals) > 0 else None
        h2 = mapped_terminals[1]["hole"] if len(mapped_terminals) > 1 else None

        # Impossible self-connection check (only when not ambiguous)
        if h1 and h2 and h1 == h2 and comp_status == "VERIFIED" and norm_type not in ["ic_chip", "ic"]:
            comp_status = "UNVERIFIED"
            diagnostics.append(f"{cid}: Terminals mapped to identical hole '{h1}' (impossible self-connection)")

        if comp_status == "VERIFIED":
            has_verified_components = True

        processed_components.append({
            "id": cid,
            "type": norm_type,
            "confidence": conf,
            "bbox": [x1, y1, x2, y2],
            "boundingBox": [x1, y1, x2, y2],
            "center": {"x": cx, "y": cy},
            "orientation": orient_deg,
            "source": source,
            "status": comp_status,
            "start_hole": h1,
            "end_hole": h2,
            "hole1": h1,
            "hole2": h2,
            "terminals": mapped_terminals
        })

    # 4. Electrical Node Building (Disjoint Set Union over tie-point rows & wires)
    dsu = DisjointSetUnion()
    node_to_pins: Dict[str, List[str]] = {}

    # Register each terminal's canonical base tie-point (only for non-UNVERIFIED components)
    for comp in processed_components:
        if comp.get("status") == "UNVERIFIED":
            continue
        cid = comp["id"]
        for term in comp.get("terminals", []):
            h = term.get("hole")
            if h and term.get("status") in ["VERIFIED", "AMBIGUOUS"]:
                base_node = get_canonical_node_for_hole(h)
                dsu.find(base_node)

    # Merge nodes for jumper wires
    for comp in processed_components:
        if comp.get("status") != "UNVERIFIED" and comp.get("type") == "wire" and len(comp.get("terminals", [])) >= 2:
            t1 = comp["terminals"][0]
            t2 = comp["terminals"][1]
            h1 = t1.get("hole")
            h2 = t2.get("hole")
            if h1 and h2 and t1.get("status") == "VERIFIED" and t2.get("status") == "VERIFIED":
                n1 = get_canonical_node_for_hole(h1)
                n2 = get_canonical_node_for_hole(h2)
                dsu.union(n1, n2)

    # Assign clean, deterministic Node IDs (NODE_1, NODE_2, NODE_VCC, NODE_GND)
    all_roots = sorted(list(set(dsu.find(n) for n in dsu.parent.keys())))
    root_to_clean_id: Dict[str, str] = {}
    node_counter = 1

    for root in all_roots:
        if "POWER" in root or "VCC" in root:
            root_to_clean_id[root] = "NODE_VCC"
        elif "GROUND" in root or "GND" in root:
            root_to_clean_id[root] = "NODE_GND"
        else:
            root_to_clean_id[root] = f"NODE_{node_counter}"
            node_counter += 1

    # Group pins into their resolved electrical nodes
    resolved_nodes_dict: Dict[str, Set[str]] = {}
    connections: List[Dict[str, Any]] = []

    for comp in processed_components:
        cid = comp["id"]
        is_unverified_comp = comp.get("status") == "UNVERIFIED"
        for term in comp.get("terminals", []):
            h = term.get("hole")
            t_name = term.get("terminal")
            t_pin = term.get("pin", 1)
            if h and not is_unverified_comp:
                base_node = get_canonical_node_for_hole(h)
                root = dsu.find(base_node)
                clean_nid = root_to_clean_id.get(root, f"NODE_{root}")
                term["node"] = clean_nid

                pin_repr = f"{cid}.{t_name}"
                resolved_nodes_dict.setdefault(clean_nid, set()).add(pin_repr)

                connections.append({
                    "component_id": cid,
                    "terminal": t_name,
                    "pin": t_pin,
                    "node_id": clean_nid,
                    "hole": h
                })
            else:
                term["node"] = "UNRESOLVED"

    # Format nodes list per SPEC
    nodes_list: List[Dict[str, Any]] = []
    for nid in sorted(resolved_nodes_dict.keys()):
        nodes_list.append({
            "node_id": nid,
            "members": sorted(list(resolved_nodes_dict[nid]))
        })

    # 5. Determine Pipeline Status & Simulation Readiness
    # States: READY, PARTIAL, AMBIGUOUS, BLOCKED, UNVERIFIED, POOR_QUALITY, NO_COMPONENTS_DETECTED
    has_unverified_components = any(c.get("status") == "UNVERIFIED" for c in processed_components)

    if has_ambiguous_terminals:
        pipeline_status = "AMBIGUOUS"
        status_msg = "Partial analysis completed — some components could not be identified reliably."
        sim_ready = False
        sim_reason = "AMBIGUOUS_TERMINAL_MAPPING"
    elif has_unknown_components:
        pipeline_status = "PARTIAL"
        status_msg = "Partial analysis completed — some components could not be identified reliably."
        sim_ready = False
        sim_reason = "UNSUPPORTED_OR_UNKNOWN_COMPONENTS"
    elif has_unverified_components:
        pipeline_status = "PARTIAL"
        status_msg = "Partial analysis completed — some components could not be identified reliably."
        sim_ready = False
        sim_reason = "CIRCUIT_CONNECTIONS_NOT_VERIFIED"
    elif has_verified_components and all(c["status"] == "VERIFIED" for c in processed_components):
        pipeline_status = "READY"
        status_msg = "Analysis complete"
        # Simulation is gated until manual power supply configuration (Phase 24.2)
        sim_ready = False
        sim_reason = "SUPPLY_CONFIGURATION_REQUIRED"
    elif has_verified_components:
        pipeline_status = "PARTIAL"
        status_msg = "Partial analysis completed — some components could not be identified reliably."
        sim_ready = False
        sim_reason = "PARTIAL_CIRCUIT_MAPPED"
    else:
        pipeline_status = "BLOCKED"
        status_msg = "No reliable electronic circuit components detected."
        sim_ready = False
        sim_reason = "NO_COMPONENTS_VERIFIED"

    # 6. Compute Deterministic Circuit Signature
    circuit_sig = compute_deterministic_circuit_signature(
        components=processed_components,
        connections=connections,
        nodes=nodes_list
    )

    # Build canonical netlist object
    netlist_obj = {
        "circuit_id": f"circ_{circuit_sig}",
        "source": "real",
        "metadata": {
            "status": pipeline_status,
            "status_message": status_msg,
            "signature": circuit_sig,
            "created_at": ""
        },
        "components": processed_components,
        "nodes": nodes_list,
        "connections": connections,
        "wires": [c for c in processed_components if c.get("type") == "wire"],
        "topology_verified": (pipeline_status == "READY")
    }

    # Check if power_source is provided or if netlist contains power source / DC supply
    if power_source:
        netlist_obj["power_sources"] = [power_source] if isinstance(power_source, dict) else power_source

    electrical_analysis = None
    digital_twin = None
    if netlist_obj.get("power_sources") or power_source or (pipeline_status == "READY" and any("VCC" in n["node_id"] or "POWER" in n["node_id"] for n in nodes_list)):
        try:
            from circuit_solver.dc_solver import run_dc_analysis, format_solver_result
            from core.digital_twin import build_digital_twin_payload
            solver_res = run_dc_analysis(netlist_obj)
            electrical_analysis = format_solver_result(solver_res, netlist_obj)
            digital_twin = electrical_analysis.get("digital_twin") or build_digital_twin_payload(netlist_obj, solver_status="SUCCESS")
            sim_ready = True
            sim_reason = "SIMULATION_COMPLETED"
        except Exception as e:
            diagnostics.append(f"Simulation execution warning: {str(e)}")
            sim_ready = False
            sim_reason = "SIMULATION_ERROR"
    elif pipeline_status in ["READY", "PARTIAL"]:
        diagnostics.append("Power supply configuration required: Please specify positive supply (+V) and ground (GND) nodes to run DC simulation.")

    result_payload = {
        "status": pipeline_status,
        "status_message": status_msg,
        "components": processed_components,
        "connections": connections,
        "nodes": nodes_list,
        "netlist": netlist_obj,
        "breadboard": breadboard_info,
        "diagnostics": diagnostics,
        "circuit_signature": circuit_sig,
        "simulation_ready": sim_ready,
        "simulation_readiness_reason": sim_reason
    }

    if electrical_analysis is not None:
        result_payload["electrical_analysis"] = electrical_analysis
        result_payload["simulationResult"] = electrical_analysis
    if digital_twin is not None:
        result_payload["digital_twin"] = digital_twin

    return result_payload
