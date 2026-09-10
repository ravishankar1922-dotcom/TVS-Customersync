/**
 * Builds the "Outlook draft generator" PowerShell script — used by both the
 * legacy global endpoint (routes/emails.js GET /outlook-script) and the
 * Lot-scoped one (routes/lots.js GET /:lotId/emails/outlook-script).
 * Kept in one place so the two callers can never drift apart.
 *
 * mails: [{ to, subjectB64, bodyB64 }]
 * label: shown in the header comment + used to build the output filename
 *        (e.g. cfg.CYCLE_ID for the legacy flow, lot.lot_number for a Lot).
 */
function buildOutlookScript(mails, label) {
  const mailEntries = mails.map(m =>
    `  @{ To = '${m.to.replace(/'/g, "''")}'; SubjectB64 = '${m.subjectB64}'; BodyB64 = '${m.bodyB64}' }`
  ).join(",\n");

  const script = `# BalanceSync — Outlook draft generator
# Generated ${new Date().toISOString()} for ${label} (${mails.length} recipient(s))
#
# What this does: creates one DRAFT email per recipient in your Desktop
# Outlook's Drafts folder, using YOUR machine/mailbox to send from (so it
# isn't blocked the way cloud-server SMTP sometimes is against O365).
# Nothing is sent automatically — review each draft in Outlook, then send
# manually (or select all in Drafts and send in bulk once you're satisfied).
#
# To run: right-click this file -> "Run with PowerShell". If Windows blocks
# it, open Command Prompt in this folder and run:
#   powershell -ExecutionPolicy Bypass -File "BalanceSync_Outlook_Drafts_${label}.ps1"
#
# Requires: Desktop Outlook installed and signed in to the sending mailbox.

$mails = @(
${mailEntries}
)

Write-Host "Connecting to Outlook..." -ForegroundColor Cyan
$outlook = New-Object -ComObject Outlook.Application

$done = 0
foreach ($m in $mails) {
  try {
    $subject = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($m.SubjectB64))
    $body    = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($m.BodyB64))
    $mail = $outlook.CreateItem(0)  # olMailItem
    $mail.To = $m.To
    $mail.Subject = $subject
    $mail.HTMLBody = $body
    $mail.Save()  # saves to Drafts — does NOT send
    $done++
    Write-Host "  Drafted -> $($m.To)" -ForegroundColor Green
  } catch {
    Write-Host "  FAILED  -> $($m.To): $($_.Exception.Message)" -ForegroundColor Red
  }
}

Write-Host ""
Write-Host "Done. $done of $($mails.Count) draft(s) created in Outlook > Drafts." -ForegroundColor Cyan
Write-Host "Review them there, then send individually or select-all + send."
`;

  // UTF-8 BOM so Windows PowerShell 5.1 (which otherwise guesses the system
  // codepage for script files without a BOM) reads this as UTF-8 reliably.
  const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
  return Buffer.concat([bom, Buffer.from(script, 'utf8')]);
}

module.exports = { buildOutlookScript };
