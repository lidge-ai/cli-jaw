param(
    [Parameter(Mandatory = $true)]
    [string]$Dir,

    [Parameter(Mandatory = $true)]
    [ValidateSet('add', 'remove')]
    [string]$Mode,

    # Pure mode: transform this PATH value, print it and touch nothing.
    [string]$Current,

    # Subkey under HKCU that holds Path. Tests point this at a disposable key.
    [string]$RegistryKey = 'Environment',

    [switch]$NoBroadcast
)

# Adds or removes the bundled server/bin directory in the USER Path only.
# The old installer ran `setx PATH "<dir>;%PATH%"`, which copied the machine
# PATH into the user value, added another copy on every install or update and
# truncated at 1024 characters. This reads the raw registry value so %VAR%
# entries stay unexpanded and the value kind (REG_EXPAND_SZ / REG_SZ) is kept.

function Get-UpdatedPath([string]$Value) {
    $normalizedDir = $Dir.TrimEnd('\')
    $entries = @(($Value -split ';') | Where-Object {
        $_ -ne '' -and $_.TrimEnd('\') -ine $normalizedDir
    })
    if ($Mode -eq 'add') {
        $entries = @($Dir) + $entries
    }
    return ($entries -join ';')
}

try {
    if ($PSBoundParameters.ContainsKey('Current')) {
        Write-Output (Get-UpdatedPath $Current)
        exit 0
    }

    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($RegistryKey, $true)
    if ($null -eq $key) {
        throw "HKCU\$RegistryKey could not be opened for writing"
    }
    try {
        if ($key.GetValueNames() -contains 'Path') {
            $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $kind = $key.GetValueKind('Path')
        } else {
            $raw = ''
            $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        }
        $updated = Get-UpdatedPath $raw
        if ($updated.Contains('%')) {
            $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        } elseif ($kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) {
            $kind = [Microsoft.Win32.RegistryValueKind]::String
        }
        $key.SetValue('Path', $updated, $kind)
    } finally {
        $key.Close()
    }

    if (-not $NoBroadcast) {
        try {
            Add-Type -Namespace CliJaw -Name NativeMethods -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);
'@
            $result = [System.UIntPtr]::Zero
            # HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG, 5 s.
            [void][CliJaw.NativeMethods]::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, 'Environment', 0x2, 5000, [ref]$result)
        } catch {
            # The value is written; new logons and restarted shells still see it.
            [Console]::Error.WriteLine("cli-jaw: PATH updated, but the change broadcast failed: $($_.Exception.Message)")
        }
    }
    exit 0
} catch {
    [Console]::Error.WriteLine("cli-jaw: failed to update the user PATH: $($_.Exception.Message)")
    exit 1
}
