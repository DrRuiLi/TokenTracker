import Foundation
import XCTest

final class ResumableDownloaderTests: XCTestCase {
    private var tempDirectory: URL!

    override func setUpWithError() throws {
        tempDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ResumableDownloaderTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
        ScriptedDownloadURLProtocol.reset()
    }

    override func tearDownWithError() throws {
        ScriptedDownloadURLProtocol.reset()
        try? FileManager.default.removeItem(at: tempDirectory)
    }

    func testRetriesInterruptedChunkFromLastPersistedOffset() throws {
        let payload = Data("abcdefghijkl".utf8)
        let destination = tempDirectory.appendingPathComponent("update.dmg")
        let ranges = LockedArray<String>()
        let ifRanges = LockedArray<String>()
        let requestCount = LockedCounter()

        ScriptedDownloadURLProtocol.handler = { request, protocolInstance in
            ranges.append(request.value(forHTTPHeaderField: "Range") ?? "")
            ifRanges.append(request.value(forHTTPHeaderField: "If-Range") ?? "")
            let index = requestCount.next()
            switch index {
            case 0:
                protocolInstance.succeed(
                    statusCode: 206,
                    headers: ["Content-Range": "bytes 0-3/12", "ETag": "\"asset-v1\""],
                    data: payload.subdata(in: 0..<4)
                )
            case 1:
                protocolInstance.failMidResponse(
                    statusCode: 206,
                    headers: ["Content-Range": "bytes 4-7/12", "ETag": "\"asset-v1\""],
                    partialData: payload.subdata(in: 4..<6)
                )
            case 2:
                protocolInstance.succeed(
                    statusCode: 206,
                    headers: ["Content-Range": "bytes 4-7/12", "ETag": "\"asset-v1\""],
                    data: payload.subdata(in: 4..<8)
                )
            default:
                protocolInstance.succeed(
                    statusCode: 206,
                    headers: ["Content-Range": "bytes 8-11/12", "ETag": "\"asset-v1\""],
                    data: payload.subdata(in: 8..<12)
                )
            }
        }

        let finished = expectation(description: "download finishes")
        var result: Result<URL, Error>?
        let downloader = makeDownloader(destination: destination, expectedSize: 12) {
            result = $0
            finished.fulfill()
        }
        downloader.start(url: URL(string: "https://example.test/update.dmg")!)
        wait(for: [finished], timeout: 5)

        XCTAssertEqual(try result?.get(), destination)
        XCTAssertEqual(try Data(contentsOf: destination), payload)
        XCTAssertEqual(ranges.values, ["bytes=0-3", "bytes=4-7", "bytes=4-7", "bytes=8-11"])
        XCTAssertEqual(ifRanges.values, ["", "\"asset-v1\"", "\"asset-v1\"", "\"asset-v1\""])
    }

    func testNextDownloaderResumesPersistedPartialAndAcceptsFullFallback() throws {
        let payload = Data("abcdefghijkl".utf8)
        let destination = tempDirectory.appendingPathComponent("update.dmg")
        let firstFinished = expectation(description: "first attempt fails")
        let firstRequestCount = LockedCounter()

        ScriptedDownloadURLProtocol.handler = { _, protocolInstance in
            if firstRequestCount.next() == 0 {
                protocolInstance.succeed(
                    statusCode: 206,
                    headers: ["Content-Range": "bytes 0-3/12", "ETag": "\"asset-v1\""],
                    data: payload.subdata(in: 0..<4)
                )
            } else {
                protocolInstance.failMidResponse(
                    statusCode: 206,
                    headers: ["Content-Range": "bytes 4-7/12", "ETag": "\"asset-v1\""],
                    partialData: payload.subdata(in: 4..<6)
                )
            }
        }

        let firstDownloader = makeDownloader(
            destination: destination,
            expectedSize: 12,
            maxRetries: 0
        ) { result in
            if case .success = result {
                XCTFail("interrupted download unexpectedly succeeded")
            }
            firstFinished.fulfill()
        }
        firstDownloader.start(url: URL(string: "https://example.test/update.dmg")!)
        wait(for: [firstFinished], timeout: 5)

        let partial = destination.appendingPathExtension("part")
        XCTAssertEqual(try Data(contentsOf: partial), payload.subdata(in: 0..<4))

        let observedRange = LockedArray<String>()
        let observedIfRange = LockedArray<String>()
        ScriptedDownloadURLProtocol.handler = { request, protocolInstance in
            observedRange.append(request.value(forHTTPHeaderField: "Range") ?? "")
            observedIfRange.append(request.value(forHTTPHeaderField: "If-Range") ?? "")
            protocolInstance.succeed(statusCode: 200, headers: [:], data: payload)
        }

        let secondFinished = expectation(description: "second attempt finishes")
        var secondResult: Result<URL, Error>?
        let secondDownloader = makeDownloader(destination: destination, expectedSize: 12) {
            secondResult = $0
            secondFinished.fulfill()
        }
        secondDownloader.start(url: URL(string: "https://example.test/update.dmg")!)
        wait(for: [secondFinished], timeout: 5)

        XCTAssertEqual(try secondResult?.get(), destination)
        XCTAssertEqual(try Data(contentsOf: destination), payload)
        XCTAssertEqual(observedRange.values, ["bytes=4-7"])
        XCTAssertEqual(observedIfRange.values, ["\"asset-v1\""])
        XCTAssertFalse(FileManager.default.fileExists(atPath: partial.path))
    }

    func testRestartsWhenPartialResponseETagChanges() throws {
        let firstPayload = Data("abcdefghijkl".utf8)
        let replacementPayload = Data("mnopqrstuvwx".utf8)
        let destination = tempDirectory.appendingPathComponent("update.dmg")
        let ranges = LockedArray<String>()
        let requestCount = LockedCounter()

        ScriptedDownloadURLProtocol.handler = { request, protocolInstance in
            ranges.append(request.value(forHTTPHeaderField: "Range") ?? "")
            switch requestCount.next() {
            case 0:
                protocolInstance.succeed(
                    statusCode: 206,
                    headers: ["Content-Range": "bytes 0-3/12", "ETag": "\"asset-v1\""],
                    data: firstPayload.subdata(in: 0..<4)
                )
            case 1:
                protocolInstance.succeed(
                    statusCode: 206,
                    headers: ["Content-Range": "bytes 4-7/12", "ETag": "\"asset-v2\""],
                    data: replacementPayload.subdata(in: 4..<8)
                )
            case 2:
                protocolInstance.succeed(
                    statusCode: 206,
                    headers: ["Content-Range": "bytes 0-3/12", "ETag": "\"asset-v2\""],
                    data: replacementPayload.subdata(in: 0..<4)
                )
            case 3:
                protocolInstance.succeed(
                    statusCode: 206,
                    headers: ["Content-Range": "bytes 4-7/12", "ETag": "\"asset-v2\""],
                    data: replacementPayload.subdata(in: 4..<8)
                )
            default:
                protocolInstance.succeed(
                    statusCode: 206,
                    headers: ["Content-Range": "bytes 8-11/12", "ETag": "\"asset-v2\""],
                    data: replacementPayload.subdata(in: 8..<12)
                )
            }
        }

        let finished = expectation(description: "replacement download finishes")
        var result: Result<URL, Error>?
        let downloader = makeDownloader(destination: destination, expectedSize: 12) {
            result = $0
            finished.fulfill()
        }
        downloader.start(url: URL(string: "https://example.test/update.dmg")!)
        wait(for: [finished], timeout: 5)

        XCTAssertEqual(try result?.get(), destination)
        XCTAssertEqual(try Data(contentsOf: destination), replacementPayload)
        XCTAssertEqual(ranges.values, ["bytes=0-3", "bytes=4-7", "bytes=0-3", "bytes=4-7", "bytes=8-11"])
    }

    private func makeDownloader(
        destination: URL,
        expectedSize: Int64,
        maxRetries: Int = 2,
        completion: @escaping (Result<URL, Error>) -> Void
    ) -> ResumableDownloader {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ScriptedDownloadURLProtocol.self]
        return ResumableDownloader(
            destinationURL: destination,
            expectedSize: expectedSize,
            configuration: configuration,
            chunkSize: 4,
            maxRetries: maxRetries,
            retryDelays: [0, 0],
            onProgress: { _, _ in },
            onRetry: { _, _ in },
            onComplete: completion
        )
    }
}

private final class ScriptedDownloadURLProtocol: URLProtocol {
    static var handler: ((URLRequest, ScriptedDownloadURLProtocol) -> Void)?

    static func reset() {
        handler = nil
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        handler(request, self)
    }

    override func stopLoading() {}

    func succeed(statusCode: Int, headers: [String: String], data: Data) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: headers.merging(["Content-Length": "\(data.count)"], uniquingKeysWith: { old, _ in old })
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    func failMidResponse(statusCode: Int, headers: [String: String], partialData: Data) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: partialData)
        client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
    }
}

private final class LockedArray<Element> {
    private let lock = NSLock()
    private var storage: [Element] = []

    var values: [Element] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    func append(_ value: Element) {
        lock.lock()
        storage.append(value)
        lock.unlock()
    }
}

private final class LockedCounter {
    private let lock = NSLock()
    private var value = 0

    func next() -> Int {
        lock.lock()
        defer {
            value += 1
            lock.unlock()
        }
        return value
    }
}
