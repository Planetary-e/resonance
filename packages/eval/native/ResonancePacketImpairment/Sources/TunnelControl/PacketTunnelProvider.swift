import Foundation
@preconcurrency import NetworkExtension
import PacketShaper

public enum PacketTunnelProviderError: Error, Equatable, LocalizedError, Sendable {
  case packetWriteRejected
  case startCancelled
  case invalidState

  public var errorDescription: String? {
    switch self {
    case .packetWriteRejected: "The packet flow rejected a shaped packet"
    case .startCancelled: "Tunnel start was cancelled by stop"
    case .invalidState: "The packet-tunnel provider cannot start in its current state"
    }
  }
}

final class ProviderLifecycleController: @unchecked Sendable {
  private enum Phase: Equatable {
    case idle
    case starting(UInt64)
    case running(UInt64)
    case stopping(UInt64)
    case stopped
  }

  private let lock = NSRecursiveLock()
  private var phase = Phase.idle
  private var nextGeneration: UInt64 = 0
  private var startCompletion: (@Sendable (Error?) -> Void)?
  private var stopCompletions: [@Sendable () -> Void] = []

  func beginStart(completion: @escaping @Sendable (Error?) -> Void) throws -> UInt64 {
    lock.lock()
    defer { lock.unlock() }
    guard phase == .idle || phase == .stopped else { throw PacketTunnelProviderError.invalidState }
    nextGeneration &+= 1
    startCompletion = completion
    phase = .starting(nextGeneration)
    return nextGeneration
  }

  func completeStart(
    error: Error?,
    generation: UInt64,
    stopShaper: (UInt64) -> Void,
    publish: () throws -> Void
  ) -> Bool {
    lock.lock()
    guard phase == .starting(generation), let completion = startCompletion else {
      lock.unlock()
      return false
    }
    if let error {
      startCompletion = nil
      phase = .stopping(generation)
      lock.unlock()
      stopShaper(generation)
      completion(error)
      finishStop(publish: publish)
      return false
    }
    do { try publish() }
    catch {
      startCompletion = nil
      phase = .stopping(generation)
      lock.unlock()
      stopShaper(generation)
      completion(error)
      finishStop(publish: publish)
      return false
    }
    startCompletion = nil
    phase = .running(generation)
    completion(nil)
    lock.unlock()
    return true
  }

  func stop(
    stopShaper: (UInt64) -> Void,
    publish: () throws -> Void,
    completion: @escaping @Sendable () -> Void
  ) {
    lock.lock()
    switch phase {
    case .idle, .stopped:
      phase = .stopped
      lock.unlock()
      completion()
      return
    case .stopping:
      stopCompletions.append(completion)
      lock.unlock()
      return
    case .starting, .running:
      break
    }
    let generation = activeGeneration ?? nextGeneration
    phase = .stopping(generation)
    stopCompletions.append(completion)
    let startCompletion = takeStartCompletion()
    lock.unlock()

    startCompletion?(PacketTunnelProviderError.startCancelled)
    stopShaper(generation)
    finishStop(publish: publish)
  }

  func publishIfRunning(generation: UInt64, publish: () throws -> Void) throws {
    lock.lock()
    defer { lock.unlock() }
    guard phase == .running(generation) else { return }
    try publish()
  }

  func fail(
    _ error: Error,
    generation: UInt64,
    stopShaper: (UInt64) -> Void,
    publish: () throws -> Void,
    cancel: () -> Void
  ) {
    lock.lock()
    guard activeGeneration == generation else {
      lock.unlock()
      return
    }
    switch phase {
    case .starting, .running:
      phase = .stopping(generation)
    case .stopping:
      lock.unlock()
      return
    case .idle, .stopped:
      lock.unlock()
      return
    }
    let startCompletion = takeStartCompletion()
    lock.unlock()

    startCompletion?(error)
    stopShaper(generation)
    finishStop(publish: publish)
    cancel()
  }

  func isRunning(_ generation: UInt64) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return phase == .running(generation)
  }

  private func finishStop(publish: () throws -> Void) {
    lock.lock()
    do { try publish() }
    catch { NSLog("Packet counter publication failed during stop: \(error.localizedDescription)") }
    phase = .stopped
    let completions = stopCompletions
    stopCompletions.removeAll()
    lock.unlock()
    completions.forEach { $0() }
  }

  private func takeStartCompletion() -> (@Sendable (Error?) -> Void)? {
    let completion = startCompletion
    startCompletion = nil
    return completion
  }

  private var activeGeneration: UInt64? {
    switch phase {
    case .starting(let generation), .running(let generation), .stopping(let generation):
      generation
    case .idle, .stopped:
      nil
    }
  }
}

public class PacketTunnelProvider: NEPacketTunnelProvider, @unchecked Sendable {
  private let lifecycle = ProviderLifecycleController()
  private let resourceLock = NSLock()
  private var shaper: PacketShaper?
  private var counterStore: AppGroupCounterStore?
  private var installedGeneration: UInt64?

  public override func startTunnel(
    options: [String: NSObject]?,
    completionHandler: @escaping @Sendable (Error?) -> Void
  ) {
    do {
      let providerConfiguration = (protocolConfiguration as? NETunnelProviderProtocol)?.providerConfiguration
      let configuration = try ProviderConfiguration(providerConfiguration: providerConfiguration)
      try start(configuration: configuration, counterStore: AppGroupCounterStore(), completionHandler: completionHandler)
    } catch {
      completionHandler(error)
    }
  }

  func start(
    configuration: ProviderConfiguration,
    counterStore: AppGroupCounterStore,
    completionHandler: @escaping @Sendable (Error?) -> Void
  ) throws {
    try configuration.validateForStart()
    let settings = try configuration.makeNetworkSettings()
    let shaper = try PacketShaper(configuration: configuration.profileConfiguration())
    let generation = try lifecycle.beginStart(completion: completionHandler)
    install(shaper: shaper, counterStore: counterStore, generation: generation)
    do { try counterStore.save(ShaperCounters()) }
    catch {
      completeStart(error: error, generation: generation)
      return
    }
    setTunnelNetworkSettings(settings) { [weak self] error in
      self?.completeStart(error: error, generation: generation)
    }
  }

  public override func stopTunnel(
    with reason: NEProviderStopReason,
    completionHandler: @escaping @Sendable () -> Void
  ) {
    lifecycle.stop(stopShaper: stopShaper, publish: publishCounters, completion: completionHandler)
  }

  func readPackets(generation: UInt64) {
    guard lifecycle.isRunning(generation) else { return }
    packetFlow.readPacketObjects { [weak self] packets in
      guard let self, self.lifecycle.isRunning(generation) else { return }
      self.handlePackets(packets, generation: generation)
      self.readPackets(generation: generation)
    }
  }

  private func completeStart(error: Error?, generation: UInt64) {
    let started = lifecycle.completeStart(
      error: error,
      generation: generation,
      stopShaper: stopShaper,
      publish: publishCounters
    )
    if started { readPackets(generation: generation) }
  }

  private func handlePackets(_ packets: [NEPacket], generation: UInt64) {
    guard lifecycle.isRunning(generation), let shaper = currentShaper(generation: generation) else { return }
    for packet in packets {
      _ = shaper.process(packet.data) { [weak self] forwardingPacket in
        self?.writePacket(forwardingPacket, generation: generation)
      }
    }
    publishAfterProcessing(generation: generation)
  }

  private func writePacket(_ packet: ForwardingPacket, generation: UInt64) {
    guard lifecycle.isRunning(generation) else { return }
    do {
      let output = try PacketTunnelBridge.packetObject(for: packet)
      guard packetFlow.writePacketObjects([output]) else {
        throw PacketTunnelProviderError.packetWriteRejected
      }
      try lifecycle.publishIfRunning(generation: generation, publish: publishCounters)
    } catch {
      lifecycle.fail(
        error,
        generation: generation,
        stopShaper: stopShaper,
        publish: publishCounters,
        cancel: { self.cancelTunnelWithError(error) }
      )
    }
  }

  private func publishAfterProcessing(generation: UInt64) {
    do { try lifecycle.publishIfRunning(generation: generation, publish: publishCounters) }
    catch {
      lifecycle.fail(
        error,
        generation: generation,
        stopShaper: stopShaper,
        publish: publishCounters,
        cancel: { self.cancelTunnelWithError(error) }
      )
    }
  }

  private func install(shaper: PacketShaper, counterStore: AppGroupCounterStore, generation: UInt64) {
    resourceLock.lock()
    self.shaper = shaper
    self.counterStore = counterStore
    installedGeneration = generation
    resourceLock.unlock()
  }

  private func currentShaper(generation: UInt64) -> PacketShaper? {
    resourceLock.lock()
    defer { resourceLock.unlock() }
    guard installedGeneration == generation else { return nil }
    return shaper
  }

  private func stopShaper(generation: UInt64) {
    currentShaper(generation: generation)?.stop()
  }

  private func publishCounters() throws {
    resourceLock.lock()
    defer { resourceLock.unlock() }
    guard let shaper, let counterStore else { return }
    try counterStore.save(shaper.countersSnapshot())
  }
}
