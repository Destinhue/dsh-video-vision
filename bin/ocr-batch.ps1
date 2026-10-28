param(
  [Parameter(Mandatory=$true)][string]$Dir,
  [Parameter(Mandatory=$true)][string]$Out,
  [string]$Lang = 'zh-Hans-CN'
)

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and
  $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
  $asTask = $asTaskGeneric.MakeGenericMethod($type)
  $net = $asTask.Invoke($null, @($op))
  $net.Wait(-1) | Out-Null
  $net.Result
}

[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

$language = New-Object Windows.Globalization.Language $Lang
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
if (-not $engine) { Write-Output "no OCR engine for $Lang"; exit 1 }

$sb = New-Object System.Text.StringBuilder
$files = Get-ChildItem -Path $Dir -Filter *.png | Sort-Object Name
foreach ($f in $files) {
  $null = $sb.AppendLine("== " + [System.IO.Path]::GetFileNameWithoutExtension($f.Name) + " ==")
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($f.FullName)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    foreach ($line in $result.Lines) { $null = $sb.AppendLine($line.Text) }
    $stream.Dispose()
  } catch {
    $null = $sb.AppendLine("[ocr-error] " + $_.Exception.Message)
  }
}
[System.IO.File]::WriteAllText($Out, $sb.ToString(), (New-Object System.Text.UTF8Encoding $false))
Write-Output ("ocr " + $files.Count + " files -> " + $Out)
