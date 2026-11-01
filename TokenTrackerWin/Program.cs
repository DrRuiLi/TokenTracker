namespace TokenTrackerWin;

internal static class Program
{
    // Stable per-user mutex name so subsequent launches reach the tray instance.
    private const string SingleInstanceMutexName = "TokenTracker.Windows.Tray.SingleInstance";

    [STAThread]
    private static void Main(string[] args)
    {
        InstallExceptionGuards();

        // Windows launches us with the full tokentracker://… URL as an argument when a
        // deep link fires (OAuth or billing return). Extract it if present.
        var deepLink = NativeReturnUri.FindArgument(args);
        var launchedAtStartup = args.Any(a =>
            string.Equals(a, LaunchAtStartup.StartupArgument, StringComparison.OrdinalIgnoreCase));
        Diag.Log("program", $"Main argc={args.Length} deepLinkPresent={deepLink is not null} deepLinkLen={deepLink?.Length ?? 0} startup={launchedAtStartup}");

        using var mutex = new Mutex(initiallyOwned: true, SingleInstanceMutexName, out var isNew);
        Diag.Log("program", $"mutex isNew={isNew}");
        if (!isNew)
        {
            // Forward deep links or an explicit manual launch to the live instance.
            // A redundant Windows startup launch must stay quiet.
            if (deepLink is not null)
            {
                var ok = SingleInstance.TryForwardToPrimary(deepLink);
                Diag.Log("program", $"forwarded deepLink to primary: {ok}");
            }
            else if (!launchedAtStartup)
            {
                var ok = SingleInstance.TryForwardToPrimary(SingleInstance.ActivateMessage);
                Diag.Log("program", $"forwarded activation to primary: {ok}");
            }
            return;
        }

        // Primary instance: make tokentracker:// point at this exe so the OAuth callback
        // (in the system browser) can deep-link the code back to us.
        UrlProtocol.EnsureRegistered();

        // Set per-monitor DPI awareness before WPF can create any HWNDs.
        ApplicationConfiguration.Initialize();

        // A WPF Application instance gives the (WPF) dashboard window its resource /
        // dispatcher context. We never call its Run(); the WinForms message pump below
        // drives the shared STA thread (and the WPF Dispatcher rides on it). Explicit
        // shutdown mode so WPF doesn't tear itself down when the window is hidden.
        var wpfApp = new System.Windows.Application { ShutdownMode = System.Windows.ShutdownMode.OnExplicitShutdown };
        TrayApplicationContext? trayContext = null;
        wpfApp.DispatcherUnhandledException += (_, e) =>
        {
            var shuttingDown = wpfApp.Dispatcher.HasShutdownStarted || wpfApp.Dispatcher.HasShutdownFinished;
            var recovery = DispatcherExceptionPolicy.Classify(e.Exception, shuttingDown);
            if (recovery == DispatcherExceptionPolicy.RecoveryKind.IgnoreAfterShutdown
                || recovery == DispatcherExceptionPolicy.RecoveryKind.IgnoreCancellation)
            {
                Diag.Log("program", $"WPF dispatcher exception absorbed during window teardown: {e.Exception}");
                // These callbacks have no useful work left after cancellation or
                // dispatcher teardown, so allowing WPF to continue is intentional.
                e.Handled = true;
                return;
            }

            if (recovery == DispatcherExceptionPolicy.RecoveryKind.RecreateDashboardWebView
                && trayContext?.RecoverDashboardWebView(e.Exception) == true)
            {
                Diag.Log("program", $"WPF dispatcher exception recovered by recreating WebView2: {e.Exception}");
                e.Handled = true;
                return;
            }

            // Do not turn an unknown dispatcher failure into a silently-running
            // but corrupted tray process. Leaving Handled=false preserves WPF's
            // normal shutdown path after the diagnostic has been recorded.
            Diag.Log("program", $"WPF dispatcher exception unhandled: {e.Exception}");
        };

        // Accept forwarded launches before tray initialization can block on I/O.
        // The dispatcher runs these callbacks after trayContext is assigned and
        // the WinForms message pump starts, so early launches are not discarded.
        using var listenerCts = new CancellationTokenSource();
        SingleInstance.StartListener(
            () => wpfApp.Dispatcher.BeginInvoke(new Action(() => trayContext!.ActivateDashboard())),
            payload => wpfApp.Dispatcher.BeginInvoke(new Action(() => trayContext!.HandleDeepLink(payload))),
            listenerCts.Token);

        // Show the desktop pet on a normal launch (manual run or post-install), but stay
        // quietly in the tray when Windows auto-starts us at login or when we were only
        // spun up to relay an OAuth deep link (the pet then restores only if it was open
        // last exit). Dashboard activation below is independent of the pet preference.
        var showPetOnLaunch = deepLink is null && !launchedAtStartup;
        var ctx = new TrayApplicationContext(showPetOnLaunch);
        trayContext = ctx;

        // Manual launches always show the dashboard; startup and deep links keep
        // their own behavior. Defer activation until the message pump is running.
        if (deepLink is not null) ctx.HandleDeepLink(deepLink);
        else if (!launchedAtStartup)
            wpfApp.Dispatcher.BeginInvoke(new Action(ctx.ActivateDashboard));

        Application.Run(ctx);

        listenerCts.Cancel();
        GC.KeepAlive(mutex);
    }

    private static void InstallExceptionGuards()
    {
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            Diag.Log("program", $"unhandled exception terminating={e.IsTerminating}: {e.ExceptionObject}");
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            Diag.Log("program", $"unobserved task exception: {e.Exception}");
            e.SetObserved();
        };
        System.Windows.Forms.Application.SetUnhandledExceptionMode(
            System.Windows.Forms.UnhandledExceptionMode.CatchException);
        System.Windows.Forms.Application.ThreadException += (_, e) =>
            Diag.Log("program", $"WinForms UI exception: {e}");
    }

}
