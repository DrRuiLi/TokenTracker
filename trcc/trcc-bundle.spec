# -*- mode: python ; coding: utf-8 -*-
# Onedir bundle shipped inside the TokenTracker install as {app}\trcc\.
# Windowed so `tracker serve` can start it without a console, same as pythonw.
from PyInstaller.utils.hooks import collect_all

datas = [('Inter.ttf', '.'), ('NOTICE', '.'), ('LICENSE', '.'), ('vendor/lhm', 'lhm')]
binaries = [('vendor/libusb-1.0.dll', '.')]
hiddenimports = [
    'clr',
    'usb.backend.libusb1',
    'usb.backend.libusb0',
    'PIL._tkinter_finder',
    'win32com.client',
    'pythoncom',
    'pywintypes',
    'pystray._win32',
    'grok_billing',
    'host',
    'control_api',
    'theme_edit',
]
tmp_ret = collect_all('pythonnet')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('clr_loader')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['curl_cffi'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='trcc-token-dash',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name='trcc-token-dash',
)
