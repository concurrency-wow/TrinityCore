# Network, Authentication, and Sessions

## Network layers

| Layer | Main types | Responsibility |
|---|---|---|
| Listener | `AsyncAcceptor` | Bind/listen and accept sockets |
| Distribution | `SocketMgr<T>` | Select least-loaded network thread |
| Network execution | `NetworkThread<T>` | Own socket I/O context and lifecycle |
| Generic socket | `Socket<Stream>` | Async reads, queued writes, close state |
| Auth protocol | `AuthSession` | SRP, TOTP, reconnect, realm list |
| World protocol | `WorldSocket` | Framing, header crypto, world authentication |
| Logical client | `WorldSession` | Account/player state and opcode queue |
| Dispatch registry | `OpcodeTable` | Opcode name, legal state, execution domain, handler |

Implementations are under `src/server/shared/Networking/`,
`src/server/authserver/Server/`, and `src/server/game/Server/`. Default public
listeners are auth port 3724 and world port 8085, bound to `0.0.0.0` by the
distribution files unless changed.

## Connection establishment

`SocketMgr::StartNetwork()`:

1. Creates and binds `AsyncAcceptor` on the process main I/O context.
2. Creates the configured `NetworkThread<T>` array.
3. Starts each network thread.
4. Installs a factory that chooses the thread with fewest connections.
5. Accepts directly into that thread's Asio socket.

`NetworkThread<T>` stages accepted sockets in `_newSockets`, transfers them to
`_sockets` on its 1 ms update callback, and repeatedly calls each socket's
`Update()`.

Auth and world sockets begin with an asynchronous IP-ban query through
`IpBanCheckConnectionInitializer`. Protocol reading starts only if the address
is not banned.

## Authserver state machine

`AuthSession` has protocol `AuthStatus`, distinct from world-session
`SessionStatus`.

| Expected state | Accepted command | Result |
|---|---|---|
| `STATUS_CHALLENGE` | `AUTH_LOGON_CHALLENGE` | Account query, then SRP challenge |
| `STATUS_LOGON_PROOF` | `AUTH_LOGON_PROOF` | Verify SRP/TOTP/version and store key |
| `STATUS_CHALLENGE` | `AUTH_RECONNECT_CHALLENGE` | Load key and issue nonce |
| `STATUS_RECONNECT_PROOF` | `AUTH_RECONNECT_PROOF` | Verify reconnect digest |
| `STATUS_AUTHED` | `REALM_LIST` | Character-count query and realms |
| `STATUS_XFER` | Patch-transfer commands | Handlers close; patching is unimplemented |

The constexpr table is `AuthSession.cpp::AuthHandlerTable`. A command received
in the wrong state closes the connection. Challenge/proof phases time out
after 10 seconds; authenticated and realm-list phases use one minute. See
`AuthSession::SetTimeout()`.

## Authentication flow

### Logon challenge

`AuthSession::HandleLogonChallenge()` validates the variable challenge length,
captures account, build, OS, locale, and timezone, then runs
`LOGIN_SEL_LOGONCHALLENGE`.

`LogonChallengeCallback()`:

- Loads account identity, locks, failed-logins, bans, and security.
- Enforces IP/country locking and active bans.
- Loads and optionally decrypts the TOTP secret.
- Creates `Trinity::Crypto::SRP6` from stored salt and verifier.
- Validates the client build.
- Sends SRP public value, generator, modulus, salt, version challenge, and
  security flags.

SRP is under `src/common/Cryptography/Authentication/SRP6.*`; TOTP is under
`src/common/Cryptography/TOTP.*`.

### Logon proof

`AuthSession::HandleLogonProof()`:

1. Verifies the SRP response and derives the session key.
2. Reads and validates TOTP when required.
3. Optionally verifies client executable proof with `StrictVersionCheck`.
4. Updates session key, IP, locale, OS, timezone, login, and failure state.
5. Sends the server SRP verifier and enters `STATUS_AUTHED`.

The distributed `StrictVersionCheck` default is disabled. Wrong-password
autobans are disabled by `WrongPass.MaxCount = 0`; when enabled they can ban
the account or IP. The derived session key, not the password, is consumed by
`worldserver`.

### Reconnect and realm list

Reconnect loads the stored session key, sends a random server proof, and
verifies a digest over account, client/server nonces, and the key.

`HandleRealmList()` queries per-realm character counts.
`RealmListCallback()` filters or marks realms by build compatibility, computes
security locks, and uses `Realm::GetAddressForClient()` to choose loopback,
local-subnet, or external addresses. `RealmList::UpdateRealms()` periodically
refreshes `realmlist` from the auth DB.

## Authserver to worldserver

A new `WorldSocket` runs:

1. Asynchronous IP-ban check.
2. `WorldSocket::SendAuthSession()` with server and DoS challenges.
3. Asynchronous packet reads.

The client sends `CMSG_AUTH_SESSION`.
`WorldSocket::HandleAuthSession()` parses build, account, local challenge,
realm ID, DoS response, digest, and addon data, then queries session data.

`HandleAuthSessionCallback()`:

- Initializes header crypto from the stored session key.
- Rejects a closed world or wrong realm ID.
- Checks OS validity when Warden is enabled.
- Recomputes the SHA-1 account/challenge/session digest.
- Rechecks locks, bans, and allowed security.
- Updates login address data and invokes script hooks.
- Creates `WorldSession` and parses addons.
- Optionally initializes Warden.
- Loads RBAC permissions asynchronously.
- Calls `World::AddSession()` after RBAC is ready.

`World::AddSession()` queues a world-thread handoff. `World::AddSession_()`
handles duplicate sessions and limits, then sends a wait-queue response or
calls `WorldSession::InitializeSession()`.

Initialization uses a character DB query holder for account data, tutorials,
and instance-entry restrictions. Its callback sends `AUTH_OK`, addon data,
cache version, and tutorial state.

## Packet framing

`WorldSocket::ReadHeaderHandler()` reads a packed client header containing a
16-bit size and 32-bit opcode. After authentication it decrypts and validates:

- Size is at least four bytes.
- Size is below 10,240 bytes.
- Opcode is below `NUM_OPCODE_HANDLERS`.

Payload parsing catches `ByteBufferException` at socket and session boundaries.
Most packets become `WorldPacket`s queued through
`WorldSession::QueuePacket()`. Authentication, ping, keepalive, and time-sync
timestamp capture have socket-side special handling.

Outbound flow is:

```text
WorldSession::SendPacket()
  -> WorldSocket::SendPacket()
  -> MPSC _bufferQueue
  -> WorldSocket::Update()
  -> header construction/encryption
  -> Socket::QueuePacket()
  -> network-thread write
```

## Opcode registry

Opcode numbers are declared in
`src/server/game/Server/Protocol/Opcodes.h`. `OpcodeTable::Initialize()`
registers handlers through:

```cpp
DEFINE_HANDLER(opcode, sessionStatus, processingPlace, handler)
```

A registration carries two independent policies.

### Session state

| `SessionStatus` | Required state |
|---|---|
| `STATUS_AUTHED` | Authenticated, no active player |
| `STATUS_LOGGEDIN` | Player exists and is in world |
| `STATUS_TRANSFER` | Player exists but is between maps |
| `STATUS_LOGGEDIN_OR_RECENTLY_LOGGOUT` | Active player or post-logout window |
| `STATUS_NEVER` | Client must not send it |
| `STATUS_UNHANDLED` | Known but unimplemented |

`WorldSession::Update()` applies these checks before dispatch and also runs
AntiDOS evaluation and packet-receive script hooks.

### Processing context

| `PacketProcessing` | Consumption rule |
|---|---|
| `PROCESS_THREADUNSAFE` | `WorldSessionFilter` in `World::UpdateSessions()` |
| `PROCESS_THREADSAFE` | In-world packets left for `MapSessionFilter` in `Map::Update()` |
| `PROCESS_INPLACE` | Either filter; first eligible update consumes it |

Despite its historical name, `PROCESS_INPLACE` does not normally run in
`WorldSocket::ReadDataHandler()`; the packet is queued.

`PROCESS_THREADSAFE` asserts safety on the player's owning map thread and no
unsynchronized global mutation. `PROCESS_THREADUNSAFE` serializes work on the
world thread.

## Representative packet trace: spell cast

`CMSG_CAST_SPELL` is `STATUS_LOGGEDIN`, `PROCESS_THREADSAFE`, and dispatches to
`WorldSession::HandleCastSpellOpcode`:

1. `WorldSocket::ReadDataHandler()` validates and queues it.
2. `World::UpdateSessions()` leaves it queued for an in-world player.
3. `Map::Update()` invokes `WorldSession::Update()` with `MapSessionFilter`.
4. Session state and AntiDOS checks run.
5. `HandleCastSpellOpcode()` in `Handlers/SpellHandler.cpp` validates spell and
   targets.
6. A `Spell` is created and `Spell::prepare()` enters the spell state machine.
7. Responses queue back to the network thread.

## Character entry

`CMSG_PLAYER_LOGIN` is `STATUS_AUTHED` and `PROCESS_THREADUNSAFE`.
`WorldSession::HandlePlayerLoginOpcode()` in `CharacterHandler.cpp`:

1. Rejects duplicate loading and reads the character GUID.
2. Verifies character ownership.
3. Constructs `LoginQueryHolder`.
4. Runs prepared queries via `CharacterDatabase.DelayQueryHolder()`.
5. Executes `HandlePlayerLogin()` from the session callback processor.
6. Builds `Player`, calls `Player::LoadFromDB()`, and sends initial packets.
7. Adds the player to map and object accessor.
8. Marks character/account online and calls `ScriptMgr::OnPlayerLogin()`.

## Session update and logout

`WorldSession::Update()` processes up to
`MAX_PROCESSED_PACKETS_IN_SAME_WORLDSESSION_UPDATE`, requeues temporarily
ineligible logged-in packets, and catches malformed payloads.

World-side updates also update Warden, perform delayed logout, clean closed
sockets, and return `false` when `World` should delete the session. Map-side
updates handle time synchronization but deliberately do not perform logout.

`WorldSession::LogoutPlayer()` saves and detaches player state, removes map,
social, group, and channel references, and clears online state.

## Adding or changing an opcode

1. Confirm the protocol number in `Opcodes.h`; never invent a collision.
2. Define or reuse a packet type under `src/server/game/Server/Packets/`.
3. Declare the `WorldSession` handler.
4. Add exactly one `DEFINE_HANDLER` in `OpcodeTable::Initialize()`.
5. Select `SessionStatus` from real lifecycle requirements.
6. Select `PacketProcessing` from touched ownership domains, not performance.
7. Validate lengths, indexes, GUID ownership, and object state.
8. Test auth state, transfer, logout, malformed packets, and flooding.
9. Use `network.opcode` trace logs to confirm actual consumption context.

## Security boundaries and review points

- Legacy auth/game protocols are not general-purpose TLS. Expose only the
  listeners required and protect infrastructure externally.
- IP bans run before protocol reads; account bans and locks are rechecked at
  relevant stages.
- World auth parses `Build` and `DosResponse` without using them in its final
  acceptance decision. Do not trust those fields.
- The optional TOTP suffix is accessed after the fixed proof structure; add
  explicit availability and maximum-length tests when changing this path.
- Warden is disabled by default. Windows initialization exists; macOS is
  commented out because it crashes the client.
- Remote Access is disabled by default but binds `0.0.0.0` if enabled, uses
  plaintext blocking I/O, and authenticates account credentials.
- SOAP is disabled and loopback-bound by default, but uses HTTP, not HTTPS.
- `WorldSession::DosProtection` supplements rather than replaces packet-level
  validation.
