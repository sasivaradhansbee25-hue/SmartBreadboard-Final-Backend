"""
SmartBreadboard 3D — Single-Photo Top-Angle & Image Quality Validator (Scanner Phase)
Evaluates:
- Image brightness & exposure
- Image sharpness & blur
- Image contrast
- Breadboard / circuit framing & coverage
- Perspective & top-down viewing angle
- Detectable circuit evidence

Returns:
{
    "valid": bool,
    "score": int (0-100),
    "reasons": list[str],
    "recommendations": list[str],
    "metrics": {
        "top_angle": "GOOD" | "POOR",
        "circuit_visibility": "GOOD" | "POOR",
        "image_quality": "GOOD" | "POOR"
    }
}
"""

import cv2
import numpy as np
from typing import Dict, Any, List

def validate_photo_quality(img: np.ndarray, expected_view: str = "top") -> Dict[str, Any]:
    """
    Validates a captured or uploaded single circuit image against practical top-angle,
    framing, sharpness, brightness, and circuit-evidence criteria.
    """
    if img is None or not isinstance(img, np.ndarray) or img.size == 0:
        return {
            "valid": False,
            "score": 0,
            "reasons": ["Invalid or missing image data."],
            "recommendations": ["Please capture or upload a clear circuit photo."],
            "metrics": {
                "top_angle": "POOR",
                "circuit_visibility": "POOR",
                "image_quality": "POOR",
                "sharpness": 0.0,
                "brightness": 0.0,
                "contrast": 0.0
            },
            "ready": False,
            "board_detected": False,
            "suggested_guidance": "Please present a clear view of the circuit to the camera."
        }

    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img

    reasons: List[str] = []
    recommendations: List[str] = []

    # 1. Brightness & Exposure check
    mean_brightness = float(np.mean(gray))
    if mean_brightness < 20.0:
        recommendations.append("Increase lighting or move to a brighter area.")
    elif mean_brightness > 245.0:
        recommendations.append("Reduce harsh glare or diffuse the light source.")

    # 2. Sharpness & Blur check (Laplacian variance)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    if sharpness < 8.0:
        recommendations.append("Hold the camera steady and tap to focus directly on the breadboard.")

    # 3. Contrast check
    contrast = float(np.std(gray))
    if contrast < 10.0:
        recommendations.append("Ensure the circuit is placed on a contrasting surface.")

    # 4. Circuit Evidence & Edge Density
    edges = cv2.Canny(gray, 40, 140)
    edge_density = float(np.count_nonzero(edges)) / float(gray.size)

    # 5. Breadboard / Circuit Geometry, Framing, and Top-Angle Skew
    from cv.preprocessing import find_breadboard_corners

    rect, corners_list = find_breadboard_corners(img)

    if rect is not None:
        pts = rect # [tl, tr, br, bl]
        w_top = float(np.linalg.norm(pts[1] - pts[0]))
        w_bot = float(np.linalg.norm(pts[2] - pts[3]))
        h_left = float(np.linalg.norm(pts[3] - pts[0]))
        h_right = float(np.linalg.norm(pts[2] - pts[1]))

        max_w = max(w_top, w_bot)
        min_w = min(w_top, w_bot)
        max_h = max(h_left, h_right)
        min_h = min(h_left, h_right)

        w_ratio = min_w / max_w if max_w > 0 else 1.0
        h_ratio = min_h / max_h if max_h > 0 else 1.0
        perspective_ratio = min(w_ratio, h_ratio)

        if perspective_ratio < 0.30:
            recommendations.append("For optimal accuracy, position camera top-down directly above the circuit.")

        # Breadboard Coverage check
        bb_area = float(cv2.contourArea(pts.astype(np.int32)))
        area_ratio = bb_area / float(w * h)
        if area_ratio < 0.05:
            recommendations.append("Move the camera closer so the circuit fills more of the frame.")
    else:
        # If no strict 4-corner breadboard is detected, check general edge density
        if edge_density < 0.005:
            reasons.append("No recognizable circuit or breadboard detected in the photo.")
            recommendations.append("Ensure the circuit is clearly visible in the center of the camera.")

    # Calculate overall validity (valid=True for all images containing basic edge structure)
    valid = len(reasons) == 0

    if valid:
        base_score = 80
        sharp_bonus = min(10, int(sharpness / 12.0))
        contrast_bonus = min(8, int(contrast / 10.0))
        score = min(96, base_score + sharp_bonus + contrast_bonus)
    else:
        score = 30

    top_angle_status = "POOR" if any("angle" in r or "perspective" in r for r in recommendations) else "GOOD"
    circuit_vis_status = "POOR" if any("No recognizable" in r for r in reasons) else "GOOD"
    image_qual_status = "POOR" if (sharpness < 15.0 or mean_brightness < 30.0 or contrast < 14.0) else "GOOD"

    return {
        "valid": valid,
        "score": score,
        "reasons": reasons,
        "recommendations": recommendations,
        "metrics": {
            "top_angle": top_angle_status,
            "circuit_visibility": circuit_vis_status,
            "image_quality": image_qual_status,
            "sharpness": round(sharpness, 1),
            "brightness": round(mean_brightness, 1),
            "contrast": round(contrast, 1)
        },
        "ready": valid,
        "board_detected": valid or ("No recognizable circuit" not in " ".join(reasons)),
        "angle_valid": top_angle_status == "GOOD",
        "framing_valid": circuit_vis_status == "GOOD",
        "sharpness_valid": sharpness >= 22.0,
        "lighting_valid": 40.0 <= mean_brightness <= 230.0,
        "suggested_guidance": recommendations[0] if recommendations else "Circuit view accepted."
    }
