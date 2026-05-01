import logging
from datetime import datetime
from fastapi import APIRouter, WebSocket, Request, WebSocketDisconnect

router = APIRouter()

def _format_log(data: dict) -> str:
    ts = data.get('ts', datetime.utcnow().isoformat())
    level = data.get('level', 'info').upper()
    source = data.get('source', '?')
    message = data.get('message', '')
    return f"[{ts}] [{level:5s}] [{source:8s}] {message}"

@router.post("/api/log")
async def receive_log(request: Request):
    data = await request.json()
    print(_format_log(data), flush=True)
    return {"ok": True}

@router.websocket("/ws/log")
async def ws_log(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_json()
            print(_format_log(data), flush=True)
    except WebSocketDisconnect:
        pass
