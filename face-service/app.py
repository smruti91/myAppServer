import json
from fastapi import FastAPI, UploadFile, Form
from PIL import Image
import numpy as np
import insightface

app = FastAPI()

model = insightface.app.FaceAnalysis(
    providers=['CPUExecutionProvider']
)

model.prepare(
    ctx_id=0,
    det_size=(640, 640)
)

@app.get("/health")
def health():
    return {
        "status": "ok"
    }

@app.post("/embedding")
async def embedding(file: UploadFile):

    image = Image.open(file.file).convert("RGB")

    image = np.array(image)

    faces = model.get(image)

    if not faces:
        return {
            "success": False,
            "message": "No face detected"
        }

    return {
        "success": True,
        "embedding": faces[0].embedding.tolist()
    }


@app.post("/verify")
async def verify(
    file: UploadFile,
    stored_embedding: str = Form(...),
    threshold: float = Form(0.40),
):
    """
    Compare a live face image against a stored embedding.
    - `stored_embedding`: JSON string of a 512-dim list.
    - `threshold`: cosine distance below which the face is considered a match.
    Returns: { success, distance, verified, message }
    """
    try:
        stored = np.array(json.loads(stored_embedding), dtype=np.float32)
    except Exception as e:
        return {"success": False, "verified": False, "message": f"bad stored_embedding: {e}"}

    image = Image.open(file.file).convert("RGB")
    img = np.array(image)

    faces = model.get(img)
    if not faces:
        return {"success": False, "verified": False, "message": "No face detected"}

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
    }