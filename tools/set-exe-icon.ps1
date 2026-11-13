param(
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][string]$Icon
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class IconResource {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool UpdateResource(IntPtr handle, IntPtr type, IntPtr name,
        ushort language, byte[] data, uint size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool EndUpdateResource(IntPtr handle, bool discard);
}
'@

$bytes = [IO.File]::ReadAllBytes($Icon)
$count = [BitConverter]::ToUInt16($bytes, 4)
# The group uses the ICO directory format with resource IDs in place of file offsets.
$group = [byte[]]::new(6 + 14 * $count)
[Array]::Copy($bytes, $group, 6)
$handle = [IconResource]::BeginUpdateResource($Executable, $false)
if ($handle -eq [IntPtr]::Zero) { throw [ComponentModel.Win32Exception]::new() }

function Write-IconResource([int]$Type, [int]$Id, [byte[]]$Data) {
    if (![IconResource]::UpdateResource($handle, [IntPtr]$Type, [IntPtr]$Id, 1033, $Data, $Data.Length)) {
        throw [ComponentModel.Win32Exception]::new()
    }
}

$discard = $true
try {
    for ($index = 0; $index -lt $count; $index++) {
        $entry = 6 + 16 * $index
        $size = [BitConverter]::ToUInt32($bytes, $entry + 8)
        $offset = [BitConverter]::ToUInt32($bytes, $entry + 12)
        $id = 1000 + $index
        $frame = [byte[]]::new($size)
        [Array]::Copy($bytes, $offset, $frame, 0, $size)
        $groupEntry = 6 + 14 * $index
        [Array]::Copy($bytes, $entry, $group, $groupEntry, 12)
        [Array]::Copy([BitConverter]::GetBytes([uint16]$id), 0, $group, $groupEntry + 12, 2)
        Write-IconResource 3 $id $frame
    }
    Write-IconResource 14 1 $group
    $discard = $false
} finally {
    if (![IconResource]::EndUpdateResource($handle, $discard) -and !$discard) {
        throw [ComponentModel.Win32Exception]::new()
    }
}
