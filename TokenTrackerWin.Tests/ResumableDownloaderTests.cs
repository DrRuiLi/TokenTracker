using System.Net;
using System.Net.Http.Headers;
using Xunit;

namespace TokenTrackerWin;

public sealed class ResumableDownloaderTests : IDisposable
{
    private readonly string _tempDirectory = Path.Combine(
        Path.GetTempPath(),
        "TokenTrackerWinTests",
        Guid.NewGuid().ToString("N"));

    public ResumableDownloaderTests() => Directory.CreateDirectory(_tempDirectory);

    public void Dispose()
    {
        try { Directory.Delete(_tempDirectory, recursive: true); } catch { }
    }

    [Fact]
    public async Task RetriesInterruptedChunkFromLastPersistedOffset()
    {
        var payload = "abcdefghijkl"u8.ToArray();
        var ranges = new List<string?>();
        var ifRanges = new List<string?>();
        var call = 0;
        using var client = new HttpClient(new ScriptedHandler(request =>
        {
            ranges.Add(request.Headers.Range?.ToString());
            ifRanges.Add(request.Headers.IfRange?.ToString());
            return call++ switch
            {
                0 => Partial(payload[0..4], 0, 3),
                1 => Partial(new ThrowingContent(payload[4..6]), 4, 7),
                2 => Partial(payload[6..10], 6, 9),
                _ => Partial(payload[10..12], 10, 11),
            };
        }));
        var destination = Path.Combine(_tempDirectory, "update.exe");
        var downloader = new ResumableDownloader(
            client,
            chunkSize: 4,
            maxRetries: 2,
            retryDelays: [TimeSpan.Zero, TimeSpan.Zero]);

        var result = await downloader.DownloadAsync(
            new Uri("https://example.test/update.exe"),
            destination,
            payload.Length);

        Assert.Equal(destination, result);
        Assert.Equal(payload, await File.ReadAllBytesAsync(destination));
        Assert.Equal(["bytes=0-3", "bytes=4-7", "bytes=6-9", "bytes=10-11"], ranges);
        Assert.Equal([null, "\"asset-v1\"", "\"asset-v1\"", "\"asset-v1\""], ifRanges);
    }

    [Fact]
    public async Task NextDownloaderResumesPartialAndAcceptsFullFallback()
    {
        var payload = "abcdefghijkl"u8.ToArray();
        var firstCall = 0;
        using var firstClient = new HttpClient(new ScriptedHandler(_ =>
            firstCall++ == 0
                ? Partial(payload[0..4], 0, 3)
                : Partial(new ThrowingContent(payload[4..6]), 4, 7)));
        var destination = Path.Combine(_tempDirectory, "update.exe");
        var firstDownloader = new ResumableDownloader(
            firstClient,
            chunkSize: 4,
            maxRetries: 0,
            retryDelays: []);

        await Assert.ThrowsAsync<IOException>(() => firstDownloader.DownloadAsync(
            new Uri("https://example.test/update.exe"),
            destination,
            payload.Length));

        Assert.Equal(payload[0..6], await File.ReadAllBytesAsync(destination + ".part"));

        string? observedRange = null;
        string? observedIfRange = null;
        using var secondClient = new HttpClient(new ScriptedHandler(request =>
        {
            observedRange = request.Headers.Range?.ToString();
            observedIfRange = request.Headers.IfRange?.ToString();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new ByteArrayContent(payload),
            };
        }));
        var secondDownloader = new ResumableDownloader(
            secondClient,
            chunkSize: 4,
            maxRetries: 0,
            retryDelays: []);

        await secondDownloader.DownloadAsync(
            new Uri("https://example.test/update.exe"),
            destination,
            payload.Length);

        Assert.Equal("bytes=6-9", observedRange);
        Assert.Equal("\"asset-v1\"", observedIfRange);
        Assert.Equal(payload, await File.ReadAllBytesAsync(destination));
        Assert.False(File.Exists(destination + ".part"));
    }

    [Fact]
    public async Task RestartsWhenPartialResponseETagChanges()
    {
        var firstPayload = "abcdefghijkl"u8.ToArray();
        var replacementPayload = "mnopqrstuvwx"u8.ToArray();
        var ranges = new List<string?>();
        var call = 0;
        using var client = new HttpClient(new ScriptedHandler(request =>
        {
            ranges.Add(request.Headers.Range?.ToString());
            return call++ switch
            {
                0 => Partial(firstPayload[0..4], 0, 3, "\"asset-v1\""),
                1 => Partial(replacementPayload[4..8], 4, 7, "\"asset-v2\""),
                2 => Partial(replacementPayload[0..4], 0, 3, "\"asset-v2\""),
                3 => Partial(replacementPayload[4..8], 4, 7, "\"asset-v2\""),
                _ => Partial(replacementPayload[8..12], 8, 11, "\"asset-v2\""),
            };
        }));
        var destination = Path.Combine(_tempDirectory, "update.exe");
        var downloader = new ResumableDownloader(
            client,
            chunkSize: 4,
            maxRetries: 2,
            retryDelays: [TimeSpan.Zero, TimeSpan.Zero]);

        await downloader.DownloadAsync(
            new Uri("https://example.test/update.exe"),
            destination,
            replacementPayload.Length);

        Assert.Equal(replacementPayload, await File.ReadAllBytesAsync(destination));
        Assert.Equal(["bytes=0-3", "bytes=4-7", "bytes=0-3", "bytes=4-7", "bytes=8-11"], ranges);
    }

    private static HttpResponseMessage Partial(
        byte[] data,
        long from,
        long to,
        string etag = "\"asset-v1\"")
        => Partial(new ByteArrayContent(data), from, to, etag);

    private static HttpResponseMessage Partial(
        HttpContent content,
        long from,
        long to,
        string etag = "\"asset-v1\"")
    {
        content.Headers.ContentRange = new ContentRangeHeaderValue(from, to, 12);
        return new HttpResponseMessage(HttpStatusCode.PartialContent)
        {
            Headers = { ETag = new EntityTagHeaderValue(etag) },
            Content = content,
        };
    }

    private sealed class ScriptedHandler(Func<HttpRequestMessage, HttpResponseMessage> handler)
        : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
            => Task.FromResult(handler(request));
    }

    private sealed class ThrowingContent(byte[] prefix) : HttpContent
    {
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context)
            => throw new NotSupportedException();

        protected override bool TryComputeLength(out long length)
        {
            length = prefix.Length + 2;
            return true;
        }

        protected override Task<Stream> CreateContentReadStreamAsync()
            => Task.FromResult<Stream>(new ThrowingStream(prefix));
    }

    private sealed class ThrowingStream(byte[] prefix) : MemoryStream(prefix)
    {
        private bool _thrown;

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (Position < Length) return base.ReadAsync(buffer, cancellationToken);
            if (!_thrown)
            {
                _thrown = true;
                throw new IOException("simulated connection loss");
            }
            return ValueTask.FromResult(0);
        }
    }
}
