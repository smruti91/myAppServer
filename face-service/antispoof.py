"""MiniFAS face anti-spoofing (real vs spoof) via ONNX Runtime.

Standalone port of the inference pipeline from
facenox/face-antispoof-onnx (src/inference + preprocess + crop).

Model: models/best_model_quantized.onnx
  input : (N, 3, 128, 128) float32 RGB, normalized to [0, 1]
  output: (N, 2) float32 logits -> [real_logit, spoof_logit]

Detection is intentionally left to the caller (the FastAPI service already
runs InsightFace). This module only crops the detected face and classifies it.
"""

import cv2
import numpy as np
import onnxruntime as ort
from pathlib import Path

MODEL_PATH = Path(__file__).parent / "models" / "best_model_quantized.onnx"
MODEL_IMG_SIZE = 128
BBOX_EXPANSION_FACTOR = 1.5


def load_model(model_path=MODEL_PATH):
    sess_options = ort.SessionOptions()
    sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    sess_options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    available = ort.get_available_providers()
    providers = [p for p in ("CUDAExecutionProvider", "CPUExecutionProvider") if p in available]
    if not providers:
        providers = available
    session = ort.InferenceSession(str(model_path), sess_options=sess_options, providers=providers)
    input_name = session.get_inputs()[0].name
    return session, input_name


def probability_to_logit_threshold(p: float) -> float:
    """Map a desired real-class probability to the logit-diff threshold.

    logit_diff = real_logit - spoof_logit. A probability of 0.5 maps to 0.
    """
    p = max(1e-6, min(1 - 1e-6, p))
    return float(np.log(p / (1 - p)))


def crop_face(img: np.ndarray, bbox: tuple, expansion_factor: float = BBOX_EXPANSION_FACTOR) -> np.ndarray:
    """Extract a square face crop from an InsightFace bbox [x1, y1, x2, y2].

    Mirrors the repo's crop(): expands around the bbox center, pads edges
    with BORDER_REFLECT_101, and returns a square image.
    """
    h, w = img.shape[:2]
    x1, y1, x2, y2 = (int(v) for v in bbox)

    bw = x2 - x1
    bh = y2 - y1
    if bw <= 0 or bh <= 0:
        raise ValueError("Invalid bbox dimensions")

    max_dim = max(bw, bh)
    cx, cy = x1 + bw / 2, y1 + bh / 2
    size = int(max_dim * expansion_factor)

    x = int(cx - size / 2)
    y = int(cy - size / 2)

    top_pad = int(max(0, -y))
    left_pad = int(max(0, -x))
    bottom_pad = int(max(0, (y + size) - h))
    right_pad = int(max(0, (x + size) - w))

    x1c, y1c = max(0, x), max(0, y)
    x2c, y2c = min(w, x + size), min(h, y + size)

    face = img[y1c:y2c, x1c:x2c] if x2c > x1c and y2c > y1c else np.zeros((0, 0, 3), dtype=img.dtype)
    crop = cv2.copyMakeBorder(face, top_pad, bottom_pad, left_pad, right_pad, cv2.BORDER_REFLECT_101)
    return crop


def preprocess(face: np.ndarray, model_img_size: int = MODEL_IMG_SIZE) -> np.ndarray:
    """Letterbox-resize to model_img_size, normalize to [0,1], CHW float32."""
    new_size = model_img_size
    old_h, old_w = face.shape[:2]

    ratio = float(new_size) / max(old_h, old_w)
    scaled_shape = (int(old_h * ratio), int(old_w * ratio))
    interp = cv2.INTER_LANCZOS4 if ratio > 1.0 else cv2.INTER_AREA
    resized = cv2.resize(face, (scaled_shape[1], scaled_shape[0]), interpolation=interp)

    dw = new_size - scaled_shape[1]
    dh = new_size - scaled_shape[0]
    top, bottom = dh // 2, dh - (dh // 2)
    left, right = dw // 2, dw - (dw // 2)

    resized = cv2.copyMakeBorder(resized, top, bottom, left, right, cv2.BORDER_REFLECT_101)
    return resized.transpose(2, 0, 1).astype(np.float32) / 255.0


def process_logits(logits: np.ndarray, logit_threshold: float) -> dict:
    real_logit = float(logits[0])
    spoof_logit = float(logits[1])
    logit_diff = real_logit - spoof_logit
    return {
        "is_real": bool(logit_diff >= logit_threshold),
        "status": "real" if logit_diff >= logit_threshold else "spoof",
        "logit_diff": float(logit_diff),
        "real_logit": real_logit,
        "spoof_logit": spoof_logit,
        "confidence": float(abs(logit_diff)),
    }


class LivenessModel:
    """Wraps the MiniFAS liveness session. Load once at startup, reuse forever."""

    def __init__(
        self,
        model_path=MODEL_PATH,
        img_size: int = MODEL_IMG_SIZE,
        probability_threshold: float = 0.5,
    ):
        self.session, self.input_name = load_model(model_path)
        self.img_size = img_size
        self.logit_threshold = probability_to_logit_threshold(probability_threshold)

    def predict(self, img_rgb: np.ndarray, bbox: tuple, probability_threshold: float = None) -> dict:
        """Classify the face inside ``bbox`` ([x1, y1, x2, y2]) in ``img_rgb``.

        ``probability_threshold`` overrides the instance default per call.
        """
        logit_threshold = (
            probability_to_logit_threshold(probability_threshold)
            if probability_threshold is not None
            else self.logit_threshold
        )
        face = crop_face(img_rgb, bbox, BBOX_EXPANSION_FACTOR)
        batch = preprocess(face, self.img_size)[np.newaxis, ...]
        logits = self.session.run([], {self.input_name: batch})[0][0]
        return process_logits(logits, logit_threshold)
