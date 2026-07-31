# TrinityCore LAN Connection Guide

This guide explains the minimum server-side settings needed for WoW 3.3.5a clients on the same local network.

## Connection flow

1. The client reads its `realmlist.wtf` and connects to `authserver` on TCP 3724.
2. `authserver` reads `auth.realmlist` and returns an address and port for the realm.
3. The client connects to `worldserver` on the returned address, normally TCP 8085.

The auth and world servers must listen on the LAN interface, and the realm row must advertise an address that other computers can reach. MySQL can remain bound to localhost because game clients never connect to it.

## Discover the server address

```bash
ip -brief address show scope global
ip route get 1.1.1.1
```

Use the IPv4 `src` address from the route through the active LAN interface. For example, `192.168.12.119/24` means:

- Host address: `192.168.12.119`
- Network: `192.168.12.0/24`
- Subnet mask: `255.255.255.0`

Reserve the chosen address in the router's DHCP configuration so it does not change.

## Server configuration

Confirm these settings in the installed `authserver.conf`:

```ini
RealmServerPort = 3724
BindIP = "0.0.0.0"
```

Confirm these settings in the installed `worldserver.conf`:

```ini
RealmID = 1
WorldServerPort = 8085
BindIP = "0.0.0.0"
```

`0.0.0.0` listens on all IPv4 interfaces. Keep `LoginDatabaseInfo`, `WorldDatabaseInfo`, and `CharacterDatabaseInfo` pointed at `127.0.0.1` when MySQL runs on the same host.

This checkout's binaries were compiled with `/usr/local/etc` as the default config directory, but the installed configs are under `/home/czirz/server`. Start them with explicit paths:

```bash
cd /home/czirz/server
./authserver -c /home/czirz/server/authserver.conf

cd /home/czirz/server
./worldserver -c /home/czirz/server/worldserver.conf
```

## Realm database

Inspect the row before changing it:

```sql
SELECT id, name, address, localAddress, localSubnetMask, port
FROM auth.realmlist;
```

For a LAN-only realm, set both advertised addresses to the server's LAN address:

```sql
UPDATE auth.realmlist
SET address = '192.168.12.119',
    localAddress = '192.168.12.119',
    localSubnetMask = '255.255.255.0',
    port = 8085
WHERE id = 1;
```

TrinityCore returns `localAddress` when a client belongs to the network described by `localAddress` and `localSubnetMask`. It returns `address` for other clients. An internet-accessible server would normally place its public DNS name or public address in `address`, but that requires separate router, firewall, and security work.

## Client configuration

Set this in the client's locale-specific file, such as `Data/enUS/realmlist.wtf`:

```text
set realmlist 192.168.12.119
```

## Firewall and verification

If UFW is active, restrict game ports to the LAN:

```bash
sudo ufw allow from 192.168.12.0/24 to any port 3724 proto tcp comment 'TrinityCore auth LAN'
sudo ufw allow from 192.168.12.0/24 to any port 8085 proto tcp comment 'TrinityCore world LAN'
```

Do not expose MySQL port 3306. After both TrinityCore processes start, verify listeners with:

```bash
ss -ltn | grep -E ':(3724|8085)\b'
```

From a second computer, test `192.168.12.119` with `ping` and test both TCP ports with `nc -vz`.

## Relevant source files

- `src/server/authserver/authserver.conf.dist`: auth listener and database options
- `src/server/worldserver/worldserver.conf.dist`: world listener and database options
- `sql/base/auth_database.sql`: `realmlist` schema and defaults
- `src/server/shared/Realm/Realm.cpp`: local/external address selection
- `src/server/shared/Realm/RealmList.cpp`: loading realm rows from the auth database
- `src/server/worldserver/Main.cpp`: world server realm validation
- `README.md`: official project documentation links

## Beyond the LAN

Choose an access model before changing the public-facing realm address:

| Method | Native client | Router forwarding | Client software | Best use |
| --- | --- | --- | --- | --- |
| Tailscale mesh VPN | Yes, after VPN connects | No | Tailscale | Small trusted group |
| Port forwarding | Yes | Yes | None | Conventional public server |
| Cloudflare private network | Yes, after WARP connects | No | Cloudflare One/WARP | Identity-controlled private access |
| Cloudflare Access TCP | Through a local proxy | No | `cloudflared` | Technical, identity-controlled users |
| Cloudflare Spectrum | Yes | Origin must be reachable | None | Enterprise public service |

### Tailscale mesh VPN

Install Tailscale on the server and every remote client. Obtain the server address with `tailscale ip -4`. Keep the ordinary LAN address as `localAddress`, and use the Tailscale address as the address for clients outside the home subnet:

```sql
UPDATE auth.realmlist
SET address = 'SERVER_TAILSCALE_IP',
    localAddress = '192.168.12.119',
    localSubnetMask = '255.255.255.0',
    port = 8085
WHERE id = 1;
```

Remote clients put the Tailscale address in `realmlist.wtf`; LAN clients keep the LAN address. Restrict tailnet access to TCP 3724 and 8085. This is usually the safest approach for a few trusted players.

### Router port forwarding

Reserve the server's LAN address in DHCP, then forward TCP 3724 and TCP 8085 from the router to the same ports on the server. Do not forward MySQL TCP 3306.

Set `address` to the public address or a dynamic-DNS name and retain the private address in `localAddress`:

```sql
UPDATE auth.realmlist
SET address = 'wow.example.net',
    localAddress = '192.168.12.119',
    localSubnetMask = '255.255.255.0',
    port = 8085
WHERE id = 1;
```

Remote clients use the public name. LAN clients can use the LAN address, which avoids problems on routers without NAT loopback. If using Cloudflare DNS without Spectrum, the record must be DNS-only because the ordinary Cloudflare HTTP proxy does not proxy arbitrary WoW TCP traffic.

If the router has a private/shared WAN address or port forwarding never reaches the host, the ISP may use CGNAT. Request a public IPv4 address or use a mesh/private-network solution.

### Cloudflare options

Cloudflare Tunnel private networking can route `192.168.12.119/32` to enrolled Cloudflare One/WARP devices. Apply identity and Gateway network policies for TCP 3724 and 8085. This supports non-HTTP traffic but requires enrollment software on each player device.

Cloudflare Access arbitrary TCP also requires `cloudflared` on every player computer. Each user runs local proxies for auth and world traffic. The game client connects to local port 3724 and the realm must advertise the client's local proxy on port 8085. This is awkward for a mixed LAN/remote realm and is usually less convenient than WARP or Tailscale.

Cloudflare Spectrum is the transparent Cloudflare product for native TCP/UDP clients. Current Cloudflare documentation states that custom TCP/UDP applications require an Enterprise plan with Spectrum as a paid add-on. It can front TCP 3724 and 8085 without player-side tunnel software.

Official references:

- [Cloudflare Access arbitrary TCP](https://developers.cloudflare.com/cloudflare-one/applications/non-http/cloudflared-authentication/arbitrary-tcp/)
- [Cloudflare private networks](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/private-net/)
- [Cloudflare Spectrum](https://developers.cloudflare.com/spectrum/)
- [Tailscale quickstart](https://tailscale.com/kb/1017/install)

### Internet security

- Expose only TCP 3724 and 8085.
- Keep all database connections on localhost and never expose TCP 3306.
- Do not expose remote administration unless it is separately secured and required.
- Prefer firewall source restrictions or authenticated VPN membership.
- Use unique passwords, patch the host and TrinityCore, and test database backups.
