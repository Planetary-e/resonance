import Foundation
@preconcurrency import NetworkExtension
@preconcurrency import SystemExtensions
import PacketShaper

public enum TunnelLifecycleState: Equatable {
  case disabled
  case activating
  case awaitingUserApproval
  case awaitingReboot
  case deactivating
  case configuring
  case stopped
  case starting
  case running
  case stopping
  case failed(String)
}

public enum TunnelControllerError: Error, Equatable, LocalizedError {
  case disabled
  case notConfigured
  case invalidState

  public var errorDescription: String? {
    switch self {
    case .disabled: "Packet impairment is disabled"
    case .notConfigured: "No packet-tunnel manager is configured"
    case .invalidState: "The requested tunnel lifecycle transition is not valid in the current state"
    }
  }
}

public final class PacketTunnelController: NSObject, OSSystemExtensionRequestDelegate, @unchecked Sendable {
  enum RequestAction {
    case activation
    case deactivation
  }

  private enum RequestState {
    case idle
    case activating
    case awaitingUserApproval
    case awaitingReboot
    case deactivating
  }

  private let lock = NSLock()
  private var requestState = RequestState.idle
  private var connectionState = TunnelLifecycleState.disabled
  private var configuring = false
  private var configuration = ProviderConfiguration()
  private var manager: NETunnelProviderManager?
  private var pendingRequestAction: RequestAction?
  private var statusObserver: NSObjectProtocol?

  public override init() {
    super.init()
  }

  init(manager: NETunnelProviderManager) {
    self.manager = manager
    connectionState = .stopped
    super.init()
    observeStatus(manager)
  }

  public var state: TunnelLifecycleState {
    lock.lock()
    defer { lock.unlock() }
    switch requestState {
    case .activating: return .activating
    case .awaitingUserApproval: return .awaitingUserApproval
    case .awaitingReboot: return .awaitingReboot
    case .deactivating: return .deactivating
    case .idle: break
    }
    return configuring ? .configuring : connectionState
  }

  deinit {
    if let statusObserver { NotificationCenter.default.removeObserver(statusObserver) }
  }

  public func activateExtension() throws {
    try prepareRequest(.activation)
    let request = OSSystemExtensionRequest.activationRequest(
      forExtensionWithIdentifier: PacketImpairmentIdentity.tunnelBundleIdentifier,
      queue: .main
    )
    request.delegate = self
    OSSystemExtensionManager.shared.submitRequest(request)
  }

  public func deactivateExtension() throws {
    try prepareRequest(.deactivation)
    let request = OSSystemExtensionRequest.deactivationRequest(
      forExtensionWithIdentifier: PacketImpairmentIdentity.tunnelBundleIdentifier,
      queue: .main
    )
    request.delegate = self
    currentManager()?.connection.stopVPNTunnel()
    OSSystemExtensionManager.shared.submitRequest(request)
  }

  public func configure(
    _ newConfiguration: ProviderConfiguration,
    completion: @escaping @Sendable (Result<Void, Error>) -> Void
  ) {
    do {
      try newConfiguration.validate()
      try prepareConfiguration()
    } catch {
      fail(error)
      completion(.failure(error))
      return
    }
    NETunnelProviderManager.loadAllFromPreferences { [weak self] managers, error in
      guard let self else { return }
      if let error {
        self.failConfiguration(error, completion: completion)
        return
      }
      let manager = managers?.first {
        ($0.protocolConfiguration as? NETunnelProviderProtocol)?.providerBundleIdentifier
          == PacketImpairmentIdentity.tunnelBundleIdentifier
      } ?? NETunnelProviderManager()
      let protocolConfiguration = (manager.protocolConfiguration as? NETunnelProviderProtocol)
        ?? NETunnelProviderProtocol()
      protocolConfiguration.providerBundleIdentifier = PacketImpairmentIdentity.tunnelBundleIdentifier
      protocolConfiguration.serverAddress = newConfiguration.tunnelRemoteAddress
      protocolConfiguration.providerConfiguration = newConfiguration.providerConfiguration
      manager.localizedDescription = "Resonance Packet Impairment"
      manager.protocolConfiguration = protocolConfiguration
      manager.isEnabled = newConfiguration.enabled
      manager.saveToPreferences { [weak self] error in
        guard let self else { return }
        if let error {
          self.failConfiguration(error, completion: completion)
          return
        }
        self.lock.lock()
        self.manager = manager
        self.configuration = newConfiguration
        self.configuring = false
        self.connectionState = .stopped
        self.lock.unlock()
        self.observeStatus(manager)
        completion(.success(()))
      }
    }
  }

  public func startTunnel() throws {
    lock.lock()
    guard requestState == .idle, !configuring else {
      lock.unlock()
      throw TunnelControllerError.invalidState
    }
    guard configuration.enabled else {
      lock.unlock()
      throw TunnelControllerError.disabled
    }
    guard let manager else {
      lock.unlock()
      throw TunnelControllerError.notConfigured
    }
    guard connectionState == .stopped else {
      lock.unlock()
      throw TunnelControllerError.invalidState
    }
    connectionState = .starting
    lock.unlock()
    do { try manager.connection.startVPNTunnel(options: nil) }
    catch {
      fail(error)
      throw error
    }
  }

  public func stopTunnel() throws {
    lock.lock()
    guard requestState == .idle, !configuring else {
      lock.unlock()
      throw TunnelControllerError.invalidState
    }
    guard let manager else {
      lock.unlock()
      throw TunnelControllerError.notConfigured
    }
    guard connectionState == .starting || connectionState == .running else {
      lock.unlock()
      throw TunnelControllerError.invalidState
    }
    connectionState = .stopping
    lock.unlock()
    manager.connection.stopVPNTunnel()
  }

  public func sharedCounters() throws -> ShaperCounters {
    try AppGroupCounterStore().load()
  }

  public func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
    lock.lock()
    if pendingRequestAction != nil {
      requestState = .awaitingUserApproval
    }
    lock.unlock()
  }

  public func request(_ request: OSSystemExtensionRequest, didFinishWithResult result: OSSystemExtensionRequest.Result) {
    lock.lock()
    guard let action = pendingRequestAction else {
      lock.unlock()
      return
    }
    pendingRequestAction = nil
    if result == .willCompleteAfterReboot {
      requestState = .awaitingReboot
    } else {
      requestState = .idle
      if action == .activation {
        connectionState = .stopped
      } else {
        connectionState = .disabled
        configuration = ProviderConfiguration()
        manager = nil
      }
    }
    lock.unlock()
  }

  public func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
    lock.lock()
    guard pendingRequestAction != nil else {
      lock.unlock()
      return
    }
    pendingRequestAction = nil
    requestState = .idle
    connectionState = .failed(error.localizedDescription)
    lock.unlock()
  }

  public func request(
    _ request: OSSystemExtensionRequest,
    actionForReplacingExtension existing: OSSystemExtensionProperties,
    withExtension replacement: OSSystemExtensionProperties
  ) -> OSSystemExtensionRequest.ReplacementAction {
    .replace
  }

  func prepareRequest(_ action: RequestAction) throws {
    lock.lock()
    defer { lock.unlock() }
    guard requestState == .idle, !configuring else { throw TunnelControllerError.invalidState }
    if action == .activation {
      switch connectionState {
      case .disabled, .stopped, .failed:
        break
      default:
        throw TunnelControllerError.invalidState
      }
    }
    pendingRequestAction = action
    requestState = action == .activation ? .activating : .deactivating
  }

  func prepareConfiguration() throws {
    lock.lock()
    defer { lock.unlock() }
    guard requestState == .idle, !configuring else { throw TunnelControllerError.invalidState }
    switch connectionState {
    case .disabled, .stopped, .failed:
      configuring = true
    default:
      throw TunnelControllerError.invalidState
    }
  }

  private func currentManager() -> NETunnelProviderManager? {
    lock.lock()
    defer { lock.unlock() }
    return manager
  }

  private func fail(_ error: Error) {
    lock.lock()
    configuring = false
    connectionState = .failed(error.localizedDescription)
    lock.unlock()
  }

  private func failConfiguration(
    _ error: Error,
    completion: @escaping @Sendable (Result<Void, Error>) -> Void
  ) {
    fail(error)
    completion(.failure(error))
  }

  private func observeStatus(_ manager: NETunnelProviderManager) {
    if let statusObserver { NotificationCenter.default.removeObserver(statusObserver) }
    statusObserver = NotificationCenter.default.addObserver(
      forName: .NEVPNStatusDidChange,
      object: manager.connection,
      queue: nil
    ) { [weak self] _ in
      self?.reconcileStatus(manager.connection.status, manager: manager)
    }
  }

  private func reconcileStatus(_ status: NEVPNStatus, manager: NETunnelProviderManager) {
    lock.lock()
    defer { lock.unlock() }
    guard self.manager === manager, requestState == .idle, !configuring else { return }
    switch status {
    case .invalid, .disconnected:
      switch connectionState {
      case .starting, .running, .stopping:
        connectionState = .stopped
      default:
        break
      }
    case .connecting, .reasserting:
      if connectionState == .starting || connectionState == .running {
        connectionState = .starting
      }
    case .connected:
      if connectionState == .starting || connectionState == .running {
        connectionState = .running
      }
    case .disconnecting:
      if connectionState == .starting || connectionState == .running || connectionState == .stopping {
        connectionState = .stopping
      }
    @unknown default:
      connectionState = .failed("Unknown tunnel connection status")
    }
  }
}
