"""Loopback-only PCM-to-WAV receiver. Test tool, never included in a service image."""
import json
import os
import socket
import struct
import sys
import uuid
import wave
from pathlib import Path

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

app = FastAPI()
output = Path(__file__).resolve().parents[2] / ".dev/audio/receiver"
output.mkdir(parents=True, exist_ok=True)


@app.websocket("/audio")
async def receive(socket: WebSocket):
    await socket.accept()
    writers = {}
    sequences = {}
    try:
        while True:
            frame = await socket.receive_bytes()
            if len(frame) < 4:
                await socket.close(1008)
                return
            length = struct.unpack(">I", frame[:4])[0]
            metadata = json.loads(frame[4:4 + length])
            pcm = frame[4 + length:]
            key = (str(uuid.UUID(metadata["stream_id"])), str(uuid.UUID(metadata["epoch"])))
            if (metadata["sample_rate"] != 16000 or metadata["channels"] != 1
                    or metadata["encoding"] != "pcm_s16le"
                    or len(pcm) != metadata["sample_count"] * 2
                    or metadata["sequence"] != sequences.get(key, 0)):
                await socket.close(1008)
                return
            if key not in writers:
                writer = wave.open(str(output / f"{key[0]}-{key[1]}.wav"), "wb")
                writer.setnchannels(1)
                writer.setsampwidth(2)
                writer.setframerate(16000)
                writers[key] = writer
            writers[key].writeframesraw(pcm)
            sequences[key] = metadata["sequence"] + 1
            await socket.send_json({"type": "ack", "sequence": metadata["sequence"]})
    except WebSocketDisconnect:
        pass
    finally:
        for writer in writers.values():
            writer.close()


if __name__ == "__main__":
    requested_port = int(os.environ.get("WORTLAUT_RECEIVER_PORT", "0"))
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", requested_port))
    bound_port = sock.getsockname()[1]
    print(f"WORTLAUT_RECEIVER_PORT={bound_port}", file=sys.stderr, flush=True)
    config = uvicorn.Config(app, host="127.0.0.1", port=bound_port)
    uvicorn.Server(config).run(sockets=[sock])
