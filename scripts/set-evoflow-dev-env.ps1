# Set EVOFLOW_HOME to .evoflow-dev for development environment
$targetPath = Join-Path $env:USERPROFILE ".evoflow-dev"
[System.Environment]::SetEnvironmentVariable("EVOFLOW_HOME", $targetPath, "User")

# Disable verbose debug trace logs (keep only gateway logs)
$debugLogs = @(
    "EVOFLOW_COMPACTION_TRACE_LOG",
    "EVOFLOW_THREAD_RUN_QUEUE_LOG",
    "EVOFLOW_GOAL_TRACE_LOG",
    "EVOFLOW_TOOL_APPROVAL_TRACE_LOG",
    "EVOFLOW_SUBTASK_STREAM_TRACE",
    "EVOFLOW_EXTERNAL_MEMORY_LOG",
    "EVOFLOW_STARTUP_TRACE",
    "EVOFLOW_RUN_LATENCY_VERBOSE"
)
foreach ($var in $debugLogs) {
    [System.Environment]::SetEnvironmentVariable($var, "0", "User")
}

Write-Host "EVOFLOW_HOME has been set to: $targetPath"
Write-Host ""
Write-Host "Disabled debug trace logs:"
$debugLogs | ForEach-Object { Write-Host "  - $_=0" }
Write-Host ""
Write-Host "Current value (current session):"
[System.Environment]::GetEnvironmentVariable("EVOFLOW_HOME", "User")
