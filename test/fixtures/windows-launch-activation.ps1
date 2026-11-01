param([Parameter(Mandatory = $true)][string]$SourcePath)
$ErrorActionPreference = 'Stop'

$source = [IO.File]::ReadAllText($SourcePath)
$pipeDeclaration = 'private const string PipeName = "TokenTracker.Windows.Tray.DeepLink";'
if (-not $source.Contains($pipeDeclaration)) {
    throw 'Cannot isolate the production pipe name for the regression test.'
}
# Exercise the production transport without contacting a user's running tray app.
$testPipe = 'TokenTracker.ActivationTest.' + [Guid]::NewGuid().ToString('N')
$source = $source.Replace($pipeDeclaration, 'private const string PipeName = "' + $testPipe + '";')
$source = "using System;`nusing System.Threading;`nusing System.Threading.Tasks;`n" + $source
$harness = @'
public static class ActivationRegression
{
    public static async Task<string> RunAsync()
    {
        using var cts = new CancellationTokenSource();
        using var delivered = new SemaphoreSlim(0);
        var deepLinks = new System.Collections.Concurrent.ConcurrentQueue<string>();
        var activations = 0;
        SingleInstance.StartListener(
            () => { Interlocked.Increment(ref activations); delivered.Release(); },
            payload => { deepLinks.Enqueue(payload); delivered.Release(); },
            cts.Token);
        try
        {
            async Task SendAsync(string payload)
            {
                if (!SingleInstance.TryForwardToPrimary(payload))
                    throw new Exception("Could not forward the test payload.");
                if (!await delivered.WaitAsync(TimeSpan.FromSeconds(5)))
                    throw new Exception("The named-pipe handler did not receive the payload.");
            }

            await SendAsync(SingleInstance.ActivateMessage);
            if (activations != 1 || !deepLinks.IsEmpty)
                throw new Exception("Manual activation must not invoke deep-link handling.");

            var oauth = "tokentracker://auth?code=activation-regression";
            await SendAsync(oauth);
            if (activations != 1 || !deepLinks.TryDequeue(out var received) || received != oauth)
                throw new Exception("OAuth payload was changed or treated as activation.");

            var billing = "tokentracker://billing-return?order=activation-regression";
            await SendAsync(billing);
            if (activations != 1 || !deepLinks.TryDequeue(out received) || received != billing)
                throw new Exception("Billing payload was changed or treated as activation.");

            if (!SingleInstance.TryForwardToPrimary("   "))
                throw new Exception("Could not send a blank test payload.");
            await SendAsync(SingleInstance.ActivateMessage);
            await SendAsync(SingleInstance.ActivateMessage);
            if (activations != 3 || !deepLinks.IsEmpty || delivered.CurrentCount != 0)
                throw new Exception("Blank messages or repeated activation were routed incorrectly.");
            return "PASS: activation and deep links remain distinct";
        }
        finally
        {
            cts.Cancel();
        }
    }
}
'@
Add-Type -TypeDefinition ($source + "`n" + $harness)
[TokenTrackerWin.ActivationRegression]::RunAsync().GetAwaiter().GetResult()
