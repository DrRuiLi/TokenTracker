"""Tkinter control window (Chinese UI) for trcc-token-dash.

All USB / network work happens in worker.PushWorker; this module only reads
its snapshot on a timer and pushes settings changes to it.

The optional system-tray icon (pystray) and the local control API
(control_api, used by the TokenTracker "副屏" page) run on their own threads;
they only enqueue commands that _poll() executes on the Tk thread.
"""
from __future__ import annotations

import datetime as dt
import os
import queue
import sys
import threading
import tkinter as tk
from tkinter import colorchooser, messagebox, ttk

from PIL import Image, ImageDraw, ImageTk

import control_api
import settings as cfg
from host import apply_partial, reset_settings
from layouts import layouts_meta
from render import W, H
from sysmetrics import SOURCE_LABELS, is_admin
from theme_edit import COLOR_GROUPS, color_groups_meta, get_color, set_color
from worker import PushWorker

try:
    import pystray
except Exception:  # missing package or no tray backend
    pystray = None

APP_TITLE = "利民副屏 Token 仪表盘"
PREVIEW_W = 720              # preview scale 0.75 of 960×320
POLL_MS = 200
SAVE_DEBOUNCE_MS = 600

CLOSE_LABELS = {"ask": "每次询问", "tray": "最小化到托盘", "exit": "退出程序"}
RANGES = {"render_interval": (0.2, 10.0, 0.2), "sensor_interval": (0.5, 60.0, 0.5)}


class _Call:
    """One queued command plus the slot its result is returned in."""

    def __init__(self, cmd, payload=None, wait=False):
        self.cmd, self.payload = cmd, payload
        self.done = threading.Event() if wait else None
        self.result = None
        self.error = None

    def finish(self, result=None, error=None):
        self.result, self.error = result, error
        if self.done is not None:
            self.done.set()


def _fmt_ago(ts):
    if not ts:
        return "尚未成功"
    return dt.datetime.fromtimestamp(ts).strftime("%H:%M:%S")


def app_icon(size: int = 64) -> Image.Image:
    """Blue rounded tile with a small bar chart (window + tray icon)."""
    ss = 4
    s = size * ss
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=s // 5, fill=(30, 144, 255, 255))
    bars = (0.35, 0.6, 0.45, 0.85)
    bw = s * 0.13
    gap = (s * 0.72 - bw * len(bars)) / (len(bars) - 1)
    x = s * 0.14
    for h in bars:
        d.rounded_rectangle([x, s * 0.84 - s * 0.68 * h, x + bw, s * 0.84], radius=bw / 3,
                            fill=(255, 255, 255, 255))
        x += bw + gap
    return img.resize((size, size), Image.LANCZOS)


class CloseDialog(tk.Toplevel):
    """Modal 'minimise to tray / exit / cancel' prompt.  result: 'tray' | 'exit' | None."""

    def __init__(self, parent: tk.Tk):
        super().__init__(parent)
        self.result = None
        self.remember = tk.BooleanVar(value=False)
        self.title(APP_TITLE)
        self.resizable(False, False)
        self.transient(parent)

        body = ttk.Frame(self, padding=16)
        body.pack(fill="both", expand=True)
        ttk.Label(body, text="关闭窗口后要做什么？").pack(anchor="w")
        ttk.Label(body, text="最小化到托盘：副屏继续推送，可从右下角托盘图标恢复窗口或退出。",
                  foreground="#666666").pack(anchor="w", pady=(4, 10))
        ttk.Checkbutton(body, text="记住我的选择（之后可在窗口里修改）",
                        variable=self.remember).pack(anchor="w")
        btns = ttk.Frame(body, padding=(0, 14, 0, 0))
        btns.pack(fill="x")
        tray_btn = ttk.Button(btns, text="最小化到托盘", command=lambda: self._done("tray"))
        tray_btn.pack(side="left")
        ttk.Button(btns, text="退出程序", command=lambda: self._done("exit")).pack(side="left", padx=8)
        ttk.Button(btns, text="取消", command=lambda: self._done(None)).pack(side="right")

        self.protocol("WM_DELETE_WINDOW", lambda: self._done(None))
        self.bind("<Escape>", lambda e: self._done(None))
        self.bind("<Return>", lambda e: self._done("tray"))
        self.update_idletasks()
        x = parent.winfo_rootx() + (parent.winfo_width() - self.winfo_reqwidth()) // 2
        y = parent.winfo_rooty() + (parent.winfo_height() - self.winfo_reqheight()) // 3
        self.geometry(f"+{max(0, x)}+{max(0, y)}")
        tray_btn.focus_set()
        self.grab_set()
        parent.wait_window(self)

    def _done(self, result):
        self.result = result
        self.grab_release()
        self.destroy()


class Tray:
    """pystray icon on its own thread; menu actions are queued for the Tk thread."""

    def __init__(self, app: "App"):
        self.app = app
        self._title = APP_TITLE
        menu = pystray.Menu(
            pystray.MenuItem("显示窗口", lambda: app.post("show"), default=True),
            pystray.MenuItem(lambda item: "停止推送" if app.worker.pushing else "开始推送",
                             lambda: app.post("toggle")),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("退出", lambda: app.post("quit")),
        )
        self.icon = pystray.Icon("trcc-token-dash", app_icon(64), APP_TITLE, menu)
        self.icon.run_detached()

    def set_title(self, text: str) -> None:
        text = text[:120]   # Windows tooltip limit is 128 chars
        if text != self._title:
            self._title = text
            try:
                self.icon.title = text
            except Exception:
                pass

    def notify(self, message: str) -> None:
        try:
            self.icon.notify(message, APP_TITLE)
        except Exception:
            pass

    def stop(self) -> None:
        try:
            self.icon.stop()
        except Exception:
            pass


class App:
    def __init__(self, root: tk.Tk, csv_override=None, autostart=None, start_hidden=False):
        self.root = root
        self.settings = cfg.load()
        if autostart is not None:
            self.settings["autostart"] = autostart
        self._save_job = None
        self._preview_seq = -1
        self._photo = None
        self._swatches = {}
        self._cmds: "queue.Queue[_Call]" = queue.Queue()
        self._tray_hint_shown = False
        self._quitting = False

        root.title(APP_TITLE)
        root.minsize(760, 560)
        self._icon_photo = ImageTk.PhotoImage(app_icon(64))
        root.iconphoto(True, self._icon_photo)
        self._setup_fonts()

        self.worker = PushWorker(self.settings, csv_override=csv_override)
        self.tray = None
        if pystray is not None:
            try:
                self.tray = Tray(self)
            except Exception as e:
                print(f"托盘图标不可用: {e}", file=sys.stderr)
        self._build()
        self.worker.start()
        self.api = control_api.start_server(self, self.settings["api_port"])
        root.protocol("WM_DELETE_WINDOW", self.on_close)
        if start_hidden and self.tray is not None:
            root.withdraw()
            self._tray_hint_shown = True
        root.after(POLL_MS, self._poll)

    def post(self, cmd: str, payload=None) -> None:
        """Thread-safe: queue a command for the Tk thread (tray menu)."""
        self._cmds.put(_Call(cmd, payload))

    def call(self, cmd: str, payload=None, timeout: float = 3.0):
        """Thread-safe: run a command on the Tk thread and return its result
        (control API).  Raises TimeoutError, or the handler's ValueError."""
        if self._quitting:
            raise TimeoutError("quitting")
        c = _Call(cmd, payload, wait=True)
        self._cmds.put(c)
        if not c.done.wait(timeout):
            raise TimeoutError(cmd)
        if c.error is not None:
            raise c.error
        return c.result

    # ---------- layout ----------
    def _setup_fonts(self):
        if sys.platform == "win32":
            for name in ("TkDefaultFont", "TkTextFont", "TkMenuFont", "TkHeadingFont"):
                try:
                    __import__("tkinter.font").font.nametofont(name).configure(family="Microsoft YaHei UI", size=9)
                except Exception:
                    pass

    def _build(self):
        r = self.root
        import tkinter.font as tkfont
        self._bold = tkfont.nametofont("TkDefaultFont").copy()
        self._bold.configure(weight="bold")
        outer = ttk.Frame(r, padding=8)
        outer.pack(fill="both", expand=True)

        # preview
        pv = ttk.LabelFrame(outer, text="预览（与副屏推送一致）", padding=6)
        pv.pack(fill="x")
        # With an image attached, Label width/height are pixels (else characters)
        self._photo = ImageTk.PhotoImage(Image.new("RGB", (PREVIEW_W, int(PREVIEW_W * H / W))))
        self.preview_lbl = tk.Label(pv, bg="#000000", image=self._photo)
        self.preview_lbl.pack()

        # controls
        ctl = ttk.Frame(outer, padding=(0, 8, 0, 0))
        ctl.pack(fill="x")

        self.push_btn = ttk.Button(ctl, text="停止推送", command=self.toggle_push, width=10)
        self.push_btn.grid(row=0, column=0, padx=(0, 10), pady=2, sticky="w")

        ttk.Label(ctl, text="旋转").grid(row=0, column=1, sticky="e")
        self.rot_var = tk.IntVar(value=self.settings["rotation"])
        rot_fr = ttk.Frame(ctl)
        rot_fr.grid(row=0, column=2, sticky="w", padx=(4, 10))
        for deg in cfg.ROTATIONS:
            ttk.Radiobutton(rot_fr, text=f"{deg}°", value=deg, variable=self.rot_var,
                            command=self.on_change).pack(side="left")

        self.mirror_var = tk.BooleanVar(value=self.settings["mirror"])
        ttk.Checkbutton(ctl, text="镜像", variable=self.mirror_var,
                        command=self.on_change).grid(row=0, column=3, sticky="w", padx=(0, 10))

        ttk.Label(ctl, text="画面刷新(秒)").grid(row=1, column=1, sticky="e")
        self.int_var = tk.StringVar(value=f"{self.settings['render_interval']:g}")
        sp1 = ttk.Spinbox(ctl, from_=0.2, to=10, increment=0.2, width=6,
                          textvariable=self.int_var, command=self.on_change)
        sp1.grid(row=1, column=2, sticky="w", padx=(4, 10))
        sp1.bind("<FocusOut>", lambda e: self.on_change())
        sp1.bind("<Return>", lambda e: self.on_change())

        ttk.Label(ctl, text="温度/功耗采样(秒)").grid(row=3, column=1, sticky="e", pady=(4, 0))
        self.sensor_var = tk.StringVar(value=f"{self.settings['sensor_interval']:g}")
        sp3 = ttk.Spinbox(ctl, from_=0.5, to=60, increment=0.5, width=6,
                          textvariable=self.sensor_var, command=self.on_change)
        sp3.grid(row=3, column=2, sticky="w", padx=(4, 10), pady=(4, 0))
        sp3.bind("<FocusOut>", lambda e: self.on_change())
        sp3.bind("<Return>", lambda e: self.on_change())

        ttk.Button(ctl, text="恢复默认", command=self.reset_defaults
                   ).grid(row=1, column=5, sticky="w")

        ttk.Label(ctl, text="关闭窗口时").grid(row=2, column=1, sticky="e")
        self.close_var = tk.StringVar(value=CLOSE_LABELS[self._close_action()])
        close_cb = ttk.Combobox(ctl, textvariable=self.close_var, state="readonly", width=12,
                                values=[CLOSE_LABELS[k] for k in cfg.CLOSE_ACTIONS])
        close_cb.grid(row=2, column=2, columnspan=2, sticky="w", padx=(4, 10), pady=(4, 0))
        close_cb.bind("<<ComboboxSelected>>", lambda e: self.on_close_action_change())
        if self.tray is None:
            close_cb.configure(state="disabled")
            ttk.Label(ctl, text="（托盘不可用：未安装 pystray）", foreground="#888888"
                      ).grid(row=2, column=4, columnspan=2, sticky="w", pady=(4, 0))

        if sys.platform == "win32" and not is_admin():
            ttk.Button(ctl, text="以管理员身份重启", command=self.relaunch_as_admin
                       ).grid(row=2, column=5, sticky="w", pady=(4, 0))

        # colours
        cf = ttk.LabelFrame(outer, text="颜色（点色块修改，立即生效）", padding=6)
        cf.pack(fill="both", expand=True, pady=(8, 0))
        for gi, (group, items) in enumerate(COLOR_GROUPS):
            col = ttk.Frame(cf)
            col.grid(row=0, column=gi, sticky="nw", padx=(0, 14))
            ttk.Label(col, text=group, font=self._bold).pack(anchor="w", pady=(0, 4))
            for key, label in items:
                row = ttk.Frame(col)
                row.pack(anchor="w", pady=1, fill="x")
                sw = tk.Button(row, width=3, relief="solid", bd=1,
                               command=lambda k=key, l=label: self.pick_color(k, l))
                sw.pack(side="left")
                ttk.Label(row, text=label).pack(side="left", padx=(6, 0))
                self._swatches[key] = sw
        self._refresh_swatches()

        # status
        self.status_var = tk.StringVar(value="启动中…")
        st = ttk.Label(outer, textvariable=self.status_var, anchor="w", relief="sunken", padding=(6, 3))
        st.pack(fill="x", pady=(8, 0))

    def _refresh_swatches(self):
        th = self.settings["theme"]
        for key, sw in self._swatches.items():
            c = get_color(th, key)
            sw.configure(bg=c, activebackground=c)

    # ---------- actions ----------
    def pick_color(self, key, label):
        cur = get_color(self.settings["theme"], key)
        res = colorchooser.askcolor(color=cur, title=f"选择颜色 - {label}", parent=self.root)
        if not res or not res[1]:
            return
        set_color(self.settings["theme"], key, res[1])
        self._refresh_swatches()
        self._apply()

    def toggle_push(self):
        on = not self.worker.pushing
        self.worker.set_pushing(on)
        self.settings["autostart"] = on
        self._schedule_save()
        self._update_push_btn()

    def _update_push_btn(self):
        pushing = self.worker.pushing
        if pushing == getattr(self, "_shown_pushing", None):
            return
        self._shown_pushing = pushing
        self.push_btn.configure(text="停止推送" if pushing else "开始推送")
        if self.tray is not None:
            try:
                self.tray.icon.update_menu()
            except Exception:
                pass

    def _close_action(self) -> str:
        return self.settings.get("close_action", "ask") if self.tray is not None else "exit"

    def on_close_action_change(self):
        label = self.close_var.get()
        self.settings["close_action"] = next(k for k, v in CLOSE_LABELS.items() if v == label)
        self._schedule_save()

    def on_change(self):
        self.settings["rotation"] = int(self.rot_var.get())
        self.settings["mirror"] = bool(self.mirror_var.get())
        for var, key, lo, hi in ((self.int_var, "render_interval", 0.2, 10),
                                 (self.sensor_var, "sensor_interval", 0.5, 60)):
            try:
                self.settings[key] = min(hi, max(lo, float(var.get())))
            except ValueError:
                var.set(f"{self.settings[key]:g}")
        self._apply()

    def relaunch_as_admin(self):
        if not self._relaunch_admin():
            self.status_var.set("未获得管理员权限（UAC 被取消）")

    def _relaunch_admin(self) -> bool:
        """Start an elevated copy (UAC prompt), then exit this one so it gets the USB."""
        if sys.platform != "win32" or is_admin():
            return False
        import ctypes
        import subprocess
        if getattr(sys, "frozen", False):
            exe, args = sys.executable, sys.argv[1:]
        else:
            exe = sys.executable
            args = [os.path.abspath(sys.argv[0])] + sys.argv[1:]
        self._save_now()
        rc = ctypes.windll.shell32.ShellExecuteW(
            None, "runas", exe, subprocess.list2cmdline(args), os.getcwd(), 1)
        if rc <= 32:
            return False
        self.root.after(300, self.quit)   # let the API reply go out first
        return True

    def reset_defaults(self):
        if not messagebox.askyesno(APP_TITLE, "恢复全部默认设置（旋转、颜色、刷新间隔）？", parent=self.root):
            return
        self._reset()

    def _reset(self):
        self.settings = reset_settings(self.settings, self.worker.pushing)
        self._sync_widgets()
        self._apply()

    def _sync_widgets(self):
        self.rot_var.set(self.settings["rotation"])
        self.mirror_var.set(self.settings["mirror"])
        self.int_var.set(f"{self.settings['render_interval']:g}")
        self.sensor_var.set(f"{self.settings['sensor_interval']:g}")
        self.close_var.set(CLOSE_LABELS[self._close_action()])
        self._refresh_swatches()

    # ---------- control API (runs on the Tk thread via call()) ----------
    def _settings_view(self) -> dict:
        s = self.settings
        api = self.api
        return {
            "settings": {
                "rotation": s["rotation"], "mirror": s["mirror"],
                "render_interval": s["render_interval"], "sensor_interval": s["sensor_interval"],
                "layout": s["layout"],
                "close_action": self._close_action(), "autostart": s["autostart"],
                "colors": flat_colors(s["theme"]),
            },
            "app": {
                "title": APP_TITLE,
                "tray": self.tray is not None,
                "window_visible": self.root.state() != "withdrawn",
                "api_port": api.port if api else None,
                "can_elevate": sys.platform == "win32" and not is_admin(),
                "hosted": False,
            },
            "meta": {
                "rotations": list(cfg.ROTATIONS),
                "ranges": {k: list(v) for k, v in RANGES.items()},
                "close_actions": [{"id": k, "label": CLOSE_LABELS[k]} for k in cfg.CLOSE_ACTIONS],
                "color_groups": color_groups_meta(), "layouts": layouts_meta(),
            },
        }

    def _apply_partial(self, data) -> None:
        self.settings = apply_partial(self.settings, data)
        self._sync_widgets()
        self._apply()

    def _exec(self, c: _Call):
        """Run one queued command on the Tk thread; returns False to stop polling."""
        try:
            if c.cmd == "show":
                self.show_window()
                c.finish({"ok": True})
            elif c.cmd == "toggle":
                self.toggle_push()
                c.finish({"pushing": self.worker.pushing})
            elif c.cmd == "push":
                if bool(c.payload) != self.worker.pushing:
                    self.toggle_push()
                c.finish({"pushing": self.worker.pushing})
            elif c.cmd == "get_settings":
                c.finish(self._settings_view())
            elif c.cmd == "set_settings":
                self._apply_partial(c.payload)
                c.finish(self._settings_view())
            elif c.cmd == "reset":
                self._reset()
                c.finish(self._settings_view())
            elif c.cmd == "relaunch_admin":
                c.finish({"ok": self._relaunch_admin()})
            elif c.cmd == "quit":
                c.finish({"ok": True})
                self.quit()
                return False
            else:
                c.finish(error=ValueError(f"unknown command: {c.cmd}"))
        except ValueError as e:
            c.finish(error=e)
        except Exception as e:
            c.finish(error=ValueError(f"{type(e).__name__}: {e}"))
        return True

    def _apply(self):
        self.worker.update_settings(self.settings)
        self._schedule_save()

    def _schedule_save(self):
        if self._save_job:
            self.root.after_cancel(self._save_job)
        self._save_job = self.root.after(SAVE_DEBOUNCE_MS, self._save_now)

    def _save_now(self):
        self._save_job = None
        try:
            cfg.save(self.settings)
        except Exception as e:
            self.status_var.set(f"保存设置失败: {e}")

    # ---------- polling ----------
    def _poll(self):
        while True:
            try:
                c = self._cmds.get_nowait()
            except queue.Empty:
                break
            if not self._exec(c):
                return
        hidden = self.root.state() == "withdrawn"
        seq, img = self.worker.latest_preview()
        if not hidden and img is not None and seq != self._preview_seq:
            self._preview_seq = seq
            ph = int(PREVIEW_W * img.height / img.width)
            self._photo = ImageTk.PhotoImage(img.resize((PREVIEW_W, ph), Image.LANCZOS))
            self.preview_lbl.configure(image=self._photo, width=PREVIEW_W, height=ph)
        snap = self.worker.snapshot()
        self.status_var.set(self._status_text(snap) + self._api_text())
        if self.tray is not None:
            self.tray.set_title(self._tray_text(snap))
        self._update_push_btn()
        self.root.after(POLL_MS, self._poll)

    def _api_text(self) -> str:
        api = self.api
        if api is None:
            return "  |  设置接口: 已关闭"
        if api.listening:
            return f"  |  设置接口: 127.0.0.1:{api.port}"
        return f"  |  设置接口: {api.error or '启动中…'}"

    @staticmethod
    def _tray_text(st) -> str:
        if st["connected"]:
            dev = f"推送中 {st['push_fps']:.1f} fps"
        elif not st["pushing"]:
            dev = "已停止推送"
        else:
            dev = "连接副屏中…"
        cur = "Cursor 刷新中…" if st["cursor_busy"] else f"Cursor 上次成功 {_fmt_ago(st['cursor_ok'])}"
        return f"{APP_TITLE}\n{dev}\n{cur}"

    @staticmethod
    def _status_text(st) -> str:
        if st["connected"]:
            w, h = st["size"] or (0, 0)
            dev = f"已连接 PM={st['pm']} SUB={st['sub']} {w}x{h} · {st['push_fps']:.1f} fps"
        elif not st["pushing"]:
            dev = "已停止推送（USB 已释放）"
        else:
            dev = "连接中… " + (st["usb_error"] or "")
        cur = "刷新中…" if st["cursor_busy"] else f"上次成功 {_fmt_ago(st['cursor_ok'])}"
        if st["cursor_error"]:
            cur += f" · 错误: {st['cursor_error']}"
        src = st.get("sensor_source")
        if src:
            sensor = SOURCE_LABELS.get(src, src)
        else:
            sensor = f"无（内置传感器：{st.get('sensor_embedded', '未启用')}）"
        return f"{dev}  |  Cursor: {cur}  |  温度/功耗: {sensor}  |  渲染 {st['render_ms']:.0f} ms"

    def on_close(self):
        """Window close button: ask / hide to tray / exit, per settings."""
        action = self._close_action()
        if action == "ask":
            dlg = CloseDialog(self.root)
            action = dlg.result
            if action is None:
                return
            if dlg.remember.get():
                self.settings["close_action"] = action
                self.close_var.set(CLOSE_LABELS[action])
                self._schedule_save()
        if action == "tray":
            self.hide_to_tray()
        else:
            self.quit()

    def hide_to_tray(self):
        self.root.withdraw()
        if not self._tray_hint_shown:
            self._tray_hint_shown = True
            self.tray.notify("仍在后台推送副屏。单击托盘图标恢复窗口，右键可退出。")

    def show_window(self):
        self.root.deiconify()
        self.root.state("normal")
        self.root.lift()
        self.root.attributes("-topmost", True)
        self.root.after(200, lambda: self.root.attributes("-topmost", False))
        self.root.focus_force()

    def quit(self):
        if self._quitting:
            return
        self._quitting = True
        if self.api is not None:
            self.api.stop()
        if self._save_job:
            self.root.after_cancel(self._save_job)
        self._save_now()
        if self.root.state() != "withdrawn":
            self.status_var.set("正在释放 USB…")
            self.root.update_idletasks()
        self.worker.stop(timeout=5.0)
        if self.tray is not None:
            self.tray.stop()
        self.root.destroy()


def _dpi_aware():
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass


def run_gui(csv_override=None, autostart=None, start_hidden=False) -> int:
    import tkinter.font  # noqa: F401  (ensure tk.font is loaded for _setup_fonts)
    _dpi_aware()
    root = tk.Tk()
    try:
        App(root, csv_override=csv_override, autostart=autostart, start_hidden=start_hidden)
    except Exception as e:
        messagebox.showerror(APP_TITLE, f"启动失败: {e}")
        raise
    root.mainloop()
    return 0
