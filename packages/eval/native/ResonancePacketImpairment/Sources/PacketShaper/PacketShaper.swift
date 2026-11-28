import Foundation

public struct ForwardingPacket: Sendable {
  public let data: Data
  public let source: PacketAddress
  public let destination: PacketAddress
  public let direction: PacketDirection
  public let protocolNumber: UInt8
  public let dueNanoseconds: UInt64
  public let admissionSequence: UInt64
}

public enum ShaperDisposition {
  case scheduled(ForwardingPacket)
  case disabled
  case profileDropped
  case malformed
  case overflow
  case stopped
}

public struct ShaperCounters: Equatable, Sendable {
  public internal(set) var profileDrop = 0
  public internal(set) var overflowDrop = 0
  public internal(set) var forwarded = 0
  public internal(set) var malformed = 0
  public internal(set) var delayed = 0
  public internal(set) var cancelled = 0

  public init() {}
}

public final class PacketShaper {
  private struct PendingPacket {
    let packet: ForwardingPacket
    let forward: () -> Void
  }

  private struct SplitMix64 {
    var state: UInt64

    mutating func next() -> UInt64 {
      state = state &+ 0x9e3779b97f4a7c15
      var value = state
      value = (value ^ (value >> 30)) &* 0xbf58476d1ce4e5b9
      value = (value ^ (value >> 27)) &* 0x94d049bb133111eb
      return value ^ (value >> 31)
    }

    mutating func unit() -> Double { Double(next() >> 11) / 9_007_199_254_740_992 }
  }

  public let configuration: ProfileConfiguration
  private let scheduler: MonotonicScheduling
  private let lock = NSLock()
  private let forwardingLock = NSRecursiveLock()
  private var generators: [PacketDirection: SplitMix64]
  private var pending: [PendingPacket] = []
  private var activeSequence: UInt64?
  private var activeCancellation: ShaperCancellation?
  private var inFlightSequence: UInt64?
  private var nextSequence: UInt64 = 0
  private var stopped = false
  private var counters = ShaperCounters()

  public init(
    configuration: ProfileConfiguration,
    scheduler: MonotonicScheduling = DispatchMonotonicScheduling()
  ) throws {
    try configuration.validate()
    self.configuration = configuration
    self.scheduler = scheduler
    generators = [
      .outbound: SplitMix64(state: configuration.seed ^ 0x6f7574626f756e64),
      .inbound: SplitMix64(state: configuration.seed ^ 0x696e626f756e64),
    ]
  }

  public var pendingCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return pending.count
  }

  public func countersSnapshot() -> ShaperCounters {
    lock.lock()
    defer { lock.unlock() }
    return counters
  }

  @discardableResult
  public func process(_ data: Data, forward: @escaping (ForwardingPacket) -> Void) -> ShaperDisposition {
    let parsed: ParsedPacket
    do { parsed = try parsePacket(data) }
    catch {
      lock.lock()
      counters.malformed += 1
      lock.unlock()
      return .malformed
    }

    lock.lock()
    defer { lock.unlock() }
    if stopped { return .stopped }
    guard configuration.enabled else { counters.profileDrop += 1; return .disabled }
    let sourceIsLocal = configuration.localAddresses.contains(parsed.source)
    let destinationIsLocal = configuration.localAddresses.contains(parsed.destination)
    guard sourceIsLocal != destinationIsLocal else {
      counters.profileDrop += 1
      return .profileDropped
    }
    guard configuration.destinationAllowlist.contains(parsed.destination) else {
      counters.profileDrop += 1
      return .profileDropped
    }
    guard pending.count < configuration.queueCapacity else {
      counters.overflowDrop += 1
      return .overflow
    }

    nextSequence += 1
    let direction: PacketDirection = sourceIsLocal ? .outbound : .inbound
    if generators[direction]!.unit() < configuration.lossProbability {
      counters.profileDrop += 1
      return .profileDropped
    }
    let variation = configuration.delayVariationNanoseconds
    let delay = configuration.baseDelayNanoseconds - variation
      + (variation == 0 ? 0 : UInt64(generators[direction]!.unit() * Double(variation * 2 + 1)))
    let now = scheduler.nowNanoseconds()
    let due = now > UInt64.max - delay ? UInt64.max : now + delay
    if delay > 0 { counters.delayed += 1 }
    let packet = ForwardingPacket(
      data: parsed.data,
      source: parsed.source,
      destination: parsed.destination,
      direction: direction,
      protocolNumber: parsed.protocolNumber,
      dueNanoseconds: due,
      admissionSequence: nextSequence
    )
    pending.append(PendingPacket(packet: packet, forward: { forward(packet) }))
    pending.sort { first, second in
      first.packet.dueNanoseconds == second.packet.dueNanoseconds
        ? first.packet.admissionSequence < second.packet.admissionSequence
        : first.packet.dueNanoseconds < second.packet.dueNanoseconds
    }
    scheduleHead()
    return .scheduled(packet)
  }

  /// External callers wait for an active callback. Reentrant stop permits that callback to finish
  /// as forwarded, cancels every queued packet, and prevents any new callback from beginning.
  public func stop() {
    forwardingLock.lock()
    defer { forwardingLock.unlock() }
    lock.lock()
    stopped = true
    counters.cancelled += pending.filter {
      $0.packet.admissionSequence != inFlightSequence
    }.count
    pending.removeAll()
    activeSequence = nil
    activeCancellation?.cancel()
    activeCancellation = nil
    lock.unlock()
  }

  private func scheduleHead() {
    guard inFlightSequence == nil else { return }
    guard let head = pending.first else {
      activeSequence = nil
      activeCancellation = nil
      return
    }
    if activeSequence == head.packet.admissionSequence { return }
    activeCancellation?.cancel()
    activeSequence = head.packet.admissionSequence
    activeCancellation = scheduler.schedule(at: head.packet.dueNanoseconds) { [weak self] in
      self?.fire(sequence: head.packet.admissionSequence)
    }
  }

  private func fire(sequence: UInt64) {
    forwardingLock.lock()
    defer { forwardingLock.unlock() }
    lock.lock()
    guard activeSequence == sequence, !stopped, inFlightSequence == nil,
      let index = pending.firstIndex(where: { $0.packet.admissionSequence == sequence }) else {
      lock.unlock()
      return
    }
    let pendingPacket = pending[index]
    inFlightSequence = sequence
    lock.unlock()
    pendingPacket.forward()

    lock.lock()
    if inFlightSequence == sequence {
      counters.forwarded += 1
      inFlightSequence = nil
    }
    if let index = pending.firstIndex(where: { $0.packet.admissionSequence == sequence }) {
      pending.remove(at: index)
    }
    if activeSequence == sequence {
      activeSequence = nil
      activeCancellation = nil
    }
    if !stopped { scheduleHead() }
    lock.unlock()
  }
}
