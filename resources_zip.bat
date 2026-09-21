@echo off
setlocal
set "ZIP_SELF=%~f0"
for /f %%I in ('powershell.exe -NoLogo -NoProfile -Command "Get-Date -Format yyyyMMddHHmmss"') do set "ZIP_TIMESTAMP=%%I"
set "ZIP_RUNNER=%TEMP%\resources_zip_%ZIP_TIMESTAMP%.ps1"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$lines = Get-Content -LiteralPath $env:ZIP_SELF; $marker = [Array]::IndexOf($lines, '# POWERSHELL_START'); if ($marker -lt 0) { exit 1 }; $lines[($marker + 1)..($lines.Length - 1)] | Set-Content -LiteralPath $env:ZIP_RUNNER -Encoding UTF8"
if errorlevel 1 (
    echo Failed to prepare the embedded PowerShell script. 1>&2
    del /q "%ZIP_RUNNER%" >nul 2>&1
    exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ZIP_RUNNER%" -BaseDirectory "%~dp0."
set "ZIP_EXIT=%ERRORLEVEL%"
del /q "%ZIP_RUNNER%" >nul 2>&1
exit /b %ZIP_EXIT%

# POWERSHELL_START
param([Parameter(Mandatory = $true)][string]$BaseDirectory)

$ErrorActionPreference = 'Stop'

$baseDirectory = [IO.Path]::GetFullPath($BaseDirectory).TrimEnd('\', '/')
$settingsPath = Join-Path $baseDirectory 'resources_zip.json'

function Convert-GitIgnoreGlobToRegex {
    param([string]$Glob)

    $builder = New-Object Text.StringBuilder
    for ($index = 0; $index -lt $Glob.Length; $index++) {
        $character = $Glob[$index]
        if ($character -eq '*') {
            if (($index + 1) -lt $Glob.Length -and $Glob[$index + 1] -eq '*') {
                $index++
                if (($index + 1) -lt $Glob.Length -and $Glob[$index + 1] -eq '/') {
                    $index++
                    [void]$builder.Append('(?:.*/)?')
                } else {
                    [void]$builder.Append('.*')
                }
            } else {
                [void]$builder.Append('[^/]*')
            }
        } elseif ($character -eq '?') {
            [void]$builder.Append('[^/]')
        } else {
            [void]$builder.Append([regex]::Escape([string]$character))
        }
    }
    return $builder.ToString()
}

function Test-Excluded {
    param(
        [string]$RelativePath,
        [object[]]$Patterns
    )

    $path = $RelativePath.Replace('\', '/').TrimStart('/')
    $excluded = $false
    foreach ($item in $Patterns) {
        $pattern = [string]$item
        if ([string]::IsNullOrWhiteSpace($pattern) -or $pattern.StartsWith('#')) { continue }
        $pattern = $pattern.Replace('\', '/')

        $negated = $pattern.StartsWith('!')
        if ($negated) { $pattern = $pattern.Substring(1) }
        if ([string]::IsNullOrEmpty($pattern)) { continue }

        $directoryOnly = $pattern.EndsWith('/')
        if ($directoryOnly) { $pattern = $pattern.TrimEnd('/') }
        $anchored = $pattern.StartsWith('/')
        if ($anchored) { $pattern = $pattern.TrimStart('/') }
        if ([string]::IsNullOrEmpty($pattern)) { continue }

        $hasSlash = $pattern.Contains('/')
        $body = Convert-GitIgnoreGlobToRegex $pattern
        if ($anchored -or $hasSlash) {
            if ($directoryOnly) { $expression = '^' + $body + '(?:/.*)?$' }
            else { $expression = '^' + $body + '$' }
        } else {
            $expression = '(?:^|/)' + $body + '(?:/|$)'
        }

        if ([regex]::IsMatch($path, $expression, [Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
            $excluded = -not $negated
        }
    }
    return $excluded
}

try {
    if (-not (Test-Path -LiteralPath $settingsPath)) {
        $prompt = [regex]::Unescape('ZIP\u540d\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044')
        $zipName = Read-Host $prompt
        if ([string]::IsNullOrWhiteSpace($zipName)) { throw 'ZIP name must not be empty.' }
        if (-not $zipName.EndsWith('.zip', [StringComparison]::OrdinalIgnoreCase)) {
            $zipName += '.zip'
        }
        $settings = [ordered]@{
            zipName = $zipName
            exclude = @('.git/', '.gitignore', '/*.zip', 'resources_zip.bat', 'resources_zip.json')
        }
        $excludeLines = @()
        for ($index = 0; $index -lt $settings.exclude.Count; $index++) {
            $suffix = if ($index -lt ($settings.exclude.Count - 1)) { ',' } else { '' }
            $excludeLines += '    ' + ($settings.exclude[$index] | ConvertTo-Json -Compress) + $suffix
        }
        $jsonLines = @(
            '{'
            '  "zipName": ' + ($settings.zipName | ConvertTo-Json -Compress) + ','
            '  "exclude": ['
        ) + $excludeLines + @(
            '  ]'
            '}'
        )
        $jsonLines | Set-Content -LiteralPath $settingsPath -Encoding UTF8
    }

    $settings = Get-Content -Raw -LiteralPath $settingsPath | ConvertFrom-Json
    $zipName = [string]$settings.zipName
    if ([string]::IsNullOrWhiteSpace($zipName)) { throw 'zipName must not be empty.' }
    if ($zipName -ne [IO.Path]::GetFileName($zipName) -or $zipName.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) {
        throw 'zipName must be a valid file name without a directory path.'
    }
    if ($null -eq $settings.exclude) { throw 'exclude must be a JSON array.' }
    $outputPath = Join-Path $baseDirectory $zipName

    $stageDirectory = Join-Path ([IO.Path]::GetTempPath()) ('resources_zip_' + [guid]::NewGuid().ToString('N'))
    $temporaryZip = Join-Path ([IO.Path]::GetTempPath()) ('resources_zip_' + [guid]::NewGuid().ToString('N') + '.zip')
    New-Item -ItemType Directory -Path $stageDirectory | Out-Null
    try {
        foreach ($directory in Get-ChildItem -LiteralPath $baseDirectory -Directory -Recurse -Force) {
            $relativePath = $directory.FullName.Substring($baseDirectory.Length).TrimStart('\', '/') + '/'
            if (Test-Excluded $relativePath @($settings.exclude)) { continue }
            New-Item -ItemType Directory -Path (Join-Path $stageDirectory $relativePath) -Force | Out-Null
        }

        foreach ($file in Get-ChildItem -LiteralPath $baseDirectory -File -Recurse -Force) {
            $relativePath = $file.FullName.Substring($baseDirectory.Length).TrimStart('\', '/')
            if (Test-Excluded $relativePath @($settings.exclude)) { continue }
            $destination = Join-Path $stageDirectory $relativePath
            $destinationDirectory = Split-Path -Parent $destination
            if (-not (Test-Path -LiteralPath $destinationDirectory)) {
                New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
            }
            Copy-Item -LiteralPath $file.FullName -Destination $destination
        }

        Add-Type -AssemblyName System.IO.Compression
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = [IO.Compression.ZipFile]::Open($temporaryZip, [IO.Compression.ZipArchiveMode]::Create)
        try {
            foreach ($directory in Get-ChildItem -LiteralPath $stageDirectory -Directory -Recurse -Force) {
                if ($null -eq (Get-ChildItem -LiteralPath $directory.FullName -Force | Select-Object -First 1)) {
                    $entryName = $directory.FullName.Substring($stageDirectory.Length).TrimStart('\', '/').Replace('\', '/').TrimEnd('/') + '/'
                    [void]$archive.CreateEntry($entryName)
                }
            }
            foreach ($file in Get-ChildItem -LiteralPath $stageDirectory -File -Recurse -Force) {
                $entryName = $file.FullName.Substring($stageDirectory.Length).TrimStart('\', '/').Replace('\', '/')
                [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $entryName, [IO.Compression.CompressionLevel]::Optimal)
            }
        } finally {
            $archive.Dispose()
        }
        Move-Item -LiteralPath $temporaryZip -Destination $outputPath -Force
        Write-Host ('Created: ' + $outputPath)
    } finally {
        Remove-Item -LiteralPath $stageDirectory -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $temporaryZip -Force -ErrorAction SilentlyContinue
    }
    exit 0
} catch {
    $errorPrefix = [regex]::Unescape('\u8a2d\u5b9a\u307e\u305f\u306f\u5727\u7e2e\u51e6\u7406\u306b\u5931\u6557\u3057\u307e\u3057\u305f')
    Write-Error ($errorPrefix + ': ' + $_.Exception.Message)
    exit 1
}
