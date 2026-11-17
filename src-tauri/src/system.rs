use serde_json::Value;
use std::process::Command;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows shows a console window for every cmd/powershell spawn unless
/// CREATE_NO_WINDOW is set. Wrap every headless spawn with this.
pub fn silent(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    { cmd.creation_flags(0x0800_0000); } // CREATE_NO_WINDOW
    cmd
}

pub fn lock_workstation() -> bool {
    let _ = silent(&mut Command::new("rundll32.exe")
        .args(&["user32.dll,LockWorkStation"]))
        .spawn();
    true
}

pub fn open_url(url: &str) -> bool {
    let _ = silent(&mut Command::new("cmd")
        .args(&["/c", "start", "", url]))
        .spawn();
    true
}

fn parse_url_tab_info(raw: &str) -> (bool, Vec<String>) {
    let u = raw.trim();
    let after_scheme = if let Some(s) = u.strip_prefix("https://") {
        s
    } else if let Some(s) = u.strip_prefix("http://") {
        s
    } else {
        u
    };

    let (host_part, path_and_query) = match after_scheme.find('/') {
        Some(idx) => (&after_scheme[..idx], &after_scheme[idx..]),
        None => (after_scheme, ""),
    };

    let host = host_part.split(':').next().unwrap_or(host_part).to_lowercase();
    let is_pure_root = (path_and_query.is_empty() || path_and_query == "/" || path_and_query == "/#")
        && !path_and_query.contains('?');

    let h_clean = host.strip_prefix("www.").unwrap_or(&host);
    let mut keywords = Vec::new();
    if h_clean.contains("youtube") {
        keywords.push("youtube".to_string());
    } else if h_clean.contains("whatsapp") {
        keywords.push("whatsapp".to_string());
    } else if h_clean.contains("mail.google") || h_clean == "gmail.com" {
        keywords.push("gmail".to_string());
        keywords.push("inbox".to_string());
        keywords.push("mail".to_string());
    } else if h_clean.contains("github") {
        keywords.push("github".to_string());
    } else if h_clean.contains("telegram") {
        keywords.push("telegram".to_string());
    } else if h_clean.contains("instagram") {
        keywords.push("instagram".to_string());
    } else if h_clean == "x.com" || h_clean.contains("twitter") {
        keywords.push("x.com".to_string());
        keywords.push("twitter".to_string());
    } else if h_clean.contains("maps.google") {
        keywords.push("maps".to_string());
    } else if h_clean.contains("drive.google") {
        keywords.push("drive".to_string());
    } else if h_clean.contains("calendar.google") {
        keywords.push("calendar".to_string());
    } else {
        let parts: Vec<&str> = h_clean.split('.').filter(|s| !s.is_empty()).collect();
        if parts.len() >= 2 {
            keywords.push(parts[parts.len() - 2].to_string());
        } else if !h_clean.is_empty() {
            keywords.push(h_clean.to_string());
        }
    }

    (is_pure_root, keywords)
}

pub async fn open_url_smart(raw_url: &str) -> Value {
    let url_str = raw_url.trim().to_string();
    if url_str.is_empty() {
        return serde_json::json!({ "ok": false, "reason": "empty" });
    }

    let full_url = if !url_str.starts_with("http://") && !url_str.starts_with("https://") {
        format!("https://{}", url_str)
    } else {
        url_str.clone()
    };

    let (is_pure_root, keywords) = parse_url_tab_info(&full_url);
    let kw_json = serde_json::to_string(&keywords).unwrap_or_else(|_| "[]".to_string());

    let ps_script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class DnTabActR {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool c);
  [DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e);
  public static bool Bring(IntPtr h) {
    if (h == IntPtr.Zero) return false;
    if (IsIconic(h)) { ShowWindow(h, 9); }
    uint pid = 0;
    uint ft = GetWindowThreadProcessId(h, out pid);
    uint mt = GetCurrentThreadId();
    keybd_event(0, 0, 0, UIntPtr.Zero);
    if (ft != 0 && ft != mt) { AttachThreadInput(mt, ft, true); }
    ShowWindow(h, 9);
    bool ok = SetForegroundWindow(h);
    if (ft != 0 && ft != mt) { AttachThreadInput(mt, ft, false); }
    return ok;
  }
  public static void Key(byte vk) {
    keybd_event(vk, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(30);
    keybd_event(vk, 0, 2, UIntPtr.Zero);
  }
  public static void Ctrl(byte vk) {
    keybd_event(0x11, 0, 0, UIntPtr.Zero);
    keybd_event(vk, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(30);
    keybd_event(vk, 0, 2, UIntPtr.Zero);
    keybd_event(0x11, 0, 2, UIntPtr.Zero);
  }
}
"@

$targetUrl = [Console]::In.ReadLine()
$pureRoot = [Console]::In.ReadLine() -eq "1"
$kwList = [Console]::In.ReadLine() | ConvertFrom-Json

$browsers = @(Get-Process chrome, msedge, firefox, brave, opera, vivaldi -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
if ($browsers.Count -eq 0) {
  Start-Process $targetUrl
  [Console]::Out.WriteLine("OPEN")
  exit 0
}

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$tabCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
$matchedTab = $null
$matchedWin = $null
$tabName = ""
$totalTabsFound = 0

foreach ($p in $browsers) {
  $wins = $AE::RootElement.FindAll($TS::Children, (New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $p.Id)))
  foreach ($win in $wins) {
    if (-not $win) { continue }
    $tabs = $win.FindAll($TS::Descendants, $tabCond)
    $totalTabsFound += $tabs.Count
    foreach ($tb in $tabs) {
      $nm = ""
      try { $nm = $tb.Current.Name } catch {}
      if (-not $nm) { continue }
      $low = $nm.ToLower()
      foreach ($k in $kwList) {
        if ($k -and $low.Contains(([string]$k).ToLower())) {
          $matchedTab = $tb
          $matchedWin = $win
          $tabName = $nm
          break
        }
      }
      if ($matchedTab) { break }
    }
    if ($matchedTab) { break }
  }
  if ($matchedTab) { break }
}

if ($matchedTab) {
  try { ([System.Windows.Automation.SelectionItemPattern]$matchedTab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)).Select() } catch { try { ([System.Windows.Automation.InvokePattern]$matchedTab.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke() } catch {} }
  $null = [DnTabActR]::Bring([IntPtr]$matchedWin.Current.NativeWindowHandle)
  if ($pureRoot) {
    [Console]::Out.WriteLine("REUSE`t" + $tabName)
    exit 0
  } else {
    Start-Sleep -Milliseconds 200
    Set-Clipboard -Value $targetUrl
    [DnTabActR]::Ctrl(0x4C)
    Start-Sleep -Milliseconds 150
    [DnTabActR]::Ctrl(0x56)
    Start-Sleep -Milliseconds 100
    [DnTabActR]::Key(0x0D)
    [Console]::Out.WriteLine("NAVIGATE`t" + $tabName)
    exit 0
  }
}

if ($totalTabsFound -eq 0) {
  $cand = $null
  foreach ($p in $browsers) {
    $tLow = $p.MainWindowTitle.ToLower()
    foreach ($k in $kwList) {
      if ($k -and $tLow.Contains(([string]$k).ToLower())) { $cand = $p; break }
    }
    if ($cand) { break }
  }
  if (-not $cand) { $cand = $browsers[0] }
  if ($cand) {
    $null = [DnTabActR]::Bring($cand.MainWindowHandle)
    $cLow = $cand.MainWindowTitle.ToLower()
    $hasKw = $false
    foreach ($k in $kwList) { if ($k -and $cLow.Contains(([string]$k).ToLower())) { $hasKw = $true; break } }
    if ($pureRoot -and $hasKw) {
      [Console]::Out.WriteLine("REUSE`t" + $cand.MainWindowTitle)
      exit 0
    }
    Start-Sleep -Milliseconds 200
    Set-Clipboard -Value $targetUrl
    [DnTabActR]::Ctrl(0x4C)
    Start-Sleep -Milliseconds 150
    [DnTabActR]::Ctrl(0x56)
    Start-Sleep -Milliseconds 100
    [DnTabActR]::Key(0x0D)
    [Console]::Out.WriteLine("NAVIGATE`t" + $cand.MainWindowTitle)
    exit 0
  }
}

Start-Process $targetUrl
[Console]::Out.WriteLine("OPEN")
"#;

    let target_url_clone = full_url.clone();
    let is_pure_root_str = if is_pure_root { "1" } else { "0" };
    let stdin_payload = format!("{}\n{}\n{}\n", target_url_clone, is_pure_root_str, kw_json);

    let res = tokio::time::timeout(Duration::from_secs(6), tokio::task::spawn_blocking(move || {
        use std::io::Write;
        let mut child = silent(&mut Command::new("powershell.exe")
            .args(&["-NoProfile", "-NonInteractive", "-Command", ps_script])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null()))
            .spawn()?;

        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(stdin_payload.as_bytes());
        }

        let output = child.wait_with_output()?;
        Ok::<String, std::io::Error>(String::from_utf8_lossy(&output.stdout).trim().to_string())
    })).await;

    match res {
        Ok(Ok(Ok(out))) => {
            if let Some(tab_name) = out.strip_prefix("REUSE\t") {
                serde_json::json!({
                    "ok": true,
                    "reused": true,
                    "navigated": false,
                    "tab": tab_name.trim()
                })
            } else if let Some(tab_name) = out.strip_prefix("NAVIGATE\t") {
                serde_json::json!({
                    "ok": true,
                    "reused": true,
                    "navigated": true,
                    "tab": tab_name.trim()
                })
            } else {
                serde_json::json!({
                    "ok": true,
                    "reused": false
                })
            }
        }
        _ => {
            open_url(&full_url);
            serde_json::json!({
                "ok": true,
                "reused": false
            })
        }
    }
}

/// Fokus jendela app pemutar musik berdasarkan SMTC sourceAppId (AUMID).
/// AUMID tidak sama dengan judul jendela ("Microsoft.MicrosoftEdge" vs
/// "... Microsoft Edge"), jadi dinormalisasi dulu, lalu pakai focus_window.
pub async fn focus_media_app(app_id: &str) -> Value {
    let a = app_id.trim().to_lowercase();
    let hint = if a.contains("msedge") || a.contains("microsoftedge") {
        "microsoft edge".to_string()
    } else if a.contains("chrome") {
        "chrome".to_string()
    } else if a.contains("firefox") {
        "firefox".to_string()
    } else if a.contains("brave") {
        "brave".to_string()
    } else if a.contains("spotify") {
        "spotify".to_string()
    } else if a.contains("vlc") {
        "vlc".to_string()
    } else if a.contains("musicbee") {
        "musicbee".to_string()
    } else if a.contains("itunes") {
        "itunes".to_string()
    } else {
        // token PERTAMA AUMID (mis. "ZenBrowser-F0DC..." -> "zenbrowser")
        a.split(['.', '-', '_', '!', ' ']).next().unwrap_or("").to_string()
    };
    focus_window(&hint).await
}

/// Klik notifikasi: fokuskan app sumbernya, dan kalau ada URL, buka URL itu
/// DI BROWSER SUMBERNYA (exe Zen/Chrome yang sedang jalan) — bukan browser
/// default. Dipakai tab Notif agar klik = langsung ke tujuan.
pub async fn notif_open(hint: &str, url: &str, profile: &str) -> Value {
    let h = hint.trim().to_lowercase();
    let tok = h
        .split(['.', '-', '_', '!', ' '])
        .next()
        .unwrap_or("")
        .to_string();
    let ps = format!(
        r#"$ErrorActionPreference='SilentlyContinue'; $tok='{}'; Add-Type @'
using System; using System.Runtime.InteropServices;
public class DnFoc2 {{
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}}
'@;
$procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {{ $_.MainWindowHandle -ne 0 }});
$pick = $null;
foreach ($p in $procs) {{
  $pn = $p.ProcessName.ToLower();
  if ($tok -and ($pn.Contains($tok) -or $tok.Contains($pn))) {{ $pick = $p; break; }}
}}
if ($pick) {{
  try {{ Add-Type -AssemblyName System.Windows.Forms }} catch {{}}
  try {{ [System.Windows.Forms.SendKeys]::SendWait('%') }} catch {{}}
  [DnFoc2]::ShowWindow($pick.MainWindowHandle, 9) | Out-Null;
  [DnFoc2]::SetForegroundWindow($pick.MainWindowHandle) | Out-Null;
  $p = '';
  try {{ $p = $pick.Path }} catch {{}}
  [Console]::Out.Write('OK|' + $p);
}} else {{
  [Console]::Out.Write('NO|');
}}
"#,
        tok.replace('\'', "''")
    );
    let res = tokio::task::spawn_blocking(move || {
        silent(&mut Command::new("powershell.exe")
            .args(&["-NoProfile", "-NonInteractive", "-Command", &ps]))
            .output()
    }).await;
    let (ok, exe) = match res {
        Ok(Ok(out)) => {
            let s = String::from_utf8_lossy(&out.stdout);
            if s.contains("OK|") {
                let path = s.trim().strip_prefix("OK|").unwrap_or("").trim().to_string();
                (true, path)
            } else {
                (false, String::new())
            }
        }
        _ => (false, String::new()),
    };
    // URL ada + exe browser sumber ketemu -> buka URL DI browser sumbernya
    if !url.is_empty() && !exe.is_empty() {
        let url = url.to_string();
        let profile = profile.to_string();
        let opened = tokio::task::spawn_blocking(move || {
            // TANPA -profile, zen/firefox membuka INSTANCE BARU (profil lain)
            // — itulah "buka aplikasi zen baru". Dengan -profile <path>,
            // remoting meneruskan URL ke instance yang SUDAH JALAN.
            let mut cmd = Command::new(exe);
            if !profile.is_empty() {
                cmd.arg("-profile").arg(&profile);
            }
            cmd.arg(&url);
            silent(&mut cmd).spawn().is_ok()
        }).await
        .unwrap_or(false);
        return serde_json::json!({ "ok": ok || opened, "opened": opened });
    }
    serde_json::json!({ "ok": ok, "opened": false })
}

pub async fn focus_window(hint: &str) -> Value {
    let h = hint.trim().to_lowercase();
    let ps = format!(
        r#"$ErrorActionPreference='SilentlyContinue'; $hint='{}'; Add-Type @'
using System; using System.Runtime.InteropServices;
public class DnFoc {{
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}}
'@;
$procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {{ $_.MainWindowHandle -ne 0 }});
$pick = $null;
foreach ($p in $procs) {{
  if ($hint -and $p.MainWindowTitle.ToLower().Contains($hint)) {{ $pick = $p; break; }}
}}
if (-not $pick) {{
  $tok = ($hint -split '[-_. ]')[0];
  if ($tok) {{
    foreach ($p in $procs) {{
      $pn = $p.ProcessName.ToLower();
      if ($pn -and ($pn.Contains($tok) -or $hint.Contains($pn))) {{ $pick = $p; break; }}
    }}
  }}
}}
if ($pick) {{
  try {{ Add-Type -AssemblyName System.Windows.Forms }} catch {{}}
  try {{ [System.Windows.Forms.SendKeys]::SendWait('%') }} catch {{}}
  [DnFoc]::ShowWindow($pick.MainWindowHandle, 9) | Out-Null;
  [DnFoc]::SetForegroundWindow($pick.MainWindowHandle) | Out-Null;
  $p = '';
  try {{ $p = $pick.Path }} catch {{}}
  [Console]::Out.Write('OK|' + $p);
}} else {{
  [Console]::Out.Write('NO');
}}
"#,
        h.replace('\'', "''")
    );
    let res = tokio::task::spawn_blocking(move || {
        silent(&mut Command::new("powershell.exe")
            .args(&["-NoProfile", "-NonInteractive", "-Command", &ps]))
            .output()
    }).await;
    let ok = match res {
        Ok(Ok(out)) => String::from_utf8_lossy(&out.stdout).contains("OK"),
        _ => false,
    };
    serde_json::json!({ "ok": ok })
}

pub fn open_path(path: &str) -> bool {
    let _ = silent(&mut Command::new("explorer")
        .arg(path))
        .spawn();
    true
}

pub fn reveal_path(path: &str) -> bool {
    let _ = silent(&mut Command::new("explorer")
        .arg(format!("/select,{}", path)))
        .spawn();
    true
}

pub async fn toggle_theme(mode: &str) -> Value {
    let m = mode.to_lowercase();
    let is_light = m == "light" || m == "terang" || m == "cerah" || m == "putih";
    let val = if is_light { 1 } else { 0 };

    let ps = format!(
        r#"$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Themes\Personalize', $true); $k.SetValue('AppsUseLightTheme', {}, [Microsoft.Win32.RegistryValueKind]::DWord); $k.SetValue('SystemUsesLightTheme', {}, [Microsoft.Win32.RegistryValueKind]::DWord); [Console]::Out.Write('OK')"#,
        val, val
    );

    let res = tokio::task::spawn_blocking(move || {
        silent(&mut Command::new("powershell.exe")
            .args(&["-NoProfile", "-NonInteractive", "-Command", &ps]))
            .output()
    }).await;

    let ok = match res {
        Ok(Ok(out)) => String::from_utf8_lossy(&out.stdout).contains("OK"),
        _ => false,
    };

    serde_json::json!({
        "ok": ok,
        "mode": if is_light { "light" } else { "dark" }
    })
}

pub async fn set_volume(level: Option<i64>, delta: Option<i64>) -> Value {
    let ps = if let Some(lvl) = level {
        let clamped = lvl.clamp(0, 100);
        let float_val = clamped as f64 / 100.0;
        format!(
            r#"$w = New-Object -ComObject WScript.Shell; Add-Type -TypeDefinition 'using System.Runtime.InteropServices; [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IAudioEndpointVolume {{ int SetMasterVolumeLevelScalar(float fLevel, System.Guid pguidEventContext); }} [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IMMDevice {{ int Activate(ref System.Guid id, int clsCtx, int pActivationParams, out IAudioEndpointVolume aev); }} [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IMMDeviceEnumerator {{ int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice); }} [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MMDeviceEnumeratorComObject {{}} public class DnVol {{ public static void Set(float v) {{ var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject()); IMMDevice dev; enumerator.GetDefaultAudioEndpoint(0, 1, out dev); var guid = typeof(IAudioEndpointVolume).GUID; IAudioEndpointVolume aev; dev.Activate(ref guid, 23, 0, out aev); aev.SetMasterVolumeLevelScalar(v, System.Guid.Empty); }} }}'; [DnVol]::Set({:?}); [Console]::Out.Write('OK')"#,
            float_val
        )
    } else if let Some(d) = delta {
        let count = (d.abs() / 2).max(1);
        let key = if d > 0 { "{VOLUME_UP}" } else { "{VOLUME_DOWN}" };
        let mut loop_str = String::new();
        for _ in 0..count {
            loop_str.push_str(&format!(r#"[System.Windows.Forms.SendKeys]::SendWait("{}"); "#, key));
        }
        format!(
            r#"Add-Type -AssemblyName System.Windows.Forms; {}; [Console]::Out.Write('OK')"#,
            loop_str
        )
    } else {
        return serde_json::json!({ "ok": false, "reason": "no level or delta" });
    };

    let res = tokio::task::spawn_blocking(move || {
        silent(&mut Command::new("powershell.exe")
            .args(&["-NoProfile", "-NonInteractive", "-Command", &ps]))
            .output()
    }).await;

    let ok = match res {
        Ok(Ok(out)) => String::from_utf8_lossy(&out.stdout).contains("OK"),
        _ => false,
    };

    serde_json::json!({ "ok": ok })
}

pub fn launch_app(id: &str, name: &str) -> bool {
    let target = if !id.is_empty() { id } else { name };
    if target.is_empty() {
        return false;
    }

    if std::path::Path::new(target).exists() {
        let _ = silent(&mut Command::new("explorer").arg(target)).spawn();
        return true;
    }

    let ps = format!(
        r#"$ErrorActionPreference='SilentlyContinue'; $id = '{}'; $name = '{}'; $procs = Get-Process | Where-Object {{ $_.MainWindowHandle -ne 0 -and (($name -and ($_.ProcessName -like "*$name*" -or $_.MainWindowTitle -like "*$name*")) -or ($id -and ($_.ProcessName -like "*$id*" -or $_.MainWindowTitle -like "*$id*"))) }}; if ($procs) {{ [W]::ShowWindow($procs[0].MainWindowHandle, 3) | Out-Null; [W]::SetForegroundWindow($procs[0].MainWindowHandle) | Out-Null; [Console]::Out.Write('ACT'); }} else if ($id) {{ Start-Process "explorer.exe" "shell:AppsFolder\$id"; }}"#,
        id.replace('\'', "''"), name.replace('\'', "''")
    );

    let _ = silent(&mut Command::new("powershell.exe")
        .args(&["-NoProfile", "-NonInteractive", "-Command", &ps]))
        .spawn();

    true
}

/// Executes sandboxed PowerShell command with blocklist of dangerous commands and 30s timeout
pub async fn run_sandboxed_shell(cmd: &str) -> Value {
    let trimmed = cmd.trim();
    if trimmed.is_empty() {
        return serde_json::json!({ "ok": false, "code": -1, "out": "perintah kosong" });
    }
    if trimmed.len() > 2000 {
        return serde_json::json!({ "ok": false, "code": -1, "out": "perintah terlalu panjang" });
    }

    let lower = trimmed.to_lowercase();
    let dangerous = [
        "format ", "mkfs", "diskpart", "rm -rf /", "bcdedit", "vssadmin delete",
        "cipher /w", "net user ", "reg delete hklm", "shutdown /s", "set-executionpolicy"
    ];

    if dangerous.iter().any(|&d| lower.contains(d)) {
        return serde_json::json!({ "ok": false, "code": -1, "out": "perintah ditolak oleh pengaman" });
    }

    let cmd_str = trimmed.to_string();
    let result = tokio::time::timeout(Duration::from_secs(30), tokio::task::spawn_blocking(move || {
        let output = silent(&mut Command::new("powershell.exe")
            .args(&["-NoProfile", "-NonInteractive", "-Command", &cmd_str]))
            .output();

        match output {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                let combined = if stderr.is_empty() { stdout } else { format!("{}\n{}", stdout, stderr) };
                let capped = if combined.len() > 60000 {
                    format!("{}\n…(dipotong)", &combined[..60000])
                } else {
                    combined
                };
                let code = out.status.code().unwrap_or(-1);
                (code == 0, code, capped.trim().to_string())
            }
            Err(e) => (false, -1, format!("gagal menjalankan powershell: {}", e)),
        }
    })).await;

    match result {
        Ok(Ok((ok, code, out))) => serde_json::json!({ "ok": ok, "code": code, "out": out }),
        Ok(Err(e)) => serde_json::json!({ "ok": false, "code": -1, "out": format!("task error: {}", e) }),
        Err(_) => serde_json::json!({ "ok": false, "code": -2, "out": "timeout (30s)" }),
    }
}

/// Search for files matching query in Desktop, Documents, Downloads
pub async fn search_files(query: &str, hint: Option<&str>) -> Value {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return serde_json::json!([]);
    }

    let user_profile = std::env::var("USERPROFILE").unwrap_or_else(|_| r"C:\Users\Default".to_string());
    let mut dirs = Vec::new();

    match hint.unwrap_or("") {
        "download" | "downloads" => dirs.push(format!(r"{}\Downloads", user_profile)),
        "documents" | "dokumen" => dirs.push(format!(r"{}\Documents", user_profile)),
        "desktop" => dirs.push(format!(r"{}\Desktop", user_profile)),
        _ => {
            dirs.push(format!(r"{}\Desktop", user_profile));
            dirs.push(format!(r"{}\Documents", user_profile));
            dirs.push(format!(r"{}\Downloads", user_profile));
        }
    }

    let hits = tokio::task::spawn_blocking(move || {
        let mut found = Vec::new();
        for dir in dirs {
            let path = std::path::Path::new(&dir);
            if !path.exists() {
                continue;
            }
            if let Ok(entries) = std::fs::read_dir(path) {
                for entry in entries.flatten() {
                    let file_name = entry.file_name().to_string_lossy().to_string();
                    if file_name.to_lowercase().contains(&q) {
                        found.push(serde_json::json!({
                            "name": file_name,
                            "path": entry.path().to_string_lossy().to_string()
                        }));
                        if found.len() >= 12 {
                            break;
                        }
                    }
                }
            }
            if found.len() >= 12 {
                break;
            }
        }
        found
    }).await.unwrap_or_default();

    serde_json::json!(hits)
}

use base64::prelude::*;

/// Returns metadata and base64 thumbnail for an absolute file path
pub fn describe_file(path_str: &str) -> Option<Value> {
    let path = std::path::Path::new(path_str);
    if !path.exists() {
        return None;
    }
    let is_dir = path.is_dir();
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or(path_str).to_string();

    let mut thumb: Option<String> = None;
    if !is_dir {
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        if ext == "png" || ext == "jpg" || ext == "jpeg" || ext == "bmp" || ext == "webp" {
            // Read file up to 8MB to create thumbnail data url
            if let Ok(metadata) = path.metadata() {
                if metadata.len() < 8 * 1024 * 1024 {
                    if let Ok(bytes) = std::fs::read(path) {
                        let mime = match ext.as_str() {
                            "jpg" | "jpeg" => "image/jpeg",
                            "webp" => "image/webp",
                            "bmp" => "image/bmp",
                            _ => "image/png",
                        };
                        let b64 = BASE64_STANDARD.encode(&bytes);
                        thumb = Some(format!("data:{};base64,{}", mime, b64));
                    }
                }
            }
        }
    }

    Some(serde_json::json!({
        "path": path_str,
        "name": name,
        "isDir": is_dir,
        "thumb": thumb,
        "icon": Value::Null
    }))
}

// ---------------------------------------------------------------------------
// Diagnostik sistem (read-only) — "kenapa laptop lambat?"
// ---------------------------------------------------------------------------

/// Batas keras diagnosa: script PowerShell tidak boleh menggantung, dan
/// stdout-nya dibatasi supaya tidak membanjiri bridge.
const DIAG_TIMEOUT_SECS: u64 = 15;
const DIAG_MAX_OUTPUT: usize = 20 * 1024;

/// Script PowerShell read-only. TIDAK ada input user yang di-embed di sini —
/// seluruh query bersifat tetap, jadi tidak ada permukaan command injection.
/// Outputnya satu objek JSON (ConvertTo-Json), diparse di Rust.
const DIAG_PS_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$cpu = $null
try {
  $c = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c -and $null -ne $c.LoadPercentage) { $cpu = [double]$c.LoadPercentage }
} catch {}

$ramTotalKb = $null
$ramFreeKb = $null
try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
  if ($os) {
    if ($null -ne $os.TotalVisibleMemorySize) { $ramTotalKb = [double]$os.TotalVisibleMemorySize }
    if ($null -ne $os.FreePhysicalMemory) { $ramFreeKb = [double]$os.FreePhysicalMemory }
  }
} catch {}

$diskFree = $null
$diskUsed = $null
try {
  $d = Get-PSDrive -Name C -ErrorAction SilentlyContinue
  if ($d) { $diskFree = [double]$d.Free; $diskUsed = [double]$d.Used }
  if ($null -eq $diskFree) {
    $ld = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" -ErrorAction SilentlyContinue
    if ($ld) { $diskFree = [double]$ld.FreeSpace; $diskUsed = [double]$ld.Size }
  }
} catch {}

$uptimeH = $null
try {
  $os2 = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
  if ($os2 -and $os2.LastBootUpTime) {
    $uptimeH = [math]::Round(((Get-Date) - $os2.LastBootUpTime).TotalHours, 2)
  }
} catch {}

$nCpu = 1
try {
  $n = [double](Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).NumberOfLogicalProcessors
  if ($n -gt 0) { $nCpu = $n }
} catch {}

$prev = @{}
try {
  Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
    if ($null -ne $_.CPU) { $prev[$_.Id] = [double]$_.CPU }
  }
} catch {}
Start-Sleep -Milliseconds 900

$procs = @()
try {
  $procs = @(Get-Process -ErrorAction SilentlyContinue | Sort-Object -Property WS -Descending | Select-Object -First 5 | ForEach-Object {
    $p = $_
    $before = 0.0
    if ($prev.ContainsKey($p.Id)) { $before = [double]$prev[$p.Id] }
    $after = 0.0
    if ($null -ne $p.CPU) { $after = [double]$p.CPU }
    $delta = $after - $before
    if ($delta -lt 0) { $delta = 0 }
    $mem = 0.0
    if ($null -ne $p.WS) { $mem = [double]$p.WS }
    [PSCustomObject]@{
      name = [string]$p.Name
      mem_mb = [math]::Round(($mem / 1MB), 1)
      cpu = [math]::Round((($delta / 0.9) * 100.0 / $nCpu), 1)
    }
  })
} catch {}

[PSCustomObject]@{
  cpu_pct = $cpu
  ram_total_kb = $ramTotalKb
  ram_free_kb = $ramFreeKb
  disk_c_free = $diskFree
  disk_c_used = $diskUsed
  uptime_h = $uptimeH
  top_processes = $procs
} | ConvertTo-Json -Compress -Depth 4
"#;

/// Jalankan script PowerShell, bunuh prosesnya kalau melewati deadline,
/// lalu kembalikan stdout yang sudah dipotong 20 KB.
fn run_ps_script(script: &str, deadline: Duration) -> Result<String, String> {
    let mut child = silent(&mut Command::new("powershell.exe"))
        .args(&["-NoProfile", "-NonInteractive", "-Command", script])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("gagal menjalankan PowerShell: {}", e))?;

    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("PowerShell timeout".to_string());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("gagal menunggu PowerShell: {}", e)),
        }
    }

    let out = child
        .wait_with_output()
        .map_err(|e| format!("gagal membaca output PowerShell: {}", e))?;
    let s = String::from_utf8_lossy(&out.stdout).to_string();
    if s.len() > DIAG_MAX_OUTPUT {
        Ok(String::from_utf8_lossy(&s.as_bytes()[..DIAG_MAX_OUTPUT]).to_string())
    } else {
        Ok(s)
    }
}

fn jf(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| x.as_f64()).filter(|n| n.is_finite())
}

fn round1(n: f64) -> f64 {
    (n * 10.0).round() / 10.0
}

/// Diagnostik read-only: metrik CPU / RAM / disk / uptime + 5 proses
/// teratas by memory. Untuk menjawab "kenapa laptop lambat?" tanpa mengubah
/// apa pun di sistem.
pub async fn diagnose_system() -> Value {
    let res = tokio::time::timeout(
        Duration::from_secs(DIAG_TIMEOUT_SECS),
        tokio::task::spawn_blocking({
            let script = DIAG_PS_SCRIPT.to_string();
            move || {
                run_ps_script(
                    &script,
                    Duration::from_secs(DIAG_TIMEOUT_SECS.saturating_sub(1)),
                )
            }
        }),
    )
    .await;

    let raw = match res {
        Ok(Ok(Ok(s))) => s,
        Ok(Ok(Err(e))) => {
            return serde_json::json!({ "ok": false, "reason": e });
        }
        Ok(Err(e)) => {
            return serde_json::json!({
                "ok": false,
                "reason": format!("gagal menjalankan diagnostik: {}", e)
            });
        }
        Err(_) => {
            return serde_json::json!({
                "ok": false,
                "reason": "diagnostik timeout (15 detik)"
            });
        }
    };

    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return serde_json::json!({
            "ok": false,
            "reason": "PowerShell tidak mengembalikan output"
        });
    }

    let data: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(e) => {
            return serde_json::json!({
                "ok": false,
                "reason": format!("output PowerShell bukan JSON yang valid: {}", e)
            });
        }
    };

    let mut notes: Vec<String> = Vec::new();

    // --- CPU ---
    let cpu_pct = jf(&data, "cpu_pct").map(round1);
    if cpu_pct.is_none() {
        notes.push("Gagal membaca beban CPU".to_string());
    }

    // --- RAM (KB -> GB) ---
    let ram_total_gb = jf(&data, "ram_total_kb").map(|kb| round1(kb / 1024.0 / 1024.0));
    let ram_used_gb = match (jf(&data, "ram_total_kb"), jf(&data, "ram_free_kb")) {
        (Some(total), Some(free)) => {
            let used = (total - free).max(0.0);
            Some(round1(used / 1024.0 / 1024.0))
        }
        _ => None,
    };
    if ram_total_gb.is_none() || ram_used_gb.is_none() {
        notes.push("Gagal membaca penggunaan RAM".to_string());
    }

    // --- Disk C: (byte -> GB) ---
    let disk_c_free_gb = jf(&data, "disk_c_free").map(|b| round1(b / 1024.0 / 1024.0 / 1024.0));
    let disk_c_total_gb = match (jf(&data, "disk_c_used"), jf(&data, "disk_c_free")) {
        (Some(used), Some(free)) => Some(round1((used + free) / 1024.0 / 1024.0 / 1024.0)),
        _ => None,
    };
    if disk_c_free_gb.is_none() || disk_c_total_gb.is_none() {
        notes.push("Gagal membaca kapasitas disk C:".to_string());
    }

    // --- Uptime ---
    let uptime_h = jf(&data, "uptime_h").map(round1);
    if uptime_h.is_none() {
        notes.push("Gagal membaca uptime sistem".to_string());
    }

    // --- Top proses ---
    let top_processes: Value = match data.get("top_processes") {
        Some(Value::Array(arr)) => Value::Array(
            arr.iter()
                .map(|p| {
                    serde_json::json!({
                        "name": p.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                        "mem_mb": round1(jf(p, "mem_mb").unwrap_or(0.0)),
                        "cpu": round1(jf(p, "cpu").unwrap_or(0.0)),
                    })
                })
                .collect(),
        ),
        _ => {
            notes.push("Gagal membaca daftar proses teratas".to_string());
            Value::Null
        }
    };

    // --- Analisis ringan ---
    if let (Some(used), Some(total)) = (ram_used_gb, ram_total_gb) {
        if total > 0.0 && (used / total) * 100.0 > 85.0 {
            notes.push("RAM hampir penuh".to_string());
        }
    }
    if let Some(c) = cpu_pct {
        if c > 80.0 {
            notes.push("CPU tinggi".to_string());
        }
    }
    if let Some(free) = disk_c_free_gb {
        if free < 15.0 {
            notes.push("disk C: hampir penuh".to_string());
        }
    }

    serde_json::json!({
        "ok": true,
        "cpu_pct": cpu_pct,
        "ram_used_gb": ram_used_gb,
        "ram_total_gb": ram_total_gb,
        "disk_c_free_gb": disk_c_free_gb,
        "disk_c_total_gb": disk_c_total_gb,
        "uptime_h": uptime_h,
        "top_processes": top_processes,
        "notes": notes
    })
}

const RUN_KEY_PATH: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE_NAME: &str = "DeskNotch";
/// Reads the current autostart entry. Returns the stored command line, if any.
#[cfg(windows)]
pub fn start_on_boot_entry() -> Option<String> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE,
        RRF_RT_REG_SZ,
    };

    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        let subkey: Vec<u16> = RUN_KEY_PATH
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let name: Vec<u16> = RUN_VALUE_NAME
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        if RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_QUERY_VALUE, &mut hkey) != 0 {
            return None;
        }

        let mut buf: Vec<u16> = vec![0; 1024];
        let mut len: u32 = buf.len() as u32;
        let status = RegGetValueW(
            hkey,
            std::ptr::null(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr().cast(),
            &mut len,
        );
        RegCloseKey(hkey);

        if status != 0 {
            return None;
        }
        let text = String::from_utf16_lossy(&buf[..len.saturating_sub(1) as usize]);
        if text.trim().is_empty() {
            None
        } else {
            Some(text)
        }
    }
}

#[cfg(not(windows))]
pub fn start_on_boot_entry() -> Option<String> {
    None
}

/// True when the running exe lives inside a cargo build directory. Dev
/// builds must not register an autostart entry: the path disappears with
/// the next `cargo clean`, which leaves Windows pointing at a dead file.
#[cfg(windows)]
fn is_dev_build_exe(exe: &std::path::Path) -> bool {
    exe.components().any(|c| c.as_os_str() == "target")
}

/// Real autostart toggle: writes/removes HKCU\...\Run\DeskNotch pointing at
/// the running exe (quoted — the install path contains spaces).
/// Returns Ok(true) when the registry now reflects the requested state.
#[cfg(windows)]
pub fn set_start_on_boot(enable: bool) -> Result<bool, String> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_QUERY_VALUE, KEY_SET_VALUE, REG_SZ,
    };

    const ERROR_FILE_NOT_FOUND: u32 = 2;

    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        let subkey: Vec<u16> = RUN_KEY_PATH
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let name: Vec<u16> = RUN_VALUE_NAME
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        let status = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            KEY_SET_VALUE | KEY_QUERY_VALUE,
            &mut hkey,
        );
        if status != 0 {
            return Err(format!("buka registry Run gagal (kode {})", status));
        }

        let result = if enable {
            let exe = std::env::current_exe()
                .map_err(|e| format!("path exe tidak tersedia: {}", e))?;
            if is_dev_build_exe(&exe) {
                eprintln!(
                    "[DeskNotch] autostart dilewati: exe dev build {}",
                    exe.display()
                );
                Ok(false)
            } else {
            let cmdline = format!("\"{}\"", exe.display());
            let val: Vec<u16> = cmdline.encode_utf16().chain(std::iter::once(0)).collect();
            let status = RegSetValueExW(
                hkey,
                name.as_ptr(),
                0,
                REG_SZ,
                val.as_ptr().cast(),
                (val.len() as u32) * 2,
            );
            if status == 0 {
                Ok(true)
            } else {
                Err(format!("tulis nilai Run gagal (kode {})", status))
            }
            }
        } else {
            let status = RegDeleteValueW(hkey, name.as_ptr());
            // Removing an absent entry still satisfies "not on boot".
            if status == 0 || status == ERROR_FILE_NOT_FOUND {
                Ok(true)
            } else {
                Err(format!("hapus nilai Run gagal (kode {})", status))
            }
        };

        RegCloseKey(hkey);
        result
    }
}

#[cfg(not(windows))]
pub fn set_start_on_boot(_enable: bool) -> Result<bool, String> {
    Err("autostart hanya didukung di Windows".into())
}
