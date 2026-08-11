import json
from fastapi import FastAPI, UploadFile, Form
from PIL import Image
import numpy as np
import insightface
from antispoof import LivenessModel

app = FastAPI()

model = insightface.app.FaceAnalysis(
    providers=['CPUExecutionProvider']
)

model.prepare(
    ctx_id=0,
    det_size=(640, 640)
)

# MiniFAS anti-spoofing model (facenox/face-antispoof-onnx)
liveness = LivenessModel()


def load_rgb(file: UploadFile) -> np.ndarray:
    """Read an uploaded image as a uint8 RGB array (matches InsightFace input)."""
    image = Image.open(file.file).convert("RGB")
    return np.array(image)


def check_liveness(img: np.ndarray, bbox, probability_threshold: float) -> dict:
    """Run anti-spoofing on the detected face. bbox = [x1, y1, x2, y2]."""
    return liveness.predict(img, bbox, probability_threshold)


@app.get("/health")
def health():
    return {
        "status": "ok"
    }


@app.post("/liveness")
async def liveness_check(
    file: UploadFile,
    threshold: float = Form(0.5),
):
    """
    Anti-spoofing only: detect a face and classify it as real or spoof.
    - `threshold`: real-class probability threshold (0.5 default).
    Returns: { success, is_real, status, confidence, logit_diff, ... }
    """
    img = load_rgb(file)

    faces = model.get(img)
    if not faces:
        return {
            "success": False,
            "is_real": False,
            "status": "no_face",
            "message": "No face detected",
        }

    result = check_liveness(img, faces[0].bbox, threshold)
    result["success"] = True
    return result


@app.post("/embedding")
async def embedding(
    file: UploadFile,
    require_liveness: bool = Form(True),
    threshold: float = Form(0.5),
):
    """
    Extract a 512-dim embedding for a face image.
    Spoofed faces are rejected by default; pass require_liveness=false to skip.
    Returns: { success, embedding, liveness, message }
    """
    img = load_rgb(file)

    faces = model.get(img)
    if not faces:
        return {
            "success": False,
            "message": "No face detected"
        }

    result = check_liveness(img, faces[0].bbox, threshold)

    if require_liveness and not result["is_real"]:
        return {
            "success": False,
            "message": f"Spoofed face detected ({result['status']})",
            "liveness": result,
        }

    return {
        "success": True,
        "embedding": faces[0].embedding.tolist(),
        "liveness": result,
    }


@app.post("/verify")
async def verify(
    file: UploadFile,
    stored_embedding: str = Form(...),
    threshold: float = Form(0.40),
    require_liveness: bool = Form(True),
    liveness_threshold: float = Form(0.5),
):
    """
    Compare a live face image against a stored embedding.
    - `stored_embedding`: JSON string of a 512-dim list.
    - `threshold`: cosine distance below which the face is considered a match.
    - `require_liveness`: reject spoofed faces (default true).
    Returns: { success, distance, verified, message, liveness }
    """
    try:
        stored = np.array(json.loads(stored_embedding), dtype=np.float32)
    except Exception as e:
        return {"success": False, "verified": False, "message": f"bad stored_embedding: {e}"}

    img = load_rgb(file)

    faces = model.get(img)
    if not faces:
        return {"success": False, "verified": False, "message": "No face detected"}

    result = check_liveness(img, faces[0].bbox, liveness_threshold)

    if require_liveness and not result["is_real"]:
        return {
            "success": False,
            "verified": False,
            "distance": 1.0,
            "threshold": threshold,
            "message": f"Spoofed face detected ({result['status']})",
            "liveness": result,
        }

    live = faces[0].embedding.astype(np.float32)

    # Cosine distance = 1 - cosine similarity
    a = live / (np.linalg.norm(live) + 1e-12)
    b = stored / (np.linalg.norm(stored) + 1e-12)
    distance = float(1.0 - float(np.dot(a, b)))

    verified = distance <= threshold

    return {
        "success": True,
        "verified": verified,
        "distance": distance,
        "threshold": threshold,
        "message": "match" if verified else "no match",
        "liveness": result,
    }
