import Foundation

/// Allocate the track after reserving the gaps. The final width is the unused
/// pool; zero means there is no remainder. Tiny shares stay proportional rather
/// than forcing later products outside the track with a minimum pixel width.
enum UsageLimitSegmentLayout {
    static func widths(percentages: [Double], trackWidth: Double, gap: Double) -> [Double] {
        let weights = percentages.map { $0.isFinite ? min(100, max(0, $0)) : 0 }
        let total = weights.reduce(0, +)
        let remaining = max(0, 100 - total)
        let all = weights + [remaining]
        let count = all.filter { $0 > 0 }.count
        let width = max(0, trackWidth)
        let safeGap = min(max(0, gap), width / Double(max(1, count)))
        let usable = max(0, width - safeGap * Double(max(0, count - 1)))
        return all.map { usable * $0 / max(100, total) }
    }
}
