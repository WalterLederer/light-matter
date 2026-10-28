import {
  enumerateMonitors,
  ImageEncoder,
  ImageEncoderPixelFormat,
  ImageFormat,
  ScreenCapture
} from '@screen-capture/node';
import { app, dialog, ipcMain, IpcMainInvokeEvent, screen } from 'electron';
import { encodeExr, init as initExr } from 'exrs';
import { CaptureFormat, CaptureResult, CaptureSources, CaptureTarget, FileListing, supportedFileExtensions } from 'internal-api';
import Vips from 'wasm-vips';
import { execFileSync } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Injector } from '../../injector/injector';
import App from '../app';
import { IpcRegistry } from '../decorators/ipc-registry';
import { captureLoupeFrame, releaseLoupeFrame, sampleLoupeRectangle, sampleLoupeRegion } from '../loupe-capture';

let exrInitPromise: Promise<void> | undefined;
let vipsInitPromise: Promise<typeof Vips> | undefined;

const halfToFloat = (half: number): number => {
  const sign = (half & 0x8000) !== 0 ? -1 : 1;
  const exponent = (half >> 10) & 0x1f;
  const fraction = half & 0x03ff;
  if (exponent === 0) {
    return fraction === 0 ? sign * 0 : sign * 2 ** -14 * (fraction / 1024);
  }
  if (exponent === 0x1f) {
    return fraction === 0 ? sign * Infinity : NaN;
  }
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
};

const CAPTURE_BRIGHTNESS_CORRECTION = 0.4;

interface CapturedHdrFrame {
  targetKey: string;
  width: number;
  height: number;
  buffer: Buffer;
}

let cachedHdrFrame: CapturedHdrFrame | null = null;

const captureTargetKey = (target: CaptureTarget): string =>
  target.kind === 'monitor'
    ? `monitor:${target.index}`
    : `window:${target.handle}`;

const captureHdrFrame = async (target: CaptureTarget): Promise<CapturedHdrFrame> => {
  if (process.platform !== 'win32') {
    throw new Error('HDR capture is currently supported on Windows only.');
  }
  if (target?.kind !== 'monitor' && target?.kind !== 'window') {
    throw new Error('Choose a monitor or application window to capture.');
  }
  const targetKey = captureTargetKey(target);
  const options = target.kind === 'monitor' ? { monitorIndex: target.index } : { windowHandle: target.handle };
  const capture = new ScreenCapture({
    ...options,
    colorFormat: 'rgba16F' as unknown as ConstructorParameters<typeof ScreenCapture>[0]['colorFormat'],
    cursorCapture: false,
    drawBorder: false,
    minimumUpdateIntervalMs: 0
  });
  let phase = 'initialize capture';
  const logPhase = (nextPhase: string): void => {
    phase = nextPhase;
    console.info(`[HDR Capture] ${phase}`);
  };
  try {
    logPhase('start native capture session');
    await capture.start();
    logPhase('wait for first FP16 frame');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const frame = await Promise.race([
      capture.nextFrame(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Timed out waiting for the HDR capture frame.')), 10000);
      })
    ]).finally(() => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    });
    if (!frame) {
      throw new Error('The selected capture source is no longer available.');
    }
    logPhase('validate FP16 frame');
    if (
      frame.colorFormat !== 'rgba16F' || frame.rowPitch !== frame.width * 8
      || frame.buffer.byteLength !== frame.width * frame.height * 8
    ) {
      throw new Error('The capture did not return the expected packed FP16 HDR frame.');
    }
    const captured: CapturedHdrFrame = {
      targetKey,
      width: frame.width,
      height: frame.height,
      buffer: Buffer.from(frame.buffer)
    };
    cachedHdrFrame = captured;
    logPhase(`FP16 HDR frame ready (${frame.width}x${frame.height})`);
    return captured;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[HDR Capture] Failed during "${phase}": ${message}`);
  } finally {
    await capture.stop().catch(() => undefined);
  }
};

const getHdrFrame = async (target: CaptureTarget): Promise<CapturedHdrFrame> => {
  const key = captureTargetKey(target);
  if (cachedHdrFrame?.targetKey === key) {
    // console.info('[HDR Capture] reuse cached FP16 HDR frame');
    return cachedHdrFrame;
  }
  return captureHdrFrame(target);
};
const halfConversionBuffer = new ArrayBuffer(4);
const halfConversionFloat = new Float32Array(halfConversionBuffer);
const halfConversionBits = new Uint32Array(halfConversionBuffer);

const floatToHalf = (value: number): number => {
  halfConversionFloat[0] = value;
  const bits = halfConversionBits[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  let mantissa = bits & 0x7fffff;
  if (exponent <= 0) {
    if (exponent < -10) {
      return sign;
    }
    mantissa = (mantissa | 0x800000) >> (1 - exponent);
    return sign | ((mantissa + 0x1000) >> 13);
  }
  if (exponent >= 31) {
    return sign | 0x7c00 | (mantissa ? 0x0200 : 0);
  }
  return sign | (exponent << 10) | ((mantissa + 0x1000) >> 13);
};

export default class ElectronEvents {
  static bootstrapElectronEvents(): Electron.IpcMain {
    const injector = Injector.getInstance();

    IpcRegistry
      .getInstance()
      .registerIpcHandlers(
        ipcMain,
        [
          injector.inject('Dialogs'),
          injector.inject('Exif'),
          injector.inject('FileSystem'),
          injector.inject('ProcessManager'),
          injector.inject('CacheManager'),
          injector.inject('Histogram')
        ]
      );

    return ipcMain;
  }
}

ipcMain.handle('openFolder', async (): Promise<FileListing> => {
  const result = await dialog.showOpenDialog({ properties: [ 'openDirectory' ] });

  if (!result.canceled && result.filePaths.length > 0) {
    const folder = result.filePaths[0];

    return {
      success: true,
      data: {
        folder,
        files: await readFolder(folder)
      }
    };
  }

  return { success: false, errorMessage: '' };
});

ipcMain.handle('openFile', async (): Promise<FileListing> => {
  const result = await dialog.showOpenDialog({
    properties: [ 'openFile' ],
    filters: [ { name: 'Images', extensions: supportedFileExtensions } ]
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const fileName = result.filePaths[0];
    const folder = path.dirname(fileName);

    return {
      success: true,
      data: {
        folder,
        files: await readFolder(folder),
        selected: fileName
      }
    };
  }

  return { success: false, errorMessage: '' };
});

ipcMain.handle('openFileFromArgs', async (_: IpcMainInvokeEvent, fileName: string): Promise<FileListing> => {
  const folder = path.dirname(fileName);

  return {
    success: true,
    data: {
      folder,
      files: await readFolder(folder),
      selected: fileName
    }
  };
});

ipcMain.handle('Loupe.capture', async () => {
  let phase = 'prepare display capture';
  try {
    if (process.platform !== 'win32' || !App.mainWindow || App.mainWindow.isDestroyed()) {
      throw new Error('HDR loupe capture is unavailable: a live Windows application window is required.');
    }

    // Capture the whole monitor containing the application, not the application
    // window. This avoids window-frame/Chromium-area rounding differences.
    const windowBounds = App.mainWindow.getBounds();
    const contentBounds = App.mainWindow.getContentBounds();
    const display = screen.getDisplayMatching(windowBounds);
    const displays = screen.getAllDisplays();
    const displayPosition = displays.findIndex(candidate => candidate.id === display.id);
    const monitors = enumerateMonitors();
    const expectedWidth = Math.round(display.bounds.width * display.scaleFactor);
    const expectedHeight = Math.round(display.bounds.height * display.scaleFactor);

    // Electron and WGC normally enumerate displays in the same order. If the
    // dimensions show they do not, use the closest physical-size match instead.
    let monitorIndex = displayPosition >= 0 ? displayPosition + 1 : 1;
    const indexedMonitor = monitors[monitorIndex - 1];
    if (
      !indexedMonitor
      || Math.abs(indexedMonitor.width - expectedWidth) > 2
      || Math.abs(indexedMonitor.height - expectedHeight) > 2
    ) {
      const closest = monitors
        .map(monitor => ({
          index: monitor.index,
          score: Math.abs(monitor.width - expectedWidth) + Math.abs(monitor.height - expectedHeight)
        }))
        .sort((a, b) => a.score - b.score)[0];
      if (closest) {
        monitorIndex = closest.index;
      }
    }

    phase = 'capture FP16 monitor frame';
    const frame = await captureLoupeFrame(monitorIndex);
    return {
      width: frame.width,
      height: frame.height,
      x: display.bounds.x,
      y: display.bounds.y,
      contentX: contentBounds.x,
      contentY: contentBounds.y,
      windowWidth: display.bounds.width,
      windowHeight: display.bounds.height,
      scaleFactor: display.scaleFactor
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const gpuInfo = await app.getGPUInfo('complete').catch(() => null);
    const devices = (gpuInfo as {
      gpuDevice?: Array<
        { description?: string; driverVersion?: string; driverDate?: string; vendorId?: number; deviceId?: number; }
      >;
    } | null)?.gpuDevice ?? [];
    const gpu = devices.length
      ? devices.map(device =>
        `${device.description ?? 'Unknown GPU'} (vendor ${device.vendorId ?? '?'}, device ${
          device.deviceId ?? '?'
        }, driver ${device.driverVersion ?? 'unknown'}${device.driverDate ? `, ${device.driverDate}` : ''})`
      ).join(' | ')
      : 'GPU/driver information unavailable from Electron';
    throw new Error(
      `${message}\nDiagnostics: phase=${phase}; OS=${os.version()} [${os.release()}]; Electron=${process.versions.electron}; API=@screen-capture/node; requested format=rgba16F (FP16 / R16G16B16A16_FLOAT); GPU=${gpu}`
    );
  }
});

ipcMain.handle('Loupe.sample', (_event, x: number, y: number, radius?: number) => sampleLoupeRegion(x, y, radius));
ipcMain.handle(
  'Loupe.region',
  (_event, x: number, y: number, width: number, height: number) => sampleLoupeRectangle(x, y, width, height)
);
ipcMain.handle('Loupe.release', () => releaseLoupeFrame());

const queryWindowsMonitorHdrModes = (): Record<string, boolean | null> => {
  if (process.platform !== 'win32') {
    return {};
  }
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public sealed class LightMatterDisplayMode {
  public string deviceName { get; set; }
  public bool? isHdr { get; set; }
}
public static class LightMatterDisplayConfig {
  [StructLayout(LayoutKind.Sequential)] public struct LUID { public uint LowPart; public int HighPart; }
  [StructLayout(LayoutKind.Sequential)] public struct HEADER { public int type; public uint size; public LUID adapterId; public uint id; }
  [StructLayout(LayoutKind.Sequential)] public struct PATH_SOURCE { public uint adapterIdLow; public int adapterIdHigh; public uint id; public uint modeInfoIdx; public uint statusFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct PATH_TARGET { public uint adapterIdLow; public int adapterIdHigh; public uint id; public uint modeInfoIdx; public uint outputTechnology; public uint rotation; public uint scaling; public uint refreshNumerator; public uint refreshDenominator; public uint scanLineOrdering; public int targetAvailable; public uint statusFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct PATH_INFO { public PATH_SOURCE sourceInfo; public PATH_TARGET targetInfo; public uint flags; }

  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct SOURCE_NAME {
    public HEADER header;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)]
    public string viewGdiDeviceName;
  }

  [StructLayout(LayoutKind.Sequential)] public struct ADVANCED_COLOR_INFO { public HEADER header; public uint value; public uint colorEncoding; public uint bitsPerColorChannel; }
  [StructLayout(LayoutKind.Sequential)] public struct ADVANCED_COLOR_INFO_2 { public HEADER header; public uint value; public uint colorEncoding; public uint bitsPerColorChannel; public uint activeColorMode; }
  [DllImport("user32.dll")] public static extern int GetDisplayConfigBufferSizes(uint flags, out uint pathCount, out uint modeCount);

  [DllImport("user32.dll")]
  public static extern int QueryDisplayConfig(
    uint flags,
    ref uint pathCount,
    [Out] PATH_INFO[] paths,
    ref uint modeCount,
    IntPtr modes,
    IntPtr currentTopologyId);

  [DllImport("user32.dll")] public static extern int DisplayConfigGetDeviceInfo(ref SOURCE_NAME requestPacket);
  [DllImport("user32.dll")] public static extern int DisplayConfigGetDeviceInfo(ref ADVANCED_COLOR_INFO requestPacket);
  [DllImport("user32.dll")] public static extern int DisplayConfigGetDeviceInfo(ref ADVANCED_COLOR_INFO_2 requestPacket);
  public static LightMatterDisplayMode[] GetModes() {
    uint pathCount, modeCount;
    int sizeResult = GetDisplayConfigBufferSizes(2, out pathCount, out modeCount);
    if (sizeResult != 0) {
      Console.Error.WriteLine("[Capture HDR modes] GetDisplayConfigBufferSizes failed: " + sizeResult);
      return new LightMatterDisplayMode[0];
    }
    var paths = new PATH_INFO[pathCount];
    uint pc = pathCount, mc = modeCount;
    // QueryDisplayConfig requires storage for the returned DISPLAYCONFIG_MODE_INFO entries.
    // The native structure is 48 bytes on supported Windows x64 systems; we only inspect paths.
    IntPtr modeBuffer = Marshal.AllocHGlobal(checked((int)Math.Max(1u, modeCount) * 48));
    int result;
    try { result = QueryDisplayConfig(2, ref pc, paths, ref mc, modeBuffer, IntPtr.Zero); }
    finally { Marshal.FreeHGlobal(modeBuffer); }
    if (result != 0) {
      Console.Error.WriteLine("[Capture HDR modes] QueryDisplayConfig failed: " + result + "; paths=" + pc + "; modes=" + mc);
      return new LightMatterDisplayMode[0];
    }
    var rows = new List<LightMatterDisplayMode>();

/*
    Console.Error.WriteLine(
      "[Capture HDR modes] HEADER size=" + Marshal.SizeOf(typeof(HEADER)) +
      "; SOURCE_NAME size=" + Marshal.SizeOf(typeof(SOURCE_NAME)) +
      "; paths=" + pc);
*/

    for (int i = 0; i < pc; i++) {
      var source = new SOURCE_NAME();
      source.header.type = 1;
      source.header.size = (uint)Marshal.SizeOf(typeof(SOURCE_NAME));
      source.header.adapterId = new LUID { LowPart = paths[i].sourceInfo.adapterIdLow, HighPart = paths[i].sourceInfo.adapterIdHigh };
      source.header.id = paths[i].sourceInfo.id;
      int sourceResult = DisplayConfigGetDeviceInfo(ref source);
      if (sourceResult != 0 || String.IsNullOrEmpty(source.viewGdiDeviceName)) {
        Console.Error.WriteLine("[Capture HDR modes] DisplayConfigGetDeviceInfo(source) failed: " + sourceResult);
        continue;
      }
      var targetAdapter = new LUID { LowPart = paths[i].targetInfo.adapterIdLow, HighPart = paths[i].targetInfo.adapterIdHigh };
      bool? hdr = null;
      // Windows 11 24H2+ distinguishes HDR from wide-color-gamut (WCG).
      // DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO_2 = 15 (Windows 11 24H2+).
      var color2 = new ADVANCED_COLOR_INFO_2();
      color2.header.type = 15;
      color2.header.size = (uint)Marshal.SizeOf(typeof(ADVANCED_COLOR_INFO_2));
      color2.header.adapterId = targetAdapter;
      color2.header.id = paths[i].targetInfo.id;
      int color2Result = DisplayConfigGetDeviceInfo(ref color2);
      if (color2Result == 0) {
        hdr = color2.activeColorMode == 2u; // DISPLAYCONFIG_ADVANCED_COLOR_MODE_HDR; SDR=0, WCG=1
        // Console.Error.WriteLine("[Capture HDR modes] " + source.viewGdiDeviceName + ": API v2 activeColorMode=" + color2.activeColorMode);
      } else {
        // Legacy API for earlier Windows versions: bit 1 is advancedColorEnabled.
        // On those versions Windows does not expose a distinct HDR/WCG active mode.
        var color = new ADVANCED_COLOR_INFO();
        color.header.type = 9;
        color.header.size = (uint)Marshal.SizeOf(typeof(ADVANCED_COLOR_INFO));
        color.header.adapterId = targetAdapter;
        color.header.id = paths[i].targetInfo.id;
        int legacyResult = DisplayConfigGetDeviceInfo(ref color);
        if (legacyResult == 0) {
          hdr = (color.value & 2u) != 0;
          // Console.Error.WriteLine("[Capture HDR modes] " + source.viewGdiDeviceName + ": legacy advancedColorEnabled=" + ((color.value & 2u) != 0));
        } else {
          Console.Error.WriteLine("[Capture HDR modes] " + source.viewGdiDeviceName + ": API v2 failed=" + color2Result + "; legacy failed=" + legacyResult);
        }
      }
      rows.Add(new LightMatterDisplayMode { deviceName = source.viewGdiDeviceName, isHdr = hdr });
    }
    return rows.ToArray();
  }
}
'@
    [LightMatterDisplayConfig]::GetModes() | ConvertTo-Json -Compress -Depth 4
  `;
  try {
    const raw = execFileSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
    const parsed = JSON.parse(raw || '[]') as
      | { deviceName: string; isHdr: boolean | null; }
      | Array<{ deviceName: string; isHdr: boolean | null; }>;
    const rows = Array.isArray(parsed) ? parsed : [ parsed ];
    const modes: Record<string, boolean | null> = {};
    for (const row of rows) {
      modes[row.deviceName.toLowerCase().replace(/[^a-z0-9]/g, '')] = row.isHdr;
    }
    // console.info('[Capture HDR modes] Windows API rows:', rows, 'normalized keys:', Object.keys(modes));
    return modes;
  } catch (error) {
    const e = error as NodeJS.ErrnoException & {
      status?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };

    console.warn('[Capture] Failed to query Windows HDR monitor modes:', {
      message: e.message,
      status: e.status,
      stdout: e.stdout?.toString(),
      stderr: e.stderr?.toString()
    });

    return {};
  }
};

ipcMain.handle('Capture.listSources', async (): Promise<CaptureSources> => {
  if (process.platform !== 'win32') {
    throw new Error('HDR capture of individual windows and monitors is currently supported on Windows only.');
  }

  const hdrModes = queryWindowsMonitorHdrModes();

  /*
  const enumeratedMonitors = enumerateMonitors();
  console.info('[Capture HDR modes] Raw Windows mapping:', JSON.stringify({
    hdrModes,
    monitors: enumeratedMonitors.map(m => ({
      index: m.index,
      name: m.name,
      deviceName: m.deviceName,
      normalizedDeviceName: (m.deviceName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
    }))
  }, null, 2));
  */

  const monitors = enumerateMonitors().map(monitor => {
    const deviceKey = (monitor.deviceName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return {
      index: monitor.index,
      name: monitor.name || monitor.deviceName || `Monitor ${monitor.index}`,
      deviceName: monitor.deviceName,
      width: monitor.width,
      height: monitor.height,
      refreshRate: monitor.refreshRate,
      isHdr: deviceKey in hdrModes ? hdrModes[deviceKey] ?? undefined : undefined
    };
  });

  const sourceErrors: string[] = [];
  let windows: CaptureSources['windows'] = [];

  // @screen-capture/node's enumerateWindows() throws ACCESS_DENIED on some
  // systems. Enumerate top-level windows through Win32 instead, and tolerate
  // protected processes for which Windows will not provide an executable path.
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    # Windows PowerShell 5.1 otherwise may emit redirected native output using the active OEM code page.
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;

public sealed class LightMatterWindowRow {
  public string handle { get; set; }
  public string title { get; set; }
  public uint processId { get; set; }
  public string executablePath { get; set; }
  public int width { get; set; }
  public int height { get; set; }
  public int monitorIndex { get; set; }
  public string monitorDeviceName { get; set; }
  public bool isMinimized { get; set; }
}

public static class LightMatterWindowEnumerator {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)]
  private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct MONITORINFOEX {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string szDevice;
  }
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", SetLastError=true)] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] private static extern IntPtr MonitorFromRect(ref RECT rect, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool GetMonitorInfoW(IntPtr monitor, ref MONITORINFOEX info);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref uint size);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);

  public static LightMatterWindowRow[] GetWindows() {
    var rows = new List<LightMatterWindowRow>();
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      var titleBuffer = new StringBuilder(1024);
      GetWindowText(hWnd, titleBuffer, titleBuffer.Capacity);
      var title = titleBuffer.ToString().Trim();
      if (title.Length == 0 || title.StartsWith("Light Matter", StringComparison.OrdinalIgnoreCase)) return true;
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      string exePath = null;
      if (pid != 0) {
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process != IntPtr.Zero) {
          try {
            var pathBuffer = new StringBuilder(32768);
            uint size = (uint)pathBuffer.Capacity;
            if (QueryFullProcessImageNameW(process, 0, pathBuffer, ref size)) exePath = pathBuffer.ToString();
          } finally { CloseHandle(process); }
        }
      }
      RECT rect;
      int width = 0, height = 0;
      string monitorDeviceName = null;
      if (GetWindowRect(hWnd, out rect)) {
        width = Math.Max(0, rect.Right - rect.Left);
        height = Math.Max(0, rect.Bottom - rect.Top);
        if (width >= 100 && height >= 100 && !IsIconic(hWnd)) {
          IntPtr monitor = MonitorFromRect(ref rect, 2); // MONITOR_DEFAULTTONEAREST
          if (monitor != IntPtr.Zero) {
            var monitorInfo = new MONITORINFOEX();
            monitorInfo.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            if (GetMonitorInfoW(monitor, ref monitorInfo)) monitorDeviceName = monitorInfo.szDevice;
          }
        }
      }
      rows.Add(new LightMatterWindowRow { handle = hWnd.ToInt64().ToString(), title = title, processId = pid, executablePath = exePath, width = width, height = height, monitorIndex = -1, monitorDeviceName = monitorDeviceName, isMinimized = IsIconic(hWnd) });
      return true;
    }, IntPtr.Zero);
    return rows.ToArray();
  }
}
'@
    [LightMatterWindowEnumerator]::GetWindows() | ConvertTo-Json -Compress -Depth 4
  `;

  try {
    const nativeJson = execFileSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script
    ], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
    const nativeRows = JSON.parse(nativeJson || '[]') as Array<{
      handle: string;
      title: string;
      processId: number;
      executablePath?: string | null;
      width: number;
      height: number;
      monitorIndex: number;
      monitorDeviceName?: string | null;
      isMinimized: boolean;
    }>;
    windows = nativeRows
      .filter(window => Number(window.processId) !== process.pid)
      .map(window => {
        const executablePath = window.executablePath || undefined;
        return {
          title: window.title.trim(),
          processName: executablePath ? path.basename(executablePath) : 'Unknown executable',
          executablePath,
          processId: Number(window.processId) || 0,
          handle: Number(window.handle),
          width: Number(window.width) || 0,
          height: Number(window.height) || 0,
          monitorIndex: Number(window.monitorIndex) || -1,
          monitorDeviceName: window.monitorDeviceName || undefined,
          isMinimized: Boolean(window.isMinimized)
        };
      })
      .sort((a, b) =>
        a.processName.localeCompare(b.processName, undefined, { sensitivity: 'base' })
        || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
      );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sourceErrors.push(`PowerShell Win32 window enumeration failed: ${message}`);
  }

  return { monitors, windows, sourceErrors };
});

ipcMain.handle('Capture.chooseFolder', async (_event, initialPath?: string): Promise<string | null> => {
  const result = await dialog.showOpenDialog(App.mainWindow, {
    title: 'Choose HDR capture folder',
    defaultPath: initialPath || undefined,
    properties: [ 'openDirectory', 'createDirectory' ]
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

ipcMain.handle(
  'Capture.preview',
  async (_event, target: CaptureTarget): Promise<{ width: number; height: number; pixels: Uint16Array; }> => {
    // console.info('[HDR Capture] preview requested');
    // Always capture a fresh frame for Preview. The resulting frame remains cached
    // so Save can reuse exactly the image the user just inspected.
    const frame = await captureHdrFrame(target);
    const pixels = new Uint16Array(
      frame.buffer.buffer.slice(frame.buffer.byteOffset, frame.buffer.byteOffset + frame.buffer.byteLength)
    );
    console.info(`[HDR Capture] send FP16 frame to WebGPU preview (${frame.width}x${frame.height})`);
    return { width: frame.width, height: frame.height, pixels };
  }
);

ipcMain.handle(
  'Capture.capture',
  async (_event, target: CaptureTarget, folder: string, format: CaptureFormat = 'exr'): Promise<CaptureResult> => {
    if (format !== 'exr' && format !== 'jxr' && format !== 'uhdr') {
      throw new Error('Choose OpenEXR, JPEG XR, or Ultra HDR JPEG as the capture format.');
    }
    if (process.platform !== 'win32') {
      throw new Error('HDR capture is currently supported on Windows only.');
    }
    if (!folder || !path.isAbsolute(folder)) {
      throw new Error('Choose a valid destination folder before capturing.');
    }
    if (target?.kind !== 'monitor' && target?.kind !== 'window') {
      throw new Error('Choose a monitor or application window to capture.');
    }

    let phase = 'get FP16 HDR frame';
    const logPhase = (nextPhase: string): void => {
      phase = nextPhase;
      console.info(`[HDR Capture] ${phase}`);
    };
    try {
      const frame = await getHdrFrame(target);
      const sourceChannels = new Uint16Array(frame.buffer.buffer, frame.buffer.byteOffset, frame.buffer.byteLength / 2);
      const extension = format === 'uhdr' ? 'jpg' : format;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const baseName = `LightMatter_Capture_${stamp}`;
      let outputPath = path.join(folder, `${baseName}.${extension}`);
      let suffix = 1;
      while (fsSync.existsSync(outputPath)) {
        outputPath = path.join(folder, `${baseName}_${suffix++}.${extension}`);
      }
      if (format === 'uhdr') {
        logPhase(`convert FP16 scRGB frame to Float32 RGBA with brightness correction ${CAPTURE_BRIGHTNESS_CORRECTION}`);
        const rgb = new Float32Array(frame.width * frame.height * 3);
        for (let pixel = 0; pixel < frame.width * frame.height; pixel++) {
          const source = pixel * 4;
          const destination = pixel * 3;
          rgb[destination] = halfToFloat(sourceChannels[source]) * CAPTURE_BRIGHTNESS_CORRECTION;
          rgb[destination + 1] = halfToFloat(sourceChannels[source + 1]) * CAPTURE_BRIGHTNESS_CORRECTION;
          rgb[destination + 2] = halfToFloat(sourceChannels[source + 2]) * CAPTURE_BRIGHTNESS_CORRECTION;
        }
        logPhase('initialize libvips Ultra HDR JPEG encoder');
        vipsInitPromise ??= Vips();
        const vips = await vipsInitPromise;
        vips.Cache.max(0);
        vips.Cache.maxMem(0);
        using image = vips.Image.newFromMemory(rgb, frame.width, frame.height, 3, vips.BandFormat.float);
        using scrgb = image.copy({ interpretation: vips.Interpretation.scrgb });
        logPhase('encode Ultra HDR JPEG with embedded gain map');
        scrgb.uhdrsave(outputPath, { Q: 90 });
        logPhase('Ultra HDR JPEG written');
      } else {
        let encoded: Buffer | Uint8Array;
        if (format === 'jxr') {
          logPhase('pack RGBA16F input and encode JPEG XR');
          // Keep the native RGBA16F layout. The Windows JPEG XR encoder reported
          // WINCODEC_ERR_INSUFFICIENTBUFFER when given a tightly packed RGB16F buffer.
          // Use the encoder's RGBA16F pixel format so channel order and row size agree.
          const rgba = Buffer.allocUnsafe(frame.width * frame.height * 4 * 2);
          for (let channelIndex = 0; channelIndex < sourceChannels.length; channelIndex++) {
            const channel = channelIndex % 4;
            const value = halfToFloat(sourceChannels[channelIndex]) * (channel === 3 ? 1 : CAPTURE_BRIGHTNESS_CORRECTION);
            rgba.writeUInt16LE(floatToHalf(value), channelIndex * 2);
          }
          const encoder = new ImageEncoder(ImageFormat.JpegXr, ImageEncoderPixelFormat.Rgb16F);
          encoded = encoder.encode(rgba, frame.width, frame.height);
        } else {
          logPhase(
            `convert native RGBA16F to Float32 RGBA (${frame.width}x${frame.height}) without brightness correction`
          );
          const rgba = new Float32Array(frame.width * frame.height * 4);
          for (let source = 0; source < sourceChannels.length; source++) {
            rgba[source] = halfToFloat(sourceChannels[source]);
          }
          logPhase('initialize OpenEXR encoder');
          exrInitPromise ??= initExr();
          await exrInitPromise;
          logPhase('encode OpenEXR');
          encoded = encodeExr({
            width: frame.width,
            height: frame.height,
            layers: [ {
              name: 'rgba',
              channelNames: [ 'R', 'G', 'B', 'A' ],
              interleavedPixels: rgba,
              precision: 'f32',
              compression: 'piz'
            } ]
          });
        }
        logPhase(`write ${format.toUpperCase()} file`);
        await fs.writeFile(outputPath, encoded, { flag: 'wx' });
      }
      if (cachedHdrFrame === frame) {
        cachedHdrFrame = null;
      }
      return { path: outputPath, width: frame.width, height: frame.height };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[HDR Capture] Failed during "${phase}": ${message}`);
    }
  }
);

ipcMain.on('quit', (_, code) => app.exit(code));

const readFolder = async (folder: string): Promise<string[]> =>
  (await fs.readdir(folder))
    .map(f => path.join(folder, f))
    .filter(f => fsSync.lstatSync(f).isFile())
    .filter(f => supportedFileExtensions.includes(path.extname(f).toLowerCase().replace('.', '')));
