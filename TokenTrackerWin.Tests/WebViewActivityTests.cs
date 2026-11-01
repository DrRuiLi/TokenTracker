using Xunit;

namespace TokenTrackerWin;

public class WebViewActivityTests
{
    [Fact]
    public async Task HiddenDocumentSleepsAndVisibleDocumentResumes()
    {
        var visible = true;
        var sleeps = 0;
        var resumes = 0;
        using var activity = new WebViewActivity(value => visible = value,
            () => resumes++, () => { Assert.False(visible); sleeps++; return Task.FromResult(true); }, _ => { });
        activity.Update(false);
        await activity.WhenSettled;
        Assert.Equal(1, sleeps);
        activity.Update(true);
        Assert.True(visible);
        Assert.Equal(1, resumes);
    }

    [Fact]
    public async Task ReopenDuringPendingSuspendResumesAgainAfterTheLateCompletion()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finish = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var resumes = 0;
        using var activity = new WebViewActivity(_ => { }, () => resumes++,
            () => { started.SetResult(); return finish.Task; }, _ => { });
        activity.Update(false);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        activity.Update(true);
        Assert.Equal(1, resumes);
        finish.SetResult(true);
        await activity.WhenSettled;
        Assert.Equal(2, resumes);
    }

    [Fact]
    public async Task HiddenOAuthStaysAwakeUntilTheExchangeCompletes()
    {
        var sleeps = 0;
        var resumes = 0;
        using var activity = new WebViewActivity(_ => { }, () => resumes++,
            () => { sleeps++; return Task.FromResult(true); }, _ => { });
        activity.Update(false, keepRunning: true);
        await activity.WhenSettled;
        Assert.Equal(0, sleeps);
        Assert.Equal(1, resumes);
        activity.Update(false);
        await activity.WhenSettled;
        Assert.Equal(1, sleeps);
    }

    [Fact]
    public async Task FailureCanRetryAndOldDisposedControllerCannotResumeItsReplacement()
    {
        var calls = 0;
        using var retry = new WebViewActivity(_ => { }, () => { },
            () => ++calls == 1 ? Task.FromException<bool>(new InvalidOperationException("renderer exited")) : Task.FromResult(true), _ => { });
        retry.Update(false);
        await retry.WhenSettled;
        retry.Update(false);
        await retry.WhenSettled;
        Assert.Equal(2, calls);

        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finish = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var resumes = 0;
        var old = new WebViewActivity(_ => { }, () => resumes++,
            () => { started.SetResult(); return finish.Task; }, _ => { });
        old.Update(false);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        old.Update(true);
        old.Dispose();
        finish.SetResult(true);
        await old.WhenSettled;
        old.Update(true);
        Assert.Equal(1, resumes);
    }
}
