@preconcurrency import Dispatch
import Foundation
@preconcurrency import NetworkExtension
@preconcurrency import SystemExtensions
import XCTest
@testable import PacketShaper
@testable import PacketTunnelControl

private final class TestTunnelConnection: NETunnelProviderSession, @unchecked Sendable {
  var testStatus: NEVPNStatus

  init(status: NEVPNStatus) {
    testStatus = status
    super.init()
  }

  override var status: NEVPNStatus { testStatus }
}

private final class TestTunnelManager: NETunnelProviderManager, @unchecked Sendable {
  let testConnection: TestTunnelConnection

  init(status: NEVPNStatus) {
    testConnection = TestTunnelConnection(status: status)
    super.init()
  }

  override var connection: NETunnelProviderSession { testConnection }
}

private final class ProviderCallbackRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var errors: [Error] = []
  private var starts = 0
  private var stops = 0
  private var stoppedGenerations: [UInt64] = []

  func recordStart(_ error: Error?) {
    lock.lock()
    starts += 1
    if let error { errors.append(error) }
    lock.unlock()
  }

  func recordStop() {
    lock.lock()
    stops += 1
    lock.unlock()
  }

  func recordShaperStop(_ generation: UInt64) {
    lock.lock()
    stoppedGenerations.append(generation)
    lock.unlock()
  }

  func snapshot() -> (errors: [Error], starts: Int, stops: Int, stoppedGenerations: [UInt64]) {
    lock.lock()
    defer { lock.unlock() }
    return (errors, starts, stops, stoppedGenerations)
  }
}

final class TunnelIntegrationTests: XCTestCase {
  private let localIPv4 = try! PacketAddress("192.0.2.1")
  private let localIPv6 = try! PacketAddress("2001:db8::1")
  private let remoteIPv4 = try! PacketAddress("192.0.2.10")
  private let remoteIPv6 = try! PacketAddress("2001:db8::10")

  private func enabledConfiguration() throws -> ProviderConfiguration {
    var configuration = ProviderConfiguration()
    configuration.enabled = true
    configuration.localAddresses = [localIPv4, localIPv6]
    configuration.testDestinations = [remoteIPv4, remoteIPv6]
    configuration.lossProbability = 0
    return configuration
  }

  func testConfigurationDefaultsDisabledAndRoundTrips() throws {
    let disabled = ProviderConfiguration()
    XCTAssertFalse(disabled.enabled)
    XCTAssertThrowsError(try disabled.validateForStart()) { error in
      XCTAssertEqual(error as? ProviderConfigurationError, .disabled)
    }

    let configuration = try enabledConfiguration()
    let decoded = try ProviderConfiguration(providerConfiguration: configuration.providerConfiguration)
    XCTAssertEqual(decoded, configuration)
    let profile = decoded.profileConfiguration()
    XCTAssertTrue(profile.enabled)
    XCTAssertEqual(profile.destinationAllowlist, decoded.testDestinations.union(decoded.localAddresses))
    XCTAssertEqual(profile.localAddresses, decoded.localAddresses)
  }

  func testConfigurationRejectsInvalidAndUnsupportedValues() throws {
    var missingDestinations = ProviderConfiguration()
    missingDestinations.enabled = true
    XCTAssertThrowsError(try missingDestinations.validate()) { error in
      XCTAssertEqual(error as? ProviderConfigurationError, .emptyTestDestinations)
    }

    var unspecifiedDestination = try enabledConfiguration()
    unspecifiedDestination.testDestinations = [try PacketAddress("0.0.0.0")]
    XCTAssertThrowsError(try unspecifiedDestination.validate())

    var missingIPv6Local = try enabledConfiguration()
    missingIPv6Local.localAddresses = [localIPv4]
    XCTAssertThrowsError(try missingIPv6Local.validate()) { error in
      XCTAssertEqual(error as? ProviderConfigurationError, .missingLocalAddress(remoteIPv6.description))
    }

    var localDestination = try enabledConfiguration()
    localDestination.testDestinations = [localIPv4]
    XCTAssertThrowsError(try localDestination.validate()) { error in
      XCTAssertEqual(error as? ProviderConfigurationError, .destinationIsLocal(localIPv4.description))
    }

    var dictionary = try enabledConfiguration().providerConfiguration
    dictionary["baseDelayNanoseconds"] = "18446744073709551616"
    XCTAssertThrowsError(try ProviderConfiguration(providerConfiguration: dictionary))
    dictionary = try enabledConfiguration().providerConfiguration
    dictionary["tunnelRemoteAddress"] = "not-an-ip"
    XCTAssertThrowsError(try ProviderConfiguration(providerConfiguration: dictionary)) { error in
      XCTAssertEqual(error as? ProviderConfigurationError, .invalidRemoteAddress)
    }
  }

  func testNetworkSettingsContainOnlyExplicitHostRoutes() throws {
    let configuration = try enabledConfiguration()
    let settings = try configuration.makeNetworkSettings()
    XCTAssertEqual(settings.tunnelRemoteAddress, configuration.tunnelRemoteAddress)

    let ipv4Routes = try XCTUnwrap(settings.ipv4Settings?.includedRoutes)
    XCTAssertEqual(ipv4Routes.map(\.destinationAddress), [remoteIPv4.description])
    XCTAssertEqual(ipv4Routes.map(\.destinationSubnetMask), ["255.255.255.255"])
    XCTAssertFalse(ipv4Routes.contains {
      $0.destinationAddress == "0.0.0.0" && $0.destinationSubnetMask == "0.0.0.0"
    })

    let ipv6Routes = try XCTUnwrap(settings.ipv6Settings?.includedRoutes)
    XCTAssertEqual(ipv6Routes.map(\.destinationAddress), [remoteIPv6.description])
    XCTAssertEqual(ipv6Routes.map(\.destinationNetworkPrefixLength.intValue), [128])
    XCTAssertFalse(ipv6Routes.contains {
      $0.destinationAddress == "::" && $0.destinationNetworkPrefixLength.intValue == 0
    })
  }

  func testPacketBridgePreservesBytesProtocolAndFamily() throws {
    var bytes = [UInt8](repeating: 0, count: 20)
    bytes[0] = 0x45
    bytes[3] = 20
    bytes[9] = 6
    bytes.replaceSubrange(12..<16, with: localIPv4.bytes)
    bytes.replaceSubrange(16..<20, with: remoteIPv4.bytes)
    let data = Data(bytes)
    let packet = ForwardingPacket(
      data: data,
      source: localIPv4,
      destination: remoteIPv4,
      direction: .outbound,
      protocolNumber: 6,
      dueNanoseconds: 1,
      admissionSequence: 1
    )

    let output = try PacketTunnelBridge.packetObject(for: packet)
    XCTAssertEqual(output.protocolFamily, sa_family_t(AF_INET))
    XCTAssertEqual(output.data, data)
    XCTAssertEqual(try parsePacket(output.data).protocolNumber, 6)
  }

  func testSharedCountersRoundTripAndRejectMalformedValues() throws {
    let suiteName = "TunnelIntegrationTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let store = AppGroupCounterStore(defaults: defaults)
    XCTAssertEqual(try store.load(), ShaperCounters())
    var counters = ShaperCounters()
    counters.forwarded = 7
    counters.cancelled = 2
    try store.save(counters)
    XCTAssertEqual(try store.load(), counters)
    defaults.set(["forwarded": "invalid"], forKey: AppGroupCounterStore.storageKey)
    XCTAssertThrowsError(try store.load()) { error in
      XCTAssertEqual(error as? SharedCounterStoreError, .malformedValue)
    }
  }

  func testLifecycleDefaultsDisabledAndReportsApprovalFailureWithoutSubmission() throws {
    let controller = PacketTunnelController()
    XCTAssertEqual(controller.state, .disabled)
    XCTAssertThrowsError(try controller.startTunnel()) { error in
      XCTAssertEqual(error as? TunnelControllerError, .disabled)
    }

    try controller.prepareRequest(.activation)
    let request = OSSystemExtensionRequest.activationRequest(
      forExtensionWithIdentifier: PacketImpairmentIdentity.tunnelBundleIdentifier,
      queue: .main
    )
    controller.requestNeedsUserApproval(request)
    XCTAssertEqual(controller.state, .awaitingUserApproval)
    controller.request(request, didFailWithError: TunnelControllerError.invalidState)
    XCTAssertEqual(controller.state, .failed(TunnelControllerError.invalidState.localizedDescription))
  }

  func testProviderStopBeforeSettingsSuccessCannotReviveOrPublish() throws {
    let lifecycle = ProviderLifecycleController()
    let recorder = ProviderCallbackRecorder()
    let generation = try lifecycle.beginStart { recorder.recordStart($0) }
    var publications = 0
    var shaperStops = 0
    var reads = 0
    XCTAssertEqual(recorder.snapshot().starts, 0)

    lifecycle.stop(stopShaper: { _ in shaperStops += 1 }, publish: { publications += 1 }) {
      recorder.recordStop()
    }
    var callbacks = recorder.snapshot()
    XCTAssertEqual(callbacks.starts, 1)
    XCTAssertEqual(callbacks.stops, 1)
    XCTAssertEqual(callbacks.errors.count, 1)
    XCTAssertEqual(callbacks.errors.first as? PacketTunnelProviderError, .startCancelled)
    XCTAssertEqual(publications, 1)
    XCTAssertEqual(shaperStops, 1)

    if lifecycle.completeStart(
      error: nil,
      generation: generation,
      stopShaper: { _ in shaperStops += 1 },
      publish: { publications += 1 }
    ) { reads += 1 }
    if lifecycle.completeStart(
      error: TunnelControllerError.invalidState,
      generation: generation,
      stopShaper: { _ in shaperStops += 1 },
      publish: { publications += 1 }
    ) { reads += 1 }
    callbacks = recorder.snapshot()
    XCTAssertEqual(callbacks.starts, 1)
    XCTAssertEqual(callbacks.stops, 1)
    XCTAssertEqual(publications, 1)
    XCTAssertEqual(shaperStops, 1)
    XCTAssertEqual(reads, 0)
  }

  func testProviderSettingsFailureCompletesOnceWithoutReads() throws {
    let lifecycle = ProviderLifecycleController()
    let recorder = ProviderCallbackRecorder()
    let generation = try lifecycle.beginStart { recorder.recordStart($0) }
    var publications = 0
    var shaperStops = 0
    var reads = 0

    if lifecycle.completeStart(
      error: PacketTunnelProviderError.packetWriteRejected,
      generation: generation,
      stopShaper: { _ in shaperStops += 1 },
      publish: { publications += 1 }
    ) { reads += 1 }
    if lifecycle.completeStart(
      error: nil,
      generation: generation,
      stopShaper: { _ in shaperStops += 1 },
      publish: { publications += 1 }
    ) { reads += 1 }
    var callbacks = recorder.snapshot()
    XCTAssertEqual(callbacks.starts, 1)
    XCTAssertEqual(callbacks.stops, 0)
    XCTAssertEqual(callbacks.errors.count, 1)
    XCTAssertEqual(callbacks.errors.first as? PacketTunnelProviderError, .packetWriteRejected)
    XCTAssertEqual(publications, 1)
    XCTAssertEqual(shaperStops, 1)
    XCTAssertEqual(reads, 0)

    lifecycle.stop(stopShaper: { _ in shaperStops += 1 }, publish: { publications += 1 }) {
      recorder.recordStop()
    }
    callbacks = recorder.snapshot()
    XCTAssertEqual(callbacks.starts, 1)
    XCTAssertEqual(callbacks.stops, 1)
    XCTAssertEqual(publications, 1)
    XCTAssertEqual(shaperStops, 1)
    XCTAssertEqual(reads, 0)
  }

  func testGatedConcurrentStopAndRestartDuringSettingsError() throws {
    try exerciseConcurrentStopAndRestart(
      error: .invalidState,
      publicationFails: false
    )
  }

  func testGatedConcurrentStopAndRestartDuringPublicationError() throws {
    try exerciseConcurrentStopAndRestart(
      error: .packetWriteRejected,
      publicationFails: true
    )
  }

  func testAsyncConnectionNotificationsPreserveDeactivationAndRejectInvalidTransitions() async throws {
    let manager = TestTunnelManager(status: .disconnected)
    let controller = PacketTunnelController(manager: manager)
    await postStatus(.connected, manager: manager)
    XCTAssertEqual(controller.state, .stopped)
    XCTAssertThrowsError(try controller.stopTunnel()) { error in
      XCTAssertEqual(error as? TunnelControllerError, .invalidState)
    }

    try controller.prepareRequest(.deactivation)
    XCTAssertEqual(controller.state, .deactivating)
    await postStatus(.disconnecting, manager: manager)
    XCTAssertEqual(controller.state, .deactivating)
    XCTAssertThrowsError(try controller.stopTunnel()) { error in
      XCTAssertEqual(error as? TunnelControllerError, .invalidState)
    }
    XCTAssertThrowsError(try controller.prepareRequest(.activation))
    await postStatus(.disconnected, manager: manager)
    XCTAssertEqual(controller.state, .deactivating)

    let request = OSSystemExtensionRequest.deactivationRequest(
      forExtensionWithIdentifier: PacketImpairmentIdentity.tunnelBundleIdentifier,
      queue: .main
    )
    controller.request(request, didFinishWithResult: .completed)
    XCTAssertEqual(controller.state, .disabled)
    await postStatus(.connected, manager: manager)
    XCTAssertEqual(controller.state, .disabled)
  }

  private func exerciseConcurrentStopAndRestart(
    error: PacketTunnelProviderError,
    publicationFails: Bool
  ) throws {
    let lifecycle = ProviderLifecycleController()
    let recorder = ProviderCallbackRecorder()
    let generation = try lifecycle.beginStart { recorder.recordStart($0) }
    let teardownEntered = DispatchSemaphore(value: 0)
    let finishTeardown = DispatchSemaphore(value: 0)
    let errorPathReturned = DispatchSemaphore(value: 0)
    let stopReturned = DispatchSemaphore(value: 0)
    let stopCompleted = DispatchSemaphore(value: 0)

    DispatchQueue.global().async {
      _ = lifecycle.completeStart(
        error: publicationFails ? nil : error,
        generation: generation,
        stopShaper: { stoppedGeneration in
          recorder.recordShaperStop(stoppedGeneration)
          teardownEntered.signal()
          XCTAssertEqual(finishTeardown.wait(timeout: .now() + 2), .success)
        },
        publish: {
          if publicationFails { throw error }
        }
      )
      errorPathReturned.signal()
    }
    XCTAssertEqual(teardownEntered.wait(timeout: .now() + 2), .success)

    DispatchQueue.global().async {
      lifecycle.stop(
        stopShaper: { recorder.recordShaperStop($0) },
        publish: {},
        completion: {
          recorder.recordStop()
          stopCompleted.signal()
        }
      )
      stopReturned.signal()
    }
    XCTAssertEqual(stopReturned.wait(timeout: .now() + 2), .success)
    XCTAssertThrowsError(try lifecycle.beginStart { _ in }) { error in
      XCTAssertEqual(error as? PacketTunnelProviderError, .invalidState)
    }
    XCTAssertEqual(recorder.snapshot().starts, 0)
    XCTAssertEqual(recorder.snapshot().stops, 0)

    finishTeardown.signal()
    XCTAssertEqual(errorPathReturned.wait(timeout: .now() + 2), .success)
    XCTAssertEqual(stopCompleted.wait(timeout: .now() + 2), .success)
    var callbacks = recorder.snapshot()
    XCTAssertEqual(callbacks.starts, 1)
    XCTAssertEqual(callbacks.stops, 1)
    XCTAssertEqual(callbacks.errors.count, 1)
    XCTAssertEqual(callbacks.errors.first as? PacketTunnelProviderError, error)
    XCTAssertEqual(callbacks.stoppedGenerations, [generation])

    let replacement = try lifecycle.beginStart { recorder.recordStart($0) }
    XCTAssertNotEqual(replacement, generation)
    lifecycle.stop(
      stopShaper: { recorder.recordShaperStop($0) },
      publish: {},
      completion: { recorder.recordStop() }
    )
    callbacks = recorder.snapshot()
    XCTAssertEqual(callbacks.starts, 2)
    XCTAssertEqual(callbacks.stops, 2)
    XCTAssertEqual(callbacks.stoppedGenerations, [generation, replacement])
    XCTAssertEqual(callbacks.errors.last as? PacketTunnelProviderError, .startCancelled)
  }

  private func postStatus(_ status: NEVPNStatus, manager: TestTunnelManager) async {
    await withCheckedContinuation { continuation in
      DispatchQueue.global().async {
        manager.testConnection.testStatus = status
        NotificationCenter.default.post(name: .NEVPNStatusDidChange, object: manager.connection)
        continuation.resume()
      }
    }
  }
}
