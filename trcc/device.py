"""Minimal USBLCDNew Bulk LCD driver for Thermalright 87AD:70DB panels.

Reimplemented from Lexonight1/thermalright-trcc-linux (GPL-3.0):
  bulk_lcd.py handshake + frame header + 16 KiB chunked writes + ZLP,
  Encode rotation is a USER setting here (default 0°).  The upstream rule
  for 960×320 (SUB ≥ 5 → 180°) rendered HydroNous R1 (PM=17 SUB=5) upside
  down on real hardware, so it is not applied automatically.

This module does NOT depend on the full trcc package.
"""
from __future__ import annotations

import io
import logging
import os
import struct
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple

log = logging.getLogger("trcc_dash.device")

_LIBUSB_NAME = "libusb-1.0.dll"


def find_libusb() -> Optional[Path]:
    """Bundled libusb: PyInstaller temp dir, exe dir, source dir, source/vendor."""
    here = Path(__file__).resolve().parent
    dirs = []
    if getattr(sys, "frozen", False):
        dirs += [Path(getattr(sys, "_MEIPASS", here)), Path(sys.executable).resolve().parent]
    dirs += [here, here / "vendor"]
    for d in dirs:
        p = d / _LIBUSB_NAME
        if p.is_file():
            return p
    return None


def get_backend():
    """pyusb libusb1 backend using the bundled DLL when present (Windows),
    else whatever pyusb finds on the system."""
    import usb.backend.libusb1 as libusb1
    dll = find_libusb() if os.name == "nt" else None
    if dll is not None:
        backend = libusb1.get_backend(find_library=lambda _name: str(dll))
        if backend is not None:
            return backend
        log.warning("无法加载 %s，改用系统 libusb", dll)
    backend = libusb1.get_backend()
    if backend is None:
        raise RuntimeError(
            "找不到 libusb 后端（No backend available）。"
            f"请把 {_LIBUSB_NAME} 放到程序目录或 vendor\\ 下。"
        )
    return backend

VID = 0x87AD
PID = 0x70DB

_HANDSHAKE = bytes([
    0x12, 0x34, 0x56, 0x78, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 1, 0, 0, 0,
    0, 0, 0, 0,
])
_HANDSHAKE_READ = 1024
_HANDSHAKE_TIMEOUT_MS = 1000
_WRITE_TIMEOUT_MS = 2000
_WRITE_CHUNK = 16 * 1024
_EP_OUT = 0x01
_EP_IN = 0x81  # EP01 IN

# PM → resolution for FBL-224 family (and common bulk siblings). Default 480×480.
_PM_RES: dict[int, Tuple[int, int]] = {
    5: (320, 240),
    9: (854, 480),
    10: (960, 540),
    11: (854, 480),
    12: (800, 480),
    13: (960, 320),
    15: (640, 172),
    16: (960, 540),
    17: (960, 320),
    18: (960, 320),
    20: (854, 480),
    32: (320, 320),
    50: (320, 240),
    65: (1920, 462),
    66: (1920, 462),
    68: (1280, 480),
    69: (1920, 440),
}
_RGB565_PMS = frozenset({32, 50})


@dataclass
class Profile:
    width: int
    height: int
    jpeg: bool
    encode_deg: int  # clockwise rotation applied before encode
    pm: int
    sub: int


def resolve_profile(pm: int, sub: int) -> Profile:
    w, h = _PM_RES.get(pm, (480, 480))
    jpeg = pm not in _RGB565_PMS
    # Verified on HydroNous R1 (PM=17, SUB=5): 0° is upright.  Users can
    # still rotate 90/180/270 and mirror from settings.
    return Profile(w, h, jpeg, 0, pm, sub)


def build_handshake_payload() -> bytes:
    return _HANDSHAKE


def build_frame_header(cmd: int, width: int, height: int, payload_len: int) -> bytes:
    header = bytearray(64)
    header[0:4] = _HANDSHAKE[0:4]
    struct.pack_into("<I", header, 4, cmd)
    struct.pack_into("<I", header, 8, width)
    struct.pack_into("<I", header, 12, height)
    struct.pack_into("<I", header, 56, 2)
    struct.pack_into("<I", header, 60, payload_len)
    return bytes(header)


def orient_image(image, width: int, height: int, rotate_deg: int = 0, mirror: bool = False):
    """Rotate (clockwise) / mirror, then fit to width×height.

    0/180 on a landscape panel is a straight resize.  90/270 turns a landscape
    dashboard sideways, so it is letterboxed (aspect kept, black bars) rather
    than stretched.
    """
    from PIL import Image

    img = image.convert("RGB")
    if mirror:
        img = img.transpose(Image.FLIP_LEFT_RIGHT)
    deg = rotate_deg % 360
    if deg:
        # PIL rotate is counter-clockwise; CW N == CCW -N
        img = img.rotate(-deg, expand=True)
    if img.size == (width, height):
        return img
    if (img.width >= img.height) == (width >= height):
        return img.resize((width, height), Image.LANCZOS)
    scale = min(width / img.width, height / img.height)
    fitted = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))), Image.LANCZOS)
    canvas = Image.new("RGB", (width, height), (0, 0, 0))
    canvas.paste(fitted, ((width - fitted.width) // 2, (height - fitted.height) // 2))
    return canvas


def encode_jpeg(image, width: int, height: int, quality: int = 85, rotate_deg: int = 0,
                mirror: bool = False) -> bytes:
    """PIL Image → JPEG bytes sized to width×height, optional CW rotation / mirror."""
    img = orient_image(image, width, height, rotate_deg, mirror)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True)
    return buf.getvalue()


def pack_frame(payload: bytes, width: int, height: int, *, jpeg: bool = True) -> bytes:
    cmd = 2 if jpeg else 3
    return build_frame_header(cmd, width, height, len(payload)) + payload


class DeviceBusyError(RuntimeError):
    """Official TRCC (or another process) still holds the USB interface."""


class BulkLcd:
    """pyusb BulkLcd for 87AD:70DB (and same-protocol siblings)."""

    def __init__(self, vid: int = VID, pid: int = PID, serial: Optional[str] = None):
        self.vid = vid
        self.pid = pid
        self.serial = serial
        self._dev = None
        self._claimed = False
        self.profile: Optional[Profile] = None
        self.rotate_deg = 0      # user setting, clockwise
        self.mirror = False
        self._last_frame: Optional[bytes] = None

    def _total_rotation(self) -> int:
        base = self.profile.encode_deg if self.profile else 0
        return (base + self.rotate_deg) % 360

    def open(self) -> Profile:
        import usb.core
        import usb.util

        devices = list(usb.core.find(find_all=True, idVendor=self.vid, idProduct=self.pid,
                                     backend=get_backend()))
        if not devices:
            raise RuntimeError(
                f"未找到副屏 USB {self.vid:04X}:{self.pid:04X}。"
                "请确认已插入，并已退出官方 TRCC。"
            )
        chosen = None
        for d in devices:
            try:
                sn = usb.util.get_string(d, d.iSerialNumber) if d.iSerialNumber else None
            except Exception:
                sn = None
            if self.serial and sn and sn != self.serial:
                continue
            chosen = d
            if self.serial and sn == self.serial:
                break
        if chosen is None:
            log.warning("没有序列号为 %s 的副屏，改用第一台 %04X:%04X 设备",
                        self.serial, self.vid, self.pid)
            chosen = devices[0]
        self._dev = chosen

        try:
            if self._dev.is_kernel_driver_active(0):
                self._dev.detach_kernel_driver(0)
        except (NotImplementedError, usb.core.USBError):
            pass

        try:
            self._dev.set_configuration()
        except usb.core.USBError as e:
            # already configured is fine
            if getattr(e, "errno", None) not in (16,):
                log.debug("set_configuration: %s", e)

        try:
            usb.util.claim_interface(self._dev, 0)
            self._claimed = True
        except usb.core.USBError as e:
            raise DeviceBusyError(
                "无法占用副屏 USB 接口。请先完全退出官方 TRCC "
                r"(任务管理器结束 TRCC.exe / USBLCDNEW.exe)，再重试。"
            ) from e

        self._dev.write(_EP_OUT, _HANDSHAKE, _HANDSHAKE_TIMEOUT_MS)
        resp = bytes(self._dev.read(_EP_IN, _HANDSHAKE_READ, _HANDSHAKE_TIMEOUT_MS))
        if len(resp) < 41 or resp[24] == 0:
            raise RuntimeError(
                f"握手失败 (len={len(resp)}, PM={resp[24] if len(resp) > 24 else 'N/A'})"
            )
        pm, sub = resp[24], resp[36]
        self.profile = resolve_profile(pm, sub)
        log.info(
            "handshake OK: PM=%d SUB=%d → %dx%d jpeg=%s encode=%d°",
            pm, sub, self.profile.width, self.profile.height,
            self.profile.jpeg, self.profile.encode_deg,
        )
        return self.profile

    def send_image(self, image) -> bool:
        if self._dev is None or self.profile is None:
            raise RuntimeError("设备未连接，先调用 open()")
        p = self.profile
        if p.jpeg:
            payload = encode_jpeg(image, p.width, p.height,
                                  rotate_deg=self._total_rotation(), mirror=self.mirror)
        else:
            raise NotImplementedError("本机预期 JPEG；RGB565 未在 v1 实现")
        frame = pack_frame(payload, p.width, p.height, jpeg=True)
        return self._write_frame(frame)

    def prepare(self, image, oriented: bool = False) -> None:
        """Encode and cache the frame that resend() pushes.

        oriented=True: `image` is already rotated/mirrored to panel size
        (e.g. the GUI preview), so it is only JPEG-encoded.
        """
        p = self.profile
        if p is None:
            raise RuntimeError("设备未连接，先调用 open()")
        if oriented and image.size == (p.width, p.height):
            payload = encode_jpeg(image, p.width, p.height)
        else:
            payload = encode_jpeg(image, p.width, p.height,
                                  rotate_deg=self._total_rotation(), mirror=self.mirror)
        self._last_frame = pack_frame(payload, p.width, p.height, jpeg=True)

    def resend(self) -> bool:
        frame = self._last_frame
        return self._write_frame(frame) if (frame and self._dev is not None) else False

    def _write_frame(self, frame: bytes) -> bool:
        for offset in range(0, len(frame), _WRITE_CHUNK):
            chunk = frame[offset:offset + _WRITE_CHUNK]
            n = self._dev.write(_EP_OUT, chunk, _WRITE_TIMEOUT_MS)
            if n < len(chunk):
                log.warning("SHORT write at offset %d/%d", offset, len(frame))
                return False
        if len(frame) % 512 == 0:
            self._dev.write(_EP_OUT, b"", _WRITE_TIMEOUT_MS)
        return True

    def close(self) -> None:
        if self._dev is None:
            return
        import usb.util
        if self._claimed:
            try:
                usb.util.release_interface(self._dev, 0)
            except Exception:
                pass
        try:
            usb.util.dispose_resources(self._dev)
        except Exception:
            pass
        self._claimed = False
        self._dev = None
        self.profile = None
        self._last_frame = None

    def __enter__(self):
        self.open()
        return self

    def __exit__(self, *exc):
        self.close()
