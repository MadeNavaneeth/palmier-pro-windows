npm run typecheck
if ($LASTEXITCODE -ne 0) { exit 1 }
npm run lint 2>&1 | Select-Object -Last 2
npm test 2>&1 | Out-File "$env:TEMP\f14.log" -Encoding utf8
Select-String -Path "$env:TEMP\f14.log" -Pattern 'Tests ' | Select-Object -First 1
npm run ui:probe 2>&1 | Select-Object -Last 5
