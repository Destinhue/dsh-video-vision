# sapi_tts.ps1 -- render one sentence to a 44.1kHz 16-bit mono WAV with Windows SAPI.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File sapi_tts.ps1 -Text "..." -Out "x.wav" [-Voice "Microsoft Zira Desktop"] [-Rate 0]
param(
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Voice = "Microsoft Zira Desktop",
    [int]$Rate = 0,
    [int]$Volume = 100
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
    44100,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono
)

$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $s.SelectVoice($Voice)
} catch {
    Write-Warning "voice '$Voice' unavailable, using default: $($s.Voice.Name)"
}
$s.Rate = $Rate
$s.Volume = $Volume
$s.SetOutputToWaveFile($Out, $fmt)

# Slow down slightly so the ASR test sentences are comfortably intelligible.
$s.Speak($Text)
$s.SetOutputToNull()
$s.Dispose()

if (-not (Test-Path $Out)) { throw "SAPI produced no output at $Out" }
$len = (Get-Item $Out).Length
Write-Output "WROTE $Out ($len bytes)"
