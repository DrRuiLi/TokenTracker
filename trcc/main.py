#!/usr/bin/env python3
"""trcc-token-dash — push a Cursor token + system dashboard to HydroNous R1.

GPL-3.0. USB protocol adapted from Lexonight1/thermalright-trcc-linux.
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from pathlib import Path

def _ensure_stdio(attach_console: bool) -> None:
    """--noconsole exe: stdout/stderr are None.  For --cli, attach to the
    parent cmd/PowerShell console so output is visible; else use devnull."""
    if sys.stdout is not None and sys.stderr is not None:
        return
    if attach_console and sys.platform == "win32":
        try:
            import ctypes
            if ctypes.windll.kernel32.AttachConsole(-1):
                sys.stdout = open("CONOUT$", "w", encoding="utf-8", buffering=1)
                sys.stderr = sys.stdout
                return
        except Exception:
            pass
    devnull = open(os.devnull, "w")
    if sys.stdout is None:
        sys.stdout = devnull
    if sys.stderr is None:
        sys.stderr = devnull


# Allow running from source tree or PyInstaller bundle
if getattr(sys, "frozen", False):
    BASE = Path(sys._MEIPASS)  # type: ignore[attr-defined]
    HERE = Path(sys.executable).resolve().parent
else:
    BASE = HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(BASE))

from render import render, placeholder_metrics, token_stats_from_csv  # noqa: E402
from sysmetrics import MetricsCollector  # noqa: E402
from cursor_usage import CursorUsage  # noqa: E402
from device import VID, PID, orient_image  # noqa: E402
from worker import PushWorker, empty_stats  # noqa: E402
import settings as cfg  # noqa: E402

log = logging.getLogger("trcc_dash")

ONCE_TIMEOUT_S = 15.0


def _serve_log() -> None:
    """pythonw has no console; keep a file log next to the settings."""
    path = cfg.settings_dir() / "serve.log"
    handler = logging.FileHandler(path, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s",
                                           datefmt="%H:%M:%S"))
    logging.getLogger().addHandler(handler)


def setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Thermalright side-screen Cursor token dashboard "
                                             "(默认打开控制窗口；--cli 为控制台模式)")
    p.add_argument("--cli", action="store_true", help="控制台模式（无窗口），Ctrl+C 退出")
    p.add_argument("--no-autostart", action="store_true", help="GUI 打开时先不推送")
    p.add_argument("--tray", action="store_true",
                   help="启动后直接隐藏到托盘（在 TokenTracker 的“副屏”页面里设置）")
    p.add_argument("--serve", action="store_true",
                   help="无窗口、无托盘，由 TokenTracker 作为子进程拉起")
    p.add_argument("--parent-pid", type=int, default=0,
                   help="父进程退出后本进程也退出（--serve）")
    p.add_argument("--usage-file", type=Path, default=None,
                   help="TokenTracker 汇总用量 JSONL（--serve）")
    p.add_argument("--rotate", type=int, choices=(0, 90, 180, 270),
                   help="覆盖设置里的旋转角度（顺时针）")
    p.add_argument("--mirror", action="store_true", help="镜像（覆盖设置）")
    p.add_argument("--preview-only", metavar="PNG", nargs="?", const="preview.png",
                   help="渲染一张预览图后退出（不碰 USB）")
    p.add_argument("--once", action="store_true", help="推一帧到副屏后退出")
    p.add_argument("--sensors", metavar="FILE", nargs="?", const="-",
                   help="诊断：采样温度/功耗约 6 秒后输出（到 FILE 或控制台）")
    p.add_argument("--csv", type=Path, help="用本地 CSV 代替在线拉取（调试）")
    p.add_argument("--interval", type=float, default=None, help="画面重绘间隔秒（默认取设置，1）")
    p.add_argument("--serial", default=None, help="USB 序列号过滤（默认取设置）")
    p.add_argument("--vid", default=f"{VID:04x}")
    p.add_argument("--pid", default=f"{PID:04x}")
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args(argv)


def _settings_with_overrides(args):
    st = cfg.load()
    if getattr(args, "rotate", None) is not None:
        st["rotation"] = args.rotate
    if getattr(args, "mirror", False):
        st["mirror"] = True
    if getattr(args, "interval", None) is not None:
        st["render_interval"] = args.interval
    if getattr(args, "serial", None) is not None:
        st["serial"] = args.serial
    return st


def run_preview(path: Path, csv: Path | None, args=None):
    if csv and csv.is_file():
        stats = token_stats_from_csv(csv)
    else:
        usage = CursorUsage(csv_override=csv)
        usage.get_stats(force=True)
        stats = usage.current()
    metrics = None
    try:
        metrics = MetricsCollector()
        time.sleep(0.5)   # let the sensor thread take a first reading
        m = metrics.sample()
    except Exception:
        m = placeholder_metrics()
    finally:
        if metrics is not None:
            metrics.close()
    st = _settings_with_overrides(args)
    img = render(m, stats or empty_stats(), st["theme"], st.get("layout", "classic"))
    img = orient_image(img, img.width, img.height, st["rotation"], st["mirror"])
    path = Path(path)
    img.save(path)
    print(f"wrote {path.resolve()} ({img.size[0]}x{img.size[1]})")


def run_sensor_check(dest: str) -> int:
    from sysmetrics import SOURCE_LABELS
    out = sys.stdout if dest == "-" else open(dest, "w", encoding="utf-8")
    metrics = MetricsCollector()
    try:
        for i in range(3):
            time.sleep(2)
            m = metrics.sample()
            info = metrics.sensor_info()
            print(f"[{(i + 1) * 2}s] 温度={m['temp_c']} 功耗={m['power_w']} "
                  f"来源={SOURCE_LABELS.get(info['sensor_source'], info['sensor_source'])} "
                  f"内置传感器={info['sensor_embedded']} 管理员={info['admin']}", file=out, flush=True)
    finally:
        metrics.close()
        if out is not sys.stdout:
            out.close()
    return 0


def _status_line(snap) -> str:
    if snap["connected"]:
        w, h = snap["size"] or (0, 0)
        return f"已连接 PM={snap['pm']} SUB={snap['sub']} {w}x{h}"
    return "连接中… " + (snap["usb_error"] or "")


def run_loop(args):
    """Console mode: same PushWorker as the GUI, so it reconnects on USB errors."""
    st = _settings_with_overrides(args)
    st["autostart"] = True
    worker = PushWorker(st, csv_override=args.csv,
                        vid=int(args.vid, 16), pid=int(args.pid, 16))
    print("正在连接副屏…（请确认已退出官方 TRCC）")
    worker.start()
    try:
        if args.once:
            ok = worker.wait_frame(ONCE_TIMEOUT_S)
            snap = worker.snapshot()
            if not ok:
                print(f"推送失败: {snap['usb_error'] or '超时'}", file=sys.stderr)
                return 1
            print(f"{_status_line(snap)} · 已推送一帧（副屏约 2~3 秒后回到 logo）")
            return 0
        last = None
        last_log = 0.0
        while worker.is_alive():
            snap = worker.snapshot()
            line = _status_line(snap)
            if line != last:
                print(line + (f" 旋转={st['rotation']}° 镜像={'是' if st['mirror'] else '否'}"
                              if snap["connected"] else ""))
                last = line
            if time.monotonic() - last_log >= 30:
                err = f" cursor_err={snap['cursor_error']}" if snap["cursor_error"] else ""
                log.info("push %.1f fps · render %.0f ms%s", snap["push_fps"], snap["render_ms"], err)
                last_log = time.monotonic()
            time.sleep(0.5)
        return 1
    except KeyboardInterrupt:
        print("\n已停止")
        return 0
    finally:
        worker.stop()


def main(argv=None):
    args = parse_args(argv)
    gui_mode = not (args.cli or args.serve or args.once or args.preview_only is not None or args.sensors)
    _ensure_stdio(attach_console=not gui_mode and not args.serve)
    setup_logging(args.verbose)
    if args.serve:
        _serve_log()
        from host import run_serve
        serve_args = ["--serve"]
        if args.usage_file:
            serve_args.extend(["--usage-file", str(args.usage_file)])
        return run_serve(csv_override=args.csv, parent_pid=args.parent_pid,
                         usage_file=args.usage_file, serve_args=serve_args)
    if args.sensors:
        return run_sensor_check(args.sensors)
    if args.preview_only is not None:
        run_preview(Path(args.preview_only), args.csv, args)
        return 0
    if gui_mode:
        from gui import run_gui
        return run_gui(csv_override=args.csv,
                       autostart=False if args.no_autostart else None,
                       start_hidden=args.tray)
    return run_loop(args)


if __name__ == "__main__":
    sys.exit(main() or 0)
