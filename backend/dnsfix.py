"""DNS fallback for environments where `getaddrinfo` is blocked.

Some endpoint-security agents block name resolution for Python processes started
by file path (`python run.py`) while leaving raw sockets open. The symptom is
`[Errno 11001] getaddrinfo failed` on every outbound call even though the network
itself is reachable.

`install()` wraps `socket.getaddrinfo`: the native call is always tried first, and
only when it raises `gaierror` do we resolve A records ourselves with a minimal
DNS/UDP client aimed at the resolvers configured on the machine. Because the patch
lives at the socket layer, httpx, TLS/SNI and asyncio all keep working unchanged.
"""
from __future__ import annotations

import random
import socket
import struct
import threading
import time

_TTL = 300.0
_cache: dict[str, tuple[float, list[str]]] = {}
_lock = threading.Lock()
_native_getaddrinfo = socket.getaddrinfo
_installed = False

PUBLIC_FALLBACK = ("1.1.1.1", "8.8.8.8")


def _system_resolvers() -> list[str]:
    """Nameservers from the Windows registry (no network call involved)."""
    servers: list[str] = []
    try:
        import winreg
    except ImportError:  # non-Windows
        try:
            with open("/etc/resolv.conf", encoding="utf-8") as fh:
                for line in fh:
                    if line.startswith("nameserver"):
                        parts = line.split()
                        if len(parts) > 1 and parts[1] not in servers:
                            servers.append(parts[1])
        except OSError:
            pass
        return servers

    base = r"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces"
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, base) as root:
            for index in range(winreg.QueryInfoKey(root)[0]):
                try:
                    with winreg.OpenKey(root, winreg.EnumKey(root, index)) as key:
                        for value_name in ("NameServer", "DhcpNameServer"):
                            try:
                                raw = winreg.QueryValueEx(key, value_name)[0]
                            except FileNotFoundError:
                                continue
                            for ip in str(raw).replace(",", " ").split():
                                if ip.count(".") == 3 and ip not in servers:
                                    servers.append(ip)
                except OSError:
                    continue
    except OSError:
        pass
    return servers


def _build_query(host: str) -> tuple[int, bytes]:
    transaction_id = random.randint(0, 0xFFFF)
    packet = struct.pack(">HHHHHH", transaction_id, 0x0100, 1, 0, 0, 0)
    for label in host.rstrip(".").split("."):
        encoded = label.encode("idna") if any(ord(c) > 127 for c in label) else label.encode()
        if not 0 < len(encoded) < 64:
            raise socket.gaierror(f"invalid DNS label in {host!r}")
        packet += bytes([len(encoded)]) + encoded
    packet += b"\x00" + struct.pack(">HH", 1, 1)  # QTYPE=A, QCLASS=IN
    return transaction_id, packet


def _skip_name(data: bytes, pos: int) -> int:
    while pos < len(data):
        length = data[pos]
        if length == 0:
            return pos + 1
        if length & 0xC0 == 0xC0:
            return pos + 2
        pos += length + 1
    raise socket.gaierror("malformed DNS name")


def _parse_answer(data: bytes, transaction_id: int) -> list[str]:
    if len(data) < 12 or struct.unpack(">H", data[:2])[0] != transaction_id:
        raise socket.gaierror("DNS response mismatch")
    questions, answers = struct.unpack(">H", data[4:6])[0], struct.unpack(">H", data[6:8])[0]
    pos = 12
    for _ in range(questions):
        pos = _skip_name(data, pos) + 4
    ips: list[str] = []
    for _ in range(answers):
        pos = _skip_name(data, pos)
        rtype, _rclass, _ttl, rdlength = struct.unpack(">HHIH", data[pos:pos + 10])
        pos += 10
        if rtype == 1 and rdlength == 4:
            ips.append(".".join(str(b) for b in data[pos:pos + 4]))
        pos += rdlength
    return ips


def _resolve_a(host: str, timeout: float = 4.0) -> list[str]:
    with _lock:
        hit = _cache.get(host)
        if hit and hit[0] > time.monotonic():
            return list(hit[1])

    transaction_id, packet = _build_query(host)
    for server in [*_system_resolvers(), *PUBLIC_FALLBACK]:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(timeout)
        try:
            sock.sendto(packet, (server, 53))
            data, _addr = sock.recvfrom(4096)
            ips = _parse_answer(data, transaction_id)
        except (OSError, socket.gaierror, struct.error):
            continue
        finally:
            sock.close()
        if ips:
            with _lock:
                _cache[host] = (time.monotonic() + _TTL, ips)
            return ips
    raise socket.gaierror(f"fallback DNS could not resolve {host!r}")


def _is_ip_literal(host: str) -> bool:
    try:
        socket.inet_aton(host)
        return True
    except OSError:
        return ":" in host


def _port_number(port) -> int:
    if port is None:
        return 0
    if isinstance(port, int):
        return port
    try:
        return int(port)
    except ValueError:
        try:
            return socket.getservbyname(port)  # local services file, no DNS
        except OSError:
            return 0


def _patched_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):  # noqa: A002
    try:
        return _native_getaddrinfo(host, port, family, type, proto, flags)
    except socket.gaierror:
        # anyio/httpcore pass the host as bytes (IDNA-encoded), not str.
        if isinstance(host, (bytes, bytearray)):
            try:
                name = bytes(host).decode("ascii")
            except UnicodeDecodeError:
                raise
        else:
            name = host
        if not isinstance(name, str) or not name or _is_ip_literal(name):
            raise
        if family not in (0, socket.AF_INET):
            raise
        ips = _resolve_a(name)
        sock_type = type or socket.SOCK_STREAM
        sock_proto = proto or (socket.IPPROTO_TCP if sock_type == socket.SOCK_STREAM
                               else socket.IPPROTO_UDP)
        resolved_port = _port_number(port)
        return [(socket.AF_INET, sock_type, sock_proto, "", (ip, resolved_port)) for ip in ips]


def install() -> None:
    """Idempotently install the fallback resolver."""
    global _installed
    if _installed:
        return
    socket.getaddrinfo = _patched_getaddrinfo
    _installed = True


def diagnose(host: str) -> dict:
    """Report which resolution path works for `host` - used by /api/ai-check."""
    result = {"host": host, "native": False, "fallback": False, "ips": [],
              "resolvers": _system_resolvers()}
    try:
        _native_getaddrinfo(host, 443)
        result["native"] = True
    except socket.gaierror as exc:
        result["native_error"] = str(exc)
    try:
        result["ips"] = _resolve_a(host)
        result["fallback"] = bool(result["ips"])
    except socket.gaierror as exc:
        result["fallback_error"] = str(exc)
    return result
