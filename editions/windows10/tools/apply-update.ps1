[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$PlanPath,
    [Parameter(Mandatory=$true)][string]$PlanSha256,
    [ValidateSet('Prepare','Apply')][string]$Mode = 'Prepare',
    [switch]$TestOnly,
    [int]$FailAfterFiles = 0
)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + [IO.Path]::PathSeparator + $env:PSModulePath
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Set-StrictMode -Version 2
Add-Type -AssemblyName System.IO.Compression.FileSystem
$script:plan = $null
$script:statusFile = $null
$script:changed = New-Object System.Collections.Generic.List[object]
$script:restartAttempted = $false

function Full([string]$Value) { return [System.IO.Path]::GetFullPath($Value).TrimEnd('\') }
function Inside([string]$Parent, [string]$Child) {
    $a = Full $Parent; $b = Full $Child
    return $a.Equals($b, [StringComparison]::OrdinalIgnoreCase) -or $b.StartsWith($a + '\', [StringComparison]::OrdinalIgnoreCase)
}
function No-Reparse([string]$Value) {
    $current = [System.IO.Path]::GetFullPath($Value)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Update paths cannot pass through symbolic links or junctions.' }
        }
        $parent = [IO.Path]::GetDirectoryName($current.TrimEnd('\'))
        if ($parent -eq $current) { break }; $current = $parent
    }
}
function Hash([string]$Value) {
    $algorithm = [Security.Cryptography.SHA256]::Create(); $stream = [IO.File]::OpenRead($Value)
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
function Safe-Relative([string]$Value) {
    if (-not $Value.StartsWith('codex-mobile/', [StringComparison]::Ordinal) -or $Value.Length -gt 512 -or $Value -match '[\\\x00-\x1f<>:"|?*]') { throw 'Invalid archive filename.' }
    $relative = $Value.Substring(13)
    $parts = $relative.Split('/')
    foreach ($part in $parts) {
        if (-not $part -or $part -eq '.' -or $part -eq '..' -or $part -match '[. ]$' -or $part -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$' -or $part -match '^\.(?i:runtime|codex|git|env)$') { throw 'Archive traversal or reserved filename rejected.' }
    }
    $rootFiles = @('server.mjs','package.json','README.md','LICENSE','THIRD_PARTY_NOTICES.md','Start.cmd','Stop.cmd','Launch.ps1','Stop.ps1','Codex-Mobile.exe','build-launcher.ps1','update.json','edition.json')
    $directories = @('lib','public','launcher','tools','test','docs','runtime','vendor')
    if (($parts.Count -eq 1 -and $rootFiles -cnotcontains $relative) -or ($parts.Count -gt 1 -and $directories -cnotcontains $parts[0])) { throw 'Archive writes outside the program allowlist.' }
    if ($relative -match '(?i)(^|/)(owner-url\.txt|auth\.json|devices\.json|tasks\.json|sessions\.json|credentials\.json)$|\.(log|sqlite|db|key|pem|pfx)$') { throw 'Personal data cannot be included in an update.' }
    return $relative
}
function Target([string]$Base, [string]$Relative) {
    $result = [IO.Path]::GetFullPath((Join-Path $Base $Relative.Replace('/','\')))
    if (-not (Inside $Base $result)) { throw 'Target escaped the intended directory.' }
    No-Reparse $result
    return $result
}
function Status([string]$State, [string]$Message) {
    if ($script:statusFile) {
        $record = @{ status=$State; message=$Message; version=$script:plan.version; updatedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
        [IO.File]::WriteAllText($script:statusFile, ($record | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
        [IO.File]::AppendAllText((Join-Path $script:plan.jobDir 'apply.log'), ([DateTime]::UtcNow.ToString('o') + ' ' + $State + ': ' + $Message + [Environment]::NewLine))
    }
}
function Verified-Process($Expected, [string]$Kind) {
    if ($null -eq $Expected -or [int]$Expected.pid -lt 1) { return $null }
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$Expected.pid) -ErrorAction SilentlyContinue
    if ($null -eq $process) { return $null }
    $expectedExe = if ($Kind -eq 'launcher') { Join-Path $script:plan.rootDir 'Codex-Mobile.exe' } else { [string]$Expected.executable }
    if (-not $process.ExecutablePath -or -not (Full $process.ExecutablePath).Equals((Full $expectedExe), [StringComparison]::OrdinalIgnoreCase)) { throw 'PID identity changed; refusing to stop a process.' }
    $creation = ([DateTimeOffset]$process.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()
    if ([Math]::Abs($creation - [double]$Expected.startedAt) -gt 5000) { throw 'Process creation time does not match; no process was stopped.' }
    if ($Kind -eq 'server') {
        $serverPath = Join-Path $script:plan.rootDir 'server.mjs'
        $expression = '(?i)(?:^|\s|")' + [Regex]::Escape($serverPath) + '(?:$|\s|")'
        if ($process.CommandLine -notmatch $expression -or [IO.Path]::GetFileName($process.ExecutablePath) -ine 'node.exe') { throw 'The server command does not belong to this installation.' }
    }
    return $process
}
function Wait-OwnedExit($Expected, [string]$Kind) {
    if ($null -eq $Expected) { return }
    for ($attempt=0; $attempt -lt 60; $attempt++) {
        $process = Verified-Process $Expected $Kind
        if ($null -eq $process) { return }
        Start-Sleep -Milliseconds 250
    }
    $process = Verified-Process $Expected $Kind
    if ($null -ne $process) {
        # Exact PID + executable + start time (+ server script) were checked.
        Stop-Process -Id ([int]$Expected.pid) -Force -ErrorAction Stop
        Wait-Process -Id ([int]$Expected.pid) -Timeout 15 -ErrorAction SilentlyContinue
    }
    if ($null -ne (Verified-Process $Expected $Kind)) { throw 'The verified application process is still holding files.' }
}
function Read-Edition([string]$Base) {
    $filename = Join-Path $Base 'edition.json'
    No-Reparse $filename
    if (-not (Test-Path -LiteralPath $filename -PathType Leaf) -or (Get-Item -LiteralPath $filename).Length -gt 16384) { throw 'Missing or oversized local edition identity.' }
    $edition = Get-Content -LiteralPath $filename -Raw -Encoding UTF8 | ConvertFrom-Json
    $platforms = @{ windows11='Windows 11 x64'; windows10='Windows 10 x64' }
    if (-not $platforms.ContainsKey([string]$edition.id) -or $edition.platform -cne $platforms[$edition.id] -or $edition.repository -cne 'maxlzyver/codex-mobile-editions' -or $edition.updatePath -cne ('editions/' + $edition.id) -or $edition.version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$' -or $edition.assetName -cne ('codex-mobile-' + $edition.id + '-' + $edition.version + '-x64.zip')) { throw 'Invalid Windows edition identity.' }
    return $edition
}

function Restart-Application {
    if ($TestOnly) { return }
    $script:restartAttempted = $true
    if ([int]$script:plan.restartPort -ge 1024 -and [int]$script:plan.restartPort -le 65535) { $env:CODEX_MOBILE_PORT = [string]$script:plan.restartPort }
    $started = Start-Process -FilePath (Join-Path $script:plan.rootDir 'Codex-Mobile.exe') -ArgumentList '--after-update' -WorkingDirectory $script:plan.rootDir -WindowStyle Hidden -PassThru
    $expectedVersion = (Get-Content -LiteralPath (Join-Path $script:plan.rootDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    for ($attempt=0; $attempt -lt 100; $attempt++) {
        Start-Sleep -Milliseconds 400
        try {
            $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $script:plan.restartPort + '/health') -TimeoutSec 1
            $serverState = Get-Content -LiteralPath (Join-Path $script:plan.runtimeDir 'server.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($health.app -eq 'codex-mobile' -and $health.version -eq $expectedVersion -and (Full $serverState.root) -ieq (Full $script:plan.rootDir) -and $serverState.startedAt -gt $script:plan.server.startedAt) { return }
        } catch { }
        if ($started.HasExited) { break }
    }
    # Only this exact newly spawned launcher and its verified local server may be stopped.
    try {
        $newServer = Get-Content -LiteralPath (Join-Path $script:plan.runtimeDir 'server.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ((Full $newServer.root) -ieq (Full $script:plan.rootDir) -and $newServer.startedAt -gt $script:plan.server.startedAt) {
            $newServer | Add-Member -NotePropertyName executable -NotePropertyValue (Join-Path $script:plan.rootDir 'runtime\node.exe')
            Wait-OwnedExit $newServer 'server'
        }
    } catch { }
    if (-not $started.HasExited) {
        $identity = @{ pid=$started.Id; startedAt=([DateTimeOffset]$started.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds() }
        Wait-OwnedExit $identity 'launcher'
    }
    throw 'Updated application did not pass its startup health check.'
}

try {
    if ($PlanSha256 -notmatch '^[a-fA-F0-9]{64}$' -or (Hash $PlanPath) -ne $PlanSha256.ToLowerInvariant()) { throw 'The installation plan failed SHA256 verification.' }
    $script:plan = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($script:plan.schema -ne 1 -or $script:plan.version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$') { throw 'Invalid installation version or schema.' }
    if ([bool]$script:plan.testMode -ne [bool]$TestOnly) { throw 'The plan execution mode is inconsistent.' }
    if ($FailAfterFiles -ne 0 -and -not $TestOnly) { throw 'Failure injection is permitted only in an isolated test.' }
    $root = Full $script:plan.rootDir; $runtime = Full $script:plan.runtimeDir; $job = Full $script:plan.jobDir
    if ($runtime -ine (Join-Path $root '.runtime') -or -not (Inside (Join-Path $runtime 'updates') $job) -or (Full ([IO.Path]::GetDirectoryName($PlanPath))) -ine $job) { throw 'Invalid update staging location.' }
    foreach ($location in @($root,$runtime,$job,$script:plan.zipPath,$script:plan.manifestPath)) { No-Reparse $location }
    foreach ($location in @($script:plan.zipPath,$script:plan.manifestPath)) { if (-not (Inside (Join-Path $runtime 'updates') $location)) { throw 'Update input escaped its cache.' } }
    $localEdition = Read-Edition $root
    $repository = $script:plan.PSObject.Properties['source'] -and $script:plan.source -ceq 'repository'
    $prefix = 'codex-mobile-editions-' + $script:plan.sourceCommit + '/' + $localEdition.updatePath + '/'
    if (-not $repository -or $script:plan.editionId -cne $localEdition.id -or $script:plan.sourceCommit -notmatch '^[a-f0-9]{40}$' -or $script:plan.releaseUrl -cne ('https://github.com/maxlzyver/codex-mobile-editions/tree/' + $script:plan.sourceCommit) -or $script:plan.archivePrefix -cne $prefix -or $script:plan.assetName -cne ('codex-mobile-' + $localEdition.id + '-' + $script:plan.version + '-x64.zip')) { throw 'Pinned repository or edition identity mismatch.' }
    $script:statusFile = Join-Path $job 'status.json'
    if ((Get-Item -LiteralPath $script:plan.zipPath).Length -ne $script:plan.size -or (Hash $script:plan.zipPath) -ne $script:plan.sha256) { throw 'Update ZIP failed size or SHA256 verification.' }
    if ($script:plan.PSObject.Properties['manifestSha256'] -and $script:plan.manifestSha256 -and (Hash $script:plan.manifestPath) -ine $script:plan.manifestSha256) { throw 'Update manifest failed SHA256 verification.' }
    $manifest = Get-Content -LiteralPath $script:plan.manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.version -cne $script:plan.version -or $manifest.repository -cne 'maxlzyver/codex-mobile-editions' -or $manifest.platform -cne $localEdition.platform -or $manifest.edition -cne $localEdition.id) { throw 'Repository manifest edition identity mismatch.' }
    if ($manifest.PSObject.Properties['runtimePolicy'] -and $manifest.runtimePolicy -cne 'preserve') { throw 'Unsupported runtime policy.' }
    $stage = Join-Path $job 'stage'; $backup = Join-Path $job 'backup'; $inventoryPath = Join-Path $job 'inventory.json'
    if ($Mode -eq 'Prepare') {
        Status 'preparing' 'Validating and extracting program files.'
        if (Test-Path -LiteralPath $stage) { throw 'Staging already exists; create a fresh installation job.' }
        New-Item -ItemType Directory -Path $stage | Out-Null
        $expected = @{}
        $hasFileManifest = $true
        if ($hasFileManifest) {
            $manifestFiles = $manifest.files
            if (@($manifestFiles).Count -lt 1 -or @($manifestFiles).Count -gt 10000) { throw 'Invalid edition manifest file count.' }
            foreach ($file in $manifestFiles) {
                $manifestName = 'codex-mobile/' + $file.path
                $relative = Safe-Relative $manifestName
                if ($expected.ContainsKey($relative) -or $file.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or [long]$file.bytes -lt 0) { throw 'Invalid or duplicate manifest file.' }
                $expected[$relative] = $file
            }
        } elseif ($manifest.verificationSource -cne 'SHA256SUMS') { throw 'The manifest lacks file checksums or SHA256SUMS verification.' }
        $inventory = New-Object System.Collections.Generic.List[object]
        $seen = @{}; [long]$total = 0
        $archive = [IO.Compression.ZipFile]::OpenRead($script:plan.zipPath)
        try {
            if ($archive.Entries.Count -gt 12000) { throw 'Update ZIP contains too many entries.' }
            foreach ($entry in $archive.Entries) {
                $name = $entry.FullName
                if ($name -match '[\\\x00-\x1f<>:"|?*]' -or $name.StartsWith('/') -or @($name.TrimEnd('/').Split('/') | Where-Object { $_ -eq '..' -or $_ -eq '.' -or -not $_ -or $_ -match '[. ]$' }).Count -gt 0) { throw 'ZIP path traversal rejected.' }
                $unixType = ($entry.ExternalAttributes -shr 16) -band 61440
                if ($unixType -eq 40960 -or (($entry.ExternalAttributes -band 1024) -ne 0)) { throw 'ZIP symbolic links and reparse points are prohibited.' }
                if ($repository) {
                    if (-not $name.StartsWith($script:plan.archivePrefix, [StringComparison]::Ordinal)) { continue }
                    $name = 'codex-mobile/' + $name.Substring($script:plan.archivePrefix.Length)
                    if ($name -ceq 'codex-mobile/') { continue }
                    if ($name.EndsWith('/')) { continue }
                    $candidate = $name.Substring(13)
                    # Repository-only files (including update.json itself) are not installed.
                    if (-not $expected.ContainsKey($candidate)) { continue }
                }
                if ($name.EndsWith('/')) {
                    if ($name -ceq 'codex-mobile/') { continue }
                    $directoryName = $name.TrimEnd('/')
                    # Directory names are checked through a harmless child path.
                    Safe-Relative ($directoryName + '/directory-check.txt') | Out-Null
                    continue
                }
                $relative = Safe-Relative $name
                Target $root $relative | Out-Null
                if ($seen.ContainsKey($relative)) { throw 'Case-insensitive duplicate ZIP path.' }; $seen[$relative] = $true
                [long]$total += $entry.Length
                if ($entry.Length -gt 268435456 -or $total -gt 1073741824) { throw 'Update uncompressed size exceeds limits.' }
                if ($hasFileManifest -and (-not $expected.ContainsKey($relative) -or $entry.Length -ne $expected[$relative].bytes)) { throw 'ZIP file list or size does not match the manifest.' }
                $destination = Target $stage $relative
                [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $false)
                $digest = Hash $destination
                if ($hasFileManifest -and $digest -ine $expected[$relative].sha256) { throw 'Extracted file checksum mismatch.' }
                $inventory.Add(@{ path=$relative; bytes=$entry.Length; sha256=$digest })
            }
        } finally { $archive.Dispose() }
        if ($hasFileManifest -and $seen.Count -ne $expected.Count) { throw 'The ZIP is missing manifest files.' }
        $preserveRuntime = $repository -and $manifest.PSObject.Properties['runtimePolicy'] -and $manifest.runtimePolicy -ceq 'preserve'
        $requiredFiles = @('edition.json','server.mjs','package.json','Codex-Mobile.exe','LICENSE','README.md','lib/security.mjs','public/index.html','tools/apply-update.ps1','vendor/qrcode.cjs')
        if (-not $preserveRuntime) { $requiredFiles += 'runtime/node.exe' }
        foreach ($required in $requiredFiles) { if (-not $seen.ContainsKey($required)) { throw ('Missing required program file: ' + $required) } }
        if ($preserveRuntime) {
            foreach ($file in $inventory) { if ($file.path -match '^(runtime/|vendor/cloudflared)') { throw 'A preserve-runtime update cannot replace runtime components.' } }
            foreach ($required in @('runtime/node.exe','runtime/LICENSE','vendor/cloudflared-windows-amd64.exe','vendor/cloudflared-release.json')) {
                $existing = Target $root $required
                if (-not (Test-Path -LiteralPath $existing -PathType Leaf)) { throw 'A lightweight update requires an existing complete portable installation.' }
            }
            $cloudflareMetadata = Get-Content -LiteralPath (Join-Path $root 'vendor\cloudflared-release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            if ((Hash (Join-Path $root 'vendor\cloudflared-windows-amd64.exe')) -ine $cloudflareMetadata.sha256) { throw 'Existing cloudflared integrity check failed.' }
        }
        $package = Get-Content -LiteralPath (Join-Path $stage 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($package.version -cne $script:plan.version -or $package.name -cne 'codex-mobile-console') { throw 'The extracted package identity does not match the release.' }
        $targetEdition = Read-Edition $stage
        if ($targetEdition.id -cne $localEdition.id -or $targetEdition.platform -cne $localEdition.platform -or $targetEdition.repository -cne $localEdition.repository -or $targetEdition.updatePath -cne $localEdition.updatePath -or $targetEdition.version -cne $script:plan.version) { throw 'Extracted edition.json does not match this installed edition.' }

        if ($repository) {
            if ($seen.ContainsKey('update.json')) { throw 'Repository manifest must not hash itself.' }
            $savedManifest = Join-Path $stage 'update.json'
            Copy-Item -LiteralPath $script:plan.manifestPath -Destination $savedManifest
            $inventory.Add(@{ path='update.json'; bytes=(Get-Item -LiteralPath $savedManifest).Length; sha256=(Hash $savedManifest) })
        }
        [IO.File]::WriteAllText($inventoryPath, (ConvertTo-Json -InputObject @($inventory.ToArray()) -Depth 5), (New-Object Text.UTF8Encoding($false)))
        Status 'prepared' 'All program files have passed verification.'
        exit 0
    }

    if (-not (Test-Path -LiteralPath $inventoryPath -PathType Leaf)) { throw 'Prepare must succeed before Apply.' }
    if (-not $script:plan.PSObject.Properties['inventorySha256'] -or (Hash $inventoryPath) -ine $script:plan.inventorySha256) { throw 'Prepared inventory changed; apply cancelled.' }
    $inventory = Get-Content -LiteralPath $inventoryPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($file in $inventory) {
        Safe-Relative ('codex-mobile/' + $file.path) | Out-Null
        $staged = Target $stage $file.path
        if ((Hash $staged) -ine $file.sha256 -or (Get-Item -LiteralPath $staged).Length -ne $file.bytes) { throw 'Prepared files changed; apply cancelled.' }
        Target $root $file.path | Out-Null
    }
    if (-not $TestOnly) {
        Status 'waiting' 'Waiting for active requests to finish and the local service to close.'
        $ready = $false
        for ($attempt=0; $attempt -lt 480; $attempt++) {
            if (Test-Path -LiteralPath (Join-Path $job 'cancel.json')) { throw 'The application cancelled this update.' }
            if (Test-Path -LiteralPath (Join-Path $job 'apply-ready.json')) { $ready=$true; break }
            Start-Sleep -Milliseconds 250
        }
        if (-not $ready) { throw 'Timed out waiting for the safe shutdown signal.' }
        $launcher = $null
        $launcherState = Join-Path $runtime 'launcher-process.json'
        if (Test-Path -LiteralPath $launcherState) {
            $launcher = Get-Content -LiteralPath $launcherState -Raw -Encoding UTF8 | ConvertFrom-Json
            if ((Full $launcher.root) -ine $root) { throw 'Launcher belongs to another installation.' }
            Verified-Process $launcher 'launcher' | Out-Null
            [IO.File]::WriteAllText((Join-Path $runtime 'update-exit.json'), (@{ pid=$launcher.pid; startedAt=$launcher.startedAt; root=$root } | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
        }
        Wait-OwnedExit $launcher 'launcher'
        Wait-OwnedExit $script:plan.server 'server'
    }
    Status 'applying' 'Backing up and replacing verified program files; personal data is preserved.'
    [IO.Directory]::CreateDirectory($backup) | Out-Null
    $count = 0
    foreach ($file in $inventory) {
        $destination = Target $root $file.path; $saved = Target $backup $file.path
        $existed = Test-Path -LiteralPath $destination -PathType Leaf
        if ((Test-Path -LiteralPath $destination) -and -not $existed) { throw 'An update destination is not a regular file.' }
        if ($existed) { [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($saved)) | Out-Null; Copy-Item -LiteralPath $destination -Destination $saved -Force }
        $script:changed.Add(@{path=$file.path; existed=$existed})
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
        $copied = $false
        for ($retry=0; $retry -lt 40; $retry++) {
            try { Copy-Item -LiteralPath (Target $stage $file.path) -Destination $destination -Force; $copied=$true; break }
            catch { if ($retry -eq 39) { throw }; Start-Sleep -Milliseconds 250 }
        }
        if (-not $copied -or (Hash $destination) -ine $file.sha256) { throw 'Installed file verification failed.' }
        $count++
        if ($TestOnly -and $FailAfterFiles -gt 0 -and $count -ge $FailAfterFiles) { throw 'Simulated copy failure for rollback test.' }
    }
    Status 'installed' 'Program files updated. Restarting the tray application in background.'
    Restart-Application
    [IO.File]::WriteAllText((Join-Path $runtime 'installed-files.json'), (@{version=$script:plan.version;files=@($inventory)} | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
    Status 'complete' 'Update installed; phone pairings and user projects were preserved.'
    exit 0
} catch {
    $reason = $_.Exception.Message
    $rollbackError = $null
    if ($script:changed.Count -gt 0) {
        for ($i=$script:changed.Count-1; $i -ge 0; $i--) {
            $record = $script:changed[$i]
            try {
                $destination = Target $script:plan.rootDir $record.path
                if ($record.existed) { Copy-Item -LiteralPath (Target (Join-Path $script:plan.jobDir 'backup') $record.path) -Destination $destination -Force }
                elseif (Test-Path -LiteralPath $destination -PathType Leaf) { Remove-Item -LiteralPath $destination -Force }
            } catch { $rollbackError = $_.Exception.Message }
        }
        Status 'rolled-back' ('Update failed; prior program files restored. ' + $reason)
        if (-not $TestOnly -and -not $rollbackError) { try { Restart-Application } catch { $rollbackError = $_.Exception.Message } }
    } else { Status 'error' $reason }
    if ($rollbackError) { Status 'rollback-failed' ('Manual recovery from the backup directory is required. ' + $rollbackError) }
    Write-Error $reason
    exit 1
}
