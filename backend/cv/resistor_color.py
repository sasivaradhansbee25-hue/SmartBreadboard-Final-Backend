"""
SmartBreadboard 3D — Resistor Color-Band Recognition Engine (Phase 11 Real AI Pipeline)
Performs resistor crop orientation alignment, CIELAB color-band segmentation,
12-color classification, 4-band and 5-band mathematical decoding, unit formatting,
confidence scoring, and low-confidence warning flagging.
"""

import cv2
import numpy as np
import base64
import math

# Standard Resistor Color Code Definitions (CIELAB Reference Values L*, a*, b*)
COLOR_REFS_LAB = {
    "black":  {"lab": (15, 0, 0),      "digit": 0, "mult": 1,        "tol": None},
    "brown":  {"lab": (35, 15, 25),    "digit": 1, "mult": 10,       "tol": 0.01},
    "red":    {"lab": (45, 55, 45),    "digit": 2, "mult": 100,      "tol": 0.02},
    "orange": {"lab": (60, 45, 55),    "digit": 3, "mult": 1000,     "tol": None},
    "yellow": {"lab": (80, 5, 75),     "digit": 4, "mult": 10000,    "tol": None},
    "green":  {"lab": (50, -45, 35),   "digit": 5, "mult": 100000,   "tol": 0.005},
    "blue":   {"lab": (40, 10, -50),   "digit": 6, "mult": 1000000,  "tol": 0.0025},
    "violet": {"lab": (35, 35, -35),   "digit": 7, "mult": 10000000, "tol": 0.001},
    "gray":   {"lab": (55, 0, 0),      "digit": 8, "mult": None,     "tol": 0.0005},
    "white":  {"lab": (90, 0, 0),      "digit": 9, "mult": None,     "tol": None},
    "gold":   {"lab": (70, 10, 50),    "digit": None, "mult": 0.1,   "tol": 0.05},
    "silver": {"lab": (75, 0, 5),      "digit": None, "mult": 0.01,  "tol": 0.10}
}

def delta_e_cie76(lab1, lab2):
    """Calculates Euclidean color distance Delta E in CIELAB color space."""
    return math.sqrt((lab1[0] - lab2[0])**2 + (lab1[1] - lab2[1])**2 + (lab1[2] - lab2[2])**2)

def classify_pixel_color(lab_pixel):
    """Classifies a LAB color pixel into the closest standard resistor color band."""
    min_dist = float('inf')
    best_color = "brown"

    for color_name, meta in COLOR_REFS_LAB.items():
        dist = delta_e_cie76(lab_pixel, meta["lab"])
        if dist < min_dist:
            min_dist = dist
            best_color = color_name

    return best_color, min_dist

def align_resistor_crop(cv_img: np.ndarray) -> np.ndarray:
    """
    Aligns resistor major axis horizontally using minimum area rectangle (cv2.minAreaRect).
    """
    gray = cv2.cvtColor(cv_img, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 40, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    cnts, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    if not cnts:
        return cv_img

    largest_cnt = max(cnts, key=cv2.contourArea)
    rect = cv2.minAreaRect(largest_cnt)
    angle = rect[2]

    w, h = rect[1]
    if w < h:
        angle += 90

    (cx, cy) = rect[0]
    M = cv2.getRotationMatrix2D((cx, cy), angle, 1.0)
    rotated = cv2.warpAffine(cv_img, M, (cv_img.shape[1], cv_img.shape[0]), flags=cv2.INTER_CUBIC)

    return rotated

def format_resistance_value(ohms: float, tol: float) -> str:
    """Formats resistance into readable units (Ohms, kOhms, MOhms) + tolerance."""
    tol_pct = int(round(tol * 100)) if tol is not None else 5
    if ohms >= 1e6:
        val_str = f"{round(ohms / 1e6, 2):g} Mohm"
    elif ohms >= 1e3:
        val_str = f"{round(ohms / 1e3, 2):g} kohm"
    else:
        val_str = f"{round(ohms, 2):g} ohm"
    return f"{val_str} +/-{tol_pct}%"

def decode_resistor_bands(bands: list[str]) -> dict:
    """
    Decodes 4-band or 5-band color sequences into numeric resistance, multiplier, tolerance.
    """
    if len(bands) < 4:
        return {"resistance_ohms": 1000.0, "tolerance": 0.05, "formatted": "1 kohm +/-5%", "valid": False}

    is_5band = (len(bands) >= 5)

    if is_5band:
        d1 = COLOR_REFS_LAB.get(bands[0], {}).get("digit", 1) or 1
        d2 = COLOR_REFS_LAB.get(bands[1], {}).get("digit", 0) or 0
        d3 = COLOR_REFS_LAB.get(bands[2], {}).get("digit", 0) or 0
        mult = COLOR_REFS_LAB.get(bands[3], {}).get("mult", 100) or 100
        tol = COLOR_REFS_LAB.get(bands[4], {}).get("tol", 0.05) or 0.05

        val_digits = d1 * 100 + d2 * 10 + d3
        ohms = val_digits * mult
    else:
        d1 = COLOR_REFS_LAB.get(bands[0], {}).get("digit", 1) or 1
        d2 = COLOR_REFS_LAB.get(bands[1], {}).get("digit", 0) or 0
        mult = COLOR_REFS_LAB.get(bands[2], {}).get("mult", 100) or 100
        tol = COLOR_REFS_LAB.get(bands[3], {}).get("tol", 0.05) or 0.05

        val_digits = d1 * 10 + d2
        ohms = val_digits * mult

    formatted = format_resistance_value(ohms, tol)
    return {
        "resistance_ohms": float(ohms),
        "tolerance": float(tol),
        "formatted": formatted,
        "valid": True
    }

def analyze_resistor_color(crop_input: bytes | str, resistor_id: str = "R1") -> dict:
    """
    Main entry point for Phase 11 Resistor Color-Band Recognition.
    Accepts Base64 PNG crop or raw bytes.
    Decodes color bands, calculates resistance value, formats units, and computes confidence.
    """
    try:
        if isinstance(crop_input, str):
            if ',' in crop_input:
                crop_input = crop_input.split(',')[1]
            crop_bytes = base64.b64decode(crop_input)
        else:
            crop_bytes = crop_input

        nparr = np.frombuffer(crop_bytes, np.uint8)
        cv_img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if cv_img is None:
            return {
                "status": "error",
                "resistor_id": resistor_id,
                "error": "Failed to decode resistor crop bytes.",
                "detected_value": None,
                "user_override_value": None
            }

        aligned_img = align_resistor_crop(cv_img)
        h, w = aligned_img.shape[:2]

        lab_img = cv2.cvtColor(aligned_img, cv2.COLOR_BGR2LAB)
        l_channel, a_channel, b_channel = cv2.split(lab_img)
        clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
        l_clahe = clahe.apply(l_channel)
        lab_enhanced = cv2.merge((l_clahe, a_channel, b_channel))

        slice_y1 = int(h * 0.35)
        slice_y2 = int(h * 0.65)
        center_slice = lab_enhanced[slice_y1:slice_y2, :]

        col_labs = np.mean(center_slice, axis=0)

        detected_bands = []
        band_confidences = []
        step_stride = max(1, w // 4)

        for col_idx in range(step_stride // 2, w, step_stride):
            if len(detected_bands) >= 4:
                break
            pixel_lab = col_labs[col_idx]
            color_name, dist = classify_pixel_color(pixel_lab)
            conf = max(0.40, min(0.98, 1.0 - (dist / 40.0)))

            detected_bands.append(color_name)
            band_confidences.append(conf)

        avg_confidence = round(float(np.mean(band_confidences)), 2)
        is_uncertain = avg_confidence < 0.60 or len(detected_bands) < 4
        confidence_warning = is_uncertain

        warnings = []
        if is_uncertain:
            warnings.append("[WARNING] Resistor color-band value uncertain due to lighting or contrast.")

        decoded = decode_resistor_bands(detected_bands)

        formatted_val = "UNCERTAIN" if is_uncertain else decoded["formatted"]

        detected_payload = {
            "resistor_id": resistor_id,
            "band_count": len(detected_bands),
            "bands": detected_bands if not is_uncertain else [],
            "resistance_ohms": decoded["resistance_ohms"] if not is_uncertain else None,
            "tolerance": decoded["tolerance"] if not is_uncertain else None,
            "formatted_value": formatted_val,
            "confidence": avg_confidence,
            "confidence_category": "CONFIRMED" if avg_confidence >= 0.75 else ("PROBABLE" if avg_confidence >= 0.60 else "UNCERTAIN"),
            "confidence_warning": confidence_warning,
            "is_uncertain": is_uncertain,
            "warnings": warnings
        }

        # AGENTS.md Rule 5: Keep detected_value and user_override_value separate
        return {
            "status": "success" if not is_uncertain else "uncertain",
            "resistor_id": resistor_id,
            "detected_value": detected_payload,
            "user_override_value": None
        }

    except Exception as e:
        return {
            "status": "error",
            "resistor_id": resistor_id,
            "error": f"Resistor color analysis failure: {str(e)}",
            "detected_value": None,
            "user_override_value": None
        }
