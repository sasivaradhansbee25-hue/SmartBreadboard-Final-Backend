"""
SmartBreadboard 3D — Circuit Data Model & Netlist Generator Engine (Phase 12 Real AI Pipeline)
Applies solderless breadboard internal connectivity rules, merges jumper wire nodes,
and constructs the Circuit Data Model JSON netlist per SPEC.md Section 9.
"""

import re
from datetime import datetime
from cv.breadboard_grid import extract_component_lead_positions, extract_component_lead_positions_verbose, estimate_component_orientation
from cv.value_consensus import extract_value_consensus_from_crop, build_fallback_response
from core.wire_connectivity import build_electrical_connectivity, get_base_node_for_hole
from core.circuit_validator import validate_circuit

def get_base_node_for_hole(hole_id: str) -> str:

    """
    Returns the internal breadboard electrical node name for any tie-point hole:
    - Main grid columns 1-63: Rows A-E -> NODE_COL_c_TOP, Rows F-J -> NODE_COL_c_BOT
    - Power rails: VCC_TOP -> NODE_PWR_TOP, GND_TOP -> NODE_GND_TOP
    """
    if hole_id.startswith("VCC_TOP"):
        return "NODE_POWER_VCC"
    elif hole_id.startswith("GND_TOP"):
        return "NODE_GROUND"
    elif hole_id.startswith("VCC_BOT"):
        return "NODE_POWER_VCC_BOT"
    elif hole_id.startswith("GND_BOT"):
        return "NODE_GROUND_BOT"

    # Main grid row-column match (e.g. A22, E22, F22)
    m = re.match(r"([A-J])(\d+)", hole_id)
    if m:
        row = m.group(1)
        col = int(m.group(2))
        if row in ['A', 'B', 'C', 'D', 'E']:
            return f"NODE_COL_{col}_TOP"
        else:
            return f"NODE_COL_{col}_BOT"

    return f"NODE_HOLE_{hole_id}"

class DisjointSetUnion:
    """Disjoint Set Union (DSU) / Union-Find algorithm for merging connected electrical nodes."""
    def __init__(self):
        self.parent = {}

    def find(self, i):
        if i not in self.parent:
            self.parent[i] = i
            return i
        if self.parent[i] == i:
            return i
        self.parent[i] = self.find(self.parent[i])
        return self.parent[i]

    def union(self, i, j):
        root_i = self.find(i)
        root_j = self.find(j)
        if root_i != root_j:
            self.parent[root_i] = root_j

def build_netlist_from_detections(detections: list[dict], resistor_analyses: list[dict] = None, img_w: int = 800, img_h: int = 300, power_source: dict = None) -> dict:
    """
    Converts YOLO detections into a complete Circuit Data Model JSON netlist.
    Applies solderless breadboard terminal strip rules and merges nodes connected by jumper wires.
    Outputs normalized component schema with start_hole/end_hole, confidence, nets, and uncertainty flags.
    Distinguishes physically detected power connections vs user-provided power source vs unpowered.
    """
    dsu = DisjointSetUnion()
    processed_components = []

    resistor_val_map = {}
    if resistor_analyses:
        for r_item in resistor_analyses:
            r_id = r_item.get("resistor_id")
            det_val = r_item.get("detected_value", {})
            if r_id and det_val:
                resistor_val_map[r_id] = det_val

    # Designator counters per class
    prefix_counters = {
        "resistor": {"prefix": "R", "count": 1},
        "led": {"prefix": "LED", "count": 1},
        "wire": {"prefix": "W", "count": 1},
        "diode_rectifier": {"prefix": "D", "count": 1},
        "ic_chip": {"prefix": "U", "count": 1},
        "capacitor": {"prefix": "C", "count": 1}
    }

    comp_counter = 1

    for d in detections:
        # Phase 18 Circuit Vision Safety Gate: strictly exclude REJECTED or duplicate candidates
        if d.get("verification") == "REJECTED" or d.get("is_duplicate"):
            continue

        # Standardize class name
        c_type = d.get("class") or d.get("class_name") or "resistor"
        c_type_lower = c_type.lower()
        if "resistor" in c_type_lower:
            c_type = "resistor"
        elif "led" in c_type_lower:
            c_type = "led"
        elif "wire" in c_type_lower or "jumper" in c_type_lower:
            c_type = "wire"
        elif "diode" in c_type_lower:
            c_type = "diode_rectifier"
        elif "ic" in c_type_lower or "chip" in c_type_lower:
            c_type = "ic_chip"
        elif "cap" in c_type_lower:
            c_type = "capacitor"

        bbox = d.get("bbox_pixels") or d.get("bbox") or [100, 100, 200, 150]
        c_id = d.get("id", f"comp-{comp_counter}")
        conf = float(d.get("confidence", 0.85))

        # Assign clean standard designator (e.g. R1, LED1, W1, D1, U1, C1)
        cfg = prefix_counters.get(c_type, {"prefix": "COMP", "count": comp_counter})
        designator = f"{cfg['prefix']}{cfg['count']}"
        cfg["count"] += 1

        # Extract lead coordinates and mapped holes
        cur_w = d.get("img_w", img_w)
        cur_h = d.get("img_h", img_h)
        if "hole1" in d and "hole2" in d:
            hole1 = d["hole1"]
            hole2 = d["hole2"]
            map_conf = d.get("mapping_confidence", 0.90)
            is_uncertain = d.get("is_uncertain", False)
            map_reason = d.get("reason", "Hole mapping verified")
            sub_scores = d.get("sub_scores", {})
        else:
            lead_info = extract_component_lead_positions_verbose(bbox, c_type, img_w=cur_w, img_h=cur_h)
            hole1 = lead_info["hole1"]
            hole2 = lead_info["hole2"]
            map_conf = lead_info["mapping_confidence"]
            is_uncertain = lead_info["is_uncertain"]
            map_reason = lead_info["reason"]
            sub_scores = lead_info["sub_scores"]

        # If leads map to identical hole for 2-terminal component, adjust adjacent hole along component axis
        if hole1 == hole2 and c_type not in ["ic_chip"]:
            m = re.match(r"([A-J])(\d+)", hole1)
            if m:
                row, col = m.group(1), int(m.group(2))
                adj_col = min(63, col + 2)
                hole2 = f"{row}{adj_col}"

        raw_node1 = get_base_node_for_hole(hole1)
        raw_node2 = get_base_node_for_hole(hole2)

        # Register nodes in DSU
        dsu.find(raw_node1)
        dsu.find(raw_node2)

        # Jumper wire merges connected nodes
        if c_type in ["wire", "jumper"]:
            dsu.union(raw_node1, raw_node2)

        # Multi-pass value consensus extraction or analysis injection
        crop_b64 = d.get("crop_base64") or d.get("crop_b64")
        if c_id in resistor_val_map:
            val_consensus = resistor_val_map[c_id]
        elif designator in resistor_val_map:
            val_consensus = resistor_val_map[designator]
        elif "value" in d and d.get("value") is not None:
            val_consensus = {
                "value": d.get("value"),
                "unit": d.get("unit", "Ω"),
                "displayValue": str(d.get("value")),
                "valueSource": "user_override" if d.get("user_override_value") else "detected",
                "confidence": float(d.get("confidence", 0.9)),
                "needsConfirmation": d.get("needsConfirmation", False),
                "rawCandidates": []
            }
        elif crop_b64 and c_type not in ["wire", "jumper"]:
            val_consensus = extract_value_consensus_from_crop(crop_b64, comp_type=c_type, comp_id=designator)
        else:
            if c_type in ["wire", "jumper"]:
                val_consensus = {
                    "value": 0.001,
                    "unit": "Ω",
                    "displayValue": "Jumper Wire",
                    "valueSource": "detected",
                    "confidence": 0.99,
                    "needsConfirmation": False,
                    "rawCandidates": []
                }
            else:
                val_consensus = build_fallback_response(c_type, designator, "No crop image available.")

        dist1 = d.get("dist1", 2.5)
        dist2 = d.get("dist2", 2.5)

        orient_info = estimate_component_orientation(bbox, c_type)
        orient_deg = float(orient_info.get("angle_deg", 0.0))
        cx = round((bbox[0] + bbox[2]) / 2.0, 1)
        cy = round((bbox[1] + bbox[3]) / 2.0, 1)

        t1_name = "terminal_a" if c_type in ["resistor", "capacitor", "inductor"] else ("anode" if c_type in ["led", "diode_rectifier"] else "start")
        t2_name = "terminal_b" if c_type in ["resistor", "capacitor", "inductor"] else ("cathode" if c_type in ["led", "diode_rectifier"] else "end")

        terminals_list = [
            {
                "pin": 1,
                "terminal": t1_name,
                "hole": hole1,
                "node": raw_node1,
                "status": "VERIFIED" if not is_uncertain else "UNVERIFIED"
            },
            {
                "pin": 2,
                "terminal": t2_name,
                "hole": hole2,
                "node": raw_node2,
                "status": "VERIFIED" if not is_uncertain else "UNVERIFIED"
            }
        ]

        processed_components.append({
            "id": c_id,
            "designator": designator,
            "type": c_type,
            "bbox": bbox,
            "boundingBox": bbox,
            "center": {"x": cx, "y": cy},
            "orientation": orient_deg,
            "start_hole": hole1,
            "end_hole": hole2,
            "hole1": hole1,
            "hole2": hole2,
            "terminals": terminals_list,
            "confidence": round(conf, 2),
            "mapping_confidence": round(map_conf, 2),
            "uncertain_mapping": is_uncertain,
            "is_uncertain": is_uncertain,
            "status": "VERIFIED" if not is_uncertain else "UNVERIFIED",
            "mapping_reason": map_reason,
            "reason": map_reason,
            "sub_scores": sub_scores,
            "value": val_consensus.get("value"),
            "unit": val_consensus.get("unit", "Ω"),
            "displayValue": val_consensus.get("displayValue", "Not detected"),
            "detected_value": val_consensus.get("displayValue", "Not detected"),
            "valueSource": val_consensus.get("valueSource", "user_required"),
            "val_confidence": val_consensus.get("confidence", 0.0),
            "needsConfirmation": val_consensus.get("needsConfirmation", True),
            "rawCandidates": val_consensus.get("rawCandidates", []),
            "user_override_value": None,
            "lead1_distance_px": dist1,
            "lead2_distance_px": dist2,
            "connection_warning": is_uncertain
        })

        comp_counter += 1

    # Delegate electrical connectivity calculation to wire_connectivity engine
    conn = build_electrical_connectivity(processed_components)

    nodes_list = conn["nodes"]
    formatted_nets = conn["nets"]
    pins_list = conn["pins"]
    wires_list = conn["wires"]
    updated_components = conn["components"]
    connectivity_warnings = conn["warnings"]

    nets_summary_strings = []
    for n in formatted_nets:
        pins_str = ", ".join(n["connected_pins"]) if n["connected_pins"] else "None"
        nets_summary_strings.append(f"{n['net_id']}: {pins_str}")

    # ----------------------------------------------------
    # Power Source Handling (Physical Detected vs User vs None)
    # ----------------------------------------------------
    vcc_net = next((n for n in formatted_nets if "VCC" in n["net_id"].upper() or any("VCC" in str(h).upper() for h in n.get("holes", []))), None)
    gnd_net = next((n for n in formatted_nets if "GND" in n["net_id"].upper() or any("GND" in str(h).upper() for h in n.get("holes", []))), None)

    # Check if circuit components actually connect to power rails
    vcc_connected = vcc_net is not None and len(vcc_net.get("connected_pins", [])) > 0
    gnd_connected = gnd_net is not None and len(gnd_net.get("connected_pins", [])) > 0

    if power_source:
        # Case B: User-provided power source
        p_pos = power_source.get("node_pos") or power_source.get("positive_node") or power_source.get("positiveNode")
        p_neg = power_source.get("node_neg") or power_source.get("negative_node") or power_source.get("negativeNode")
        p_volt = power_source.get("voltage")
        
        # If user didn't specify pos/neg, default to VCC/GND nets if available, or first available nets
        if not p_pos:
            p_pos = vcc_net["net_id"] if vcc_net else (formatted_nets[0]["net_id"] if len(formatted_nets) > 0 else None)
        if not p_neg:
            p_neg = gnd_net["net_id"] if gnd_net else (formatted_nets[-1]["net_id"] if len(formatted_nets) > 1 else None)

        power_source_status = {
            "detected": False,
            "source": "user",
            "voltage": p_volt,
            "node_pos": p_pos,
            "node_neg": p_neg,
            "confidence": 1.0
        }
        power_sources = [
            {
                "id": power_source.get("id", "V1"),
                "type": power_source.get("type", "dc"),
                "voltage": p_volt,
                "node_pos": p_pos,
                "node_neg": p_neg,
                "positive_node": p_pos,
                "negative_node": p_neg
            }
        ]
    elif vcc_connected and gnd_connected:
        # Case A: Physically detected power rail connection (default 5.0V for DC simulation)
        power_source_status = {
            "detected": True,
            "source": "detected",
            "voltage": 5.0,
            "node_pos": vcc_net["net_id"],
            "node_neg": gnd_net["net_id"],
            "positive_node": vcc_net["net_id"],
            "negative_node": gnd_net["net_id"],
            "confidence": 0.85
        }
        power_sources = [
            {
                "id": "V1",
                "type": "dc",
                "voltage": 5.0,
                "node_pos": vcc_net["net_id"],
                "node_neg": gnd_net["net_id"],
                "positive_node": vcc_net["net_id"],
                "negative_node": gnd_net["net_id"]
            }
        ]
    else:
        # Case C: Simple circuit detected without explicit power rail wires
        # Attach default 5.0V power source across circuit entry and ground nodes
        pos_n = formatted_nets[0]["net_id"] if len(formatted_nets) > 0 else "NODE_PWR"
        neg_n = formatted_nets[-1]["net_id"] if len(formatted_nets) > 1 else "NODE_GND"
        if pos_n == neg_n and len(formatted_nets) > 1:
            neg_n = formatted_nets[1]["net_id"]

        power_source_status = {
            "detected": False,
            "source": "default_simulated",
            "voltage": 5.0,
            "node_pos": pos_n,
            "node_neg": neg_n,
            "positive_node": pos_n,
            "negative_node": neg_n,
            "confidence": 0.90
        }
        power_sources = [
            {
                "id": "V1",
                "type": "dc",
                "voltage": 5.0,
                "node_pos": pos_n,
                "node_neg": neg_n,
                "positive_node": pos_n,
                "negative_node": neg_n
            }
        ]

    # Construct final Circuit Data Model JSON per SPEC.md Section 9
    netlist_model = {
        "circuit_id": "circ_real_detected",
        "source": "real",
        "metadata": {
            "name": "Real Breadboard Scanned Circuit",
            "source": "real",
            "created_at": datetime.now().isoformat()
        },
        "power_source_status": power_source_status,
        "power_sources": power_sources,
        "nodes": nodes_list,
        "nets": formatted_nets,
        "nets_summary": nets_summary_strings,
        "components": updated_components,
        "pins": pins_list,
        "wires": wires_list
    }

    # Run Real Circuit Validator
    val_res = validate_circuit(netlist_model)

    # Embed validated topology and checks in netlist
    netlist_model["validity"] = {
        "status": val_res["status"],
        "netlist_status": val_res.get("netlist_status", "NETLIST_VALID"),
        "valid": val_res["valid"],
        "errors": val_res["errors"],
        "warnings": list(dict.fromkeys(connectivity_warnings + val_res["warnings"])),
        "checks": val_res["checks"],
        "component_connectivity": val_res["component_connectivity"]
    }
    netlist_model["solver_status"] = val_res["solver_status"]
    netlist_model["solver_reason"] = val_res["solver_reason"]

    return netlist_model
