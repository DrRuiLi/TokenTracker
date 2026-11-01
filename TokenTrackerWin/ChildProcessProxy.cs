using System.Net;

namespace TokenTrackerWin;

internal enum ChildProcessProxySource
{
    None,
    ExplicitEnvironment,
    WindowsSystem,
}

/// <summary>
/// Configures proxy variables for the bundled Node child without changing the
/// parent process or the user's environment. Loopback stays direct because the
/// Windows host and dashboard communicate with Node over 127.0.0.1.
/// </summary>
internal static class ChildProcessProxy
{
    private static readonly Uri HttpsProbe = new("https://chatgpt.com/");
    private static readonly Uri HttpProbe = new("http://example.com/");
    private static readonly string[] LoopbackHosts = ["localhost", "127.0.0.1", "::1"];

    internal static ChildProcessProxySource Configure(
        IDictionary<string, string?> environment,
        IWebProxy systemProxy)
    {
        var hadExplicitProxy = HasAnyProxy(environment);
        var systemProxyApplied = false;

        if (!HasProxyForScheme(environment, "HTTPS_PROXY", "https_proxy"))
        {
            var proxyUrl = ResolveProxy(systemProxy, HttpsProbe);
            if (proxyUrl is not null)
            {
                Set(environment, "HTTPS_PROXY", proxyUrl);
                systemProxyApplied = true;
            }
        }

        if (!HasProxyForScheme(environment, "HTTP_PROXY", "http_proxy"))
        {
            var proxyUrl = ResolveProxy(systemProxy, HttpProbe);
            if (proxyUrl is not null)
            {
                Set(environment, "HTTP_PROXY", proxyUrl);
                systemProxyApplied = true;
            }
        }

        if (!HasAnyProxy(environment)) return ChildProcessProxySource.None;

        Set(environment, "NODE_USE_ENV_PROXY", "1");
        EnsureLoopbackBypass(environment);
        return systemProxyApplied && !hadExplicitProxy
            ? ChildProcessProxySource.WindowsSystem
            : ChildProcessProxySource.ExplicitEnvironment;
    }

    private static bool HasAnyProxy(IDictionary<string, string?> environment)
        => HasValue(environment, "HTTPS_PROXY", "https_proxy")
           || HasValue(environment, "HTTP_PROXY", "http_proxy")
           || HasValue(environment, "ALL_PROXY", "all_proxy");

    private static bool HasProxyForScheme(
        IDictionary<string, string?> environment,
        string uppercaseName,
        string lowercaseName)
        => HasValue(environment, uppercaseName, lowercaseName)
           || HasValue(environment, "ALL_PROXY", "all_proxy");

    private static bool HasValue(
        IDictionary<string, string?> environment,
        params string[] names)
    {
        var key = FindKey(environment, names);
        return key is not null && !string.IsNullOrWhiteSpace(environment[key]);
    }

    private static string? ResolveProxy(IWebProxy systemProxy, Uri destination)
    {
        try
        {
            if (systemProxy.IsBypassed(destination)) return null;
            var proxy = systemProxy.GetProxy(destination);
            if (proxy is null || proxy == destination || !proxy.IsAbsoluteUri) return null;
            if (proxy.Scheme is not ("http" or "https") || string.IsNullOrWhiteSpace(proxy.Host))
                return null;
            return proxy.AbsoluteUri;
        }
        catch
        {
            // Proxy discovery is best-effort. Direct networking remains the fallback.
            return null;
        }
    }

    private static void EnsureLoopbackBypass(IDictionary<string, string?> environment)
    {
        var key = FindKey(environment, "NO_PROXY", "no_proxy") ?? "NO_PROXY";
        var existing = environment.TryGetValue(key, out var value) ? value : null;
        var entries = string.IsNullOrWhiteSpace(existing)
            ? new List<string>()
            : existing.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();

        foreach (var host in LoopbackHosts)
        {
            if (!entries.Contains(host, StringComparer.OrdinalIgnoreCase)) entries.Add(host);
        }
        environment[key] = string.Join(',', entries);
    }

    private static void Set(
        IDictionary<string, string?> environment,
        string name,
        string value)
    {
        var key = FindKey(environment, name) ?? name;
        environment[key] = value;
    }

    private static string? FindKey(
        IDictionary<string, string?> environment,
        params string[] names)
        => environment.Keys.FirstOrDefault(key =>
            names.Any(name => string.Equals(key, name, StringComparison.OrdinalIgnoreCase)));
}
