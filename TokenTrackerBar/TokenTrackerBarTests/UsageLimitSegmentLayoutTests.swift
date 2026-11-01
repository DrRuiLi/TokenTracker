import XCTest

final class UsageLimitSegmentLayoutTests: XCTestCase {
    func testFullPoolKeepsEveryProductInsideTrack() {
        let widths = UsageLimitSegmentLayout.widths(percentages: [98, 1, 1], trackWidth: 200, gap: 1.5)
        XCTAssertEqual(widths.count, 4)
        XCTAssertEqual(widths[3], 0)
        XCTAssertTrue(widths.prefix(3).allSatisfy { $0 > 0 })
        XCTAssertEqual(widths.reduce(0, +) + 3, 200, accuracy: 0.0001)
        XCTAssertEqual(widths[0] / widths[1], 98, accuracy: 0.0001)
    }

    func testNearlyFullPoolPreservesRemainderAndTinyProducts() {
        let widths = UsageLimitSegmentLayout.widths(percentages: [97, 1, 1], trackWidth: 80, gap: 0.8)
        XCTAssertTrue(widths.allSatisfy { $0 > 0 })
        XCTAssertEqual(widths[1], widths[3], accuracy: 0.0001)
        XCTAssertEqual(widths.reduce(0, +) + 2.4, 80, accuracy: 0.0001)
    }

    func testOverfullAndNarrowTracksRemainBounded() {
        for size in [1.0, 20, 200] {
            let widths = UsageLimitSegmentLayout.widths(percentages: [100, 1, 1], trackWidth: size, gap: size / 100)
            XCTAssertEqual(widths.last, 0)
            XCTAssertTrue(widths.prefix(3).allSatisfy { $0 > 0 })
            XCTAssertEqual(widths.reduce(0, +) + size / 50, size, accuracy: 0.0001)
        }
    }

    func testUnallocatedUsedShareDoesNotIncreaseTheRemainingPool() {
        // 62% used, but the named products account for only 61.4%.
        let widths = UsageLimitSegmentLayout.widths(percentages: [45, 13, 3, 0.4, 0.6], trackWidth: 200, gap: 1.5)
        let usable = 200.0 - 5 * 1.5
        XCTAssertGreaterThan(widths[4], 0)
        XCTAssertEqual(widths[5] / usable, 0.38, accuracy: 0.0001)
        XCTAssertEqual(widths.reduce(0, +) + 7.5, 200, accuracy: 0.0001)
    }
}
