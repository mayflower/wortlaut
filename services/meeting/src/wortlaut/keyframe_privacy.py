"""Local CPU face detection and anonymization for screen-share keyframes.

When a presenter shares an entire desktop rather than a single application
window, floating conference Picture-in-Picture (PiP) overlays can embed a live
webcam feed into the shared screen stream. Detecting and blurring faces before
object-storage persistence upholds the 'no participant camera images' guarantee
without adding external services or heavy image dependencies.
"""

import logging
import struct
import zlib
from functools import lru_cache
from pathlib import Path
from typing import cast

import numpy as np
import onnxruntime as ort

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
YUNET_MODEL_PATH = Path(__file__).resolve().parent / "assets" / "face_detection_yunet_2023mar.onnx"
TILE_SIZE = 640
STRIDES = (8, 16, 32)
SCORE_THRESHOLD = 0.58
FULL_FRAME_SCORE_THRESHOLD = 0.62
NMS_IOU_THRESHOLD = 0.30
MAX_PNG_DIMENSION = 1280


@lru_cache(maxsize=1)
def _yunet_session() -> ort.InferenceSession:
    ort.set_default_logger_severity(3)
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 1
    opts.inter_op_num_threads = 1
    opts.log_severity_level = 3
    return ort.InferenceSession(
        str(YUNET_MODEL_PATH),
        sess_options=opts,
        providers=["CPUExecutionProvider"],
    )


def _decode_png_8bit(png_bytes: bytes) -> tuple[np.ndarray, int] | None:
    """Decode non-interlaced 8-bit Grayscale/RGB/Palette/RGBA PNG into (H, W, C) uint8."""
    if len(png_bytes) < 33 or png_bytes[:8] != PNG_SIGNATURE:
        return None
    pos = 8
    width = height = bit_depth = color_type = interlace = -1
    idat = bytearray()
    palette: bytes | None = None
    trns: bytes | None = None

    while pos + 8 <= len(png_bytes):
        length, tag = struct.unpack(">I4s", png_bytes[pos : pos + 8])
        chunk_end = pos + 8 + length
        if chunk_end + 4 > len(png_bytes):
            return None
        chunk = png_bytes[pos + 8 : chunk_end]
        pos = chunk_end + 4
        if tag == b"IHDR":
            if length != 13:
                return None
            width, height, bit_depth, color_type, comp, filt, interlace = struct.unpack(
                ">IIBBBBB", chunk
            )
            if (
                bit_depth != 8
                or comp != 0
                or filt != 0
                or interlace != 0
                or color_type not in (0, 2, 3, 6)
                or not (1 <= width <= MAX_PNG_DIMENSION and 1 <= height <= MAX_PNG_DIMENSION)
            ):
                return None
        elif tag == b"PLTE":
            palette = chunk
        elif tag == b"tRNS":
            trns = chunk
        elif tag == b"IDAT":
            idat.extend(chunk)
        elif tag == b"IEND":
            break

    if width <= 0 or height <= 0 or not idat:
        return None
    channels = {0: 1, 2: 3, 3: 1, 6: 4}[color_type]
    if color_type == 3 and (palette is None or len(palette) < 3 or len(palette) % 3 != 0):
        return None

    stride = width * channels
    expected_raw = height * (1 + stride)
    dobj = zlib.decompressobj()
    try:
        raw = dobj.decompress(bytes(idat), max_length=expected_raw + 64)
        if not dobj.eof or dobj.unconsumed_tail:
            return None
        tail = dobj.flush(64)
        if tail:
            raw += tail
    except zlib.error:
        return None
    if len(raw) != expected_raw:
        return None

    raw_np = np.frombuffer(raw, dtype=np.uint8).reshape(height, 1 + stride)
    out = np.empty((height, stride), dtype=np.uint8)
    prev = bytearray(stride)

    for y in range(height):
        ft = int(raw_np[y, 0])
        row = raw_np[y, 1:]
        if ft == 0:
            cur = row.copy()
        elif ft == 1:
            r_ch = row.reshape(width, channels).astype(np.int32)
            cur = (np.cumsum(r_ch, axis=0) & 0xFF).astype(np.uint8).reshape(stride)
        elif ft == 2:
            prev_np = np.frombuffer(prev, dtype=np.uint8).astype(np.int16)
            cur = ((row.astype(np.int16) + prev_np) & 0xFF).astype(np.uint8)
        elif ft == 3:
            rb = row.tobytes()
            cb = bytearray(stride)
            for i in range(stride):
                a = cb[i - channels] if i >= channels else 0
                cb[i] = (rb[i] + ((a + prev[i]) >> 1)) & 0xFF
            cur = np.frombuffer(cb, dtype=np.uint8).copy()
        elif ft == 4:
            rb = row.tobytes()
            cb = bytearray(stride)
            for i in range(stride):
                a = cb[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                p = a + b - c
                pa = p - a if p >= a else a - p
                pb = p - b if p >= b else b - p
                pc = p - c if p >= c else c - p
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                cb[i] = (rb[i] + pr) & 0xFF
            cur = np.frombuffer(cb, dtype=np.uint8).copy()
        else:
            return None
        out[y] = cur
        prev = bytearray(cur.tobytes())

    if color_type == 3 and palette is not None:
        n_entries = len(palette) // 3
        pal_rgb = np.zeros((256, 3), dtype=np.uint8)
        pal_rgb[:n_entries] = np.frombuffer(palette, dtype=np.uint8).reshape(n_entries, 3)
        idx_img = out.reshape(height, width)
        if trns:
            pal_rgba = np.full((256, 4), 255, dtype=np.uint8)
            pal_rgba[:, :3] = pal_rgb
            n_trns = min(256, len(trns))
            pal_rgba[:n_trns, 3] = np.frombuffer(trns[:n_trns], dtype=np.uint8)
            return pal_rgba[idx_img], 6
        return pal_rgb[idx_img], 2

    return out.reshape(height, width, channels), color_type


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    crc = zlib.crc32(tag + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)


def _encode_png_8bit(img: np.ndarray, color_type: int, *, compress_level: int = 6) -> bytes:
    height, width, channels = img.shape
    stride = width * channels
    flat = img.reshape(height, stride)
    # Up-filtering (type 2) compresses flat desktop UI regions tightly in vectorized NumPy.
    up = np.empty((height, 1 + stride), dtype=np.uint8)
    up[:, 0] = 2
    up[0, 1:] = flat[0]
    if height > 1:
        up[1:, 1:] = ((flat[1:].astype(np.int16) - flat[:-1].astype(np.int16)) & 0xFF).astype(
            np.uint8
        )
    ihdr = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    idat = zlib.compress(up.tobytes(), level=compress_level)
    return (
        PNG_SIGNATURE
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", idat)
        + _png_chunk(b"IEND", b"")
    )


def _detect_tile_640(
    sess: ort.InferenceSession,
    tile_bgr: np.ndarray,
    score_threshold: float,
) -> list[tuple[float, float, float, float, float]]:
    inp = np.transpose(tile_bgr.astype(np.float32), (2, 0, 1))[None, :, :, :]
    outs = cast(list[np.ndarray], sess.run(None, {"input": inp}))
    boxes: list[tuple[float, float, float, float, float]] = []
    for idx, st in enumerate(STRIDES):
        cols = TILE_SIZE // st
        cls = np.clip(outs[idx][0, :, 0], 0.0, 1.0)
        obj = np.clip(outs[idx + 3][0, :, 0], 0.0, 1.0)
        scores = np.sqrt(cls * obj)
        keep = np.nonzero(scores >= score_threshold)[0]
        if keep.size == 0:
            continue
        bbox = outs[idx + 6][0, keep]
        r = keep // cols
        c = keep % cols
        cx = (c + bbox[:, 0]) * st
        cy = (r + bbox[:, 1]) * st
        bw = np.exp(bbox[:, 2]) * st
        bh = np.exp(bbox[:, 3]) * st
        x1 = cx - bw * 0.5
        y1 = cy - bh * 0.5
        for x, y, fw, fh, sc in zip(x1, y1, bw, bh, scores[keep], strict=True):
            if fw >= 10.0 and fh >= 10.0:
                boxes.append((float(x), float(y), float(fw), float(fh), float(sc)))
    return boxes


def _nms_boxes(
    boxes: list[tuple[float, float, float, float, float]],
    iou_threshold: float = NMS_IOU_THRESHOLD,
) -> list[tuple[float, float, float, float, float]]:
    if len(boxes) <= 1:
        return boxes
    ordered = sorted(boxes, key=lambda b: b[4], reverse=True)
    kept: list[tuple[float, float, float, float, float]] = []
    for cand in ordered:
        cx1, cy1, cw, ch, _ = cand
        cx2, cy2 = cx1 + cw, cy1 + ch
        c_area = max(1.0, cw * ch)
        suppressed = False
        for prev in kept:
            px1, py1, pw, ph, _ = prev
            px2, py2 = px1 + pw, py1 + ph
            ix1, iy1 = max(cx1, px1), max(cy1, py1)
            ix2, iy2 = min(cx2, px2), min(cy2, py2)
            iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
            inter = iw * ih
            if inter <= 0.0:
                continue
            union = c_area + max(1.0, pw * ph) - inter
            if inter / union >= iou_threshold or inter / min(c_area, max(1.0, pw * ph)) >= 0.65:
                suppressed = True
                break
        if not suppressed:
            kept.append(cand)
    return kept


def detect_faces_rgb(rgb: np.ndarray) -> list[tuple[int, int, int, int]]:
    """Return deduplicated (x1, y1, x2, y2) face bounding boxes on an RGB (H, W, 3) array."""
    height, width, _ = rgb.shape
    if height < 16 or width < 16:
        return []
    bgr = rgb[:, :, ::-1]
    sess = _yunet_session()
    candidates: list[tuple[float, float, float, float, float]] = []

    xs = sorted({0, max(0, (width - TILE_SIZE) // 2), max(0, width - TILE_SIZE)})
    ys = sorted({0, max(0, height - TILE_SIZE)})
    for oy in ys:
        for ox in xs:
            sub = bgr[oy : oy + TILE_SIZE, ox : ox + TILE_SIZE]
            sh, sw, _ = sub.shape
            if sh == TILE_SIZE and sw == TILE_SIZE:
                tile = sub
            else:
                tile = np.zeros((TILE_SIZE, TILE_SIZE, 3), dtype=np.uint8)
                tile[:sh, :sw] = sub
            for x, y, fw, fh, sc in _detect_tile_640(sess, tile, SCORE_THRESHOLD):
                # Discard padded border artifacts outside the real sub-image.
                if x + fw * 0.5 <= sw and y + fh * 0.5 <= sh:
                    candidates.append((x + ox, y + oy, fw, fh, sc))

    if width > TILE_SIZE or height > TILE_SIZE:
        even_h, even_w = (height // 2) * 2, (width // 2) * 2
        if even_h >= 32 and even_w >= 32:
            half = (
                bgr[:even_h, :even_w]
                .reshape(even_h // 2, 2, even_w // 2, 2, 3)
                .mean(axis=(1, 3))
                .astype(np.uint8)
            )
            hh, hw, _ = half.shape
            if hh <= TILE_SIZE and hw <= TILE_SIZE:
                tile = np.zeros((TILE_SIZE, TILE_SIZE, 3), dtype=np.uint8)
                tile[:hh, :hw] = half
                for x, y, fw, fh, sc in _detect_tile_640(sess, tile, FULL_FRAME_SCORE_THRESHOLD):
                    if x + fw * 0.5 <= hw and y + fh * 0.5 <= hh:
                        candidates.append((x * 2.0, y * 2.0, fw * 2.0, fh * 2.0, sc))

    merged = _nms_boxes(candidates)
    boxes: list[tuple[int, int, int, int]] = []
    for x, y, fw, fh, _ in merged:
        pad_x = max(6, round(fw * 0.35))
        pad_y = max(6, round(fh * 0.40))
        x1 = max(0, round(x) - pad_x)
        y1 = max(0, round(y) - pad_y)
        x2 = min(width, round(x + fw) + pad_x)
        y2 = min(height, round(y + fh) + pad_y)
        if x2 - x1 >= 8 and y2 - y1 >= 8:
            boxes.append((x1, y1, x2, y2))
    return boxes


def _blur_patch_inplace(patch: np.ndarray) -> None:
    """Irreversibly anonymize an image region via coarse mosaic + separable box blur."""
    ph, pw, _ch = patch.shape
    block = max(6, min(20, min(ph, pw) // 5))
    if block >= 2:
        for by in range(0, ph, block):
            for bx in range(0, pw, block):
                cell = patch[by : by + block, bx : bx + block]
                mean_col = cell.mean(axis=(0, 1)).astype(np.uint8)
                cell[:, :] = mean_col

    radius = max(2, min(8, block // 2))
    if ph > 2 * radius + 1 and pw > 2 * radius + 1:
        k = 2 * radius + 1
        work = patch.astype(np.float32)
        for _ in range(2):
            pad_x = np.pad(work, ((0, 0), (radius, radius), (0, 0)), mode="edge")
            cs_x = np.pad(np.cumsum(pad_x, axis=1), ((0, 0), (1, 0), (0, 0)))
            work = (cs_x[:, k:, :] - cs_x[:, :-k, :]) / k
            pad_y = np.pad(work, ((radius, radius), (0, 0), (0, 0)), mode="edge")
            cs_y = np.pad(np.cumsum(pad_y, axis=0), ((1, 0), (0, 0), (0, 0)))
            work = (cs_y[k:, :, :] - cs_y[:-k, :, :]) / k
        patch[:, :] = np.clip(np.rint(work), 0, 255).astype(np.uint8)


def redact_faces_in_png(png_bytes: bytes, *, max_bytes: int = 1_572_864) -> tuple[bytes, int]:
    """Detect and anonymize faces in a PNG image.

    Returns `(png_bytes, redacted_count)`. When zero faces are detected, the
    exact original `png_bytes` buffer is returned byte-for-byte unchanged.
    """
    if not YUNET_MODEL_PATH.is_file():
        return png_bytes, 0
    try:
        decoded = _decode_png_8bit(png_bytes)
        if decoded is None:
            return png_bytes, 0
        img, color_type = decoded
        rgb = np.repeat(img, 3, axis=2) if color_type == 0 else img[:, :, :3]

        boxes = detect_faces_rgb(rgb)
        if not boxes:
            return png_bytes, 0

        redacted = img.copy()
        color_channels = 1 if color_type == 0 else 3
        for x1, y1, x2, y2 in boxes:
            _blur_patch_inplace(redacted[y1:y2, x1:x2, :color_channels])

        encoded = _encode_png_8bit(redacted, color_type, compress_level=6)
        if len(encoded) > max_bytes:
            encoded = _encode_png_8bit(redacted, color_type, compress_level=9)
        if len(encoded) > max_bytes:
            return png_bytes, 0
        return encoded, len(boxes)
    except Exception as exc:
        logging.getLogger("wortlaut").warning(
            "keyframe_face_redaction_failed error=%s", type(exc).__name__
        )
        return png_bytes, 0
