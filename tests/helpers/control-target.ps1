# 원격 조종 시험용 "표적 창" (이슈 #23). 이 창 하나만 클릭·입력 대상으로 쓴다 — 시험이 이 PC 의 다른 창을 건드리지 않게.
# 일어난 일(클릭·우클릭·더블클릭·휠·글자)을 $out 파일에 한 줄씩 기록하고, 창 좌표(화면 픽셀)를 $out.json 에 적는다.
param([string]$out)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type 'using System;using System.Runtime.InteropServices;public class D{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();}'
[void][D]::SetProcessDPIAware()
[System.Windows.Forms.Application]::EnableVisualStyles()
Set-Content -Path $out -Value '' -Encoding ASCII
function Log($s) { Add-Content -Path $out -Value $s -Encoding ASCII }

$f = New-Object System.Windows.Forms.Form
$f.Text = 'tt-control-target'; $f.TopMost = $true; $f.StartPosition = 'Manual'
$f.Location = New-Object System.Drawing.Point(300, 300); $f.ClientSize = New-Object System.Drawing.Size(420, 220)
$btn = New-Object System.Windows.Forms.Button
$btn.Text = 'click me'; $btn.Location = New-Object System.Drawing.Point(20, 20); $btn.Size = New-Object System.Drawing.Size(160, 60)
$tb = New-Object System.Windows.Forms.TextBox
$tb.Location = New-Object System.Drawing.Point(20, 110); $tb.Size = New-Object System.Drawing.Size(360, 30)
$f.Controls.Add($btn); $f.Controls.Add($tb)

$btn.add_Click({ Log 'click' })
$btn.add_MouseUp({ param($s, $e) if ($e.Button -eq 'Right') { Log 'right' } })
$btn.add_MouseDoubleClick({ Log 'double' })
$btn.add_MouseWheel({ param($s, $e) Log ('wheel:' + $e.Delta) })
$f.add_MouseWheel({ param($s, $e) Log ('wheel:' + $e.Delta) })
$tb.add_MouseWheel({ param($s, $e) Log ('wheel:' + $e.Delta) })
$tb.add_TextChanged({ Log ('text:' + $tb.Text) })

$f.add_Shown({
  $b = $btn.PointToScreen((New-Object System.Drawing.Point(80, 30)))
  $t = $tb.PointToScreen((New-Object System.Drawing.Point(180, 15)))
  $s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  (@{ btnX = $b.X; btnY = $b.Y; tbX = $t.X; tbY = $t.Y; sw = $s.Width; sh = $s.Height } | ConvertTo-Json -Compress) | Set-Content -Path ($out + '.json') -Encoding ASCII
})
[void]$f.ShowDialog()
