from fastapi import FastAPI, UploadFile
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