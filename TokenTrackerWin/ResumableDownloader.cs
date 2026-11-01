using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace TokenTrackerWin;

/// <summary>
/// Downloads an immutable release asset into a persistent <c>.part</c> file.
/// Completed ranges survive transient failures and app restarts; an ETag-backed
/// If-Range request prevents bytes from different assets being combined.
/// </summary>
internal sealed class ResumableDownloader
{
    private readonly HttpClient _http;
    private readonly int _chunkSize;
    private readonly int _maxRetries;
    private readonly IReadOnlyList<TimeSpan> _retryDelays;

    public ResumableDownloader(
        HttpClient http,
        int chunkSize = 8 * 1024 * 1024,
        int maxRetries = 3,
        IReadOnlyList<TimeSpan>? retryDelays = null)
    {
        _http = http;
        _chunkSize = Math.Max(1, chunkSize);
        _maxRetries = Math.Max(0, maxRetries);
        _retryDelays = retryDelays ??
            [TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(3), TimeSpan.FromSeconds(8)];
    }

    public async Task<string> DownloadAsync(
        Uri source,
        string destination,
        long expectedSize,
        Action<long, long>? onProgress = null,
        Action<int, Exception>? onRetry = null,
        CancellationToken cancellationToken = default)
    {
        if (expectedSize <= 0) throw new ArgumentOutOfRangeException(nameof(expectedSize));

        var directory = Path.GetDirectoryName(destination)
            ?? throw new ArgumentException("Destination must have a parent directory", nameof(destination));
        Directory.CreateDirectory(directory);

        var partialPath = destination + ".part";
        var metadataPath = destination + ".resume.json";

        if (File.Exists(destination))
        {
            if (new FileInfo(destination).Length == expectedSize) return destination;
            File.Delete(destination);
        }

        var metadata = LoadMetadata(metadataPath);
        var partialLength = File.Exists(partialPath) ? new FileInfo(partialPath).Length : 0;
        if (metadata is null
            || metadata.SourceUrl != source.AbsoluteUri
            || metadata.ExpectedSize != expectedSize
            || partialLength < 0
            || partialLength > expectedSize)
        {
            ResetPartial(partialPath, metadataPath);
            metadata = new ResumeMetadata(source.AbsoluteUri, expectedSize, null);
            partialLength = 0;
        }

        onProgress?.Invoke(partialLength, expectedSize);

        while (partialLength < expectedSize)
        {
            var retry = 0;
            while (true)
            {
                try
                {
                    metadata = await DownloadNextChunkAsync(
                        source,
                        partialPath,
                        metadataPath,
                        expectedSize,
                        partialLength,
                        metadata,
                        onProgress,
                        cancellationToken);
                    break;
                }
                catch (AssetChangedException ex) when (retry < _maxRetries)
                {
                    // A compliant If-Range server returns 200 when the asset
                    // changes. If a CDN incorrectly returns 206 with a new
                    // ETag, discard every old byte before retrying from zero.
                    ResetPartial(partialPath, metadataPath);
                    metadata = new ResumeMetadata(source.AbsoluteUri, expectedSize, ex.NewETag);
                    SaveMetadata(metadataPath, metadata);
                    partialLength = 0;
                    retry += 1;
                    onRetry?.Invoke(retry, ex);
                    var delay = RetryDelay(retry);
                    if (delay > TimeSpan.Zero) await Task.Delay(delay, cancellationToken);
                }
                catch (Exception ex) when (IsTransient(ex, cancellationToken) && retry < _maxRetries)
                {
                    retry += 1;
                    onRetry?.Invoke(retry, ex);
                    var delay = RetryDelay(retry);
                    if (delay > TimeSpan.Zero) await Task.Delay(delay, cancellationToken);
                    partialLength = File.Exists(partialPath) ? new FileInfo(partialPath).Length : 0;
                }
            }

            partialLength = File.Exists(partialPath) ? new FileInfo(partialPath).Length : 0;
            if (partialLength > expectedSize)
            {
                ResetPartial(partialPath, metadataPath);
                throw new InvalidDataException("Downloaded update exceeds the expected size.");
            }
        }

        if (partialLength != expectedSize)
            throw new InvalidDataException($"Downloaded {partialLength} bytes, expected {expectedSize}.");

        File.Move(partialPath, destination, overwrite: true);
        TryDelete(metadataPath);
        onProgress?.Invoke(expectedSize, expectedSize);
        return destination;
    }

    private async Task<ResumeMetadata> DownloadNextChunkAsync(
        Uri source,
        string partialPath,
        string metadataPath,
        long expectedSize,
        long offset,
        ResumeMetadata metadata,
        Action<long, long>? onProgress,
        CancellationToken cancellationToken)
    {
        var end = Math.Min(expectedSize - 1, offset + _chunkSize - 1);
        using var request = new HttpRequestMessage(HttpMethod.Get, source);
        request.Headers.Range = new RangeHeaderValue(offset, end);
        if (!string.IsNullOrWhiteSpace(metadata.ETag))
            request.Headers.IfRange = new RangeConditionHeaderValue(EntityTagHeaderValue.Parse(metadata.ETag));

        using var response = await _http.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);

        if (response.StatusCode == HttpStatusCode.RequestedRangeNotSatisfiable)
        {
            var localSize = File.Exists(partialPath) ? new FileInfo(partialPath).Length : 0;
            if (localSize == expectedSize) return metadata;
            ResetPartial(partialPath, metadataPath);
            throw new IOException("Update server rejected the saved download range.");
        }

        var append = response.StatusCode == HttpStatusCode.PartialContent;
        if (append)
        {
            var range = response.Content.Headers.ContentRange;
            if (range?.From != offset || range.To is null || range.To > end)
                throw new InvalidDataException("Update server returned an unexpected byte range.");
            if (range.Length is long total && total != expectedSize)
            {
                ResetPartial(partialPath, metadataPath);
                throw new InvalidDataException("Update asset changed while it was downloading.");
            }
            var responseETag = response.Headers.ETag?.ToString();
            if (!string.IsNullOrWhiteSpace(metadata.ETag)
                && !string.IsNullOrWhiteSpace(responseETag)
                && !string.Equals(metadata.ETag, responseETag, StringComparison.Ordinal))
                throw new AssetChangedException(responseETag);
        }
        else if (response.StatusCode == HttpStatusCode.OK)
        {
            // If-Range deliberately yields 200 when the asset changed, and some
            // servers simply ignore Range. Either way the response is a full file.
            offset = 0;
            end = expectedSize - 1;
        }
        else
        {
            response.EnsureSuccessStatusCode();
            throw new InvalidDataException($"Unexpected update response {(int)response.StatusCode}.");
        }

        var etag = response.Headers.ETag?.ToString() ?? metadata.ETag;
        metadata = new ResumeMetadata(source.AbsoluteUri, expectedSize, etag);
        SaveMetadata(metadataPath, metadata);

        await using var input = await response.Content.ReadAsStreamAsync(cancellationToken);
        await using var output = new FileStream(
            partialPath,
            append ? FileMode.Append : FileMode.Create,
            FileAccess.Write,
            FileShare.None,
            bufferSize: 81920,
            useAsync: true);

        var buffer = new byte[81920];
        var received = offset;
        int read;
        while ((read = await input.ReadAsync(buffer.AsMemory(), cancellationToken)) > 0)
        {
            await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            received += read;
            onProgress?.Invoke(received, expectedSize);
        }
        await output.FlushAsync(cancellationToken);

        var savedLength = new FileInfo(partialPath).Length;
        var expectedAfterResponse = append ? end + 1 : expectedSize;
        if (savedLength != expectedAfterResponse)
            throw new IOException($"Update response ended at {savedLength} bytes; expected {expectedAfterResponse}.");

        return metadata;
    }

    private TimeSpan RetryDelay(int retry)
    {
        if (_retryDelays.Count == 0) return TimeSpan.Zero;
        return _retryDelays[Math.Min(retry - 1, _retryDelays.Count - 1)];
    }

    private static bool IsTransient(Exception exception, CancellationToken cancellationToken)
        => exception is IOException
            or HttpRequestException
            || (exception is TaskCanceledException && !cancellationToken.IsCancellationRequested);

    private static ResumeMetadata? LoadMetadata(string path)
    {
        if (!File.Exists(path)) return null;
        try
        {
            return JsonSerializer.Deserialize<ResumeMetadata>(File.ReadAllText(path));
        }
        catch
        {
            return null;
        }
    }

    private static void SaveMetadata(string path, ResumeMetadata metadata)
    {
        var temporaryPath = path + ".tmp";
        File.WriteAllText(temporaryPath, JsonSerializer.Serialize(metadata));
        File.Move(temporaryPath, path, overwrite: true);
    }

    private static void ResetPartial(string partialPath, string metadataPath)
    {
        TryDelete(partialPath);
        TryDelete(metadataPath);
        TryDelete(metadataPath + ".tmp");
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }

    private sealed record ResumeMetadata(string SourceUrl, long ExpectedSize, string? ETag);

    private sealed class AssetChangedException(string? newETag)
        : IOException("Update asset ETag changed during a ranged download.")
    {
        public string? NewETag { get; } = newETag;
    }
}
