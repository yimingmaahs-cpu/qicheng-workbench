param([int]$Port=4320,[switch]$NoBrowser)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Set-Location -LiteralPath $PSScriptRoot
$taskLock=New-Object Threading.Mutex($false,('Local\QichengWorkbench-'+$Port))
$taskOwned=$false
try {
  if($Port -lt 1024 -or $Port -gt 65535){throw '端口无效。'}
  $taskOwned=$taskLock.WaitOne(0)
  if(-not $taskOwned){Write-Host '工作台正在启动，请稍等片刻后再次双击。';exit 0}
  Write-Host '[1/3] 正在检查运行环境…'
  $taskPortable=Test-Path -LiteralPath (Join-Path $PSScriptRoot 'portable.json')
  if($taskPortable -and (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64')){throw '此包适用于 Windows 10/11 的 Intel / AMD 64 位电脑。'}
  $taskNode=Join-Path $PSScriptRoot 'runtime\node\node.exe'
  if(-not (Test-Path -LiteralPath $taskNode)){
    if($taskPortable){throw '运行环境不完整。请先把整个压缩包解压到一个文件夹，不要在压缩包内直接启动。'}
    $taskCommand=Get-Command node -ErrorAction SilentlyContinue
    if(-not $taskCommand){throw '源码版需要 Node.js 24。普通用户请使用 Windows 免安装包。'}
    $taskNode=$taskCommand.Source
  }
  if ([int]((& $taskNode --version).TrimStart('v').Split('.')[0]) -lt 24) { throw '此版本需要 Node.js 24 或更新版本。请使用完整免安装包。' }
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\tabulator-tables\package.json'))) {
    if($taskPortable){throw '程序文件不完整，请重新完整解压免安装包。'}
    & npm.cmd ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请检查网络后重试。' }
  }
  $taskVersion = (Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot 'package.json') | ConvertFrom-Json).version
  $taskDefaultData=if($taskPortable){Join-Path (Split-Path $PSScriptRoot) '我的数据'}else{Join-Path $PSScriptRoot 'local-data'}
  $taskData=[IO.Path]::GetFullPath($(if($env:WORKBENCH_DATA_DIR){$env:WORKBENCH_DATA_DIR}else{$taskDefaultData}))
  $taskHash=[Security.Cryptography.SHA256]::Create()
  try{$taskIdentity=([BitConverter]::ToString($taskHash.ComputeHash([Text.Encoding]::UTF8.GetBytes(($PSScriptRoot+"`n"+$taskData).ToLowerInvariant())))).Replace('-','').ToLowerInvariant()}finally{$taskHash.Dispose()}
  $taskUrl='http://127.0.0.1:'+ $Port
  $taskHealth=$null
  try { $taskHealth=Invoke-RestMethod -Uri ($taskUrl+'/api/health') -TimeoutSec 2 } catch {}
  if($taskHealth){
    if($taskHealth.app -ne 'offer-workbench-private' -or $taskHealth.version -ne $taskVersion -or $taskHealth.instanceId -ne $taskIdentity){
      $taskOwner=Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess
      throw "端口 $Port 已有另一份或旧版工作台（PID：$taskOwner）。请先保存工作并关闭该工作台，再启动本包。不会自动关闭其他进程。"
    }
  }else{
    $taskOwner=Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess
    if($taskOwner){throw "端口 $Port 被其他程序占用（PID：$taskOwner）。请关闭占用程序后重试。"}
    Write-Host '[2/3] 正在启动本机工作台…'
    New-Item -ItemType Directory -Force -Path $taskData | Out-Null
    $env:WORKBENCH_DATA_DIR=$taskData
    $env:PORT=[string]$Port
    $taskProcess=Start-Process -FilePath $taskNode -ArgumentList '--disable-warning=ExperimentalWarning','local-server.mjs' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskData 'server.out.log') -RedirectStandardError (Join-Path $taskData 'server.err.log')
    for($taskAttempt=0;$taskAttempt -lt 60;$taskAttempt++){
      Start-Sleep -Milliseconds 300
      try {$taskHealth=Invoke-RestMethod -Uri ($taskUrl+'/api/health') -TimeoutSec 1;if($taskHealth.instanceId -eq $taskIdentity -and $taskHealth.version -eq $taskVersion){break}}catch{}
      if($taskProcess.HasExited){break}
    }
    if(-not $taskHealth -or $taskHealth.instanceId -ne $taskIdentity){throw "启动未完成，请查看 $taskData\server.err.log。"}
  }
  Write-Host ('[3/3] 工作台已就绪，PID：'+$taskHealth.processId)
  Write-Host ('数据目录：'+$taskData)
  Write-Host ('打开地址：'+$taskUrl)
  if(-not $NoBrowser){Start-Process ($taskUrl+'/')}
}catch{
  Write-Host ('启动失败：'+$_.Exception.Message) -ForegroundColor Red
  exit 1
}finally{
  if($taskOwned){$taskLock.ReleaseMutex()}
  $taskLock.Dispose()
}
