@preconcurrency import Dispatch
import XCTest
@testable import PacketShaper

private final class ConcurrentTestBox<Value>: @unchecked Sendable {
  let value: Value

  init(_ value: Value) { self.value = value }
}

final class TestScheduler: MonotonicScheduling {
  private final class Cancellation: ShaperCancellation {
    let id: Int
    weak var scheduler: TestScheduler?
    init(id: Int, scheduler: TestScheduler) { self.id = id; self.scheduler = scheduler }
    func cancel() { scheduler?.jobs.removeAll { $0.id == id } }
  }

  struct Job {
    let id: Int
    let due: UInt64
    let work: () -> Void
  }

  var jobs: [Job] = []
  private var nextID = 0
  var now: UInt64 = 1_000_000_000

  func nowNanoseconds() -> UInt64 { now }

  func schedule(at uptimeNanoseconds: UInt64, work: @escaping () -> Void) -> ShaperCancellation {
    nextID += 1
    jobs.append(Job(id: nextID, due: uptimeNanoseconds, work: work))
    return Cancellation(id: nextID, scheduler: self)
  }

  func advance(to target: UInt64) {
    while true {
      let ready = jobs.filter { $0.due <= target }.sorted { $0.due == $1.due ? $0.id < $1.id : $0.due < $1.due }
      guard let next = ready.first else { break }
      jobs.removeAll { $0.id == next.id }
      now = next.due
      next.work()
    }
    now = target
  }
}

final class PacketShaperTests: XCTestCase {
  private let local = try! PacketAddress("2001:db8::1")
  private let localIPv4 = try! PacketAddress("192.0.2.1")
  private let remote = try! PacketAddress("192.0.2.10")
  private let alternateRemote = try! PacketAddress("2001:db8::2")

  private func configuration(queueCapacity: Int = 64) throws -> ProfileConfiguration {
    var configuration = ProfileConfiguration()
    configuration.enabled = true
    configuration.localAddresses = [local, localIPv4]
    configuration.destinationAllowlist = [local, localIPv4, remote, alternateRemote]
    configuration.lossProbability = 0
    configuration.queueCapacity = queueCapacity
    return configuration
  }

  private func ipv4(destination: PacketAddress? = nil) throws -> Data {
    var bytes = [UInt8](repeating: 0, count: 20)
    bytes[0] = 0x45
    bytes[2] = 0
    bytes[3] = 20
    bytes[9] = 6
    bytes.replaceSubrange(12..<16, with: localIPv4.bytes)
    bytes.replaceSubrange(16..<20, with: (destination ?? remote).bytes)
    return Data(bytes)
  }

  private func ipv6(payloadBytes: Int = 8) throws -> Data {
    var bytes = [UInt8](repeating: 0, count: 40 + payloadBytes)
    bytes[0] = 0x60
    bytes[4] = UInt8(payloadBytes >> 8)
    bytes[5] = UInt8(payloadBytes & 0xff)
    bytes[6] = 17
    bytes.replaceSubrange(8..<24, with: alternateRemote.bytes)
    bytes.replaceSubrange(24..<40, with: local.bytes)
    return Data(bytes)
  }

  func testBothDirectionsPreserveProtocolBytesAndMapSourceDestination() async throws {
    let scheduler = TestScheduler()
    let shaper = try PacketShaper(configuration: configuration(), scheduler: scheduler)
    var forwarded: [ForwardingPacket] = []
    let outbound = try ipv4()
    let inbound = try ipv6()
    _ = shaper.process(outbound) { forwarded.append($0) }
    _ = shaper.process(inbound) { forwarded.append($0) }
    scheduler.advance(to: scheduler.now + 40_000_000)
    XCTAssertEqual(shaper.countersSnapshot().forwarded, 2)
    XCTAssertEqual(Set(forwarded.map(\.direction)), [.outbound, .inbound])
    XCTAssertEqual(Set(forwarded.map(\.protocolNumber)), [6, 17])
    XCTAssertTrue(forwarded.contains { $0.data == outbound })
    XCTAssertTrue(forwarded.contains { $0.data == inbound })
  }

  func testSeededIndependentDirectionsAreReproducible() async throws {
    func run() throws -> (ShaperCounters, [String]) {
      var configuration = try self.configuration(queueCapacity: 4_096)
      configuration.seed = 42
      configuration.lossProbability = 0.01
      let scheduler = TestScheduler()
      let shaper = try PacketShaper(configuration: configuration, scheduler: scheduler)
      var trace: [String] = []
      for _ in 0..<1_000 {
        _ = shaper.process(try ipv4()) { packet in
          trace.append("\(packet.direction.rawValue):\(packet.admissionSequence):\(packet.dueNanoseconds)")
        }
        _ = shaper.process(try ipv6()) { packet in
          trace.append("\(packet.direction.rawValue):\(packet.admissionSequence):\(packet.dueNanoseconds)")
        }
      }
      scheduler.advance(to: scheduler.now + 40_000_000)
      return (shaper.countersSnapshot(), trace)
    }
    let first = try run()
    let second = try run()
    XCTAssertEqual(first.0, second.0)
    XCTAssertEqual(first.1, second.1)
    XCTAssertGreaterThan(first.0.profileDrop, 0)
    XCTAssertGreaterThan(first.0.delayed, 0)
  }

  func testDelayBoundsAndDueThenAdmissionOrdering() async throws {
    var configuration = try self.configuration(queueCapacity: 128)
    configuration.delayVariationNanoseconds = 5_000_000
    let scheduler = TestScheduler()
    let shaper = try PacketShaper(configuration: configuration, scheduler: scheduler)
    var due: [UInt64] = []
    var order: [UInt64] = []
    let started = scheduler.now
    for _ in 0..<100 {
      _ = shaper.process(try ipv4()) { packet in
        due.append(packet.dueNanoseconds)
        order.append(packet.admissionSequence)
      }
    }
    scheduler.advance(to: started + 30_000_000)
    XCTAssertEqual(shaper.countersSnapshot().forwarded, 100)
    XCTAssertEqual(shaper.countersSnapshot().delayed, 100)
    XCTAssertTrue(due.allSatisfy { $0 >= started + 20_000_000 && $0 <= started + 30_000_000 })
    XCTAssertEqual(due, due.sorted())
    for index in 1..<order.count {
      XCTAssertTrue(due[index - 1] < due[index] || due[index - 1] == due[index] && order[index - 1] < order[index])
    }
  }

  func testAllowlistDefaultDisabledAndMalformedPackets() async throws {
    let defaultShaper = try PacketShaper(configuration: ProfileConfiguration(), scheduler: TestScheduler())
    _ = defaultShaper.process(try ipv4()) { _ in XCTFail("Disabled shaper forwarded") }
    XCTAssertEqual(defaultShaper.countersSnapshot().profileDrop, 1)

    let shaper = try PacketShaper(configuration: configuration(), scheduler: TestScheduler())
    _ = shaper.process(try ipv4(destination: PacketAddress("198.51.100.1"))) { _ in XCTFail("Unlisted destination forwarded") }
    _ = shaper.process(Data([0x70])) { _ in XCTFail("Malformed packet forwarded") }
    XCTAssertEqual(shaper.countersSnapshot().profileDrop, 1)
    XCTAssertEqual(shaper.countersSnapshot().malformed, 1)
    XCTAssertEqual(shaper.countersSnapshot().forwarded, 0)
  }

  func testQueueOverflowAndCancellation() async throws {
    let scheduler = TestScheduler()
    let shaper = try PacketShaper(configuration: configuration(queueCapacity: 2), scheduler: scheduler)
    _ = shaper.process(try ipv4()) { _ in }
    _ = shaper.process(try ipv4()) { _ in }
    _ = shaper.process(try ipv4()) { _ in }
    XCTAssertEqual(shaper.countersSnapshot().overflowDrop, 1)
    shaper.stop()
    shaper.stop()
    XCTAssertEqual(shaper.countersSnapshot().cancelled, 2)
    XCTAssertEqual(shaper.pendingCount, 0)
    scheduler.advance(to: scheduler.now + 40_000_000)
    XCTAssertEqual(shaper.countersSnapshot().forwarded, 0)
    _ = shaper.process(try ipv4()) { _ in XCTFail("Stopped shaper forwarded") }
  }

  func testConcurrentStopWaitsForInflightForward() throws {
    let scheduler = TestScheduler()
    let shaper = try PacketShaper(configuration: configuration(), scheduler: scheduler)
    let forwardEntered = DispatchSemaphore(value: 0)
    let finishForward = DispatchSemaphore(value: 0)
    let forwardReturned = DispatchSemaphore(value: 0)
    let stopStarted = DispatchSemaphore(value: 0)
    let stopReturned = DispatchSemaphore(value: 0)

    _ = shaper.process(try ipv4()) { _ in
      forwardEntered.signal()
      XCTAssertEqual(finishForward.wait(timeout: .now() + 2), .success)
      XCTAssertEqual(stopReturned.wait(timeout: .now()), .timedOut)
    }
    let job = scheduler.jobs.removeFirst()
    let jobBox = ConcurrentTestBox(job)
    let shaperBox = ConcurrentTestBox(shaper)

    DispatchQueue.global().async {
      jobBox.value.work()
      forwardReturned.signal()
    }
    XCTAssertEqual(forwardEntered.wait(timeout: .now() + 2), .success)

    DispatchQueue.global().async {
      stopStarted.signal()
      shaperBox.value.stop()
      stopReturned.signal()
    }
    XCTAssertEqual(stopStarted.wait(timeout: .now() + 2), .success)
    XCTAssertEqual(stopReturned.wait(timeout: .now() + 0.1), .timedOut)

    finishForward.signal()
    XCTAssertEqual(forwardReturned.wait(timeout: .now() + 2), .success)
    XCTAssertEqual(stopReturned.wait(timeout: .now() + 2), .success)
    let counters = shaper.countersSnapshot()
    XCTAssertEqual(counters.forwarded, 1)
    XCTAssertEqual(counters.cancelled, 0)
    XCTAssertEqual(shaper.pendingCount, 0)
    _ = shaper.process(try ipv4()) { _ in XCTFail("Stopped shaper forwarded") }
  }

  func testReentrantStopForwardsInflightAndCancelsQueuedPacket() throws {
    let scheduler = TestScheduler()
    let shaper = try PacketShaper(configuration: configuration(queueCapacity: 2), scheduler: scheduler)
    var forwardCount = 0
    var countersDuringStop: ShaperCounters?
    for _ in 0..<2 {
      _ = shaper.process(try ipv4()) { _ in
        forwardCount += 1
        shaper.stop()
        countersDuringStop = shaper.countersSnapshot()
      }
    }

    scheduler.jobs.removeFirst().work()
    XCTAssertEqual(forwardCount, 1)
    XCTAssertEqual(countersDuringStop?.forwarded, 0)
    XCTAssertEqual(countersDuringStop?.cancelled, 1)
    let counters = shaper.countersSnapshot()
    XCTAssertEqual(counters.forwarded, 1)
    XCTAssertEqual(counters.cancelled, 1)
    XCTAssertEqual(shaper.pendingCount, 0)

    shaper.stop()
    scheduler.advance(to: scheduler.now + 40_000_000)
    XCTAssertEqual(forwardCount, 1)
    XCTAssertEqual(shaper.countersSnapshot(), counters)
  }

  func testDelayValidationRejectsUnsupportedRanges() throws {
    var variationAboveBase = try configuration()
    variationAboveBase.baseDelayNanoseconds = 1
    variationAboveBase.delayVariationNanoseconds = 2

    var overflowingEndpoint = try configuration()
    overflowingEndpoint.baseDelayNanoseconds = UInt64.max
    overflowingEndpoint.delayVariationNanoseconds = 1

    var overflowingSpan = try configuration()
    overflowingSpan.baseDelayNanoseconds = UInt64.max
    overflowingSpan.delayVariationNanoseconds = UInt64.max

    for configuration in [variationAboveBase, overflowingEndpoint, overflowingSpan] {
      XCTAssertThrowsError(try configuration.validate())
    }
  }

  func testDelayArithmeticAtUInt64UpperBoundary() throws {
    var configuration = try self.configuration()
    configuration.baseDelayNanoseconds = UInt64.max - 1
    configuration.delayVariationNanoseconds = 1
    let scheduler = TestScheduler()
    scheduler.now = 0
    let shaper = try PacketShaper(configuration: configuration, scheduler: scheduler)

    let disposition = shaper.process(try ipv4()) { _ in }
    guard case .scheduled(let packet) = disposition else {
      XCTFail("Upper-boundary delay was not scheduled")
      return
    }
    XCTAssertGreaterThanOrEqual(packet.dueNanoseconds, UInt64.max - 2)
    XCTAssertLessThanOrEqual(packet.dueNanoseconds, UInt64.max)
    XCTAssertEqual(shaper.countersSnapshot().delayed, 1)
    shaper.stop()
  }

  func testFrozenConfigurationHashAndSeed() throws {
    let first = ProfileConfiguration()
    var second = ProfileConfiguration()
    second.seed = 2
    XCTAssertEqual(first.configurationHash, first.configurationHash)
    XCTAssertNotEqual(first.configurationHash, second.configurationHash)
    XCTAssertFalse(first.enabled)
    XCTAssertEqual(first.orderingPolicy, "ascending monotonic due time, then original admission sequence")
  }
}
