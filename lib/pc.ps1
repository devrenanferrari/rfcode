# rfcode - controle do PC no Windows (tela, mouse, teclado, janelas, UI Automation, OCR).
# Chamado por lib/pc.js:  powershell -File pc.ps1 -Action <acao> -ArgsB64 <json em base64>
# Mantenha este arquivo somente ASCII (PowerShell 5.1 le .ps1 sem BOM como ANSI).
param([string]$Action, [string]$ArgsB64 = '')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$a = @{}
if ($ArgsB64) {
  $o = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgsB64)))
  foreach ($p in $o.PSObject.Properties) { $a[$p.Name] = $p.Value }
}

Add-Type -Namespace RF -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, UIntPtr extra);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr extra);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
'@
[RF.Native]::SetProcessDPIAware() | Out-Null   # coordenadas em pixels fisicos, iguais as do OCR
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes

$UIA = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$True_ = [System.Windows.Automation.Condition]::TrueCondition

function Num($v, $def) { if ($null -eq $v -or $v -eq '') { return $def } return [int]$v }

function Get-TopWindows {
  $UIA::RootElement.FindAll($Scope::Children, $True_) | Where-Object {
    try { $_.Current.Name -and -not $_.Current.IsOffscreen } catch { $false }
  }
}

function Find-Window([string]$title) {
  if (-not $title) { throw 'Informe o titulo da janela (ou parte dele).' }
  $wins = @(Get-TopWindows)
  $w = $wins | Where-Object { $_.Current.Name -eq $title } | Select-Object -First 1
  if (-not $w) { $w = $wins | Where-Object { $_.Current.Name -like "*$title*" } | Select-Object -First 1 }
  if (-not $w) {
    $w = $wins | Where-Object {
      try { (Get-Process -Id $_.Current.ProcessId -ErrorAction Stop).ProcessName -like "*$title*" } catch { $false }
    } | Select-Object -First 1
  }
  if (-not $w) { throw "Janela nao encontrada: '$title'. Use a acao list de windows para ver os titulos." }
  return $w
}

function Focus-Window($w) {
  $h = [IntPtr]$w.Current.NativeWindowHandle
  if ([RF.Native]::IsIconic($h)) { [RF.Native]::ShowWindow($h, 9) | Out-Null }
  # truque do ALT para o Windows permitir trocar a janela em primeiro plano
  [RF.Native]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [RF.Native]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [RF.Native]::SetForegroundWindow($h) | Out-Null
  try { $w.SetFocus() } catch {}
  Start-Sleep -Milliseconds 250
}

function Rect-Of($el) {
  $r = $el.Current.BoundingRectangle
  return @{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
}

# Captura a tela inteira, uma janela ou uma regiao. Retorna @{ bmp; x; y }
function Capture {
  if ($a['window']) {
    $w = Find-Window $a['window']
    Focus-Window $w
    $r = Rect-Of $w
  } elseif ($a['region']) {
    $g = @($a['region'])
    $r = @{ x = [int]$g[0]; y = [int]$g[1]; w = [int]$g[2]; h = [int]$g[3] }
  } else {
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $r = @{ x = $vs.Left; y = $vs.Top; w = $vs.Width; h = $vs.Height }
  }
  if ($r.w -le 0 -or $r.h -le 0) { throw 'Area de captura vazia (janela minimizada?).' }
  $bmp = New-Object System.Drawing.Bitmap $r.w, $r.h
  $gr = [System.Drawing.Graphics]::FromImage($bmp)
  $gr.CopyFromScreen($r.x, $r.y, 0, 0, $bmp.Size)
  $gr.Dispose()
  return @{ bmp = $bmp; x = $r.x; y = $r.y }
}

function Ocr-File([string]$path) {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
  function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
  [void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $sb = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) { throw 'OCR do Windows indisponivel (instale um pacote de idioma com OCR).' }
  $res = Await ($engine.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
  $stream.Dispose()
  return $res
}

function Format-Ocr($res, [int]$ox, [int]$oy, [string]$filter) {
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($line in $res.Lines) {
    $words = @($line.Words)
    if ($words.Count -eq 0) { continue }
    $x1 = ($words | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
    $y1 = ($words | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
    $x2 = ($words | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum
    $y2 = ($words | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum
    if ($filter -and $line.Text -notlike "*$filter*") { continue }
    $cx = [int]($ox + ($x1 + $x2) / 2); $cy = [int]($oy + ($y1 + $y2) / 2)
    $out.Add(('"{0}" @ ({1},{2})' -f $line.Text, $cx, $cy))
    if ($filter) {
      foreach ($wd in $words) {
        if ($wd.Text -like "*$filter*") {
          $b = $wd.BoundingRect
          $out.Add(('    palavra "{0}" @ ({1},{2})' -f $wd.Text, [int]($ox + $b.X + $b.Width / 2), [int]($oy + $b.Y + $b.Height / 2)))
        }
      }
    }
  }
  if ($out.Count -eq 0) { return '(nenhum texto encontrado)' }
  return ($out -join "`n")
}

function Mouse-Click([int]$x, [int]$y, [string]$button, [int]$times) {
  [RF.Native]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 60
  switch ($button) {
    'right' { $d = 0x08; $u = 0x10 }
    'middle' { $d = 0x20; $u = 0x40 }
    default { $d = 0x02; $u = 0x04 }
  }
  for ($i = 0; $i -lt $times; $i++) {
    [RF.Native]::mouse_event($d, 0, 0, 0, [UIntPtr]::Zero)
    [RF.Native]::mouse_event($u, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 70
  }
}

$VK = @{
  ctrl = 0x11; control = 0x11; shift = 0x10; alt = 0x12; win = 0x5B; windows = 0x5B; cmd = 0x5B
  enter = 0x0D; return = 0x0D; esc = 0x1B; escape = 0x1B; tab = 0x09; backspace = 0x08; space = 0x20
  delete = 0x2E; del = 0x2E; insert = 0x2D; home = 0x24; end = 0x23; pageup = 0x21; pagedown = 0x22
  up = 0x26; down = 0x28; left = 0x25; right = 0x27; printscreen = 0x2C; capslock = 0x14; menu = 0x5D
  volumeup = 0xAF; volumedown = 0xAE; volumemute = 0xAD; playpause = 0xB3
}
$EXT = @(0x2E, 0x2D, 0x24, 0x23, 0x21, 0x22, 0x26, 0x28, 0x25, 0x27, 0x5B, 0x5D)
for ($i = 1; $i -le 12; $i++) { $VK["f$i"] = 0x6F + $i }

function Key-Code([string]$k) {
  $k = $k.ToLower()
  if ($VK.ContainsKey($k)) { return [byte]$VK[$k] }
  if ($k.Length -eq 1 -and $k -match '[a-z0-9]') { return [byte][char]$k.ToUpper() }
  throw "Tecla desconhecida: '$k'"
}
function Key-Event([byte]$vk, [bool]$up) {
  $f = 0
  if ($EXT -contains $vk) { $f = $f -bor 1 }
  if ($up) { $f = $f -bor 2 }
  [RF.Native]::keybd_event($vk, 0, $f, [UIntPtr]::Zero)
}
function Press-Combo([string]$combo) {
  $codes = @($combo.Split('+') | Where-Object { $_ } | ForEach-Object { Key-Code $_.Trim() })
  foreach ($c in $codes) { Key-Event $c $false; Start-Sleep -Milliseconds 20 }
  [array]::Reverse($codes)
  foreach ($c in $codes) { Key-Event $c $true; Start-Sleep -Milliseconds 20 }
}

function Escape-SendKeys([string]$t) {
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $t.ToCharArray()) {
    if ('+^%~(){}[]'.Contains([string]$ch)) { [void]$sb.Append('{' + $ch + '}') }
    elseif ($ch -eq "`n") { [void]$sb.Append('{ENTER}') }
    elseif ($ch -eq "`r") { }
    elseif ($ch -eq "`t") { [void]$sb.Append('{TAB}') }
    else { [void]$sb.Append($ch) }
  }
  return $sb.ToString()
}

$INTERESTING = @('Button', 'Edit', 'MenuItem', 'ListItem', 'TabItem', 'Hyperlink', 'CheckBox', 'ComboBox',
  'RadioButton', 'TreeItem', 'Document', 'SplitButton', 'MenuBar', 'Menu', 'DataItem', 'Slider', 'Spinner', 'Text')

function Ctl-Type($el) { return $el.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '' }

function Find-Element($w, [string]$name, [string]$type) {
  $all = $w.FindAll($Scope::Descendants, $True_)
  $cands = @($all | Where-Object {
      try { -not $_.Current.IsOffscreen -and (-not $type -or (Ctl-Type $_) -eq $type) } catch { $false }
    })
  $e = $cands | Where-Object { $_.Current.Name -eq $name -or $_.Current.AutomationId -eq $name } | Select-Object -First 1
  if (-not $e) { $e = $cands | Where-Object { $_.Current.Name -like "*$name*" } | Select-Object -First 1 }
  if (-not $e) { throw "Elemento nao encontrado: '$name'. Use ui_elements para ver os nomes." }
  return $e
}

function Center($el) {
  $r = $el.Current.BoundingRectangle
  return @([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
}

switch ($Action) {
  'windows_list' {
    $fg = [RF.Native]::GetForegroundWindow()
    $lines = foreach ($w in Get-TopWindows) {
      $c = $w.Current
      $pn = try { (Get-Process -Id $c.ProcessId -ErrorAction Stop).ProcessName } catch { '?' }
      $r = Rect-Of $w
      $mark = if ([IntPtr]$c.NativeWindowHandle -eq $fg) { '* ' } else { '  ' }
      '{0}"{1}"  [{2}]  pos=({3},{4}) tam={5}x{6}' -f $mark, $c.Name, $pn, $r.x, $r.y, $r.w, $r.h
    }
    $scr = [System.Windows.Forms.SystemInformation]::VirtualScreen
    "Tela: {0}x{1} (origem {2},{3}). * = janela em primeiro plano`n" -f $scr.Width, $scr.Height, $scr.Left, $scr.Top
    $lines -join "`n"
  }
  'window_action' {
    $w = Find-Window $a['title']
    $h = [IntPtr]$w.Current.NativeWindowHandle
    switch ($a['action']) {
      'focus' { Focus-Window $w }
      'minimize' { [RF.Native]::ShowWindow($h, 6) | Out-Null }
      'maximize' { [RF.Native]::ShowWindow($h, 3) | Out-Null; Focus-Window $w }
      'restore' { [RF.Native]::ShowWindow($h, 9) | Out-Null; Focus-Window $w }
      'close' {
        try { $w.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close() }
        catch { Focus-Window $w; Press-Combo 'alt+f4' }
      }
      default { throw "Acao de janela invalida: $($a['action']) (use focus, minimize, maximize, restore, close)" }
    }
    "OK: $($a['action']) em ""$($w.Current.Name)"""
  }
  'screenshot' {
    $cap = Capture
    $path = $a['path']
    if (-not $path) { $path = Join-Path $env:TEMP ('rfcode-shot-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.png') }
    $cap.bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    "Captura salva em $path ({0}x{1}, origem na tela {2},{3})" -f $cap.bmp.Width, $cap.bmp.Height, $cap.x, $cap.y
    $cap.bmp.Dispose()
  }
  'screen_text' {
    if ($a['image']) {
      $res = Ocr-File ((Resolve-Path $a['image']).Path)
      Format-Ocr $res 0 0 $a['filter']
    } else {
      $cap = Capture
      $tmp = Join-Path $env:TEMP ('rfcode-ocr-' + [guid]::NewGuid().ToString('N') + '.png')
      $cap.bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
      $cap.bmp.Dispose()
      try { $res = Ocr-File $tmp; Format-Ocr $res $cap.x $cap.y $a['filter'] } finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
    }
  }
  'ui_elements' {
    $w = Find-Window $a['window']
    $all = $w.FindAll($Scope::Descendants, $True_)
    $out = New-Object System.Collections.Generic.List[string]
    $out.Add(('Janela "{0}"' -f $w.Current.Name))
    foreach ($e in $all) {
      if ($out.Count -gt (Num $a['limit'] 150)) { $out.Add('... (limite atingido; use filter)'); break }
      try {
        $c = $e.Current
        if ($c.IsOffscreen) { continue }
        $t = Ctl-Type $e
        if ($INTERESTING -notcontains $t) { continue }
        if (-not $c.Name -and $t -ne 'Edit' -and $t -ne 'Document') { continue }
        if ($a['filter'] -and $c.Name -notlike "*$($a['filter'])*" -and $t -notlike "*$($a['filter'])*") { continue }
        $r = $c.BoundingRectangle
        if ($r.Width -le 0 -or $r.Height -le 0) { continue }
        $val = ''
        try { $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); if ($vp.Current.Value) { $val = ' valor="' + ($vp.Current.Value.Substring(0, [Math]::Min(80, $vp.Current.Value.Length))) + '"' } } catch {}
        $id = if ($c.AutomationId) { " id=$($c.AutomationId)" } else { '' }
        $dis = if (-not $c.IsEnabled) { ' (desabilitado)' } else { '' }
        $out.Add(('[{0}] "{1}"{2}{3}{4} @ ({5},{6})' -f $t, $c.Name, $id, $val, $dis, [int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2)))
      } catch { continue }
    }
    if ($out.Count -eq 1) { $out.Add('(nenhum elemento acessivel encontrado; use screen_text com window para localizar pelo texto via OCR e clique com mouse)') }
    $out -join "`n"
  }
  'ui_click' {
    $w = Find-Window $a['window']
    Focus-Window $w
    $e = Find-Element $w $a['name'] $a['control_type']
    $done = $false
    if (-not $a['mouse']) {
      foreach ($pat in @([System.Windows.Automation.InvokePattern]::Pattern, [System.Windows.Automation.TogglePattern]::Pattern,
          [System.Windows.Automation.SelectionItemPattern]::Pattern, [System.Windows.Automation.ExpandCollapsePattern]::Pattern)) {
        try {
          $p = $e.GetCurrentPattern($pat)
          if ($p -is [System.Windows.Automation.InvokePattern]) { $p.Invoke() }
          elseif ($p -is [System.Windows.Automation.TogglePattern]) { $p.Toggle() }
          elseif ($p -is [System.Windows.Automation.SelectionItemPattern]) { $p.Select() }
          else { $p.Expand() }
          $done = $true; break
        } catch {}
      }
    }
    if (-not $done) { $c = Center $e; Mouse-Click $c[0] $c[1] 'left' 1 }
    'OK: clicou em [{0}] "{1}"' -f (Ctl-Type $e), $e.Current.Name
  }
  'ui_set_text' {
    $w = Find-Window $a['window']
    Focus-Window $w
    $e = Find-Element $w $a['name'] $a['control_type']
    try {
      $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue([string]$a['text'])
    } catch {
      $c = Center $e; Mouse-Click $c[0] $c[1] 'left' 1
      Press-Combo 'ctrl+a'
      [System.Windows.Forms.SendKeys]::SendWait((Escape-SendKeys ([string]$a['text'])))
    }
    'OK: texto definido em "{0}"' -f $e.Current.Name
  }
  'mouse' {
    $x = Num $a['x'] ([System.Windows.Forms.Cursor]::Position.X)
    $y = Num $a['y'] ([System.Windows.Forms.Cursor]::Position.Y)
    switch ($a['action']) {
      'position' { $p = [System.Windows.Forms.Cursor]::Position; "Cursor em ($($p.X),$($p.Y))"; break }
      'move' { [RF.Native]::SetCursorPos($x, $y) | Out-Null }
      'click' { Mouse-Click $x $y 'left' 1 }
      'double_click' { Mouse-Click $x $y 'left' 2 }
      'right_click' { Mouse-Click $x $y 'right' 1 }
      'middle_click' { Mouse-Click $x $y 'middle' 1 }
      'scroll' {
        [RF.Native]::SetCursorPos($x, $y) | Out-Null
        [RF.Native]::mouse_event(0x0800, 0, 0, 120 * (Num $a['amount'] -3), [UIntPtr]::Zero)
      }
      'drag' {
        [RF.Native]::SetCursorPos($x, $y) | Out-Null
        [RF.Native]::mouse_event(0x02, 0, 0, 0, [UIntPtr]::Zero)
        $tx = Num $a['to_x'] $x; $ty = Num $a['to_y'] $y
        for ($i = 1; $i -le 10; $i++) {
          [RF.Native]::SetCursorPos([int]($x + ($tx - $x) * $i / 10), [int]($y + ($ty - $y) * $i / 10)) | Out-Null
          Start-Sleep -Milliseconds 30
        }
        [RF.Native]::mouse_event(0x04, 0, 0, 0, [UIntPtr]::Zero)
      }
      default { throw "Acao de mouse invalida: $($a['action'])" }
    }
    if ($a['action'] -ne 'position') { "OK: $($a['action']) em ($x,$y)" }
  }
  'keyboard' {
    if ($a['window']) { Focus-Window (Find-Window $a['window']) }
    if ($a['text']) { [System.Windows.Forms.SendKeys]::SendWait((Escape-SendKeys ([string]$a['text']))) }
    if ($a['keys']) { foreach ($combo in ([string]$a['keys'] -split '\s+' | Where-Object { $_ })) { Press-Combo $combo; Start-Sleep -Milliseconds 60 } }
    'OK'
  }
  'open' {
    $target = [string]$a['target']
    # Process.Start com ShellExecute: abre programas, arquivos, pastas e URLs, e nao quebra com PATH/Path duplicado
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $target
    if ($a['args']) { $psi.Arguments = [string]$a['args'] }
    $psi.UseShellExecute = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    Start-Sleep -Milliseconds (Num $a['wait_ms'] 1500)
    if ($p) { "Aberto: $target (pid $($p.Id))" } else { "Aberto: $target" }
  }
  'clipboard' {
    if ($a['action'] -eq 'set') { Set-Clipboard -Value ([string]$a['text']); 'OK: copiado para a area de transferencia' }
    else { $t = Get-Clipboard -Raw; if ($t) { $t } else { '(area de transferencia vazia ou sem texto)' } }
  }
  default { throw "Acao desconhecida: $Action" }
}
