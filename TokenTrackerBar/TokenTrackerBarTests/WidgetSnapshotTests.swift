import XCTest

final class WidgetSnapshotTests: XCTestCase {

    func testYesterdayDeltaIsUnavailableWhenDailyTrendSkipsYesterday() {
        let snapshot = WidgetSnapshot(
            generatedAt: date(year: 2026, month: 8, day: 10),
            today: PeriodTotals(tokens: 200),
            dailyTrend: [
                DailyPoint(
                    day: date(year: 2026, month: 8, day: 7),
                    totalTokens: 100,
                    costUsd: 0
                ),
                DailyPoint(
                    day: date(year: 2026, month: 8, day: 10),
                    totalTokens: 200,
                    costUsd: 0
                ),
            ]
        )

        XCTAssertEqual(snapshot.yesterdayTokens, 0)
        XCTAssertNil(snapshot.todayDeltaPercent)
    }

    func testYesterdayUsesTheSnapshotGenerationDate() {
        let snapshot = WidgetSnapshot(
            generatedAt: date(year: 2024, month: 2, day: 10),
            today: PeriodTotals(tokens: 150),
            dailyTrend: [
                DailyPoint(
                    day: date(year: 2024, month: 2, day: 9),
                    totalTokens: 75,
                    costUsd: 0
                ),
                DailyPoint(
                    day: date(year: 2024, month: 2, day: 10),
                    totalTokens: 150,
                    costUsd: 0
                ),
            ]
        )

        XCTAssertEqual(snapshot.yesterdayTokens, 75)
        XCTAssertEqual(snapshot.todayDeltaPercent, 100)
    }

    private func date(year: Int, month: Int, day: Int) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar.date(from: DateComponents(year: year, month: month, day: day, hour: 12))!
    }
}
