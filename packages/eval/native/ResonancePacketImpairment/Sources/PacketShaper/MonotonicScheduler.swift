import Foundation

public protocol ShaperCancellation: AnyObject {
  func cancel()
}

public protocol MonotonicScheduling {
  func nowNanoseconds() -> UInt64
  func schedule(at uptimeNanoseconds: UInt64, work: @escaping () -> Void) -> ShaperCancellation
}

public final class DispatchMonotonicScheduling: MonotonicScheduling {
  private final class WorkItemCancellation: ShaperCancellation {
    private let item: DispatchWorkItem
    init(_ item: DispatchWorkItem) { self.item = item }
    func cancel() { item.cancel() }
  }

  public init() {}

  public func nowNanoseconds() -> UInt64 { DispatchTime.now().uptimeNanoseconds }

  public func schedule(at uptimeNanoseconds: UInt64, work: @escaping () -> Void) -> ShaperCancellation {
    let item = DispatchWorkItem(block: work)
    DispatchQueue.global(qos: .utility).asyncAfter(
      deadline: DispatchTime(uptimeNanoseconds: uptimeNanoseconds),
      execute: item
    )
    return WorkItemCancellation(item)
  }
}
