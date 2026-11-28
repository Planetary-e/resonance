import Foundation
@preconcurrency import NetworkExtension
import PacketShaper

public enum PacketTunnelBridge {
  public static func packetObject(for packet: ForwardingPacket) throws -> NEPacket {
    guard let version = packet.data.first.map({ $0 >> 4 }) else { throw PacketError.malformedPacket }
    let family: sa_family_t
    switch version {
    case 4: family = sa_family_t(AF_INET)
    case 6: family = sa_family_t(AF_INET6)
    default: throw PacketError.unsupportedVersion
    }
    return NEPacket(data: packet.data, protocolFamily: family)
  }
}
