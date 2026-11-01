using System.Diagnostics;
using System.Net;
using Xunit;

namespace TokenTrackerWin;

public sealed class ChildProcessProxyTests
{
    [Fact]
    public void AcceptsProcessStartInfoChildEnvironment()
    {
        var startInfo = new ProcessStartInfo { UseShellExecute = false };
        var proxy = new StubProxy(_ => new Uri("http://127.0.0.1:7897"));

        var source = ChildProcessProxy.Configure(startInfo.Environment, proxy);

        Assert.Equal(ChildProcessProxySource.WindowsSystem, source);
        Assert.Equal("http://127.0.0.1:7897/", startInfo.Environment["HTTPS_PROXY"]);
    }

    [Fact]
    public void PreservesExplicitProxyAndAddsLoopbackBypass()
    {
        var environment = EnvironmentWith(
            ("HTTPS_PROXY", "http://explicit.test:7890"),
            ("NO_PROXY", "internal.test,127.0.0.1"));
        var proxy = new StubProxy(_ => throw new InvalidOperationException("must not replace HTTPS proxy"));

        var source = ChildProcessProxy.Configure(environment, proxy);

        Assert.Equal(ChildProcessProxySource.ExplicitEnvironment, source);
        Assert.Equal("http://explicit.test:7890", environment["HTTPS_PROXY"]);
        Assert.Equal("1", environment["NODE_USE_ENV_PROXY"]);
        Assert.Equal("internal.test,127.0.0.1,localhost,::1", environment["NO_PROXY"]);
    }

    [Fact]
    public void DerivesHttpAndHttpsProxiesFromWindowsSystemProxy()
    {
        var environment = EnvironmentWith();
        var proxy = new StubProxy(destination => destination.Scheme == "https"
            ? new Uri("http://127.0.0.1:7897")
            : new Uri("http://127.0.0.1:7898"));

        var source = ChildProcessProxy.Configure(environment, proxy);

        Assert.Equal(ChildProcessProxySource.WindowsSystem, source);
        Assert.Equal("http://127.0.0.1:7897/", environment["HTTPS_PROXY"]);
        Assert.Equal("http://127.0.0.1:7898/", environment["HTTP_PROXY"]);
        Assert.Equal("1", environment["NODE_USE_ENV_PROXY"]);
        Assert.Equal("localhost,127.0.0.1,::1", environment["NO_PROXY"]);
    }

    [Fact]
    public void LeavesEnvironmentDirectWhenDestinationsAreBypassed()
    {
        var environment = EnvironmentWith();
        var proxy = new StubProxy(destination => destination, isBypassed: true);

        var source = ChildProcessProxy.Configure(environment, proxy);

        Assert.Equal(ChildProcessProxySource.None, source);
        Assert.DoesNotContain("HTTP_PROXY", environment.Keys);
        Assert.DoesNotContain("HTTPS_PROXY", environment.Keys);
        Assert.DoesNotContain("NODE_USE_ENV_PROXY", environment.Keys);
        Assert.DoesNotContain("NO_PROXY", environment.Keys);
    }

    [Fact]
    public void IgnoresUnsupportedOrFailingSystemProxyDiscovery()
    {
        var unsupportedEnvironment = EnvironmentWith();
        var unsupported = new StubProxy(_ => new Uri("socks5://127.0.0.1:1080"));
        Assert.Equal(
            ChildProcessProxySource.None,
            ChildProcessProxy.Configure(unsupportedEnvironment, unsupported));

        var failingEnvironment = EnvironmentWith();
        var failing = new StubProxy(_ => throw new InvalidOperationException("discovery failed"));
        Assert.Equal(
            ChildProcessProxySource.None,
            ChildProcessProxy.Configure(failingEnvironment, failing));
    }

    private static Dictionary<string, string?> EnvironmentWith(
        params (string Key, string Value)[] entries)
        => entries.ToDictionary(entry => entry.Key, entry => (string?)entry.Value, StringComparer.OrdinalIgnoreCase);

    private sealed class StubProxy(
        Func<Uri, Uri?> resolver,
        bool isBypassed = false) : IWebProxy
    {
        public ICredentials? Credentials { get; set; }

        public Uri? GetProxy(Uri destination) => resolver(destination);

        public bool IsBypassed(Uri host) => isBypassed;
    }
}
