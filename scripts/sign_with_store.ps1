param(
  [Parameter(Mandatory=$true)][string]$pdfPath,
  [Parameter(Mandatory=$true)][string]$thumbprint,
  [Parameter(Mandatory=$false)][string]$outPath
)

if (-not (Test-Path $pdfPath)) { Write-Error "PDF not found: $pdfPath"; exit 10 }
if (-not $outPath) { $outPath = [System.IO.Path]::ChangeExtension($pdfPath, '-signed.pdf') }

[byte[]]$bytes = [System.IO.File]::ReadAllBytes($pdfPath)
$txt = [System.Text.Encoding]::ASCII.GetString($bytes)

$brMatch = [regex]::Match($txt, '/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]')
if (-not $brMatch.Success) { Write-Error 'ByteRange not found in PDF'; exit 11 }

$r0 = [int]$brMatch.Groups[1].Value
$l0 = [int]$brMatch.Groups[2].Value
$r1 = [int]$brMatch.Groups[3].Value
$l1 = [int]$brMatch.Groups[4].Value

$part1 = New-Object byte[] $l0
[Array]::Copy($bytes, $r0, $part1, 0, $l0)
$part2 = New-Object byte[] $l1
[Array]::Copy($bytes, $r1, $part2, 0, $l1)

$content = New-Object byte[] ($part1.Length + $part2.Length)
[Array]::Copy($part1, 0, $content, 0, $part1.Length)
[Array]::Copy($part2, 0, $content, $part1.Length, $part2.Length)

$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { ($_.Thumbprint -replace ' ','') -ieq ($thumbprint -replace ' ','') -and $_.HasPrivateKey } | Select-Object -First 1
if (-not $cert) { Write-Error "Certificate with thumbprint $thumbprint not found or has no private key"; exit 12 }

$signedCms = New-Object System.Security.Cryptography.Pkcs.SignedCms([System.Security.Cryptography.Pkcs.ContentInfo]::new($content), $true)
$signer = New-Object System.Security.Cryptography.Pkcs.CmsSigner($cert)
$signer.IncludeOption = [System.Security.Cryptography.Pkcs.X509IncludeOption]::EndCertOnly
$signedCms.ComputeSignature($signer)
$signature = $signedCms.Encode()

# find /Contents <...> placeholder
$contentsIdx = $txt.IndexOf('/Contents')
if ($contentsIdx -lt 0) { Write-Error 'Contents tag not found'; exit 13 }
$lt = $txt.IndexOf('<', $contentsIdx)
$gt = $txt.IndexOf('>', $lt)
if ($lt -lt 0 -or $gt -lt 0) { Write-Error 'Contents angle brackets not found'; exit 14 }

$placeholderLen = $gt - $lt - 1
$hex = ($signature | ForEach-Object { $_.ToString('x2') }) -join ''
if ($hex.Length -gt $placeholderLen) { Write-Error "Signature (hex length $($hex.Length)) larger than placeholder ($placeholderLen)"; exit 15 }
$hexPadded = $hex + ('0' * ($placeholderLen - $hex.Length))

$hexBytes = [System.Text.Encoding]::ASCII.GetBytes($hexPadded)
[Array]::Copy($hexBytes, 0, $bytes, $lt + 1, $hexBytes.Length)

[System.IO.File]::WriteAllBytes($outPath, $bytes)
Write-Output $outPath
