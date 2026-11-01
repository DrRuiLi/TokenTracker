import Foundation

/// Downloads immutable release assets in bounded ranges and persists completed
/// chunks to a `.part` file. A failed chunk is retried, while earlier chunks
/// survive both network failures and application restarts.
final class ResumableDownloader: NSObject, URLSessionDownloadDelegate {
    private struct ResumeMetadata: Codable {
        let sourceURL: String
        let expectedSize: Int64
        let etag: String?
    }

    private enum DownloadError: LocalizedError {
        case invalidRange
        case assetChanged
        case incomplete(expected: Int64, actual: Int64)
        case unexpectedStatus(Int)

        var errorDescription: String? {
            switch self {
            case .invalidRange:
                return "The update server returned an invalid byte range."
            case .assetChanged:
                return "The update asset changed while it was downloading."
            case .incomplete(let expected, let actual):
                return "The update download ended at \(actual) bytes; expected \(expected)."
            case .unexpectedStatus(let status):
                return "The update server returned HTTP \(status)."
            }
        }
    }

    private let destinationURL: URL
    private let partialURL: URL
    private let metadataURL: URL
    private let expectedSize: Int64
    private let configuration: URLSessionConfiguration
    private let chunkSize: Int64
    private let maxRetries: Int
    private let retryDelays: [TimeInterval]
    private let callbackQueue: DispatchQueue
    private let onProgress: (Int64, Int64) -> Void
    private let onRetry: (Int, Error) -> Void
    private let onComplete: (Result<URL, Error>) -> Void

    private let delegateQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.name = "TokenTracker.ResumableDownloader"
        queue.maxConcurrentOperationCount = 1
        queue.qualityOfService = .utility
        return queue
    }()

    private var session: URLSession?
    private var sourceURL: URL?
    private var metadata: ResumeMetadata?
    private var currentOffset: Int64 = 0
    private var currentEnd: Int64 = 0
    private var retryCount = 0
    private var chunkSucceeded = false
    private var shouldFinalize = false
    private var shouldRestart = false
    private var processingError: Error?
    private var completionCalled = false

    init(
        destinationURL: URL,
        expectedSize: Int64,
        configuration: URLSessionConfiguration = .default,
        chunkSize: Int64 = 8 * 1024 * 1024,
        maxRetries: Int = 3,
        retryDelays: [TimeInterval] = [1, 3, 8],
        callbackQueue: DispatchQueue = .main,
        onProgress: @escaping (Int64, Int64) -> Void,
        onRetry: @escaping (Int, Error) -> Void,
        onComplete: @escaping (Result<URL, Error>) -> Void
    ) {
        self.destinationURL = destinationURL
        self.partialURL = destinationURL.appendingPathExtension("part")
        self.metadataURL = destinationURL.appendingPathExtension("resume.json")
        self.expectedSize = expectedSize
        self.configuration = configuration
        self.chunkSize = max(1, chunkSize)
        self.maxRetries = max(0, maxRetries)
        self.retryDelays = retryDelays
        self.callbackQueue = callbackQueue
        self.onProgress = onProgress
        self.onRetry = onRetry
        self.onComplete = onComplete
    }

    func start(url: URL) {
        delegateQueue.addOperation { [weak self] in
            self?.startOnDelegateQueue(url: url)
        }
    }

    private func startOnDelegateQueue(url: URL) {
        guard expectedSize > 0 else {
            completeOnce(.failure(DownloadError.incomplete(expected: expectedSize, actual: 0)))
            return
        }

        sourceURL = url
        do {
            if fileSize(at: destinationURL) == expectedSize {
                completeOnce(.success(destinationURL))
                return
            }
            try? FileManager.default.removeItem(at: destinationURL)
            try prepareResumeState(url: url)
            let saved = fileSize(at: partialURL)
            reportProgress(saved)
            if saved == expectedSize {
                try finalizeDownload()
                return
            }

            session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
            startNextChunk()
        } catch {
            completeOnce(.failure(error))
        }
    }

    private func prepareResumeState(url: URL) throws {
        let savedMetadata: ResumeMetadata? = {
            guard let data = try? Data(contentsOf: metadataURL) else { return nil }
            return try? JSONDecoder().decode(ResumeMetadata.self, from: data)
        }()
        let partialSize = fileSize(at: partialURL)
        let isValid = savedMetadata?.sourceURL == url.absoluteString
            && savedMetadata?.expectedSize == expectedSize
            && partialSize >= 0
            && partialSize <= expectedSize

        if isValid {
            metadata = savedMetadata
        } else {
            resetPartial()
            metadata = ResumeMetadata(sourceURL: url.absoluteString, expectedSize: expectedSize, etag: nil)
        }
    }

    private func startNextChunk() {
        guard !completionCalled, let session, let sourceURL else { return }
        let offset = fileSize(at: partialURL)
        if offset == expectedSize {
            do { try finalizeDownload() } catch { completeOnce(.failure(error)) }
            return
        }
        if offset < 0 || offset > expectedSize {
            resetPartial()
            completeOnce(.failure(DownloadError.incomplete(expected: expectedSize, actual: offset)))
            return
        }

        currentOffset = offset
        currentEnd = min(expectedSize - 1, offset + chunkSize - 1)
        chunkSucceeded = false
        shouldFinalize = false
        shouldRestart = false
        processingError = nil

        var request = URLRequest(url: sourceURL)
        request.setValue("bytes=\(currentOffset)-\(currentEnd)", forHTTPHeaderField: "Range")
        if let etag = metadata?.etag, !etag.isEmpty {
            request.setValue(etag, forHTTPHeaderField: "If-Range")
        }
        session.downloadTask(with: request).resume()
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        reportProgress(min(expectedSize, currentOffset + totalBytesWritten))
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        guard let response = downloadTask.response as? HTTPURLResponse else {
            processingError = DownloadError.unexpectedStatus(-1)
            return
        }

        do {
            switch response.statusCode {
            case 206:
                guard let value = response.value(forHTTPHeaderField: "Content-Range"),
                      let range = Self.parseContentRange(value),
                      range.start == currentOffset,
                      range.end <= currentEnd else {
                    throw DownloadError.invalidRange
                }
                if let total = range.total, total != expectedSize {
                    resetPartial()
                    throw DownloadError.assetChanged
                }
                let responseETag = response.value(forHTTPHeaderField: "ETag")
                if let savedETag = metadata?.etag,
                   !savedETag.isEmpty,
                   let responseETag,
                   !responseETag.isEmpty,
                   responseETag != savedETag {
                    // A compliant If-Range server returns 200 when the asset
                    // changes. Defend against a non-compliant CDN returning
                    // 206: never append bytes protected by different ETags.
                    resetPartial()
                    try updateMetadata(etag: responseETag)
                    processingError = DownloadError.assetChanged
                    return
                }
                try updateMetadata(etag: responseETag)
                try appendDownloadedChunk(from: location)
                let saved = fileSize(at: partialURL)
                guard saved == range.end + 1 else {
                    throw DownloadError.incomplete(expected: range.end + 1, actual: saved)
                }
                chunkSucceeded = true
                shouldFinalize = saved == expectedSize

            case 200:
                // If-Range returns 200 when an asset changed; some servers also
                // ignore Range entirely. In both cases this response is a full file.
                try replacePartial(with: location)
                let saved = fileSize(at: partialURL)
                guard saved == expectedSize else {
                    throw DownloadError.incomplete(expected: expectedSize, actual: saved)
                }
                try updateMetadata(etag: response.value(forHTTPHeaderField: "ETag"))
                chunkSucceeded = true
                shouldFinalize = true

            case 416:
                if fileSize(at: partialURL) == expectedSize {
                    shouldFinalize = true
                } else {
                    resetPartial()
                    metadata = ResumeMetadata(
                        sourceURL: sourceURL?.absoluteString ?? "",
                        expectedSize: expectedSize,
                        etag: nil
                    )
                    shouldRestart = true
                }

            default:
                throw DownloadError.unexpectedStatus(response.statusCode)
            }
        } catch {
            processingError = error
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard !completionCalled else { return }
        if let failure = processingError ?? error {
            handleFailure(failure)
            return
        }
        if shouldRestart {
            retryCount = 0
            startNextChunk()
            return
        }
        if shouldFinalize {
            do { try finalizeDownload() } catch { completeOnce(.failure(error)) }
            return
        }
        if chunkSucceeded {
            retryCount = 0
            startNextChunk()
            return
        }
        handleFailure(DownloadError.incomplete(expected: currentEnd + 1, actual: fileSize(at: partialURL)))
    }

    private func handleFailure(_ error: Error) {
        guard retryCount < maxRetries else {
            completeOnce(.failure(error))
            return
        }
        retryCount += 1
        let attempt = retryCount
        callbackQueue.async { [onRetry] in onRetry(attempt, error) }
        let delay: TimeInterval = retryDelays.isEmpty
            ? 0
            : retryDelays[min(attempt - 1, retryDelays.count - 1)]
        if delay > 0 { Thread.sleep(forTimeInterval: delay) }
        startNextChunk()
    }

    private func appendDownloadedChunk(from location: URL) throws {
        let manager = FileManager.default
        if !manager.fileExists(atPath: partialURL.path) {
            manager.createFile(atPath: partialURL.path, contents: nil)
        }
        let input = try FileHandle(forReadingFrom: location)
        let output = try FileHandle(forWritingTo: partialURL)
        defer {
            try? input.close()
            try? output.close()
        }
        try output.seekToEnd()
        while let data = try input.read(upToCount: 1_048_576), !data.isEmpty {
            try output.write(contentsOf: data)
        }
        try output.synchronize()
    }

    private func replacePartial(with location: URL) throws {
        try? FileManager.default.removeItem(at: partialURL)
        try FileManager.default.moveItem(at: location, to: partialURL)
    }

    private func updateMetadata(etag: String?) throws {
        guard let sourceURL else { return }
        let next = ResumeMetadata(
            sourceURL: sourceURL.absoluteString,
            expectedSize: expectedSize,
            etag: etag ?? metadata?.etag
        )
        let data = try JSONEncoder().encode(next)
        try data.write(to: metadataURL, options: .atomic)
        metadata = next
    }

    private func finalizeDownload() throws {
        let saved = fileSize(at: partialURL)
        guard saved == expectedSize else {
            throw DownloadError.incomplete(expected: expectedSize, actual: saved)
        }
        try? FileManager.default.removeItem(at: destinationURL)
        try FileManager.default.moveItem(at: partialURL, to: destinationURL)
        try? FileManager.default.removeItem(at: metadataURL)
        reportProgress(expectedSize)
        completeOnce(.success(destinationURL))
    }

    private func resetPartial() {
        try? FileManager.default.removeItem(at: partialURL)
        try? FileManager.default.removeItem(at: metadataURL)
    }

    private func fileSize(at url: URL) -> Int64 {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = attributes[.size] as? NSNumber else { return 0 }
        return size.int64Value
    }

    private func reportProgress(_ received: Int64) {
        callbackQueue.async { [onProgress, expectedSize] in
            onProgress(received, expectedSize)
        }
    }

    private func completeOnce(_ result: Result<URL, Error>) {
        guard !completionCalled else { return }
        completionCalled = true
        session?.finishTasksAndInvalidate()
        session = nil
        callbackQueue.async { [onComplete] in onComplete(result) }
    }

    private static func parseContentRange(_ value: String) -> (start: Int64, end: Int64, total: Int64?)? {
        guard value.hasPrefix("bytes ") else { return nil }
        let components = value.dropFirst(6).split(separator: "/", maxSplits: 1)
        guard components.count == 2 else { return nil }
        let bounds = components[0].split(separator: "-", maxSplits: 1)
        guard bounds.count == 2,
              let start = Int64(bounds[0]),
              let end = Int64(bounds[1]),
              start <= end else { return nil }
        let total = components[1] == "*" ? nil : Int64(components[1])
        return (start, end, total)
    }
}
