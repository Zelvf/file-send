$recordPath = Join-Path $PSScriptRoot 'received\server.8787.pid.json'
if (-not (Test-Path -LiteralPath $recordPath)) {
  $recordPath = Join-Path $PSScriptRoot 'received\server.pid.json'
}
if (-not (Test-Path -LiteralPath $recordPath)) {
  Write-Host 'File Send is not running, or it was started before stop.cmd was added.'
  exit 0
}

try {
  $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
  $fileSendProcessId = [int]$record.pid
  $fileSendPort = [int]$record.port
  $expectedScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'server.js'))
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $fileSendProcessId" -ErrorAction Stop
  $listener = Get-NetTCPConnection -LocalPort $fileSendPort -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -eq $fileSendProcessId }
  if ($record.script -ne $expectedScript -or
      -not $processInfo -or
      $processInfo.Name -ne 'node.exe' -or
      $processInfo.CommandLine -notmatch 'server\.js' -or
      -not $listener) {
    Write-Host 'The saved process is not the running File Send server. Nothing was stopped.'
    exit 1
  }
  Stop-Process -Id $fileSendProcessId -ErrorAction Stop
  Remove-Item -LiteralPath $recordPath -Force -ErrorAction SilentlyContinue
  Write-Host 'File Send stopped. Port' $fileSendPort 'is available again.'
} catch {
  Write-Host 'Could not stop File Send:' $_.Exception.Message
  exit 1
}
