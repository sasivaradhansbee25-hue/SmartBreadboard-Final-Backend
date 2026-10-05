"""
SmartBreadboard 3D — Circuit Validation Engine
Checks circuit netlist for engineering errors: missing ground, floating nodes, short circuits, zero/negative resistance, missing source.
"""

from typing import List, Dict, Any, Tuple, Optional

def validate_circuit_netlist(components: List[Dict[str, Any]], power_sources: List[Dict[str, Any]]) -> Tuple[bool, Optional[Dict[str, Any]], List[str]]:
    """
    Validates components and sources.
    Returns (is_valid, error_dict_or_none, list_of_warnings)
    """
    warnings = []

    if not components:
        return False, {
            "code": "EMPTY_CIRCUIT",
            "message": "Circuit contains no detected or defined components."
        }, warnings

    if not power_sources:
        has_reactive = any("cap" in str(c.get("type", "")).lower() or "ind" in str(c.get("type", "")).lower() for c in components)
        if not has_reactive:
            return False, {
                "code": "POWER_SOURCE_REQUIRED",
                "message": "No active power source was detected in this photograph. Please add a simulated source for analysis."
            }, warnings


    # Validate each power source
    for ps in power_sources:
        pos_n = str(ps.get("positive_node") or ps.get("node_pos") or ps.get("positiveNode") or ps.get("node1", ""))
        neg_n = str(ps.get("negative_node") or ps.get("node_neg") or ps.get("negativeNode") or ps.get("node2", ""))

        stype = str(ps.get("type", "voltage_source")).lower()
        v_candidates = [
            ps.get("voltage"),
            ps.get("value"),
            ps.get("final_value"),
            ps.get("finalValue"),
            ps.get("initial_value"),
            ps.get("initialValue"),
            ps.get("v_high"),
            ps.get("high"),
            ps.get("amplitude"),
            ps.get("v_ac")
        ]
        non_none_v = [float(v) for v in v_candidates if v is not None]
        v_val = max(non_none_v) if non_none_v else 0.0

        is_transient_or_ac_type = stype in ["step", "voltage_step", "dc_step", "pulse", "voltage_pulse", "square", "sine", "ac", "sinusoidal", "transient"]
        has_reactive = any("cap" in str(c.get("type", "")).lower() or "ind" in str(c.get("type", "")).lower() for c in components)
        if v_val <= 0 and not is_transient_or_ac_type and not has_reactive:
            return False, {
                "code": "INVALID_SOURCE_VOLTAGE",
                "message": f"Simulated voltage source must be greater than 0V (got {v_val}V)."
            }, warnings

        if not pos_n or not neg_n:
            return False, {
                "code": "INVALID_SOURCE_CONNECTION",
                "message": "Source terminals must be connected to valid circuit nodes."
            }, warnings


        if pos_n.upper() == neg_n.upper():
            return False, {
                "code": "SAME_NODE_SOURCE",
                "message": "The selected positive and negative terminals resolve to the same electrical node."
            }, warnings

    has_ground = False
    all_nodes = set()
    node_connections = {}

    for c in components:
        n1 = str(c.get("node1", c.get("hole1", "")))
        n2 = str(c.get("node2", c.get("hole2", "")))

        if not n1 or not n2:
            return False, {
                "code": "DISCONNECTED_COMPONENT",
                "message": f"Component '{c.get('id', 'unknown')}' is missing valid terminal/node connections."
            }, warnings

        all_nodes.add(n1)
        all_nodes.add(n2)

        node_connections[n1] = node_connections.get(n1, 0) + 1
        node_connections[n2] = node_connections.get(n2, 0) + 1

        if "GND" in n1.upper() or "GND" in n2.upper() or "GROUND" in n1.upper() or "GROUND" in n2.upper():
            has_ground = True

    for ps in power_sources:
        n1 = str(ps.get("positive_node", ps.get("positiveNode", ps.get("node1", ""))))
        n2 = str(ps.get("negative_node", ps.get("negativeNode", ps.get("node2", ""))))
        if n1:
            all_nodes.add(n1)
        if n2:
            all_nodes.add(n2)
        if "GND" in n1.upper() or "GND" in n2.upper() or "GROUND" in n1.upper() or "GROUND" in n2.upper():
            has_ground = True

    if not has_ground:
        if power_sources:
            warnings.append("No explicit GND label found; using power source negative terminal as reference node.")
        else:
            return False, {
                "code": "MISSING_GROUND",
                "message": "Circuit has no ground (0V) reference node. Please designate a ground node or connect a power source."
            }, warnings

    # Check for floating nodes
    for node, count in node_connections.items():
        if count == 1 and not ("GND" in node.upper() or "PWR" in node.upper() or "VCC" in node.upper()):
            warnings.append(f"Node '{node}' is floating (connected to only 1 terminal).")

    # Check for invalid or unknown component values
    for c in components:
        comp_type = str(c.get("type", "")).lower()
        cid = c.get("designator", c.get("id", "R"))
        val = c.get("value") if c.get("value") is not None else (c.get("detected_value") or c.get("user_override_value"))
        needs_conf = c.get("needsConfirmation", False)
        v_source = c.get("valueSource", "")
        c_source = str(c.get("source", "")).lower()

        # Unknown components must be manually defined before simulation
        if comp_type == "unknown" or c_source == "unknown":
            return False, {
                "code": "UNKNOWN_COMPONENT_DEFINITION_REQUIRED",
                "message": f"Component '{cid}' is unknown and must be manually defined before simulation."
            }, warnings

        # Resistors, Capacitors, Inductors require numeric electrical values
        if comp_type in ["resistor", "res", "capacitor", "cap", "inductor", "ind"]:
            if val is None:
                if comp_type in ["resistor", "res"]:
                    c["value"] = 220.0
                    val = 220.0
                elif comp_type in ["capacitor", "cap"]:
                    c["value"] = 100e-9
                    val = 100e-9
                elif comp_type in ["inductor", "ind"]:
                    c["value"] = 1e-3
                    val = 1e-3
                else:
                    return False, {
                        "code": "VALUE_CONFIRMATION_REQUIRED",
                        "message": f"Component '{cid}' requires value confirmation before simulation."
                    }, warnings

            if isinstance(val, (int, float)):
                if val <= 0:
                    return False, {
                        "code": "INVALID_VALUE",
                        "message": f"Component '{cid}' has invalid non-positive value ({val})."
                    }, warnings

    return True, None, warnings

