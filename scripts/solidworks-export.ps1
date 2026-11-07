param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][ValidateSet('preview','dxf','pdf','step')][string]$Operation,
    [int]$FirstPage = 1
)

$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'SolidWorksDispatch.cs')
function Invoke-Sw($Target, [string]$Member, [object[]]$Arguments = @()) {
    for ($i = 0; $i -lt $Arguments.Length; $i++) {
        if ($null -ne $Arguments[$i]) { $Arguments[$i] = $Arguments[$i].PSObject.BaseObject }
    }
    [SolidWorksDispatch]::Call($Target, $Member, $Arguments)
}
$app = $null
$owned = $false
$drawing = $null
$previousDxf = $null
$previousReferences = $null
$watchdog = $null
$launched = $null
try {
    $existing = @(Get-Process SLDWORKS -ErrorAction SilentlyContinue)
    if ($existing.Count -and $Operation -ne 'step') { throw 'SolidWorks is already open.' }
    if ($existing.Count) {
        $executable = $existing[0].Path
        if (-not $executable) { throw 'Could not locate SolidWorks for a separate session.' }
        $launched = Start-Process -FilePath $executable -WindowStyle Hidden -PassThru
        $watchdog = [SolidWorksDispatch]::Watch($launched)
        $deadline = [DateTime]::UtcNow.AddSeconds(32)
        do {
            $app = [SolidWorksDispatch]::FindSession($launched.Id)
            if ($null -ne $app) { break }
            Start-Sleep -Milliseconds 200
        } until ($launched.HasExited -or [DateTime]::UtcNow -gt $deadline)
        if ($null -eq $app) { throw 'Could not bind the separate SolidWorks session.' }
    } else {
        $app = [Activator]::CreateInstance([type]::GetTypeFromProgID('SldWorks.Application'))
    }
    $vendorPid = Invoke-Sw $app GetProcessID
    $vendorProcess = Get-Process -Id $vendorPid
    if ($vendorProcess.ProcessName -ne 'SLDWORKS' -or (Invoke-Sw $app GetDocumentCount) -ne 0) {
        throw 'Could not establish a fresh SolidWorks session.'
    }
    if ($null -ne $launched -and $vendorPid -ne $launched.Id) { throw 'SolidWorks process mismatch.' }
    $owned = $true
    if ($null -eq $watchdog) { $watchdog = [SolidWorksDispatch]::Watch($vendorProcess) }
    $previousReferences = Invoke-Sw $app GetUserPreferenceIntegerValue @(82)
    if (-not (Invoke-Sw $app SetUserPreferenceIntegerValue @(82, 2))) { throw 'Could not disable external references.' }
    $errors = [SolidWorksDispatch+IntRef]::new()
    $warnings = [SolidWorksDispatch+IntRef]::new()
    if ($Operation -eq 'step') {
        # Part, silent + read-only, using the saved active configuration.
        $drawing = Invoke-Sw $app OpenDoc6 @($Source, 1, 3, '', $errors, $warnings)
        if ($null -eq $drawing -or $errors.Value -ne 0 -or $warnings.Value -ne 0 -or
            (Invoke-Sw $app GetDocumentCount) -ne 1) {
            throw "Saved part unavailable ($($errors.Value)/$($warnings.Value))."
        }
        $extension = [SolidWorksDispatch]::Get($drawing, 'Extension')
        $noExportData = [Runtime.InteropServices.DispatchWrapper]::new($null)
        $target = Join-Path $Directory 'model.step'
        if (-not (Invoke-Sw $extension SaveAs @($target, 0, 1, $noExportData, $errors, $warnings)) -or
            $errors.Value -or $warnings.Value) {
            throw "STEP export failed ($($errors.Value)/$($warnings.Value))."
        }
        return
    }
    # Drawing, silent + read-only + detailing mode.
    $drawing = Invoke-Sw $app OpenDoc6 @($Source, 3, 1027, '', $errors, $warnings)
    if ($null -eq $drawing -or $errors.Value -ne 0 -or (Invoke-Sw $app GetDocumentCount) -ne 1 -or
        (-not (Invoke-Sw $drawing IsDetailingMode) -and -not (Invoke-Sw $app IsRapidDraft @($Source)))) {
        throw "Saved detailing mode unavailable ($($errors.Value)/$($warnings.Value))."
    }
    $sheets = @(Invoke-Sw $drawing GetSheetNames)
    $extension = [SolidWorksDispatch]::Get($drawing, 'Extension')
    if (-not $sheets.Count -or $sheets.Count -gt 64) { throw 'Invalid sheet count.' }
    if ($FirstPage -lt 1 -or $FirstPage -gt $sheets.Count) { throw 'Invalid first sheet.' }
    # Large drawings use short batches to release the CAD process between groups of sheets.
    $lastPage = if ($Operation -eq 'pdf') { $sheets.Count } else { [Math]::Min($FirstPage + 3, $sheets.Count) }
    if ($Operation -ne 'pdf') {
        # Save each active sheet as a separate editable DXF.
        $previousDxf = Invoke-Sw $app GetUserPreferenceIntegerValue @(253)
        if (-not (Invoke-Sw $app SetUserPreferenceIntegerValue @(253, 0))) { throw 'Could not select current-sheet DXF export.' }
    }
    $sheetInfo = @()
    $noExportData = [Runtime.InteropServices.DispatchWrapper]::new($null)
    for ($index = $FirstPage; $index -le $lastPage; $index++) {
        $sheet = $sheets[$index - 1]
        if (-not (Invoke-Sw $drawing ActivateSheet @($sheet))) { throw 'Could not activate the source sheet.' }
        $sheetView = Invoke-Sw $drawing GetFirstView
        if ($null -eq $sheetView) { throw 'Could not read the source sheet view.' }
        $views = 0
        while ($null -ne ($sheetView = Invoke-Sw $sheetView GetNextView)) {
            if (++$views -gt 10000) { throw 'The sheet view chain is invalid.' }
        }
        $sheetInfo += @{ name = $sheet; modelViews = $views }
        if ($Operation -ne 'pdf') {
            $errors.Value = $warnings.Value = 0
            $target = Join-Path $Directory ('sheet-{0:D4}.dxf' -f $index)
            if (-not (Invoke-Sw $extension SaveAs @($target, 0, 1, $noExportData, $errors, $warnings)) -or $errors.Value -or $warnings.Value) {
                throw "DXF export failed on sheet ${index} ($($errors.Value)/$($warnings.Value))."
            }
        }
    }
    if ($Operation -eq 'pdf') {
        $pdf = Invoke-Sw $app GetExportFileData @(1)
        [SolidWorksDispatch]::Set($pdf, 'ViewPdfAfterSaving', $false)
        if (-not (Invoke-Sw $pdf SetSheets @(3, [string[]]$sheets))) { throw 'Could not select all PDF sheets.' }
        $errors.Value = $warnings.Value = 0
        $target = Join-Path $Directory 'drawing.pdf'
        if (-not (Invoke-Sw $extension SaveAs @($target, 0, 1, $pdf, $errors, $warnings)) -or $errors.Value -or $warnings.Value) {
            throw "PDF export failed ($($errors.Value)/$($warnings.Value))."
        }
    }
    $manifest = @{ total = $sheets.Count; pages = $sheetInfo }
    [IO.File]::WriteAllText((Join-Path $Directory 'sheets.json'), (ConvertTo-Json -InputObject $manifest -Compress),
        (New-Object Text.UTF8Encoding($false)))
} finally {
    try {
        if ($owned -and -not $vendorProcess.HasExited) {
            try {
                if ($null -ne $previousDxf) { [void](Invoke-Sw $app SetUserPreferenceIntegerValue @(253, $previousDxf)) }
                if ($null -ne $previousReferences) { [void](Invoke-Sw $app SetUserPreferenceIntegerValue @(82, $previousReferences)) }
                if ($null -ne $drawing) {
                    $title = Invoke-Sw $drawing GetTitle
                    [void](Invoke-Sw $app CloseDoc @($title))
                }
            } finally {
                [void](Invoke-Sw $app ExitApp)
            }
            if (-not $vendorProcess.WaitForExit(5000) -and (Invoke-Sw $app GetDocumentCount) -eq 0) {
                $vendorProcess.Kill()
                [void]$vendorProcess.WaitForExit(5000)
            }
        }
    } finally {
        if ($null -ne $launched -and -not $launched.HasExited) {
            $launched.Kill()
            [void]$launched.WaitForExit(5000)
        }
        if ($null -ne $watchdog) { $watchdog.Dispose() }
    }
}
