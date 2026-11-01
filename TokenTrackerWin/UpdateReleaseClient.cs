using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text.Json;

namespace TokenTrackerWin;

/// <summary>
/// Resolves a release without downloading or executing an installer. A throttled
/// REST API falls back to the official release redirect, with both assets pinned
/// to that tag. Kept UI-free so the HTTP flow can be tested without an app install.
/// </summary>
internal sealed class UpdateReleaseClient(HttpClient http, Func<DateTimeOffset>? utcNow = null)
{
    internal const string ReleasePageUrl = "https://github.com/xiufengsun/TokenTracker/releases/latest";
    internal const string SetupAssetName = "TokenTracker-Setup.exe";
    private const string ApiUrl = "https://api.github.com/repos/xiufengsun/TokenTracker/releases/latest";
    private const string TagPath = "/xiufengsun/TokenTracker/releases/tag/";
    private const string DownloadBase = "https://github.com/xiufengsun/TokenTracker/releases/download/";
    private readonly Func<DateTimeOffset> _utcNow = utcNow ?? (() => DateTimeOffset.UtcNow);
    private DateTimeOffset? _apiNotBefore;

    internal readonly record struct ReleaseInfo(string Version, string SetupUrl, long SetupSize, string? ChecksumsUrl);

    public DateTimeOffset? ApiRetryAt { get; private set; }
    public bool UsedFallback { get; private set; }

    public async Task<ReleaseInfo> FetchLatestAsync(CancellationToken cancellationToken = default)
    {
        UsedFallback = false;
        if (_apiNotBefore is not { } retryAt || retryAt <= _utcNow())
        {
            ApiRetryAt = null;
            using var request = new HttpRequestMessage(HttpMethod.Get, ApiUrl);
            request.Headers.Accept.ParseAdd("application/vnd.github+json");
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            Diag.Log("update", $"github api status {(int)response.StatusCode}");
            if (response.IsSuccessStatusCode)
                return await ReadApiReleaseAsync(response, cancellationToken);

            if (response.StatusCode is not (HttpStatusCode.Forbidden or HttpStatusCode.TooManyRequests))
                response.EnsureSuccessStatusCode();

            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            var exhausted = Header(response, "x-ratelimit-remaining") == "0";
            if (response.StatusCode != HttpStatusCode.TooManyRequests && !exhausted
                && response.Headers.RetryAfter is null
                && !body.Contains("rate limit", StringComparison.OrdinalIgnoreCase))
                response.EnsureSuccessStatusCode();

            ApiRetryAt = ResolveRetryAt(response, exhausted);
            _apiNotBefore = ApiRetryAt ?? _utcNow().AddMinutes(1);
            Diag.Log("update", $"github api rate limited; retry_at={_apiNotBefore:O}");
        }

        UsedFallback = true;
        Diag.Log("update", "checking official release page (api cooldown)");
        return await ReadReleasePageAsync(cancellationToken);
    }

    private static async Task<ReleaseInfo> ReadApiReleaseAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var root = doc.RootElement;
        var tag = root.TryGetProperty("tag_name", out var t) ? t.GetString() ?? "" : "";
        var version = ParseVersion(tag);
        string? setupUrl = null;
        long setupSize = 0;
        string? checksumsUrl = null;
        if (root.TryGetProperty("assets", out var assets) && assets.ValueKind == JsonValueKind.Array)
        {
            foreach (var asset in assets.EnumerateArray())
            {
                var name = asset.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
                if (!asset.TryGetProperty("browser_download_url", out var u)) continue;
                if (name.Equals(SetupAssetName, StringComparison.OrdinalIgnoreCase))
                {
                    setupUrl = u.GetString();
                    setupSize = asset.TryGetProperty("size", out var s) && s.TryGetInt64(out var size) ? size : 0;
                }
                else if (name.Equals(UpdateIntegrity.ChecksumsAssetName, StringComparison.OrdinalIgnoreCase))
                    checksumsUrl = u.GetString();
            }
        }

        if (string.IsNullOrWhiteSpace(setupUrl) || setupSize <= 0)
            throw new InvalidDataException("The release has no usable Windows installer asset.");
        return new ReleaseInfo(version, setupUrl, setupSize, checksumsUrl);
    }

    private async Task<ReleaseInfo> ReadReleasePageAsync(CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Head, ReleasePageUrl);
        request.Headers.Accept.ParseAdd("text/html");
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        Diag.Log("update", $"release page status {(int)response.StatusCode}");
        response.EnsureSuccessStatusCode();
        var uri = response.RequestMessage?.RequestUri;
        if (uri is null || uri.Scheme != Uri.UriSchemeHttps
            || !uri.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase) || !uri.IsDefaultPort
            || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0
            || !uri.AbsolutePath.StartsWith(TagPath, StringComparison.Ordinal))
            throw new InvalidDataException("The release page did not resolve to the official version tag.");

        var tag = uri.AbsolutePath[TagPath.Length..];
        var version = ParseVersion(tag);
        var setupUrl = DownloadBase + tag + "/" + SetupAssetName;
        var checksumsUrl = DownloadBase + tag + "/" + UpdateIntegrity.ChecksumsAssetName;
        using var setupRequest = new HttpRequestMessage(HttpMethod.Head, setupUrl);
        using var setupResponse = await http.SendAsync(setupRequest, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        Diag.Log("update", $"release installer metadata status {(int)setupResponse.StatusCode}");
        setupResponse.EnsureSuccessStatusCode();
        var setupSize = setupResponse.Content.Headers.ContentLength ?? 0;
        if (setupSize <= 0)
            throw new InvalidDataException("The release installer size is unavailable.");

        using var checksumsResponse = await http.GetAsync(checksumsUrl, cancellationToken);
        Diag.Log("update", $"release checksums status {(int)checksumsResponse.StatusCode}");
        checksumsResponse.EnsureSuccessStatusCode();
        var checksums = await checksumsResponse.Content.ReadAsStringAsync(cancellationToken);
        if (UpdateIntegrity.FindDigest(checksums, SetupAssetName) is null)
            throw new InvalidDataException("The release has no usable Windows installer checksum.");

        Diag.Log("update", $"official release page resolved version={version}");
        return new ReleaseInfo(version, setupUrl, setupSize, checksumsUrl);
    }

    private DateTimeOffset? ResolveRetryAt(HttpResponseMessage response, bool exhausted)
    {
        var now = _utcNow();
        DateTimeOffset? retryAt = response.Headers.RetryAfter?.Date;
        if (response.Headers.RetryAfter?.Delta is { } delta)
            retryAt = now + delta;
        if (exhausted && long.TryParse(Header(response, "x-ratelimit-reset"), NumberStyles.None,
                CultureInfo.InvariantCulture, out var epoch)
            && epoch is >= 0 and <= 253402300799)
        {
            var resetAt = DateTimeOffset.FromUnixTimeSeconds(epoch);
            if (retryAt is null || resetAt > retryAt) retryAt = resetAt;
        }
        return retryAt is { } candidate && candidate > now ? candidate : null;
    }

    private static string? Header(HttpResponseMessage response, string name)
        => response.Headers.TryGetValues(name, out var values) ? values.FirstOrDefault() : null;

    private static string ParseVersion(string tag)
    {
        var version = tag.StartsWith('v') ? tag[1..] : tag;
        if (!Version.TryParse(version, out var parsed) || parsed.Build < 0 || parsed.Revision >= 0)
            throw new InvalidDataException("The release tag is not a stable three-part version.");
        return version;
    }
}
